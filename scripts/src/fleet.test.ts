import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ApiJob,
  type ApiRun,
  ENVIRONMENT_JOB,
  environmentLifetimeMs,
  formatDuration,
  median,
  regressions,
  renderReport,
  runReport,
  SELF_DESTRUCT_JOB,
  stepOutcome,
  summarise,
} from './fleet.js';

function environmentJob(overrides: Partial<ApiJob> = {}): ApiJob {
  return {
    name: ENVIRONMENT_JOB,
    conclusion: 'success',
    steps: [
      {
        name: 'Deploy the environment',
        conclusion: 'success',
        started_at: '2026-08-11T15:56:21Z',
        completed_at: '2026-08-11T15:56:33Z',
      },
      {
        name: 'Prove the environment is gone',
        conclusion: 'success',
        started_at: '2026-08-11T15:57:55Z',
        completed_at: '2026-08-11T15:57:55Z',
      },
    ],
    ...overrides,
  };
}

function selfDestructJob(conclusion = 'success'): ApiJob {
  return {
    name: SELF_DESTRUCT_JOB,
    conclusion,
    steps: [{ name: 'And it left nothing cluster-scoped behind', conclusion }],
  };
}

const RUN: ApiRun = {
  id: 31509283582,
  event: 'push',
  conclusion: 'success',
  created_at: '2026-08-11T15:50:00Z',
  head_branch: 'main',
};

describe('environmentLifetimeMs', () => {
  it('measures the install starting to the teardown being proved', () => {
    // Not the job's duration: creating a cluster and loading images are the
    // pipeline's cost, not the environment's.
    assert.equal(environmentLifetimeMs(environmentJob()), 94_000);
  });

  it('is undefined when the environment never went up', () => {
    assert.equal(environmentLifetimeMs(undefined), undefined);
    assert.equal(environmentLifetimeMs({ name: ENVIRONMENT_JOB, conclusion: null }), undefined);
  });

  it('is undefined when teardown never ran, rather than zero', () => {
    const job = environmentJob({
      steps: [
        {
          name: 'Deploy the environment',
          conclusion: 'success',
          started_at: '2026-08-11T15:56:21Z',
          completed_at: '2026-08-11T15:56:33Z',
        },
      ],
    });
    assert.equal(environmentLifetimeMs(job), undefined);
  });

  it('never reports a negative lifetime', () => {
    const job = environmentJob({
      steps: [
        {
          name: 'Deploy the environment',
          conclusion: 'success',
          started_at: '2026-08-11T15:58:00Z',
          completed_at: '2026-08-11T15:58:10Z',
        },
        {
          name: 'Prove the environment is gone',
          conclusion: 'success',
          started_at: '2026-08-11T15:56:00Z',
          completed_at: '2026-08-11T15:56:00Z',
        },
      ],
    });
    assert.equal(environmentLifetimeMs(job), 0);
  });

  it('ignores an unparseable timestamp', () => {
    const job = environmentJob({
      steps: [
        { name: 'Deploy the environment', conclusion: 'success', started_at: 'not a date' },
        {
          name: 'Prove the environment is gone',
          conclusion: 'success',
          completed_at: '2026-08-11T15:57:55Z',
        },
      ],
    });
    assert.equal(environmentLifetimeMs(job), undefined);
  });
});

describe('stepOutcome', () => {
  it('tells a step that did not exist yet from one that declined to run', () => {
    // Reading history across a change, the two are opposite: a check that was
    // not written yet is not a broken guarantee.
    assert.equal(stepOutcome(environmentJob(), 'Prove the environment is gone'), 'success');
    assert.equal(stepOutcome(environmentJob(), 'A step from the future'), 'absent');
    assert.equal(
      stepOutcome(
        environmentJob({ steps: [{ name: 'Prove the environment is gone', conclusion: 'skipped' }] }),
        'Prove the environment is gone',
      ),
      'skipped',
    );
    assert.equal(
      stepOutcome(
        environmentJob({ steps: [{ name: 'Prove the environment is gone', conclusion: 'failure' }] }),
        'Prove the environment is gone',
      ),
      'failure',
    );
  });
});

