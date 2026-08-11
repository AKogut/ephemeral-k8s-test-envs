/**
 * Moving a directory tree to and from object storage.
 *
 * Kept apart from `s3.ts` so the protocol (signing, requests) and the policy
 * (which files, under which prefix, what an empty result means) can be tested
 * separately. The filesystem is injected for the same reason: these functions
 * are the ones with a decision in them, and a decision deserves a test that
 * does not need a bucket.
 */

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { S3Client } from './s3.js';

/** Content types worth setting; everything else is bytes. */
const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.html': 'text/html',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Every file under `dir`, as paths relative to it, depth first and sorted. */
export async function listFiles(dir: string): Promise<string[]> {
  const walk = async (current: string, prefix: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      // A shard that produced nothing is a case the aggregator reports on its
      // own terms; here it is simply an empty list.
      return [];
    }

    const files: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        files.push(...(await walk(path.join(current, entry.name), rel)));
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
    return files;
  };

  return walk(dir, '');
}

/**
 * Uploads a directory under a key prefix, returning what was sent.
 *
 * Sequential rather than concurrent: a shard writes a few hundred kilobytes and
 * the aggregator is waiting on the Job, not on the transfer. Concurrency here
 * would buy nothing and add a failure mode where a partial upload looks
 * complete.
 */
export async function uploadDirectory(
  client: S3Client,
  dir: string,
  prefix: string,
): Promise<{ files: string[]; bytes: number }> {
  const files = await listFiles(dir);
  let bytes = 0;

  for (const file of files) {
    const body = await readFile(path.join(dir, file));
    bytes += body.byteLength;
    await client.putObject(`${prefix}/${file}`, body, contentTypeFor(file));
  }

  return { files, bytes };
}

/**
 * Downloads everything under a prefix into a directory, preserving layout.
 *
 * The prefix is stripped from each key, so `pr-1/shard-0/a.json` under prefix
 * `pr-1` lands at `<dir>/shard-0/a.json` — which is the layout the aggregator
 * already knows how to read from a volume.
 */
export async function downloadPrefix(
  client: S3Client,
  prefix: string,
  dir: string,
): Promise<{ files: string[]; bytes: number }> {
  const normalised = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const keys = await client.listObjects(normalised);
  const files: string[] = [];
  let bytes = 0;

  for (const key of keys) {
    const relative = key.slice(normalised.length);
    // A key that does not sit under the prefix cannot happen with a correct
    // listing, but writing it outside `dir` if it did is not a failure mode
    // worth leaving open.
    if (relative === '' || relative.startsWith('/') || relative.split('/').includes('..')) continue;

    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const body = await client.getObject(key);
    await writeFile(target, body);

    files.push(relative);
    bytes += body.byteLength;
  }

  return { files, bytes };
}

/**
 * The prefix one environment owns.
 *
 * Every key an environment writes lives under it, which is what makes cleanup a
 * single call and makes "did this environment leave anything behind" a question
 * with an answer.
 */
export function environmentPrefix(envId: string): string {
  const safe = envId
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');

  // Requiring an alphanumeric rather than merely a non-empty string: `///`
  // reduces to separators only, which would otherwise become a prefix that
  // names nothing and quietly collides with the next such id.
  if (!/[a-zA-Z0-9]/.test(safe)) {
    throw new Error(`environment id "${envId}" contains no usable characters for a key prefix`);
  }
  return safe;
}
