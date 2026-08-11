/**
 * Just enough of the zip format to read one file out of a workflow artifact.
 *
 * The Actions API hands artifacts back as zip, and Node has no zip reader —
 * `node:zlib` speaks deflate but knows nothing about the container. The
 * alternatives were a dependency or shelling out to `unzip`, and this project
 * has already made this call once: it hand-wrote SigV4 rather than pull 15 MB
 * of AWS SDK into two images (ADR 0007). The same reasoning applies to eighty
 * lines of structure parsing.
 *
 * What it does *not* do is as important. This is not a zip library: no
 * encryption, no zip64, no multi-disk archives, no streaming. Each of those is
 * a case it refuses loudly rather than misreads — an artifact this cannot
 * understand should say so, not hand back plausible-looking bytes.
 *
 * Layout, for anyone reading along:
 *
 *   [local header][data] … [central directory entries][end of central directory]
 *
 * The central directory at the end is the index, which is why the file has to
 * be read backwards to be read at all.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The largest a zip comment can be, and therefore how far back the index can hide. */
const MAX_COMMENT = 0xffff;
const EOCD_MIN_SIZE = 22;

const STORED = 0;
const DEFLATED = 8;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the *local* header, which is where the data actually lives. */
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - MAX_COMMENT - EOCD_MIN_SIZE);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('not a zip archive: no end-of-central-directory record');
}

/**
 * The archive's index.
 *
 * Zip64 is refused rather than guessed at: the sentinel values mean the real
 * numbers are in a different record entirely, and reading the sentinels as
 * sizes would produce an archive that parses and lies.
 */
export function listEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error('zip64 archives are not supported');
  }

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }

    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);

    entries.push({
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * One entry's bytes.
 *
 * The local header is read rather than trusted from the index, because its
 * name and extra fields have their own lengths — the data does not begin where
 * the central directory's copy of them would suggest.
 */
export function readEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const header = entry.localHeaderOffset;
  if (buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt local header for ${entry.name}`);
  }

  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === STORED) return Buffer.from(data);
  if (entry.method === DEFLATED) return inflateRawSync(data);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

/** The named file, or undefined if the archive does not contain it. */
export function extractFile(buffer: Buffer, name: string): Buffer | undefined {
  const entry = listEntries(buffer).find((candidate) => candidate.name === name);
  return entry ? readEntry(buffer, entry) : undefined;
}
