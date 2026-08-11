import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { S3Client } from './s3.js';
import {
  contentTypeFor,
  downloadPrefix,
  environmentPrefix,
  listFiles,
  uploadDirectory,
} from './sync.js';

/**
 * A bucket in a Map.
 *
 * The signing and request layer is covered against AWS's own vectors in
 * s3.test.ts; what matters here is which files move and where they land, so the
 * transport is replaced entirely.
 */
function fakeBucket(initial: Record<string, string> = {}): {
  client: S3Client;
  objects: Map<string, Buffer>;
  puts: Array<{ key: string; contentType: string }>;
  deleted: string[];
} {
  const objects = new Map<string, Buffer>(
    Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]),
  );
  const puts: Array<{ key: string; contentType: string }> = [];
  const deleted: string[] = [];

  const client = {
    putObject(key: string, body: Uint8Array, contentType = 'application/octet-stream') {
      objects.set(key, Buffer.from(body));
      puts.push({ key, contentType });
      return Promise.resolve();
    },
    getObject(key: string) {
      const value = objects.get(key);
      if (!value) return Promise.reject(new Error(`no such key: ${key}`));
      return Promise.resolve(value);
    },
    listObjects(prefix: string) {
      return Promise.resolve([...objects.keys()].filter((k) => k.startsWith(prefix)).sort());
    },
    deleteObject(key: string) {
      objects.delete(key);
      deleted.push(key);
      return Promise.resolve();
    },
    deletePrefix(prefix: string) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      for (const key of keys) {
        objects.delete(key);
        deleted.push(key);
      }
      return Promise.resolve(keys.length);
    },
  } as unknown as S3Client;

  return { client, objects, puts, deleted };
}

async function tempTree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sync-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

describe('contentTypeFor', () => {
  it('names the types a report is made of', () => {
    assert.equal(contentTypeFor('a/b/result.json'), 'application/json');
    assert.equal(contentTypeFor('summary.md'), 'text/markdown');
    assert.equal(contentTypeFor('results.xml'), 'application/xml');
    assert.equal(contentTypeFor('index.html'), 'text/html');
  });

  it('is case insensitive about the extension', () => {
    assert.equal(contentTypeFor('RESULT.JSON'), 'application/json');
  });

  it('falls back to bytes for anything else', () => {
    assert.equal(contentTypeFor('screenshot.png'), 'application/octet-stream');
    assert.equal(contentTypeFor('no-extension'), 'application/octet-stream');
  });
});

