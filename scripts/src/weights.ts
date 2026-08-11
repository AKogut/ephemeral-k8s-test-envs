/**
 * Turning a finished run into the weights the shard planner reads.
 *
 * `tests/api/test-weights.json` decides how files are distributed, and until now
 * the numbers in it were typed by hand. Nothing measured them and nothing
 * noticed when they stopped being true — the planner falls back to the median
 * for a file it has not seen, so a new spec is simply assumed average and the
 * balance drifts down run by run with no symptom other than the run taking
 * longer than it should.
 *
 * The file's own comment told readers to run `npm run weights:update`. That
 * script did not exist. This is it.
 */

import type { AllureTestResult } from './aggregate.js';

/**
 * The spec file a result belongs to.
 *
 * Playwright's Allure reporter writes `fullName` as `<file>:<line>:<col>`, and
 * also emits a `suite` label with the same file. `fullName` is preferred because
 * the label is a display concern and has changed shape between reporter
 * versions.
 */
export function specFileOf(result: AllureTestResult): string | undefined {
  const fromFullName = (result.fullName ?? '').split(':')[0];
  if (fromFullName?.endsWith('.spec.ts')) return fromFullName;

  const label = (result.labels ?? []).find((l) => l.name === 'suite')?.value;
  return label?.endsWith('.spec.ts') ? label : undefined;
}

export interface RunSpan {
  earliest: number;
  latest: number;
  spanMs: number;
}

/**
 * The wall-clock window the results cover.
 *
 * Used to refuse input that cannot be a single run. Results accumulate if a
 * download directory is reused, and weights derived from several runs at once
 * are inflated by however many runs happened to be in there — a wrong number
 * that looks entirely plausible, which is the kind this project tries hardest
 * not to produce.
 */
export function runSpan(results: readonly AllureTestResult[]): RunSpan | undefined {
  const starts = results.map((r) => r.start).filter((v): v is number => typeof v === 'number');
  const stops = results.map((r) => r.stop).filter((v): v is number => typeof v === 'number');
  if (starts.length === 0 || stops.length === 0) return undefined;

  const earliest = Math.min(...starts);
  const latest = Math.max(...stops);
  return { earliest, latest, spanMs: Math.max(0, latest - earliest) };
}

/**
 * Seconds per spec file, summed across the tests in it.
 *
 * Additive on purpose: the planner solves a bin-packing problem, which assumes
 * a file's cost adds to whatever shard it lands on. Retries are included —
 * a flaky file genuinely does cost its shard that time.
 */
export function weightsFromResults(results: readonly AllureTestResult[]): Record<string, number> {
  const totals = new Map<string, number>();

  for (const result of results) {
    const spec = specFileOf(result);
    if (spec === undefined) continue;
    if (typeof result.start !== 'number' || typeof result.stop !== 'number') continue;

    const seconds = Math.max(0, result.stop - result.start) / 1000;
    totals.set(spec, (totals.get(spec) ?? 0) + seconds);
  }

  const weights: Record<string, number> = {};
  for (const spec of [...totals.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    // Two decimals: the planner is robust to small errors, and more precision
    // would make every regeneration a diff.
    weights[spec] = Math.round((totals.get(spec) ?? 0) * 100) / 100;
  }
  return weights;
}

/**
 * Moves the stored weights towards the measured ones.
 *
 * A single run on a loaded runner is noisy, and taking it whole would swing the
 * plan for no good reason. `alpha` is how much of the new measurement to keep:
 * 1 replaces, 0 changes nothing.
 *
 * Files absent from the measurement keep their stored weight rather than being
 * dropped — a run that skipped a file says nothing about how long it takes.
 */
export function blendWeights(
  previous: Readonly<Record<string, number>>,
  measured: Readonly<Record<string, number>>,
  alpha: number,
): Record<string, number> {
  if (alpha < 0 || alpha > 1) throw new Error(`alpha must be between 0 and 1, got ${alpha}`);

  const blended: Record<string, number> = {};
  for (const spec of [...new Set([...Object.keys(previous), ...Object.keys(measured)])].sort((a, b) =>
    a.localeCompare(b, 'en'),
  )) {
    const before = previous[spec];
    const now = measured[spec];

    if (now === undefined) blended[spec] = before!;
    else if (before === undefined) blended[spec] = now;
    else blended[spec] = Math.round((before * (1 - alpha) + now * alpha) * 100) / 100;
  }
  return blended;
}

export interface WeightChange {
  spec: string;
  before?: number;
  after: number;
  /** Percentage change, undefined for a file that had no stored weight. */
  driftPercent?: number;
}

/** What changed, for a human to read before committing it. */
export function describeChanges(
  previous: Readonly<Record<string, number>>,
  next: Readonly<Record<string, number>>,
): WeightChange[] {
  return Object.keys(next)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((spec) => {
      const before = previous[spec];
      const after = next[spec]!;
      return before === undefined || before === 0
        ? { spec, before, after }
        : { spec, before, after, driftPercent: Math.round(((after - before) / before) * 1000) / 10 };
    });
}
