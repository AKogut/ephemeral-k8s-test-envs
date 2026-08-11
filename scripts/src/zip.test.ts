import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { extractFile, listEntries, readEntry } from './zip.js';

/**
 * A real archive, made by the `zip` utility rather than by this file.
 *
 * A fixture built with the same assumptions as the reader would only prove the
 * two agree with each other. This one contains a directory entry, a deflated
 * file and a stored one — the three shapes an artifact actually arrives in.
 */
const FIXTURE = Buffer.from(
  'UEsDBAoAAAAAACKaC10AAAAAAAAAAAAAAAAHABwAbWVyZ2VkL1VUCQADEFl7ahBZe2p1eAsAAQT1' +
  'AQAABAAAAABQSwMEFAAAAAgAIpoLXY4ORpczAAAASAAAABMAHABtZXJnZWQvc3VtbWFyeS5qc29u' +
  'VVQJAAMQWXtqEFl7anV4CwABBPUBAAAEAAAAAKtWKs5ILEopVrKKrlbKzEtJrVCyMtBRSiktSizJ' +
  'zM/zBUoYGhgY1OrAZQ1RZY1BsrG1AFBLAwQKAAAAAAAimgtd5CTCnRQAAAAUAAAACQAcAHBsYWlu' +
  'LnR4dFVUCQADEFl7ahBZe2p1eAsAAQT1AQAABAAAAABzdG9yZWQtZW50cnktY29udGVudFBLAQIe' +
  'AwoAAAAAACKaC10AAAAAAAAAAAAAAAAHABgAAAAAAAAAEADtQQAAAABtZXJnZWQvVVQFAAMQWXtq' +
  'dXgLAAEE9QEAAAQAAAAAUEsBAh4DFAAAAAgAIpoLXY4ORpczAAAASAAAABMAGAAAAAAAAQAAAKSB' +
  'QQAAAG1lcmdlZC9zdW1tYXJ5Lmpzb25VVAUAAxBZe2p1eAsAAQT1AQAABAAAAABQSwECHgMKAAAA' +
  'AAAimgtd5CTCnRQAAAAUAAAACQAYAAAAAAAAAAAApIHBAAAAcGxhaW4udHh0VVQFAAMQWXtqdXgL' +
  'AAEE9QEAAAQAAAAAUEsFBgAAAAADAAMA9QAAABgBAAAAAA==',
  'base64',
);

describe('listEntries', () => {
  it('reads the index of an archive written by something else', () => {
    const names = listEntries(FIXTURE).map((entry) => entry.name);
    assert.ok(names.includes('merged/summary.json'), names.join(', '));
    assert.ok(names.includes('plain.txt'), names.join(', '));
  });

  it('refuses a buffer that is not a zip', () => {
    assert.throws(
      () => listEntries(Buffer.alloc(200)),
      /no end-of-central-directory record/,
    );
  });

  it('refuses zip64 rather than misreading its sentinels', () => {
    // The real sizes live in another record entirely; reading 0xFFFFFFFF as an
    // offset would produce an archive that parses and lies.
    const buffer = Buffer.from(FIXTURE);
    const eocd = buffer.length - 22;
    buffer.writeUInt32LE(0xffffffff, eocd + 16);
    assert.throws(() => listEntries(buffer), /zip64/);
  });

  it('refuses a central directory that does not start where it says', () => {
    const buffer = Buffer.from(FIXTURE);
    buffer.writeUInt32LE(buffer.length - 40, buffer.length - 22 + 16);
    assert.throws(() => listEntries(buffer), /corrupt central directory/);
  });
});

describe('readEntry', () => {
  it('inflates a deflated entry', () => {
    const entry = listEntries(FIXTURE).find((e) => e.name === 'merged/summary.json')!;
    const parsed = JSON.parse(readEntry(FIXTURE, entry).toString('utf8')) as {
      shards: { durationMs: number }[];
    };
    assert.deepEqual(
      parsed.shards.map((shard) => shard.durationMs),
      [1000, 3000],
    );
  });

  it('copies a stored entry', () => {
    const entry = listEntries(FIXTURE).find((e) => e.name === 'plain.txt')!;
    assert.equal(readEntry(FIXTURE, entry).toString('utf8'), 'stored-entry-content');
  });

  it('refuses a local header that is not one', () => {
    const entry = listEntries(FIXTURE).find((e) => e.name === 'plain.txt')!;
    assert.throws(
      () => readEntry(FIXTURE, { ...entry, localHeaderOffset: 4 }),
      /corrupt local header/,
    );
  });

  it('refuses a compression method it does not implement', () => {
    const entry = listEntries(FIXTURE).find((e) => e.name === 'plain.txt')!;
    assert.throws(
      () => readEntry(FIXTURE, { ...entry, method: 14 }),
      /unsupported compression method 14/,
    );
  });

  it('reads data past a local extra field, not where the index would suggest', () => {
    // The local header carries its own name and extra lengths, and they are
    // not the central directory's. Trusting the wrong one reads garbage that
    // still inflates on a bad day.
    const payload = deflateRawSync(Buffer.from('past the extra field'));
    const name = Buffer.from('x.txt');
    const extra = Buffer.alloc(9, 0x41);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);

    const buffer = Buffer.concat([local, name, extra, payload]);
    assert.equal(
      readEntry(buffer, {
        name: 'x.txt',
        method: 8,
        compressedSize: payload.length,
        uncompressedSize: 20,
        localHeaderOffset: 0,
      }).toString('utf8'),
      'past the extra field',
    );
  });
});

describe('extractFile', () => {
  it('finds a file by name', () => {
    assert.match(extractFile(FIXTURE, 'merged/summary.json')!.toString('utf8'), /durationMs/);
  });

  it('is undefined for a file the archive does not have', () => {
    assert.equal(extractFile(FIXTURE, 'merged/nothing.json'), undefined);
  });
});
