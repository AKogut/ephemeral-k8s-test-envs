import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyWeights,
  DEFAULT_WEIGHT,
  formatPlan,
  planShards,
  selectShard,
  ShardingError,
  type ShardablePath,
} from './sharding.js';

const equalWeight = (paths: readonly string[]): ShardablePath[] =>
  paths.map((path) => ({ path, weight: DEFAULT_WEIGHT }));

const specs = (count: number): string[] =>
  Array.from({ length: count }, (_unused, i) => `specs/test-${String(i).padStart(2, '0')}.spec.ts`);

/** Deterministic shuffle so "order does not matter" is tested without randomness. */
function permute<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const allFiles = (plan: ReturnType<typeof planShards>): string[] =>
  plan.shards.flatMap((shard) => shard.files);

describe('planShards — completeness', () => {
  it('assigns every file exactly once, with no omissions or duplicates', () => {
    const files = specs(23);
    const plan = planShards(equalWeight(files), 4);
    const assigned = allFiles(plan);

    assert.equal(assigned.length, files.length, 'file count must be preserved');
    assert.deepEqual([...assigned].sort(), [...files].sort(), 'the same files must come back out');
    assert.equal(new Set(assigned).size, files.length, 'no file may appear twice');
  });

  it('handles more shards than files by leaving the extra shards empty', () => {
    const plan = planShards(equalWeight(specs(3)), 8);

    assert.equal(plan.shards.length, 8);
    assert.equal(allFiles(plan).length, 3);
    assert.equal(plan.shards.filter((shard) => shard.files.length === 0).length, 5);
  });

  it('supports a single shard holding the whole suite', () => {
    const plan = planShards(equalWeight(specs(7)), 1);
    assert.equal(plan.shards[0]!.files.length, 7);
  });

  it('accepts an empty suite without throwing', () => {
    const plan = planShards([], 3);
    assert.equal(allFiles(plan).length, 0);
    assert.equal(plan.makespan, 0);
    assert.equal(plan.balancePercent, 100);
  });
});

describe('planShards — determinism', () => {
  it('produces an identical plan regardless of input ordering', () => {
    const files = equalWeight(specs(17));
    const baseline = JSON.stringify(planShards(files, 5).shards);

    for (const seed of [1, 42, 9001, 123456]) {
      const shuffled = planShards(permute(files, seed), 5);
      assert.equal(
        JSON.stringify(shuffled.shards),
        baseline,
        `plan changed for input permutation seeded with ${seed}`,
      );
    }
  });

  it('produces an identical plan when weights tie', () => {
    const tied: ShardablePath[] = [
      { path: 'b.spec.ts', weight: 5 },
      { path: 'a.spec.ts', weight: 5 },
      { path: 'c.spec.ts', weight: 5 },
    ];
    const first = planShards(tied, 2);
    const second = planShards(permute(tied, 7), 2);
    assert.deepEqual(first.shards, second.shards);
  });

  it('is stable across repeated calls — every shard pod must derive the same slice', () => {
    const files = equalWeight(specs(11));
    for (let index = 0; index < 4; index += 1) {
      const fromPodA = selectShard(planShards(files, 4), index);
      const fromPodB = selectShard(planShards(permute(files, index + 1), 4), index);
      assert.deepEqual(fromPodA.files, fromPodB.files);
    }
  });
});