describe('runReport', () => {
  it('reads the lifetime, the teardown proof and the self-destruct job', () => {
    const report = runReport(RUN, [environmentJob(), selfDestructJob()]);

    assert.equal(report.id, RUN.id);
    assert.equal(report.branch, 'main');
    assert.equal(report.lifetimeMs, 94_000);
    assert.equal(report.teardown, 'success');
    assert.equal(report.selfDestruct, 'success');
  });

  it('marks the self-destruct check absent on a run from before it existed', () => {
    const report = runReport(RUN, [environmentJob()]);
    assert.equal(report.selfDestruct, 'absent');
  });

  it('calls a job that never reached its assertion unproven, not failed', () => {
    // The first scheduled run went red on exactly this: the job died on
    // `docker pull … denied` before asserting anything. A registry hiccup is
    // not a broken guarantee.
    const report = runReport(RUN, [
      environmentJob(),
      {
        name: SELF_DESTRUCT_JOB,
        conclusion: 'failure',
        steps: [
          { name: 'Put the images into the cluster', conclusion: 'failure' },
          { name: 'And it left nothing cluster-scoped behind', conclusion: 'skipped' },
        ],
      },
    ]);
    assert.equal(report.selfDestruct, 'unproven');
  });

  it('reads the assertion itself, both ways', () => {
    const withProof = (conclusion: string) =>
      runReport(RUN, [
        environmentJob(),
        {
          name: SELF_DESTRUCT_JOB,
          conclusion,
          steps: [{ name: 'And it left nothing cluster-scoped behind', conclusion }],
        },
      ]).selfDestruct;

    assert.equal(withProof('success'), 'success');
    assert.equal(withProof('failure'), 'failure');
  });

  it('does not credit teardown on a run that never deployed anything', () => {
    // The proof step runs `if: always()`, so with no environment it passes by
    // having nothing to find.
    const report = runReport(RUN, [
      {
        name: ENVIRONMENT_JOB,
        conclusion: 'failure',
        steps: [{ name: 'Prove the environment is gone', conclusion: 'success' }],
      },
    ]);
    assert.equal(report.lifetimeMs, undefined);
    assert.equal(report.teardown, 'unproven');
  });

  it('handles a run with no environment job and no branch', () => {
    const report = runReport({ ...RUN, head_branch: null, conclusion: null }, []);
    assert.equal(report.lifetimeMs, undefined);
    assert.equal(report.teardown, 'unproven');
    assert.equal(report.branch, '(unknown)');
    assert.equal(report.conclusion, 'unknown');
  });
});

describe('median', () => {
  it('is undefined for nothing', () => {
    assert.equal(median([]), undefined);
  });

  it('takes the middle of an odd count and the mean of the middle two', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
  });
});

describe('summarise', () => {
  const reports = [
    runReport(RUN, [environmentJob(), selfDestructJob()]),
    runReport({ ...RUN, id: 2 }, [
      environmentJob({
        steps: [
          {
            name: 'Deploy the environment',
            conclusion: 'success',
            started_at: '2026-08-11T15:00:00Z',
          },
          {
            name: 'Prove the environment is gone',
            conclusion: 'failure',
            completed_at: '2026-08-11T15:20:00Z',
          },
        ],
      }),
    ]),
  ];

  it('counts what was proved and what was not', () => {
    const summary = summarise(reports);
    assert.equal(summary.runs, 2);
    assert.equal(summary.withEnvironment, 2);
    assert.equal(summary.teardownProved, 1);
    assert.equal(summary.teardownFailed, 1);
    assert.equal(summary.selfDestructProved, 1);
    assert.equal(summary.selfDestructFailed, 0);
  });

  it('reports the longest lifetime and which run it was', () => {
    const summary = summarise(reports);
    assert.equal(summary.longestLifetimeMs, 1_200_000);
    assert.equal(summary.longest?.id, 2);
    assert.equal(summary.medianLifetimeMs, 647_000);
  });

  it('says nothing about lifetimes when no environment went up', () => {
    const summary = summarise([runReport(RUN, [])]);
    assert.equal(summary.withEnvironment, 0);
    assert.equal(summary.medianLifetimeMs, undefined);
    assert.equal(summary.longestLifetimeMs, undefined);
    assert.equal(summary.longest, undefined);
  });
});

