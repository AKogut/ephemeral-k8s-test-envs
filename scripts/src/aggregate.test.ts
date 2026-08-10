import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSummary,
  collapseAttempts,
  renderMarkdownSummary,
  shardWallClock,
  type AllureTestResult,
  type ShardInput,
} from './aggregate.js';

let uuidCounter = 0;
function result(overrides: Partial<AllureTestResult> = {}): AllureTestResult {
  uuidCounter += 1;
  return {
    uuid: `uuid-${uuidCounter}`,
    historyId: overrides.historyId ?? `history-${uuidCounter}`,
    name: 'a test',
    fullName: `suite > a test ${uuidCounter}`,
    status: 'passed',
    start: 1000,
    stop: 2000,
    ...overrides,
  };
}

describe('collapseAttempts', () => {
  it('counts a test once no matter how many retries it took', () => {
    const shard: ShardInput = {
      index: 0,
      results: [
        result({ historyId: 'h1', status: 'failed', start: 0, stop: 100 }),
        result({ historyId: 'h1', status: 'failed', start: 100, stop: 200 }),
        result({ historyId: 'h1', status: 'passed', start: 200, stop: 300 }),
      ],
    };

    const outcomes = collapseAttempts([shard]);

    assert.equal(outcomes.length, 1, 'three attempts are one test');
    assert.equal(outcomes[0]!.status, 'passed', 'the final attempt decides the status');
    assert.equal(outcomes[0]!.attempts, 3);
  });

  it('marks a test that failed then passed as flaky', () => {
    const outcomes = collapseAttempts([
      {
        index: 0,
        results: [
          result({ historyId: 'h1', status: 'failed', start: 0, stop: 10 }),
          result({ historyId: 'h1', status: 'passed', start: 10, stop: 20 }),
        ],
      },
    ]);

    assert.equal(outcomes[0]!.flaky, true);
  });

  it('does not mark a consistently passing test as flaky', () => {
    const outcomes = collapseAttempts([
      { index: 0, results: [result({ historyId: 'h1', status: 'passed' })] },
    ]);
    assert.equal(outcomes[0]!.flaky, false);
  });

  it('does not mark a test that never passed as flaky', () => {
    const outcomes = collapseAttempts([
      {
        index: 0,
        results: [
          result({ historyId: 'h1', status: 'failed', start: 0, stop: 10 }),
          result({ historyId: 'h1', status: 'failed', start: 10, stop: 20 }),
        ],
      },
    ]);
    assert.equal(outcomes[0]!.flaky, false);
    assert.equal(outcomes[0]!.status, 'failed');
  });

  it('records which shard each test came from', () => {
    const outcomes = collapseAttempts([
      { index: 0, results: [result({ historyId: 'a' })] },
      { index: 3, results: [result({ historyId: 'b' })] },
    ]);

    assert.deepEqual(
      outcomes.map((o) => o.shard).sort(),
      [0, 3],
    );
  });

  it('falls back to fullName when historyId is absent', () => {
    const outcomes = collapseAttempts([
      {
        index: 0,
        results: [
          { uuid: 'u1', fullName: 'same test', status: 'failed', start: 0, stop: 1 },
          { uuid: 'u2', fullName: 'same test', status: 'passed', start: 1, stop: 2 },
        ],
      },
    ]);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.status, 'passed');
  });
});

describe('shardWallClock', () => {
  it('spans the first start to the last stop', () => {
    assert.equal(
      shardWallClock([
        result({ start: 1000, stop: 3000 }),
        result({ start: 500, stop: 2000 }),
        result({ start: 2500, stop: 4000 }),
      ]),
      3500,
    );
  });

  it('returns zero when timing data is missing', () => {
    assert.equal(shardWallClock([{ uuid: 'x', status: 'passed' }]), 0);
    assert.equal(shardWallClock([]), 0);
  });
});

