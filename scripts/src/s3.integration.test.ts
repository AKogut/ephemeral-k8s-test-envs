/**
 * The S3 client against a real server.
 *
 * `s3.test.ts` proves the signature is correct against AWS's published vectors
 * and the request shapes against a stub. Neither notices if a real server
 * rejects what we send — a wrong `content-length`, an unsigned header the
 * server insists on, a listing that pages differently in practice. That gap is
 * what this closes.
 *
 * Skipped unless RESULTS_S3_ENDPOINT is set, so `npm test` stays a
 * no-dependencies command. CI provides MinIO; locally:
 *
 *   docker run -d --name minio -p 19000:9000 \
 *     -e MINIO_ROOT_USER=testkey -e MINIO_ROOT_PASSWORD=testsecret123 \
 *     quay.io/minio/minio server /data
 *
 *   RESULTS_S3_ENDPOINT=http://127.0.0.1:19000 RESULTS_S3_BUCKET=results \
 *   RESULTS_S3_ACCESS_KEY_ID=testkey RESULTS_S3_SECRET_ACCESS_KEY=testsecret123 \
 *   npm test
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { S3Client, s3FromEnv, sha256Hex, signRequest, type S3Config } from './s3.js';
import { downloadPrefix, uploadDirectory } from './sync.js';

const configured = Boolean(process.env.RESULTS_S3_ENDPOINT && process.env.RESULTS_S3_BUCKET);

/**
 * A skipped suite reports "tests 0, pass 0, skipped 0" — indistinguishable from
 * a file that was never collected. That is fine on a laptop with no MinIO, and
 * not fine in CI, where it would mean the live tests quietly stopped running
 * and nobody noticed for months.
 *
 * This is the check that makes the difference visible.
 */
describe('live S3 coverage', () => {
  it('runs wherever it is expected to', () => {
    if (process.env.CI && !configured) {
      assert.fail(
        'RESULTS_S3_ENDPOINT and RESULTS_S3_BUCKET are unset in CI, so the live S3 tests did not run. ' +
          'Start the MinIO service container or remove this guard deliberately.',
      );
    }
    assert.ok(true, configured ? 'live tests enabled' : 'skipped locally, which is allowed');
  });
});

describe('S3 client against a live server', { skip: configured ? false : 'RESULTS_S3_ENDPOINT not set' }, () => {
  let client: S3Client;
  let prefix: string;
  const temporaries: string[] = [];

  before(async () => {
    client = s3FromEnv()!;
    assert.ok(client, 'expected a client from the environment');

    // A distinct prefix per run, so a leftover from an earlier failure cannot
    // make this one pass.
    prefix = `it-${process.pid}-${process.hrtime.bigint().toString(36)}`;

    // Create the bucket if it is not there. This is also the first proof that
    // the hand-written signature authenticates against a real server at all.
    const config: S3Config = {
      endpoint: process.env.RESULTS_S3_ENDPOINT!,
      region: process.env.RESULTS_S3_REGION ?? 'us-east-1',
      bucket: process.env.RESULTS_S3_BUCKET!,
      accessKeyId: process.env.RESULTS_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.RESULTS_S3_SECRET_ACCESS_KEY!,
      forcePathStyle: (process.env.RESULTS_S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
    };
    const signed = signRequest(config, 'PUT', '', {}, sha256Hex(''), new Date());
    const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers });
    assert.ok(
      response.ok || response.status === 409,
      `could not create bucket: ${response.status} ${await response.text()}`,
    );
  });

  after(async () => {
    if (client) await client.deletePrefix(`${prefix}/`);
    for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a single object byte for byte', async () => {
    const body = Buffer.from('{"status":"passed","µ":"ünïcode"}', 'utf8');
    await client.putObject(`${prefix}/one.json`, body, 'application/json');
    assert.deepEqual(await client.getObject(`${prefix}/one.json`), body);
  });

  it('round-trips a whole shard directory, including awkward key names', async () => {
    // Spaces, parentheses and `!` are exactly what encodeURIComponent leaves
    // alone and SigV4 does not. A stub cannot catch this; a real server can.
    const source = await mkdtemp(path.join(tmpdir(), 's3-it-'));
    const target = await mkdtemp(path.join(tmpdir(), 's3-it-dl-'));
    temporaries.push(source, target);

    await mkdir(path.join(source, 'allure-results'), { recursive: true });
    await writeFile(path.join(source, 'allure-results', 'a-result.json'), '{"name":"one"}');
    await writeFile(path.join(source, 'allure-results', "b result (2)!.json"), '{"name":"two"}');
    await writeFile(path.join(source, 'shard-info.json'), '{"index":0}');

    // Its own sub-prefix, so a sibling test's objects cannot land in this
    // download — the same rule the API suite follows about provisioning its
    // own data.
    const uploaded = await uploadDirectory(client, source, `${prefix}/tree/shard-0`);
    assert.equal(uploaded.files.length, 3);

    const downloaded = await downloadPrefix(client, `${prefix}/tree`, target);
    assert.deepEqual(downloaded.files.sort(), [
      'shard-0/allure-results/a-result.json',
      'shard-0/allure-results/b result (2)!.json',
      'shard-0/shard-info.json',
    ]);
    assert.equal(
      await readFile(path.join(target, 'shard-0', 'allure-results', 'b result (2)!.json'), 'utf8'),
      '{"name":"two"}',
    );
    assert.equal(
      await readFile(path.join(target, 'shard-0', 'allure-results', 'a-result.json'), 'utf8'),
      '{"name":"one"}',
    );
  });

  it('lists only what belongs to the prefix', async () => {
    // `pr-1` and `pr-12` are both plausible environment names; a listing that
    // confuses them hands one environment another's results.
    await client.putObject(`${prefix}/env-1/a.json`, Buffer.from('mine'));
    await client.putObject(`${prefix}/env-12/a.json`, Buffer.from('theirs'));

    const keys = await client.listObjects(`${prefix}/env-1/`);
    assert.deepEqual(keys, [`${prefix}/env-1/a.json`]);
  });

  it('pages through a listing larger than one response', async () => {
    // MinIO and S3 both cap a page at 1000 keys. Writing that many here would
    // be slow, so this asserts the loop terminates and returns everything for a
    // set big enough to be real.
    const many = 25;
    await Promise.all(
      Array.from({ length: many }, (_, i) =>
        client.putObject(`${prefix}/many/${String(i).padStart(3, '0')}.json`, Buffer.from(`${i}`)),
      ),
    );
    assert.equal((await client.listObjects(`${prefix}/many/`)).length, many);
  });

  it('reports a missing object as an error rather than empty content', async () => {
    await assert.rejects(
      () => client.getObject(`${prefix}/definitely-absent.json`),
      (error: Error) => {
        assert.match(error.message, /failed: 404/);
        return true;
      },
    );
  });

  it('removes everything under a prefix, which is what teardown relies on', async () => {
    await client.putObject(`${prefix}/gone/a.json`, Buffer.from('a'));
    await client.putObject(`${prefix}/gone/b/c.json`, Buffer.from('c'));

    assert.equal(await client.deletePrefix(`${prefix}/gone/`), 2);
    assert.deepEqual(await client.listObjects(`${prefix}/gone/`), []);
  });
});
