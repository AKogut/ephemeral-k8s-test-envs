import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { discoverSpecs, loadWeights } from './discover.js';

const created: string[] = [];

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'shard-fixture-'));
  created.push(dir);
  return dir;
}

after(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('discoverSpecs', () => {
  it('finds spec files recursively and returns sorted, POSIX-style relative paths', async () => {
    const dir = await fixtureDir();
    await mkdir(path.join(dir, 'nested', 'deeper'), { recursive: true });
    await writeFile(path.join(dir, 'b.spec.ts'), '');
    await writeFile(path.join(dir, 'a.spec.ts'), '');
    await writeFile(path.join(dir, 'nested', 'c.spec.ts'), '');
    await writeFile(path.join(dir, 'nested', 'deeper', 'd.spec.ts'), '');

    assert.deepEqual(await discoverSpecs(dir), [
      'a.spec.ts',
      'b.spec.ts',
      'nested/c.spec.ts',
      'nested/deeper/d.spec.ts',
    ]);
  });

  it('ignores files that do not carry the suffix', async () => {
    const dir = await fixtureDir();
    await writeFile(path.join(dir, 'real.spec.ts'), '');
    await writeFile(path.join(dir, 'helper.ts'), '');
    await writeFile(path.join(dir, 'notes.md'), '');

    assert.deepEqual(await discoverSpecs(dir), ['real.spec.ts']);
  });

  it('honours a custom suffix', async () => {
    const dir = await fixtureDir();
    await writeFile(path.join(dir, 'a.test.ts'), '');
    await writeFile(path.join(dir, 'b.spec.ts'), '');

    assert.deepEqual(await discoverSpecs(dir, '.test.ts'), ['a.test.ts']);
  });

  it('returns an empty list for a directory with no specs', async () => {
    assert.deepEqual(await discoverSpecs(await fixtureDir()), []);
  });
});

describe('loadWeights', () => {
  it('returns empty weights when no path is supplied', async () => {
    const { weights } = await loadWeights(undefined);
    assert.deepEqual(weights, {});
  });

  it('falls back to equal weights when the file is missing', async () => {
    const { weights, source } = await loadWeights('/nowhere/at/all/weights.json');
    assert.deepEqual(weights, {});
    assert.match(source, /not found/);
  });

  it('reads a valid weight table', async () => {
    const dir = await fixtureDir();
    const file = path.join(dir, 'weights.json');
    await writeFile(file, JSON.stringify({ 'a.spec.ts': 1.5, 'b.spec.ts': 9 }));

    const { weights } = await loadWeights(file);
    assert.deepEqual(weights, { 'a.spec.ts': 1.5, 'b.spec.ts': 9 });
  });

  it('skips underscore-prefixed keys so the file can carry a comment', async () => {
    const dir = await fixtureDir();
    const file = path.join(dir, 'weights.json');
    await writeFile(file, JSON.stringify({ _comment: 'regenerate with npm run weights:update', 'a.spec.ts': 2 }));

    const { weights } = await loadWeights(file);
    assert.deepEqual(weights, { 'a.spec.ts': 2 });
  });

  it('rejects a non-numeric weight rather than silently ignoring it', async () => {
    const dir = await fixtureDir();
    const file = path.join(dir, 'weights.json');
    await writeFile(file, JSON.stringify({ 'a.spec.ts': 'fast' }));

    await assert.rejects(() => loadWeights(file), /must be a positive number/);
  });

  it('rejects a JSON array', async () => {
    const dir = await fixtureDir();
    const file = path.join(dir, 'weights.json');
    await writeFile(file, JSON.stringify([1, 2, 3]));

    await assert.rejects(() => loadWeights(file), /must contain a JSON object/);
  });
});
