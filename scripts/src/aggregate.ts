/**
 * Merge logic for per-shard Allure results.
 *
 * Kept free of filesystem access so the interesting parts — retry de-duplication,
 * flaky detection and the speedup calculation — are unit-testable without
 * fixtures on disk. `aggregate-results.ts` supplies the I/O.
 */

export type AllureStatus = 'passed' | 'failed' | 'broken' | 'skipped' | 'unknown';

export interface AllureTestResult {
  uuid: string;
  /** Stable identity of a test across retries; Allure computes it from the full name. */
  historyId?: string;
  name?: string;
  fullName?: string;
  status?: AllureStatus;
  statusDetails?: { message?: string; trace?: string };
  start?: number;
  stop?: number;
  labels?: Array<{ name: string; value: string }>;
}

export interface ShardInput {
  index: number;
  results: AllureTestResult[];
}

export interface TestOutcome {
  key: string;
  name: string;
  fullName: string;
  status: AllureStatus;
  shard: number;
  durationMs: number;
  attempts: number;
  /** Failed at least once but ultimately passed. */
  flaky: boolean;
  message?: string;
}

export interface ShardSummary {
  index: number;
  tests: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  /** Wall clock for the shard: last stop minus first start. */
  durationMs: number;
}

export interface RunSummary {
  totals: {
    tests: number;
    passed: number;
    failed: number;
    broken: number;
    skipped: number;
    unknown: number;
    flaky: number;
    retries: number;
  };
  shards: ShardSummary[];
  timing: {
    /** Sum of every shard's wall clock — what one sequential runner would cost. */
    sequentialMs: number;
    /** The slowest shard, which is what the run actually takes. */
    wallClockMs: number;
    savedMs: number;
    speedup: number;
    /** 100% would mean every shard finished at exactly the same moment. */
    efficiencyPercent: number;
  };
  failures: Array<{ name: string; fullName: string; shard: number; message: string }>;
  passed: boolean;
}

function identityOf(result: AllureTestResult): string {
  return result.historyId ?? result.fullName ?? result.name ?? result.uuid;
}

function durationOf(result: AllureTestResult): number {
  if (typeof result.start !== 'number' || typeof result.stop !== 'number') return 0;
  return Math.max(0, result.stop - result.start);
}

/**
 * Collapses retries into one outcome per test.
 *
 * Playwright writes one Allure result per *attempt*, so a test retried twice
 * appears three times. Counting raw result files would inflate the totals and
 * report a suite as failing when the retry passed. The latest attempt (by stop
 * time, falling back to input order) wins.
 */
export function collapseAttempts(shards: readonly ShardInput[]): TestOutcome[] {
  const byIdentity = new Map<string, { attempts: AllureTestResult[]; shard: number }>();

  for (const shard of shards) {
    for (const result of shard.results) {
      const key = identityOf(result);
      const existing = byIdentity.get(key);
      if (existing) existing.attempts.push(result);
      else byIdentity.set(key, { attempts: [result], shard: shard.index });
    }
  }

  const outcomes: TestOutcome[] = [];

  for (const [key, { attempts, shard }] of byIdentity) {
    const ordered = [...attempts].sort((a, b) => (a.stop ?? 0) - (b.stop ?? 0));
    const final = ordered[ordered.length - 1]!;
    const status = final.status ?? 'unknown';
    const failedEarlier = ordered
      .slice(0, -1)
      .some((attempt) => attempt.status === 'failed' || attempt.status === 'broken');

    outcomes.push({
      key,
      name: final.name ?? '(unnamed test)',
      fullName: final.fullName ?? final.name ?? '(unnamed test)',
      status,
      shard,
      durationMs: ordered.reduce((sum, attempt) => sum + durationOf(attempt), 0),
      attempts: ordered.length,
      flaky: failedEarlier && status === 'passed',
      ...(final.statusDetails?.message ? { message: final.statusDetails.message } : {}),
    });
  }

  return outcomes.sort((a, b) => a.fullName.localeCompare(b.fullName, 'en'));
}

/** Wall clock of a shard: from its first test start to its last test stop. */
export function shardWallClock(results: readonly AllureTestResult[]): number {
  const starts = results.map((r) => r.start).filter((v): v is number => typeof v === 'number');
  const stops = results.map((r) => r.stop).filter((v): v is number => typeof v === 'number');
  if (starts.length === 0 || stops.length === 0) return 0;
  return Math.max(0, Math.max(...stops) - Math.min(...starts));
}