describe('listFiles', () => {
  it('walks nested directories and returns paths relative to the root', async () => {
    const dir = await tempTree({
      'allure-results/a.json': '1',
      'allure-results/nested/b.json': '2',
      'shard-info.json': '3',
    });
    try {
      assert.deepEqual(await listFiles(dir), [
        'allure-results/a.json',
        'allure-results/nested/b.json',
        'shard-info.json',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is deterministic regardless of how the filesystem orders entries', async () => {
    const dir = await tempTree({ 'c.json': '', 'a.json': '', 'b.json': '' });
    try {
      assert.deepEqual(await listFiles(dir), ['a.json', 'b.json', 'c.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns nothing for a directory that does not exist', async () => {
    // A shard that crashed before writing anything. The aggregator reports that
    // on its own terms; here it is simply empty.
    assert.deepEqual(await listFiles(path.join(tmpdir(), 'definitely-not-here-12345')), []);
  });

  it('returns nothing for an empty directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sync-empty-'));
    try {
      assert.deepEqual(await listFiles(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('uploadDirectory', () => {
  it('puts every file under the prefix, keeping the tree', async () => {
    const dir = await tempTree({
      'allure-results/a.json': '{"a":1}',
      'shard-info.json': '{"index":0}',
    });
    const bucket = fakeBucket();
    try {
      const result = await uploadDirectory(bucket.client, dir, 'pr-1/shard-0');

      assert.deepEqual([...bucket.objects.keys()].sort(), [
        'pr-1/shard-0/allure-results/a.json',
        'pr-1/shard-0/shard-info.json',
      ]);
      assert.deepEqual(result.files, ['allure-results/a.json', 'shard-info.json']);
      assert.equal(result.bytes, 7 + 11);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('labels JSON as JSON, so the bucket is browsable', async () => {
    const dir = await tempTree({ 'a.json': '{}', 'b.bin': 'x' });
    const bucket = fakeBucket();
    try {
      await uploadDirectory(bucket.client, dir, 'p');
      assert.equal(bucket.puts.find((p) => p.key.endsWith('a.json'))?.contentType, 'application/json');
      assert.equal(bucket.puts.find((p) => p.key.endsWith('b.bin'))?.contentType, 'application/octet-stream');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uploads nothing, and does not throw, for a shard that produced nothing', async () => {
    const bucket = fakeBucket();
    const result = await uploadDirectory(bucket.client, path.join(tmpdir(), 'missing-99999'), 'p');
    assert.deepEqual(result.files, []);
    assert.equal(bucket.objects.size, 0);
  });
});

describe('downloadPrefix', () => {
  it('reproduces the layout the aggregator expects from a volume', async () => {
    const bucket = fakeBucket({
      'pr-1/shard-0/allure-results/a.json': '{"a":1}',
      'pr-1/shard-1/allure-results/b.json': '{"b":2}',
      'pr-1/shard-1/shard-info.json': '{"index":1}',
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'sync-dl-'));
    try {
      const result = await downloadPrefix(bucket.client, 'pr-1', dir);

      assert.deepEqual(result.files.sort(), [
        'shard-0/allure-results/a.json',
        'shard-1/allure-results/b.json',
        'shard-1/shard-info.json',
      ]);
      assert.equal(
        await readFile(path.join(dir, 'shard-0/allure-results/a.json'), 'utf8'),
        '{"a":1}',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts a prefix with or without a trailing slash', async () => {
    const bucket = fakeBucket({ 'pr-1/shard-0/a.json': 'x' });
    const dir = await mkdtemp(path.join(tmpdir(), 'sync-dl-'));
    try {
      assert.deepEqual((await downloadPrefix(bucket.client, 'pr-1/', dir)).files, ['shard-0/a.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not confuse a prefix with one that merely starts the same way', async () => {
    // `pr-1` and `pr-12` are both plausible environment names, and a listing by
    // raw prefix would hand one environment the other's results.
    const bucket = fakeBucket({
      'pr-1/shard-0/a.json': 'mine',
      'pr-12/shard-0/a.json': 'theirs',
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'sync-dl-'));
    try {
      const result = await downloadPrefix(bucket.client, 'pr-1', dir);
      assert.deepEqual(result.files, ['shard-0/a.json']);
      assert.equal(await readFile(path.join(dir, 'shard-0/a.json'), 'utf8'), 'mine');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write outside the target directory', async () => {
    // Not reachable through a correct listing, but a key that escapes the
    // directory is not a failure mode worth leaving open.
    const bucket = fakeBucket({
      'pr-1/../../escaped.json': 'no',
      'pr-1/ok.json': 'yes',
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'sync-dl-'));
    try {
      const result = await downloadPrefix(bucket.client, 'pr-1', dir);
      assert.deepEqual(result.files, ['ok.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns nothing when the environment wrote nothing', async () => {
    const bucket = fakeBucket();
    const dir = await mkdtemp(path.join(tmpdir(), 'sync-dl-'));
    try {
      assert.deepEqual((await downloadPrefix(bucket.client, 'pr-1', dir)).files, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('environmentPrefix', () => {
  it('passes through a normal environment name', () => {
    assert.equal(environmentPrefix('pr-123'), 'pr-123');
    assert.equal(environmentPrefix('run-31398412327'), 'run-31398412327');
  });

  it('replaces anything that would change the key structure', () => {
    // A slash would silently nest one environment inside another's prefix,
    // which is how a teardown check starts reporting success for the wrong set.
    assert.equal(environmentPrefix('pr/123'), 'pr-123');
    assert.equal(environmentPrefix('a b'), 'a-b');
  });

  it('does not leave traversal sequences in the prefix', () => {
    assert.equal(environmentPrefix('../etc'), 'etc');
    assert.equal(environmentPrefix('pr-1/../pr-2'), 'pr-1-.-pr-2');
  });

  it('rejects a name with nothing usable left', () => {
    // Not merely "non-empty": `///` reduces to separators, which would become a
    // prefix that names nothing and collides with the next such id.
    assert.throws(() => environmentPrefix(''), /no usable characters/);
    assert.throws(() => environmentPrefix('///'), /no usable characters/);
    assert.throws(() => environmentPrefix('...'), /no usable characters/);
  });
});
