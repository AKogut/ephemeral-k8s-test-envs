/**
 * A very small S3 client.
 *
 * Shard results have to leave the pod that produced them. Doing that through a
 * shared PersistentVolume is what pins every shard to one node — see #82 — so
 * they go to object storage instead, which every pod can reach from anywhere.
 *
 * The obvious way to talk to S3 is the AWS SDK. It is ~15 MB of dependencies,
 * and it would have to ship in *two* images: the test runner and the aggregator.
 * What is actually needed here is four requests — PUT, GET, LIST, DELETE — and
 * SigV4, which is a hash chain. So this is written out, the same trade already
 * made for the Kubernetes API in `k8s.ts`.
 *
 * The signing steps are exported individually because they are the part that is
 * hard to get right and easy to test: a wrong canonical request produces a
 * `SignatureDoesNotMatch` with no indication of which of the seven steps was
 * wrong.
 *
 * Reference: AWS Signature Version 4 for the REST API.
 */

import { createHash, createHmac } from 'node:crypto';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Path style addresses a bucket as `<endpoint>/<bucket>/<key>`, virtual-host
   * style as `<bucket>.<endpoint>/<key>`. MinIO speaks path style; AWS prefers
   * virtual-host but still accepts path style for most regions.
   */
  forcePathStyle: boolean;
}

const EMPTY_BODY_SHA256 = createHash('sha256').update('').digest('hex');

export function sha256Hex(payload: string | Uint8Array): string {
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Percent-encodes one path segment the way SigV4 requires.
 *
 * `encodeURIComponent` leaves `!'()*` alone and AWS does not, so those are
 * encoded afterwards. Getting this wrong only breaks keys containing them,
 * which is exactly the kind of bug that survives every test written with
 * alphanumeric fixtures.
 */
export function encodeS3Segment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function encodeS3Path(key: string): string {
  return key.split('/').map(encodeS3Segment).join('/');
}

/** `20260811T073900Z` and `20260811`, the two forms SigV4 needs. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface CanonicalRequestInput {
  method: string;
  canonicalUri: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
}

export function buildCanonicalRequest(input: CanonicalRequestInput): {
  canonicalRequest: string;
  signedHeaders: string;
} {
  const canonicalQuery = Object.keys(input.query)
    .sort()
    .map((key) => `${encodeS3Segment(key)}=${encodeS3Segment(input.query[key] ?? '')}`)
    .join('&');

  // Header names lowercased, values trimmed, sorted by name — the order is part
  // of the signature, not a formatting preference.
  const normalised = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => a[0].localeCompare(b[0], 'en'));

  const canonicalHeaders = normalised.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = normalised.map(([name]) => name).join(';');

  return {
    canonicalRequest: [
      input.method,
      input.canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      input.payloadHash,
    ].join('\n'),
    signedHeaders,
  };
}

export function buildStringToSign(
  amzDate: string,
  scope: string,
  canonicalRequest: string,
): string {
  return ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
}

/** The four-step key derivation: date, region, service, then the literal terminator. */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service = 's3',
): Buffer {
  const hmac = (key: Buffer | string, data: string): Buffer =>
    createHmac('sha256', key).update(data).digest();

  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Produces the URL and headers for one signed request.
 *
 * Split out from `request()` so a test can assert on the signature without a
 * server, and so a wrong signature is diagnosable one step at a time.
 */
export function signRequest(
  config: S3Config,
  method: string,
  key: string,
  query: Record<string, string>,
  payloadHash: string,
  now: Date,
  extraHeaders: Record<string, string> = {},
): SignedRequest {
  const endpoint = new URL(config.endpoint);
  const { amzDate, dateStamp } = amzDates(now);

  const encodedKey = key === '' ? '' : encodeS3Path(key);
  let host: string;
  let canonicalUri: string;

  if (config.forcePathStyle) {
    host = endpoint.host;
    canonicalUri = `/${config.bucket}${encodedKey === '' ? '' : `/${encodedKey}`}`;
  } else {
    host = `${config.bucket}.${endpoint.host}`;
    canonicalUri = `/${encodedKey}`;
  }

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extraHeaders,
  };

  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method,
    canonicalUri,
    query,
    headers,
    payloadHash,
  });

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const signature = createHmac('sha256', deriveSigningKey(config.secretAccessKey, dateStamp, config.region))
    .update(buildStringToSign(amzDate, scope, canonicalRequest))
    .digest('hex');

  const search = Object.keys(query)
    .sort()
    .map((k) => `${encodeS3Segment(k)}=${encodeS3Segment(query[k] ?? '')}`)
    .join('&');

  return {
    // `host` already carries the port, because URL.host includes it.
    url: `${endpoint.protocol}//${host}${canonicalUri}${search ? `?${search}` : ''}`,
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/**
 * Extracts object keys from a ListObjectsV2 response.
 *
 * A regex rather than an XML parser, deliberately: the response shape is fixed,
 * keys are XML-escaped by S3, and the alternative is a dependency in two images
 * to read one element name.
 */
export function parseListResponse(xml: string): { keys: string[]; nextToken?: string } {
  const unescape = (value: string): string =>
    value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');

  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => unescape(m[1] ?? ''));
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);

  return truncated && token ? { keys, nextToken: unescape(token[1] ?? '') } : { keys };
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly key: string,
    body: string,
  ) {
    super(`${method} ${key || '(bucket)'} failed: ${status} ${body.slice(0, 400)}`);
    this.name = 'S3Error';
  }
}

