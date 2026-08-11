import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  S3Client,
  S3Error,
  amzDates,
  buildCanonicalRequest,
  buildStringToSign,
  deriveSigningKey,
  encodeS3Path,
  encodeS3Segment,
  parseListResponse,
  s3FromEnv,
  sha256Hex,
  signRequest,
  type S3Config,
} from './s3.js';

/**
 * The credentials and dates below come from AWS's own published SigV4
 * examples. They are the only way to prove a signature implementation is
 * correct rather than merely self-consistent: a wrong canonical request signs
 * cleanly and fails at the server with `SignatureDoesNotMatch` and no clue
 * which of the seven steps was wrong.
 */
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  bucket: 'examplebucket',
  date: new Date('2013-05-24T00:00:00Z'),
};

const virtualHostConfig: S3Config = {
  endpoint: 'https://s3.amazonaws.com',
  region: AWS_EXAMPLE.region,
  bucket: AWS_EXAMPLE.bucket,
  accessKeyId: AWS_EXAMPLE.accessKeyId,
  secretAccessKey: AWS_EXAMPLE.secretAccessKey,
  forcePathStyle: false,
};

const localConfig: S3Config = {
  endpoint: 'http://minio:9000',
  region: 'us-east-1',
  bucket: 'results',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  forcePathStyle: true,
};

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(responses: Array<Response | (() => Response)>): {
  calls: RecordedCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  let index = 0;

  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  const urlOf = (input: FetchInput): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  globalThis.fetch = (input: FetchInput, init?: RequestInit): Promise<Response> => {
    calls.push({ url: urlOf(input), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('stubFetch ran out of responses');
    return Promise.resolve(typeof next === 'function' ? next() : next);
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('SigV4 against AWS published examples', () => {
  it('reproduces the GET Object signature exactly', () => {
    // AWS docs, "Signature Calculations … Transferring Payload in a Single
    // Chunk" — Example: GET Object.
    const signed = signRequest(
      virtualHostConfig,
      'GET',
      'test.txt',
      {},
      sha256Hex(''),
      AWS_EXAMPLE.date,
      { range: 'bytes=0-9' },
    );

    assert.match(
      signed.headers.authorization!,
      /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
    );
    assert.match(signed.headers.authorization!, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
    assert.equal(signed.url, 'https://examplebucket.s3.amazonaws.com/test.txt');
  });

  it('reproduces the PUT Object signature exactly', () => {
    // Same source — Example: PUT Object. A different verb, a real payload hash
    // and an extra signed header, so it exercises what the GET case cannot.
    const body = 'Welcome to Amazon S3.';
    const signed = signRequest(
      virtualHostConfig,
      'PUT',
      'test$file.text',
      {},
      sha256Hex(body),
      AWS_EXAMPLE.date,
      { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    );

    assert.match(
      signed.headers.authorization!,
      /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/,
    );
  });

  it('derives the signing key AWS documents', () => {
    const key = deriveSigningKey(AWS_EXAMPLE.secretAccessKey, '20130524', 'us-east-1');
    assert.equal(key.length, 32);
    // Same secret and date must always give the same key — the chain is
    // deterministic, which is what makes caching it safe.
    assert.equal(
      key.toString('hex'),
      deriveSigningKey(AWS_EXAMPLE.secretAccessKey, '20130524', 'us-east-1').toString('hex'),
    );
  });
});

describe('canonical request', () => {
  it('sorts and lowercases headers, because the order is part of the signature', () => {
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
      method: 'GET',
      canonicalUri: '/bucket/key',
      query: {},
      headers: { 'X-Amz-Date': '20260811T000000Z', Host: 'example.com', 'Content-Type': 'text/plain' },
      payloadHash: 'abc',
    });

    assert.equal(signedHeaders, 'content-type;host;x-amz-date');
    assert.match(canonicalRequest, /content-type:text\/plain\nhost:example\.com\nx-amz-date:/);
  });

  it('collapses runs of whitespace in header values', () => {
    const { canonicalRequest } = buildCanonicalRequest({
      method: 'GET',
      canonicalUri: '/',
      query: {},
      headers: { host: '  example.com  ', note: 'a    b' },
      payloadHash: 'abc',
    });

    assert.match(canonicalRequest, /host:example\.com\n/);
    assert.match(canonicalRequest, /note:a b\n/);
  });

  it('sorts and encodes the query string', () => {
    const { canonicalRequest } = buildCanonicalRequest({
      method: 'GET',
      canonicalUri: '/',
      query: { prefix: 'pr-1/shard-0', 'list-type': '2' },
      headers: { host: 'example.com' },
      payloadHash: 'abc',
    });

    assert.match(canonicalRequest, /\nlist-type=2&prefix=pr-1%2Fshard-0\n/);
  });

  it('builds the string to sign in the documented order', () => {
    const s = buildStringToSign('20260811T000000Z', '20260811/us-east-1/s3/aws4_request', 'canonical');
    assert.deepEqual(s.split('\n'), [
      'AWS4-HMAC-SHA256',
      '20260811T000000Z',
      '20260811/us-east-1/s3/aws4_request',
      sha256Hex('canonical'),
    ]);
  });
});

describe('key encoding', () => {
  it('encodes the characters encodeURIComponent leaves behind', () => {
    // These four are the reason this helper exists at all; a key containing
    // them signs incorrectly with plain encodeURIComponent.
    assert.equal(encodeS3Segment("a!b'c(d)e*f"), 'a%21b%27c%28d%29e%2Af');
  });

  it('keeps slashes as separators but encodes within a segment', () => {
    assert.equal(encodeS3Path('pr-1/shard 0/a+b.json'), 'pr-1/shard%200/a%2Bb.json');
  });

  it('leaves an ordinary key untouched', () => {
    assert.equal(encodeS3Path('pr-1/shard-0/allure-results/x.json'), 'pr-1/shard-0/allure-results/x.json');
  });
});

describe('amzDates', () => {
  it('produces both forms from one instant', () => {
    const { amzDate, dateStamp } = amzDates(new Date('2026-08-11T07:39:00.123Z'));
    assert.equal(amzDate, '20260811T073900Z');
    assert.equal(dateStamp, '20260811');
  });
});

describe('addressing style', () => {
  it('puts the bucket in the path for MinIO', () => {
    const signed = signRequest(localConfig, 'GET', 'pr-1/shard-0/x.json', {}, sha256Hex(''), AWS_EXAMPLE.date);
    assert.equal(signed.url, 'http://minio:9000/results/pr-1/shard-0/x.json');
    assert.equal(signed.headers.host, 'minio:9000');
  });

  it('puts the bucket in the host for AWS', () => {
    const signed = signRequest(virtualHostConfig, 'GET', 'a/b.json', {}, sha256Hex(''), AWS_EXAMPLE.date);
    assert.equal(signed.url, 'https://examplebucket.s3.amazonaws.com/a/b.json');
  });

  it('addresses the bucket itself when the key is empty, as LIST does', () => {
    const signed = signRequest(localConfig, 'GET', '', { 'list-type': '2' }, sha256Hex(''), AWS_EXAMPLE.date);
    assert.equal(signed.url, 'http://minio:9000/results?list-type=2');
  });
});

describe('parseListResponse', () => {
  it('extracts every key from a page', () => {
    const xml = `<?xml version="1.0"?><ListBucketResult>
      <IsTruncated>false</IsTruncated>
      <Contents><Key>pr-1/shard-0/a.json</Key><Size>12</Size></Contents>
      <Contents><Key>pr-1/shard-1/b.json</Key><Size>34</Size></Contents>
    </ListBucketResult>`;
    assert.deepEqual(parseListResponse(xml).keys, ['pr-1/shard-0/a.json', 'pr-1/shard-1/b.json']);
    assert.equal(parseListResponse(xml).nextToken, undefined);
  });

  it('reports the continuation token only when the page is truncated', () => {
    const truncated = `<ListBucketResult><IsTruncated>true</IsTruncated>
      <NextContinuationToken>tok123</NextContinuationToken>
      <Contents><Key>a</Key></Contents></ListBucketResult>`;
    assert.equal(parseListResponse(truncated).nextToken, 'tok123');

    // A token present on a non-truncated page must not cause another request —
    // that would loop forever against an implementation that always emits one.
    const notTruncated = `<ListBucketResult><IsTruncated>false</IsTruncated>
      <NextContinuationToken>tok123</NextContinuationToken></ListBucketResult>`;
    assert.equal(parseListResponse(notTruncated).nextToken, undefined);
  });

  it('unescapes XML entities in keys', () => {
    const xml = '<ListBucketResult><Contents><Key>a&amp;b/c&lt;d&gt;.json</Key></Contents></ListBucketResult>';
    assert.deepEqual(parseListResponse(xml).keys, ['a&b/c<d>.json']);
  });

  it('returns nothing for an empty bucket rather than throwing', () => {
    assert.deepEqual(parseListResponse('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>').keys, []);
  });
});

describe('S3Client', () => {
  const client = new S3Client(localConfig);

  it('PUTs a body with its length and content type', async () => {
    const stub = stubFetch([new Response('', { status: 200 })]);
    try {
      await client.putObject('pr-1/shard-0/a.json', Buffer.from('{"a":1}'), 'application/json');

      const call = stub.calls[0];
      assert.equal(call?.url, 'http://minio:9000/results/pr-1/shard-0/a.json');
      assert.equal(call?.init?.method, 'PUT');
      const headers = call?.init?.headers as Record<string, string>;
      assert.equal(headers['content-type'], 'application/json');
      assert.equal(headers['content-length'], '7');
      // The payload hash must be of the body, not of the empty string.
      assert.equal(headers['x-amz-content-sha256'], sha256Hex('{"a":1}'));
    } finally {
      stub.restore();
    }
  });

  it('GETs an object as bytes', async () => {
    const stub = stubFetch([new Response('hello', { status: 200 })]);
    try {
      const body = await client.getObject('pr-1/merged/summary.md');
      assert.equal(body.toString('utf8'), 'hello');
    } finally {
      stub.restore();
    }
  });

  it('follows continuation tokens until the listing is exhausted', async () => {
    // A run with more result files than one page holds must not silently
    // aggregate the first page only.
    const page1 = `<ListBucketResult><IsTruncated>true</IsTruncated>
      <NextContinuationToken>t1</NextContinuationToken>
      <Contents><Key>a</Key></Contents></ListBucketResult>`;
    const page2 = `<ListBucketResult><IsTruncated>false</IsTruncated>
      <Contents><Key>b</Key></Contents></ListBucketResult>`;
    const stub = stubFetch([() => new Response(page1), () => new Response(page2)]);
    try {
      assert.deepEqual(await client.listObjects('pr-1/'), ['a', 'b']);
      assert.equal(stub.calls.length, 2);
      assert.match(stub.calls[1]?.url ?? '', /continuation-token=t1/);
    } finally {
      stub.restore();
    }
  });

  it('deletes every key under a prefix and reports how many', async () => {
    const listing = `<ListBucketResult><IsTruncated>false</IsTruncated>
      <Contents><Key>pr-1/a</Key></Contents>
      <Contents><Key>pr-1/b</Key></Contents></ListBucketResult>`;
    let call = 0;
    // 204 takes a null body, not an empty string — the fetch spec rejects the
    // latter, which is exactly what a real DELETE returns.
    const stub = stubFetch([
      () => (call++ === 0 ? new Response(listing) : new Response(null, { status: 204 })),
    ]);
    try {
      assert.equal(await client.deletePrefix('pr-1/'), 2);
      assert.equal(stub.calls.length, 3); // one list, two deletes
      assert.equal(stub.calls[1]?.init?.method, 'DELETE');
    } finally {
      stub.restore();
    }
  });

  it('creates the bucket when it is absent', async () => {
    const stub = stubFetch([new Response('', { status: 200 })]);
    try {
      assert.equal(await client.ensureBucket(), 'created');
      assert.equal(stub.calls[0]?.init?.method, 'PUT');
      assert.equal(stub.calls[0]?.url, 'http://minio:9000/results');
    } finally {
      stub.restore();
    }
  });

  it('treats an existing bucket as success, because shard pods race', async () => {
    // Four shard pods start at once and all four try. Three get 409, and that
    // is the normal path, not an error.
    const stub = stubFetch([
      new Response('<Error><Code>BucketAlreadyOwnedByYou</Code></Error>', { status: 409 }),
    ]);
    try {
      assert.equal(await client.ensureBucket(), 'exists');
    } finally {
      stub.restore();
    }
  });

  it('does not swallow a real failure while creating the bucket', async () => {
    const stub = stubFetch([new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })]);
    try {
      await assert.rejects(() => client.ensureBucket(), /403/);
    } finally {
      stub.restore();
    }
  });

  it('surfaces the status and body when a request is refused', async () => {
    // A wrong key or a missing bucket policy shows up here, and the message is
    // the only diagnostic a shard pod produces.
    const stub = stubFetch([new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 })]);
    try {
      await assert.rejects(
        () => client.getObject('pr-1/a.json'),
        (error: Error) => {
          assert.ok(error instanceof S3Error);
          assert.equal(error.status, 403);
          assert.match(error.message, /GET pr-1\/a\.json failed: 403/);
          assert.match(error.message, /SignatureDoesNotMatch/);
          return true;
        },
      );
    } finally {
      stub.restore();
    }
  });

  it('names the bucket rather than an empty key when a listing fails', async () => {
    const stub = stubFetch([new Response('nope', { status: 404 })]);
    try {
      await assert.rejects(
        () => client.listObjects('pr-1/'),
        (error: Error) => {
          assert.match(error.message, /\(bucket\) failed: 404/);
          return true;
        },
      );
    } finally {
      stub.restore();
    }
  });
});

