/**
 * Turning a history of CI runs into the numbers this project claims.
 *
 * The claim is that environments are cheap and always cleaned up. Both halves
 * are asserted **per run** — `verify-teardown.sh` proves one environment is
 * gone, the summary prints one run's wall clock — and neither has ever been
 * looked at as a series. A guarantee that holds every time is a different
 * thing from one that held the last time anybody checked.
 *
 * What is *not* measured here, and why (#87):
 *
 * There is no persistent cluster. Every environment lives inside a kind
 * cluster on a runner that is destroyed with the job, so a namespace cannot
 * outlive its run and "how many environments exist right now" is always zero.
 * A scheduled namespace-age check would measure nothing and look like
 * observability, which is worse than not having it. The fleet here is the run
 * history, so that is what this reads.
 *
 * Billable minutes are not read either: the `timing` endpoint reports zero for
 * a public repository, because the minutes are free. Wall clock is the honest
 * proxy and it is what appears below.
 */

/** The subset of the Actions API this needs. Named after the API's own fields. */
export interface ApiStep {
  name: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface ApiJob {
  name: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: ApiStep[];
}

export interface ApiRun {
  id: number;
  event: string;
  conclusion: string | null;
  created_at: string;
  head_branch?: string | null;
}

/** The job that stands an environment up and proves it is gone again. */
export const ENVIRONMENT_JOB = 'Deploy, test, aggregate, tear down';
/** The job that makes the third teardown layer fire. Added in #106. */
export const SELF_DESTRUCT_JOB = 'The self-destruct layer fires, and leaves nothing';

const DEPLOY_STEP = 'Deploy the environment';
const TEARDOWN_PROOF_STEP = 'Prove the environment is gone';
/**
 * The last assertion of the self-destruct job. Everything it claims has held
 * by the time this step passes, so it is the one worth reading.
 */
const SELF_DESTRUCT_PROOF_STEP = 'And it left nothing cluster-scoped behind';

function msOf(timestamp: string | null | undefined): number | undefined {
  if (!timestamp) return undefined;
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? undefined : value;
}

function findStep(job: ApiJob | undefined, name: string): ApiStep | undefined {
  return job?.steps?.find((step) => step.name === name);
}

/**
 * How long an environment existed: from the install starting to the proof that
 * it was gone.
 *
 * Not the job's duration, which also covers creating a cluster and building
 * images — those are the pipeline's cost, not the environment's.
 */
export function environmentLifetimeMs(job: ApiJob | undefined): number | undefined {
  const start = msOf(findStep(job, DEPLOY_STEP)?.started_at);
  const end = msOf(findStep(job, TEARDOWN_PROOF_STEP)?.completed_at);
  if (start === undefined || end === undefined) return undefined;
  return Math.max(0, end - start);
}

/**
 * `unproven` is the one that took real data to find.
 *
 * The first scheduled run went red on "1 run(s) failed to prove the
 * self-destruct layer fires". True at the job level, and misleading: that job
 * died on `docker pull … denied: denied` before reaching a single assertion.
 * A run that never got to the check is not a broken guarantee, and turning the
 * weekly report red for a registry hiccup is exactly how a report teaches
 * people to ignore it.
 */
export type Outcome = 'success' | 'failure' | 'unproven' | 'skipped' | 'absent';

/**
 * What a step did, with "absent" distinguished from "skipped".
 *
 * The difference matters when reading history across a change: a step that did
 * not exist yet is not a step that declined to run, and counting them together
 * would report a guarantee as newly broken on the day it was introduced.
 */
export function stepOutcome(job: ApiJob | undefined, name: string): Outcome {
  const step = findStep(job, name);
  if (!step) return 'absent';
  if (step.conclusion === 'success') return 'success';
  if (step.conclusion === 'skipped') return 'skipped';
  return 'failure';
}

/**
 * Read from the job's last assertion rather than its conclusion, so a job that
 * failed on its way to the check is `unproven` rather than a regression.
 */
function selfDestructOutcome(job: ApiJob | undefined): Outcome {
  if (!job) return 'absent';
  const outcome = stepOutcome(job, SELF_DESTRUCT_PROOF_STEP);
  return outcome === 'success' || outcome === 'failure' ? outcome : 'unproven';
}

/**
 * How evenly the shards divided the work.
 *
 * A run is only as fast as its slowest shard, so the number that matters is
 * not the total but the share of the parallel window that sat idle: with a
 * perfect split every shard finishes together and nothing is wasted.
 *
 * This is the one measurement here that is about speed rather than about the
 * cheap-and-cleaned-up claim, which is why it is reported and never fatal.
 * Weights drift as tests are added (#85), and a report that goes red for that
 * would be a report that goes red every week.
 */
export interface ShardBalance {
  shards: number;
  slowestMs: number;
  fastestMs: number;
  /** Percentage of the slowest shard's window that other shards spent idle. */
  wastedPercent: number;
}

interface RawSummary {
  shards?: { durationMs?: number }[];
}

export function shardBalance(summary: unknown): ShardBalance | undefined {
  const durations = ((summary as RawSummary | null)?.shards ?? [])
    .map((shard) => shard.durationMs)
    .filter((value): value is number => typeof value === 'number' && value > 0);

  if (durations.length < 2) return undefined;

  const slowestMs = Math.max(...durations);
  const fastestMs = Math.min(...durations);
  const mean = durations.reduce((total, value) => total + value, 0) / durations.length;

  return {
    shards: durations.length,
    slowestMs,
    fastestMs,
    wastedPercent: Math.round((1 - mean / slowestMs) * 1000) / 10,
  };
}

export interface RunReport {
  id: number;
  event: string;
  branch: string;
  createdAt: string;
  conclusion: string;
  /** Undefined when the run never stood an environment up. */
  lifetimeMs?: number;
  teardown: Outcome;
  selfDestruct: Outcome;
  /** Undefined when the run's results are gone — artifacts expire. */
  balance?: ShardBalance;
}

export function runReport(
  run: ApiRun,
  jobs: readonly ApiJob[],
  balance?: ShardBalance,
): RunReport {
  const environment = jobs.find((job) => job.name === ENVIRONMENT_JOB);
  const selfDestruct = jobs.find((job) => job.name === SELF_DESTRUCT_JOB);

  const lifetimeMs = environmentLifetimeMs(environment);
  return {
    id: run.id,
    event: run.event,
    branch: run.head_branch ?? '(unknown)',
    createdAt: run.created_at,
    conclusion: run.conclusion ?? 'unknown',
    ...(lifetimeMs === undefined ? {} : { lifetimeMs }),
    // Only counted where an environment actually existed. The proof step runs
    // `if: always()`, so on a run that never deployed anything it passes by
    // having nothing to find — which is not evidence of teardown working.
    teardown:
      lifetimeMs === undefined ? 'unproven' : stepOutcome(environment, TEARDOWN_PROOF_STEP),
    selfDestruct: selfDestructOutcome(selfDestruct),
    ...(balance === undefined ? {} : { balance }),
  };
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export interface FleetSummary {
  runs: number;
  withEnvironment: number;
  teardownProved: number;
  teardownFailed: number;
  selfDestructProved: number;
  selfDestructFailed: number;
  /** Runs where the pipeline never reached the check. Reported, never fatal. */
  unproven: number;
  medianLifetimeMs?: number;
  longestLifetimeMs?: number;
  longest?: RunReport;
  /** Median share of the parallel window spent idle, where results survive. */
  medianWastedPercent?: number;
}

export function summarise(reports: readonly RunReport[]): FleetSummary {
  const lifetimes = reports
    .map((report) => report.lifetimeMs)
    .filter((value): value is number => value !== undefined);

  const longest = reports
    .filter((report) => report.lifetimeMs !== undefined)
    .sort((a, b) => b.lifetimeMs! - a.lifetimeMs!)[0];

  const medianWasted = median(
    reports
      .map((report) => report.balance?.wastedPercent)
      .filter((value): value is number => value !== undefined),
  );

  return {
    runs: reports.length,
    withEnvironment: lifetimes.length,
    teardownProved: reports.filter((r) => r.teardown === 'success').length,
    teardownFailed: reports.filter((r) => r.teardown === 'failure').length,
    selfDestructProved: reports.filter((r) => r.selfDestruct === 'success').length,
    selfDestructFailed: reports.filter((r) => r.selfDestruct === 'failure').length,
    unproven: reports.filter((r) => r.teardown === 'unproven' || r.selfDestruct === 'unproven')
      .length,
    ...(median(lifetimes) === undefined ? {} : { medianLifetimeMs: median(lifetimes)! }),
    ...(longest?.lifetimeMs === undefined
      ? {}
      : { longestLifetimeMs: longest.lifetimeMs, longest }),
    ...(medianWasted === undefined ? {} : { medianWastedPercent: medianWasted }),
  };
}

export interface Thresholds {
  /** An environment that lives longer than this is worth knowing about. */
  maxLifetimeMs: number;
}

/**
 * What should turn the scheduled check red.
 *
 * Deliberately not "anything got slower". A report nobody can act on is a
 * report people learn to ignore, so this fires on a broken guarantee — an
 * environment that was never proved gone, a self-destruct that failed — and on
 * a lifetime far enough out to mean something changed rather than a runner had
 * a bad day.
 */
export function regressions(summary: FleetSummary, thresholds: Thresholds): string[] {
  const found: string[] = [];

  if (summary.teardownFailed > 0) {
    found.push(`${summary.teardownFailed} run(s) failed to prove the environment was gone`);
  }
  if (summary.selfDestructFailed > 0) {
    found.push(`${summary.selfDestructFailed} run(s) failed to prove the self-destruct layer fires`);
  }
  // Deliberately not a regression: see the comment on Outcome.
  if (summary.withEnvironment > 0 && summary.teardownProved === 0) {
    found.push('no run in this window proved teardown at all');
  }
  if (
    summary.longestLifetimeMs !== undefined &&
    summary.longestLifetimeMs > thresholds.maxLifetimeMs
  ) {
    found.push(
      `an environment lived ${formatDuration(summary.longestLifetimeMs)}, ` +
        `over the ${formatDuration(thresholds.maxLifetimeMs)} threshold ` +
        `(run ${summary.longest?.id ?? 'unknown'})`,
    );
  }

  return found;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function outcomeMark(outcome: Outcome): string {
  return { success: '✓', failure: '✗', unproven: '?', skipped: '–', absent: '·' }[outcome];
}

export function renderReport(summary: FleetSummary, reports: readonly RunReport[]): string {
  const lines: string[] = [];

  lines.push('## Fleet', '');
  lines.push(`Last **${summary.runs}** runs of the pipeline.`, '');
  lines.push('| | |', '|---|---|');
  lines.push(`| Environments stood up | ${summary.withEnvironment} |`);
  lines.push(
    `| Teardown proved | ${summary.teardownProved}` +
      (summary.teardownFailed > 0 ? ` (**${summary.teardownFailed} failed**)` : '') +
      ' |',
  );
  lines.push(
    `| Self-destruct proved | ${summary.selfDestructProved}` +
      (summary.selfDestructFailed > 0 ? ` (**${summary.selfDestructFailed} failed**)` : '') +
      ' |',
  );
  if (summary.unproven > 0) {
    lines.push(`| Never reached the check | ${summary.unproven} |`);
  }
  if (summary.medianLifetimeMs !== undefined) {
    lines.push(`| Median environment lifetime | ${formatDuration(summary.medianLifetimeMs)} |`);
  }
  if (summary.longestLifetimeMs !== undefined) {
    lines.push(
      `| Longest | ${formatDuration(summary.longestLifetimeMs)} (run ${summary.longest?.id ?? '?'}) |`,
    );
  }
  if (summary.medianWastedPercent !== undefined) {
    lines.push(`| Median shard time wasted on imbalance | ${summary.medianWastedPercent}% |`);
  }
  lines.push('');

  lines.push(
    '| Run | Branch | Lifetime | Teardown | Self-destruct | Shard waste |',
    '|---|---|---|---|---|---|',
  );
  for (const report of reports) {
    lines.push(
      `| ${report.id} | \`${report.branch}\` | ` +
        `${report.lifetimeMs === undefined ? '–' : formatDuration(report.lifetimeMs)} | ` +
        `${outcomeMark(report.teardown)} | ${outcomeMark(report.selfDestruct)} | ` +
        `${report.balance === undefined ? '–' : `${report.balance.wastedPercent}%`} |`,
    );
  }
  lines.push('');
  lines.push(
    '`✓` proved · `✗` failed · `?` the run never reached the check · ' +
      '`–` skipped · `·` the check did not exist yet',
  );

  return lines.join('\n');
}
