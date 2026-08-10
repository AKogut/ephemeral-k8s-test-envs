/**
 * Deterministic test sharding.
 *
 * Every shard pod runs this same function over the same inputs and derives its
 * own slice from `JOB_COMPLETION_INDEX`. Nothing is coordinated at runtime:
 * there is no queue, no leader and no shared state, so a pod that is restarted
 * by Kubernetes recomputes exactly the slice it had before.
 *
 * The split is LPT (longest-processing-time-first) greedy bin packing rather
 * than round-robin. Round-robin balances the *number* of files per shard, which
 * is only a good proxy for duration when every file costs the same. What
 * actually matters is makespan — the slowest shard — because the aggregator
 * cannot start until the last shard finishes. LPT is guaranteed to land within
 * 4/3 - 1/(3k) of the optimal makespan, and in practice it turns a suite where
 * one file dominates into shards that finish within a few seconds of each other.
 *
 * See docs/sharding-strategy.md for the worked example.
 */

export interface ShardablePath {
  /** Repo-relative path, used as the stable identity of the test file. */
  path: string;
  /** Relative cost. Any positive unit works as long as it is used consistently. */
  weight: number;
}

export interface Shard {
  index: number;
  files: string[];
  weight: number;
}

export interface ShardPlan {
  total: number;
  shards: Shard[];
  /** Weight of the heaviest shard: the lower bound on wall-clock for the run. */
  makespan: number;
  /** Perfectly even split, for reporting how close the plan got. */
  idealWeight: number;
  balancePercent: number;
}

export class ShardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShardingError';
  }
}

export const DEFAULT_WEIGHT = 1;

/**
 * Applies a weight table to a list of files.
 *
 * Files missing from the table fall back to the median of the known weights, not
 * to 1. A brand-new spec file is far more likely to cost about as much as its
 * neighbours than to be the cheapest file in the suite, and guessing "1" would
 * pile every new file onto one shard.
 */
export function applyWeights(
  files: readonly string[],
  weights: Readonly<Record<string, number>> = {},
): ShardablePath[] {
  const known = files
    .map((file) => weights[file])
    .filter((weight): weight is number => typeof weight === 'number' && weight > 0)
    .sort((a, b) => a - b);

  const fallback = known.length === 0 ? DEFAULT_WEIGHT : (known[Math.floor(known.length / 2)] ?? DEFAULT_WEIGHT);

  return files.map((file) => {
    const weight = weights[file];
    return {
      path: file,
      weight: typeof weight === 'number' && weight > 0 ? weight : fallback,
    };
  });
}

/**
 * Splits files across `total` shards.
 *
 * Determinism comes from two places: the input is sorted by (weight desc, path
 * asc) before packing, and ties between equally-loaded shards always resolve to
 * the lowest index. Filesystem ordering therefore cannot change the plan.
 */
export function planShards(files: readonly ShardablePath[], total: number): ShardPlan {
  if (!Number.isInteger(total) || total < 1) {
    throw new ShardingError(`Shard count must be a positive integer, received ${total}`);
  }

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new ShardingError(`Duplicate test file in input: ${file.path}`);
    }
    if (!(file.weight > 0) || !Number.isFinite(file.weight)) {
      throw new ShardingError(`Weight for ${file.path} must be a finite positive number`);
    }
    seen.add(file.path);
  }

  const shards: Shard[] = Array.from({ length: total }, (_unused, index) => ({
    index,
    files: [],
    weight: 0,
  }));

  const ordered = [...files].sort(
    (a, b) => b.weight - a.weight || a.path.localeCompare(b.path, 'en'),
  );

  for (const file of ordered) {
    let target = shards[0]!;
    for (const shard of shards) {
      if (shard.weight < target.weight) target = shard;
    }
    target.files.push(file.path);
    target.weight += file.weight;
  }

  // Files inside a shard are sorted so the runner's output ordering is stable.
  for (const shard of shards) shard.files.sort((a, b) => a.localeCompare(b, 'en'));

  const totalWeight = files.reduce((sum, file) => sum + file.weight, 0);
  const makespan = shards.reduce((max, shard) => Math.max(max, shard.weight), 0);
  const idealWeight = totalWeight / total;

  return {
    total,
    shards,
    makespan,
    idealWeight,
    // 100% means a perfectly even split; lower means the slowest shard is
    // carrying more than its share.
    balancePercent: makespan === 0 ? 100 : Math.round((idealWeight / makespan) * 1000) / 10,
  };
}

export function selectShard(plan: ShardPlan, index: number): Shard {
  if (!Number.isInteger(index) || index < 0 || index >= plan.total) {
    throw new ShardingError(
      `Shard index ${index} is out of range for a plan with ${plan.total} shards`,
    );
  }
  return plan.shards[index]!;
}

/** Human-readable plan summary for CI logs. */
export function formatPlan(plan: ShardPlan): string {
  const lines = [
    `Shard plan: ${plan.shards.reduce((n, s) => n + s.files.length, 0)} files across ${plan.total} shards`,
    `Ideal weight per shard: ${plan.idealWeight.toFixed(2)} | makespan: ${plan.makespan.toFixed(2)} | balance: ${plan.balancePercent}%`,
    '',
  ];

  for (const shard of plan.shards) {
    lines.push(
      `  shard ${shard.index}: ${shard.files.length} file(s), weight ${shard.weight.toFixed(2)}`,
    );
    for (const file of shard.files) lines.push(`      - ${file}`);
    if (shard.files.length === 0) lines.push('      (no files — this shard will exit successfully)');
  }

  return lines.join('\n');
}