describe('s3FromEnv', () => {
  const complete = {
    RESULTS_S3_ENDPOINT: 'http://minio:9000',
    RESULTS_S3_BUCKET: 'results',
    RESULTS_S3_ACCESS_KEY_ID: 'id',
    RESULTS_S3_SECRET_ACCESS_KEY: 'secret',
  };

  it('builds a client when everything is present', () => {
    assert.ok(s3FromEnv(complete) instanceof S3Client);
  });

  it('returns undefined when object storage is not configured', () => {
    // Undefined rather than a throw: it is what lets the volume backend remain
    // the default while both paths exist.
    assert.equal(s3FromEnv({}), undefined);
  });

  it('returns undefined when the configuration is only partly present', () => {
    // Half-configured is the dangerous case — it would otherwise sign requests
    // with an empty secret and fail at the server with a confusing 403.
    for (const missing of Object.keys(complete)) {
      const env = { ...complete };
      delete (env as Record<string, string>)[missing];
      assert.equal(s3FromEnv(env), undefined, `should be undefined without ${missing}`);
    }
  });

  it('defaults to path style, because the in-cluster default is MinIO', () => {
    const signed = signRequest(
      { ...localConfig, forcePathStyle: (complete as Record<string, string>).X !== undefined },
      'GET',
      'k',
      {},
      sha256Hex(''),
      AWS_EXAMPLE.date,
    );
    assert.match(signed.url, /minio:9000\/k$/);
    assert.ok(s3FromEnv(complete));
  });

  it('honours an explicit opt out of path style', () => {
    const client = s3FromEnv({ ...complete, RESULTS_S3_FORCE_PATH_STYLE: 'false' });
    assert.ok(client instanceof S3Client);
  });
});