describe('regressions', () => {
  const clean = summarise([runReport(RUN, [environmentJob(), selfDestructJob()])]);

  it('says nothing when every guarantee held', () => {
    assert.deepEqual(regressions(clean, { maxLifetimeMs: 900_000 }), []);
  });

  it('fires on a teardown that was never proved', () => {
    const summary = summarise([
      runReport(RUN, [
        environmentJob({
          steps: [
            { name: 'Deploy the environment', conclusion: 'success', started_at: '2026-08-11T15:00:00Z' },
            {
              name: 'Prove the environment is gone',
              conclusion: 'failure',
              completed_at: '2026-08-11T15:01:00Z',
            },
          ],
        }),
      ]),
    ]);
    const found = regressions(summary, { maxLifetimeMs: 900_000 });
    assert.equal(found.length, 2);
    assert.match(found[0]!, /failed to prove the environment was gone/);
    assert.match(found[1]!, /no run in this window proved teardown at all/);
  });

  it('fires on a failed self-destruct job', () => {
    const summary = summarise([runReport(RUN, [environmentJob(), selfDestructJob('failure')])]);
    assert.deepEqual(regressions(summary, { maxLifetimeMs: 900_000 }), [
      '1 run(s) failed to prove the self-destruct layer fires',
    ]);
  });

  it('fires on an environment that lived past the threshold', () => {
    const found = regressions(clean, { maxLifetimeMs: 10_000 });
    assert.equal(found.length, 1);
    assert.match(found[0]!, /lived 1m 34s, over the 10s threshold/);
  });

  it('does not fire on slower alone', () => {
    // A report that goes red because a runner had a bad day is a report people
    // learn to ignore.
    assert.deepEqual(regressions(clean, { maxLifetimeMs: 95_000 }), []);
  });
});

describe('formatDuration', () => {
  it('reads as a duration rather than a number of milliseconds', () => {
    assert.equal(formatDuration(94_000), '1m 34s');
    assert.equal(formatDuration(9_000), '9s');
    assert.equal(formatDuration(600_000), '10m 00s');
  });
});

describe('renderReport', () => {
  it('puts the verdict above the detail, and says what the marks mean', () => {
    const reports = [
      runReport(RUN, [environmentJob(), selfDestructJob()]),
      runReport({ ...RUN, id: 2 }, []),
    ];
    const rendered = renderReport(summarise(reports), reports);

    assert.match(rendered, /## Fleet/);
    assert.match(rendered, /\| Median environment lifetime \| 1m 34s \|/);
    assert.match(rendered, /\| 31509283582 \| `main` \| 1m 34s \| ✓ \| ✓ \|/);
    // The run with no environment: nothing measured, nothing claimed.
    assert.match(rendered, /\| 2 \| `main` \| – \| \? \| · \|/);
    assert.match(rendered, /the check did not exist yet/);
  });

  it('marks failures in the summary rather than leaving them to be counted', () => {
    const reports = [
      runReport(RUN, [
        environmentJob({
          steps: [
            {
              name: 'Deploy the environment',
              conclusion: 'success',
              started_at: '2026-08-11T15:56:21Z',
            },
            {
              name: 'Prove the environment is gone',
              conclusion: 'failure',
              completed_at: '2026-08-11T15:57:55Z',
            },
          ],
        }),
        selfDestructJob('failure'),
      ]),
    ];
    const rendered = renderReport(summarise(reports), reports);
    assert.match(rendered, /\*\*1 failed\*\*/);
  });
});