describe('buildSummary', () => {
  const shards: ShardInput[] = [
    {
      index: 0,
      results: [
        result({ historyId: 'a', status: 'passed', start: 0, stop: 1000 }),
        result({ historyId: 'b', status: 'failed', start: 1000, stop: 2000 }),
      ],
    },
    {
      index: 1,
      results: [
        result({ historyId: 'c', status: 'passed', start: 0, stop: 500 }),
        result({ historyId: 'd', status: 'skipped', start: 500, stop: 500 }),
      ],
    },
  ];

  it('totals every status across all shards', () => {
    const summary = buildSummary(shards);
    assert.equal(summary.totals.tests, 4);
    assert.equal(summary.totals.passed, 2);
    assert.equal(summary.totals.failed, 1);
    assert.equal(summary.totals.skipped, 1);
  });

  it('reports the run as failed when any test failed', () => {
    assert.equal(buildSummary(shards).passed, false);
  });

  it('reports the run as passed only when there are tests and none failed', () => {
    const green = buildSummary([{ index: 0, results: [result({ status: 'passed' })] }]);
    assert.equal(green.passed, true);

    // An empty run is not a green run: it usually means the shard never ran.
    assert.equal(buildSummary([{ index: 0, results: [] }]).passed, false);
  });

  it('derives wall clock from the slowest shard, not the sum', () => {
    const summary = buildSummary(shards);
    assert.equal(summary.timing.wallClockMs, 2000, 'shard 0 is the slowest at 2000ms');
    assert.equal(summary.timing.sequentialMs, 2500, '2000 + 500');
    assert.equal(summary.timing.savedMs, 500);
    assert.equal(summary.timing.speedup, 1.25);
  });

  it('computes 100% efficiency when all shards take the same time', () => {
    const balanced = buildSummary([
      { index: 0, results: [result({ historyId: 'a', start: 0, stop: 1000 })] },
      { index: 1, results: [result({ historyId: 'b', start: 0, stop: 1000 })] },
    ]);
    assert.equal(balanced.timing.efficiencyPercent, 100);
    assert.equal(balanced.timing.speedup, 2);
  });

  it('lists failures with the shard that produced them', () => {
    const summary = buildSummary([
      {
        index: 2,
        results: [
          result({
            historyId: 'boom',
            status: 'failed',
            fullName: 'notes > rejects bad tags',
            statusDetails: { message: 'expected 400, got 500' },
          }),
        ],
      },
    ]);

    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0]!.shard, 2);
    assert.equal(summary.failures[0]!.fullName, 'notes > rejects bad tags');
    assert.match(summary.failures[0]!.message, /expected 400/);
  });

  it('counts retries across the whole run', () => {
    const summary = buildSummary([
      {
        index: 0,
        results: [
          result({ historyId: 'r', status: 'failed', start: 0, stop: 1 }),
          result({ historyId: 'r', status: 'passed', start: 1, stop: 2 }),
        ],
      },
    ]);
    assert.equal(summary.totals.retries, 1);
    assert.equal(summary.totals.flaky, 1);
  });

  it('handles a shard that produced no results at all', () => {
    const summary = buildSummary([
      { index: 0, results: [result({ historyId: 'a', start: 0, stop: 100 })] },
      { index: 1, results: [] },
    ]);

    assert.equal(summary.shards.length, 2);
    assert.equal(summary.shards[1]!.tests, 0);
    assert.equal(summary.shards[1]!.durationMs, 0);
  });
});

describe('renderMarkdownSummary', () => {
  it('renders a pass verdict with the speedup line', () => {
    const markdown = renderMarkdownSummary(
      buildSummary([
        { index: 0, results: [result({ historyId: 'a', start: 0, stop: 1000 })] },
        { index: 1, results: [result({ historyId: 'b', start: 0, stop: 1000 })] },
      ]),
      { Environment: 'pr-42' },
    );

    assert.match(markdown, /All tests passed/);
    assert.match(markdown, /pr-42/);
    assert.match(markdown, /\*\*2×\*\* speedup/);
    assert.match(markdown, /100% shard efficiency/);
  });

  it('renders failures and a fail verdict', () => {
    const markdown = renderMarkdownSummary(
      buildSummary([
        {
          index: 0,
          results: [
            result({
              historyId: 'x',
              status: 'failed',
              fullName: 'auth > rejects short passwords',
              statusDetails: { message: 'boom\nsecond line' },
            }),
          ],
        },
      ]),
    );

    assert.match(markdown, /Test run failed/);
    assert.match(markdown, /auth > rejects short passwords/);
    assert.match(markdown, /boom/);
    assert.doesNotMatch(markdown, /second line/, 'only the first line of a message is inlined');
  });
});
