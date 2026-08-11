import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AllureTestResult } from './aggregate.js';
import {
  blendWeights,
  describeChanges,
  runSpan,
  specFileOf,
  weightsFromResults,
} from './weights.js';

const result = (over: Partial<AllureTestResult> = {}): AllureTestResult => ({
  uuid: Math.random().toString(36).slice(2),
  fullName: 'a.spec.ts:1:1',
  start: 1_000,
  stop: 2_000,
  ...over,
});

describe('specFileOf', () => {
  it('reads the file out of Playwright\'s fullName', () => {
    assert.equal(specFileOf(result({ fullName: 'notes-crud.spec.ts:53:3' })), 'notes-crud.spec.ts');
  });

  it('falls back to the suite label when fullName is not usable', () => {
    assert.equal(
      specFileOf(result({ fullName: 'some free text', labels: [{ name: 'suite', value: 'auth-me.spec.ts' }] })),
      'auth-me.spec.ts',
    );
  });

  it('prefers fullName, because the label is a display concern', () => {
    // Reporter versions have changed the label's shape; fullName has been
    // stable, so a disagreement resolves towards it.
    assert.equal(
      specFileOf(result({ fullName: 'real.spec.ts:1:1', labels: [{ name: 'suite', value: 'other.spec.ts' }] })),
      'real.spec.ts',
    );
  });

  it('returns undefined rather than guessing at something that is not a spec', () => {
    assert.equal(specFileOf(result({ fullName: 'setup', labels: [] })), undefined);
    assert.equal(specFileOf(result({ fullName: undefined, labels: undefined })), undefined);
  });
});

describe('weightsFromResults', () => {
  it('sums the tests in each file, in seconds', () => {
    const weights = weightsFromResults([
      result({ fullName: 'a.spec.ts:1:1', start: 0, stop: 1_500 }),
      result({ fullName: 'a.spec.ts:9:1', start: 0, stop: 500 }),
      result({ fullName: 'b.spec.ts:1:1', start: 0, stop: 250 }),
    ]);
    assert.deepEqual(weights, { 'a.spec.ts': 2, 'b.spec.ts': 0.25 });
  });

  it('includes retries, because a flaky file really does cost its shard that time', () => {
    const weights = weightsFromResults([
      result({ historyId: 'x', fullName: 'a.spec.ts:1:1', start: 0, stop: 1_000 }),
      result({ historyId: 'x', fullName: 'a.spec.ts:1:1', start: 1_000, stop: 2_000 }),
    ]);
    assert.deepEqual(weights, { 'a.spec.ts': 2 });
  });

  it('rounds to two decimals so a regeneration is not a diff of noise', () => {
    const weights = weightsFromResults([result({ fullName: 'a.spec.ts:1:1', start: 0, stop: 1_234 })]);
    assert.deepEqual(weights, { 'a.spec.ts': 1.23 });
  });

  it('ignores results with no usable timing rather than counting them as zero', () => {
    const weights = weightsFromResults([
      result({ fullName: 'a.spec.ts:1:1', start: 0, stop: 1_000 }),
      result({ fullName: 'a.spec.ts:2:1', start: undefined, stop: undefined }),
    ]);
    assert.deepEqual(weights, { 'a.spec.ts': 1 });
  });

  it('never produces a negative weight from clock skew', () => {
    const weights = weightsFromResults([result({ fullName: 'a.spec.ts:1:1', start: 5_000, stop: 1_000 })]);
    assert.deepEqual(weights, { 'a.spec.ts': 0 });
  });

  it('orders the output, so the file is stable across regenerations', () => {
    const weights = weightsFromResults([
      result({ fullName: 'z.spec.ts:1:1' }),
      result({ fullName: 'a.spec.ts:1:1' }),
      result({ fullName: 'm.spec.ts:1:1' }),
    ]);
    assert.deepEqual(Object.keys(weights), ['a.spec.ts', 'm.spec.ts', 'z.spec.ts']);
  });
});