describe('planShards — balance', () => {
  it('keeps equally weighted shards within one file of each other', () => {
    const plan = planShards(equalWeight(specs(10)), 4);
    const sizes = plan.shards.map((shard) => shard.files.length);
    assert.ok(
      Math.max(...sizes) - Math.min(...sizes) <= 1,
      `sizes ${JSON.stringify(sizes)} differ by more than one`,
    );
  });

  it('beats round-robin when one file dominates the suite', () => {
    // 1 heavy file + 6 light ones. Round-robin by name would put the heavy file
    // together with two light ones; LPT isolates it.
    const files: ShardablePath[] = [
      { path: 'a-heavy.spec.ts', weight: 60 },
      ...specs(6).map((path) => ({ path, weight: 10 })),
    ];

    const plan = planShards(files, 3);
    const roundRobinMakespan = (() => {
      const loads = [0, 0, 0];
      files.forEach((file, i) => {
        loads[i % 3] = loads[i % 3]! + file.weight;
      });
      return Math.max(...loads);
    })();

    assert.ok(
      plan.makespan < roundRobinMakespan,
      `LPT makespan ${plan.makespan} should beat round-robin ${roundRobinMakespan}`,
    );
    assert.deepEqual(
      plan.shards.find((shard) => shard.files.includes('a-heavy.spec.ts'))!.files,
      ['a-heavy.spec.ts'],
      'the dominant file should get a shard to itself',
    );
  });

  it('stays within the LPT bound of 4/3 - 1/(3k) of optimal', () => {
    const weights = [8, 7, 6, 5, 4, 3, 2, 2, 1, 1];
    const k = 3;
    const files = weights.map((weight, i) => ({ path: `s${i}.spec.ts`, weight }));
    const plan = planShards(files, k);

    const total = weights.reduce((a, b) => a + b, 0);
    // Optimal is at least the larger of the average load and the heaviest file.
    const optimalLowerBound = Math.max(total / k, Math.max(...weights));
    const bound = (4 / 3 - 1 / (3 * k)) * optimalLowerBound;

    assert.ok(plan.makespan <= bound, `makespan ${plan.makespan} exceeded LPT bound ${bound}`);
  });

  it('reports balance as 100% for a perfectly even split', () => {
    const plan = planShards(equalWeight(specs(8)), 4);
    assert.equal(plan.balancePercent, 100);
    assert.equal(plan.idealWeight, 2);
  });
});

describe('planShards — input validation', () => {
  it('rejects a non-positive shard count', () => {
    for (const total of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => planShards(equalWeight(specs(3)), total), ShardingError);
    }
  });

  it('rejects duplicate paths rather than silently running a file twice', () => {
    assert.throws(
      () => planShards([{ path: 'a.spec.ts', weight: 1 }, { path: 'a.spec.ts', weight: 1 }], 2),
      /Duplicate test file/,
    );
  });

  it('rejects non-positive or non-finite weights', () => {
    for (const weight of [0, -3, Number.POSITIVE_INFINITY, Number.NaN]) {
      assert.throws(() => planShards([{ path: 'a.spec.ts', weight }], 1), /must be a finite positive number/);
    }
  });
});

describe('selectShard', () => {
  it('returns the requested shard', () => {
    const plan = planShards(equalWeight(specs(6)), 3);
    assert.equal(selectShard(plan, 2).index, 2);
  });

  it('rejects an out-of-range index', () => {
    const plan = planShards(equalWeight(specs(6)), 3);
    for (const index of [-1, 3, 99, 1.5]) {
      assert.throws(() => selectShard(plan, index), /out of range/);
    }
  });
});

describe('applyWeights', () => {
  it('uses the supplied weight when one exists', () => {
    const weighted = applyWeights(['a.spec.ts'], { 'a.spec.ts': 12.5 });
    assert.equal(weighted[0]!.weight, 12.5);
  });

  it('falls back to the median of known weights for unlisted files', () => {
    // Known weights 2, 10, 30 -> median 10. A new file should not be treated as
    // the cheapest in the suite.
    const weighted = applyWeights(['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'new.spec.ts'], {
      'a.spec.ts': 2,
      'b.spec.ts': 10,
      'c.spec.ts': 30,
    });
    assert.equal(weighted.find((w) => w.path === 'new.spec.ts')!.weight, 10);
  });

  it('falls back to equal weights when no table is supplied', () => {
    const weighted = applyWeights(['a.spec.ts', 'b.spec.ts']);
    assert.deepEqual(
      weighted.map((w) => w.weight),
      [DEFAULT_WEIGHT, DEFAULT_WEIGHT],
    );
  });

  it('ignores invalid weight entries instead of trusting them', () => {
    const weighted = applyWeights(['a.spec.ts'], { 'a.spec.ts': -5 } as Record<string, number>);
    assert.equal(weighted[0]!.weight, DEFAULT_WEIGHT);
  });
});

describe('formatPlan', () => {
  it('lists every shard and flags empty ones', () => {
    const output = formatPlan(planShards(equalWeight(specs(2)), 3));
    assert.match(output, /shard 0:/);
    assert.match(output, /shard 2:/);
    assert.match(output, /no files/);
  });
});
