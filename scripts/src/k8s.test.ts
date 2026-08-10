import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { interpretJob } from './k8s.js';

describe('interpretJob', () => {
  it('treats a Job with the Complete condition as finished', () => {
    const status = interpretJob('shards', {
      spec: { completions: 4 },
      status: { succeeded: 4, conditions: [{ type: 'Complete', status: 'True' }] },
    });

    assert.equal(status.complete, true);
    assert.equal(status.failedTerminally, false);
    assert.equal(status.succeeded, 4);
    assert.equal(status.wanted, 4);
  });

  it('treats all completions succeeding as finished even before the condition lands', () => {
    // There is a window where succeeded == completions but the controller has
    // not written the condition yet. Waiting for the condition alone would
    // stall the aggregator for no reason.
    const status = interpretJob('shards', {
      spec: { completions: 3 },
      status: { succeeded: 3 },
    });

    assert.equal(status.complete, true);
  });

  it('does not treat a partially finished Job as complete', () => {
    const status = interpretJob('shards', {
      spec: { completions: 4 },
      status: { succeeded: 2, active: 2 },
    });

    assert.equal(status.complete, false);
    assert.equal(status.failedTerminally, false);
    assert.equal(status.active, 2);
  });

  it('recognises a terminally failed Job so the aggregator still runs', () => {
    const status = interpretJob('shards', {
      spec: { completions: 4 },
      status: {
        succeeded: 3,
        failed: 1,
        conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }],
      },
    });

    assert.equal(status.failedTerminally, true);
    assert.equal(status.complete, false);
    assert.equal(status.failed, 1);
  });

  it('ignores conditions whose status is False', () => {
    const status = interpretJob('shards', {
      spec: { completions: 2 },
      status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'False' }] },
    });

    assert.equal(status.complete, false);
  });

  it('defaults completions to 1 when the spec omits it', () => {
    const status = interpretJob('one-shot', { status: { succeeded: 1 } });

    assert.equal(status.wanted, 1);
    assert.equal(status.complete, true);
  });

  it('handles a Job that has no status block yet', () => {
    const status = interpretJob('fresh', { spec: { completions: 4 } });

    assert.equal(status.succeeded, 0);
    assert.equal(status.failed, 0);
    assert.equal(status.active, 0);
    assert.equal(status.complete, false);
    assert.equal(status.failedTerminally, false);
  });

  it('handles a completely empty object without throwing', () => {
    const status = interpretJob('empty', {});
    assert.equal(status.wanted, 1);
    assert.equal(status.complete, false);
  });
});
