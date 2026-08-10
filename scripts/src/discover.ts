import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Finds spec files under `root`.
 *
 * `readdir({recursive:true})` keeps this dependency-free, but its ordering is
 * filesystem-defined — the sort is what makes discovery reproducible across the
 * developer's macOS laptop and the shard pods' Linux filesystem.
 */
export async function discoverSpecs(root: string, suffix = '.spec.ts'): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => {
      const absolute = path.join(entry.parentPath ?? root, entry.name);
      return path.relative(root, absolute);
    })
    .map((relative) => relative.split(path.sep).join('/'))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Loads a `{ "specs/foo.spec.ts": 12.5 }` weight table.
 *
 * A missing or unreadable file is not an error: weights are an optimisation, and
 * a run that cannot read them should still shard (evenly by count) rather than
 * fail. Malformed *content*, on the other hand, is a real mistake worth surfacing.
 */
export async function loadWeights(
  weightsPath: string | undefined,
): Promise<{ weights: Record<string, number>; source: string }> {
  if (!weightsPath) return { weights: {}, source: 'none (equal weights)' };

  let raw: string;
  try {
    raw = await readFile(weightsPath, 'utf8');
  } catch {
    return { weights: {}, source: `${weightsPath} (not found — falling back to equal weights)` };
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Weights file ${weightsPath} must contain a JSON object of path -> seconds`);
  }

  const weights: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // JSON has no comments, so keys starting with "_" are treated as prose.
    if (key.startsWith('_')) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Weight for "${key}" in ${weightsPath} must be a positive number`);
    }
    weights[key] = value;
  }

  return { weights, source: weightsPath };
}