export function buildSummary(shards: readonly ShardInput[]): RunSummary {
  const outcomes = collapseAttempts(shards);

  const totals = {
    tests: outcomes.length,
    passed: outcomes.filter((o) => o.status === 'passed').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    broken: outcomes.filter((o) => o.status === 'broken').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    unknown: outcomes.filter((o) => o.status === 'unknown').length,
    flaky: outcomes.filter((o) => o.flaky).length,
    retries: outcomes.reduce((sum, o) => sum + (o.attempts - 1), 0),
  };

  const shardSummaries: ShardSummary[] = [...shards]
    .sort((a, b) => a.index - b.index)
    .map((shard) => {
      const own = outcomes.filter((o) => o.shard === shard.index);
      return {
        index: shard.index,
        tests: own.length,
        passed: own.filter((o) => o.status === 'passed').length,
        failed: own.filter((o) => o.status === 'failed').length,
        broken: own.filter((o) => o.status === 'broken').length,
        skipped: own.filter((o) => o.status === 'skipped').length,
        durationMs: shardWallClock(shard.results),
      };
    });

  const sequentialMs = shardSummaries.reduce((sum, shard) => sum + shard.durationMs, 0);
  const wallClockMs = shardSummaries.reduce((max, shard) => Math.max(max, shard.durationMs), 0);
  const speedup = wallClockMs === 0 ? 1 : sequentialMs / wallClockMs;

  return {
    totals,
    shards: shardSummaries,
    timing: {
      sequentialMs,
      wallClockMs,
      savedMs: Math.max(0, sequentialMs - wallClockMs),
      speedup: Math.round(speedup * 100) / 100,
      efficiencyPercent:
        shardSummaries.length === 0 || wallClockMs === 0
          ? 100
          : Math.round((sequentialMs / (wallClockMs * shardSummaries.length)) * 1000) / 10,
    },
    failures: outcomes
      .filter((o) => o.status === 'failed' || o.status === 'broken')
      .map((o) => ({
        name: o.name,
        fullName: o.fullName,
        shard: o.shard,
        message: o.message ?? 'No failure message recorded',
      })),
    passed: totals.failed === 0 && totals.broken === 0 && totals.tests > 0,
  };
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** GitHub-flavoured Markdown, written straight into $GITHUB_STEP_SUMMARY. */
export function renderMarkdownSummary(summary: RunSummary, context: Record<string, string> = {}): string {
  const { totals, timing } = summary;
  const verdict = summary.passed ? '✅ All tests passed' : '❌ Test run failed';

  const lines = [
    `## ${verdict}`,
    '',
    ...Object.entries(context).map(([key, value]) => `**${key}:** \`${value}\`  `),
    '',
    `| Total | Passed | Failed | Broken | Skipped | Flaky | Retries |`,
    `|------:|-------:|-------:|-------:|--------:|------:|--------:|`,
    `| ${totals.tests} | ${totals.passed} | ${totals.failed} | ${totals.broken} | ${totals.skipped} | ${totals.flaky} | ${totals.retries} |`,
    '',
    '### Sharding',
    '',
    `Ran on **${summary.shards.length}** parallel shard(s).`,
    `Sequential cost would have been **${formatSeconds(timing.sequentialMs)}**; the run took **${formatSeconds(timing.wallClockMs)}** — a **${timing.speedup}×** speedup (${timing.efficiencyPercent}% shard efficiency).`,
    '',
    `| Shard | Tests | Passed | Failed | Duration |`,
    `|------:|------:|-------:|-------:|---------:|`,
    ...summary.shards.map(
      (shard) =>
        `| ${shard.index} | ${shard.tests} | ${shard.passed} | ${shard.failed + shard.broken} | ${formatSeconds(shard.durationMs)} |`,
    ),
  ];

  if (summary.failures.length > 0) {
    lines.push('', '### Failures', '');
    for (const failure of summary.failures.slice(0, 25)) {
      const firstLine = failure.message.split('\n')[0] ?? '';
      lines.push(`- **${failure.fullName}** (shard ${failure.shard}) — ${firstLine.slice(0, 300)}`);
    }
    if (summary.failures.length > 25) {
      lines.push(`- …and ${summary.failures.length - 25} more (see the Allure report)`);
    }
  }

  return `${lines.join('\n')}\n`;
}