describe('runSpan', () => {
  it('reports the window the results cover', () => {
    const span = runSpan([
      result({ start: 1_000, stop: 2_000 }),
      result({ start: 1_500, stop: 4_000 }),
    ]);
    assert.deepEqual(span, { earliest: 1_000, latest: 4_000, spanMs: 3_000 });
  });

  it('exposes the accumulation that made this check necessary', () => {
    // Results from six runs left in one directory: the same suite, hours apart.
    // Weights taken from that are inflated by however many runs were in there —
    // wrong, and entirely plausible-looking.
    const span = runSpan([
      result({ start: 0, stop: 3_000 }),
      result({ start: 5_000_000, stop: 5_003_000 }),
    ]);
    assert.ok(span!.spanMs > 60 * 60 * 1000, 'a span over an hour is not one run of this suite');
  });

  it('returns undefined when nothing carries a timestamp', () => {
    assert.equal(runSpan([result({ start: undefined, stop: undefined })]), undefined);
    assert.equal(runSpan([]), undefined);
  });
});

describe('blendWeights', () => {
  it('moves halfway by default use, rather than taking a noisy run whole', () => {
    assert.deepEqual(blendWeights({ 'a.spec.ts': 10 }, { 'a.spec.ts': 20 }, 0.5), { 'a.spec.ts': 15 });
  });

  it('replaces at alpha 1 and changes nothing at alpha 0', () => {
    assert.deepEqual(blendWeights({ 'a.spec.ts': 10 }, { 'a.spec.ts': 20 }, 1), { 'a.spec.ts': 20 });
    assert.deepEqual(blendWeights({ 'a.spec.ts': 10 }, { 'a.spec.ts': 20 }, 0), { 'a.spec.ts': 10 });
  });

  it('takes a new file at its measured value', () => {
    assert.deepEqual(blendWeights({}, { 'new.spec.ts': 4 }, 0.5), { 'new.spec.ts': 4 });
  });

  it('keeps a file the run did not measure', () => {
    // A run that skipped a file says nothing about how long it takes; dropping
    // it would send the planner back to the median for no reason.
    assert.deepEqual(blendWeights({ 'old.spec.ts': 7 }, { 'new.spec.ts': 4 }, 0.5), {
      'new.spec.ts': 4,
      'old.spec.ts': 7,
    });
  });

  it('rejects an alpha outside the range instead of clamping silently', () => {
    assert.throws(() => blendWeights({}, {}, 1.5), /between 0 and 1/);
    assert.throws(() => blendWeights({}, {}, -0.1), /between 0 and 1/);
  });
});

describe('describeChanges', () => {
  it('reports the drift as a percentage', () => {
    const changes = describeChanges({ 'a.spec.ts': 10 }, { 'a.spec.ts': 12.5 });
    assert.deepEqual(changes, [{ spec: 'a.spec.ts', before: 10, after: 12.5, driftPercent: 25 }]);
  });

  it('has no percentage for a file that had no stored weight', () => {
    assert.deepEqual(describeChanges({}, { 'new.spec.ts': 3 }), [
      { spec: 'new.spec.ts', before: undefined, after: 3 },
    ]);
  });

  it('does not divide by a stored zero', () => {
    const changes = describeChanges({ 'a.spec.ts': 0 }, { 'a.spec.ts': 2 });
    assert.equal(changes[0]?.driftPercent, undefined);
  });

  it('lists files in a stable order, so a regeneration is reviewable', () => {
    // Every other test here uses a single file, which left the ordering
    // untested — the coverage gate is what noticed.
    const changes = describeChanges(
      { 'z.spec.ts': 1, 'a.spec.ts': 1 },
      { 'z.spec.ts': 2, 'm.spec.ts': 3, 'a.spec.ts': 4 },
    );
    assert.deepEqual(
      changes.map((c) => c.spec),
      ['a.spec.ts', 'm.spec.ts', 'z.spec.ts'],
    );
    assert.equal(changes[1]?.driftPercent, undefined, 'm.spec.ts had no stored weight');
    assert.equal(changes[2]?.driftPercent, 100, 'z.spec.ts doubled');
  });
});