export class S3Client {
  constructor(private readonly config: S3Config) {}

  private async send(
    method: string,
    key: string,
    query: Record<string, string>,
    body?: Uint8Array,
    extraHeaders: Record<string, string> = {},
    now: Date = new Date(),
  ): Promise<Response> {
    const payloadHash = body ? sha256Hex(body) : EMPTY_BODY_SHA256;
    const headers = { ...extraHeaders };
    if (body) headers['content-length'] = String(body.byteLength);

    const signed = signRequest(this.config, method, key, query, payloadHash, now, headers);

    const response = await fetch(signed.url, {
      method,
      headers: signed.headers,
      body: body ? Buffer.from(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new S3Error(response.status, method, key, await response.text());
    }
    return response;
  }

  async putObject(key: string, body: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    await this.send('PUT', key, {}, body, { 'content-type': contentType });
  }

  async getObject(key: string): Promise<Buffer> {
    const response = await this.send('GET', key, {});
    return Buffer.from(await response.arrayBuffer());
  }

  /** Every key under a prefix, following continuation tokens to the end. */
  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;

    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;

      const response = await this.send('GET', '', query);
      const page = parseListResponse(await response.text());
      keys.push(...page.keys);
      token = page.nextToken;
    } while (token);

    return keys;
  }

  async deleteObject(key: string): Promise<void> {
    await this.send('DELETE', key, {});
  }

  /**
   * Removes everything under a prefix.
   *
   * Used by teardown verification: results that outlive their environment are
   * the same class of leak as an orphaned PersistentVolume, in a place nothing
   * was previously looking.
   */
  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.listObjects(prefix);
    for (const key of keys) await this.deleteObject(key);
    return keys.length;
  }
}

/**
 * Builds a client from the environment, or returns undefined when object
 * storage is not configured.
 *
 * Returning undefined rather than throwing is what lets both backends coexist
 * while the volume path is still the default.
 */
export function s3FromEnv(env: NodeJS.ProcessEnv = process.env): S3Client | undefined {
  const endpoint = env.RESULTS_S3_ENDPOINT;
  const bucket = env.RESULTS_S3_BUCKET;
  const accessKeyId = env.RESULTS_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.RESULTS_S3_SECRET_ACCESS_KEY;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;

  return new S3Client({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.RESULTS_S3_REGION ?? 'us-east-1',
    // Defaults to path style because the in-cluster default is MinIO, which
    // only speaks path style without per-bucket DNS.
    forcePathStyle: (env.RESULTS_S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
  });
}
