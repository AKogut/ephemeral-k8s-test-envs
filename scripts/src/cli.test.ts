import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs, requireInteger, resolveOption } from './cli.js';

describe('parseArgs', () => {
  it('parses --key value pairs', () => {
    assert.deepEqual(parseArgs(['--total', '4', '--index', '2']), { total: '4', index: '2' });
  });

  it('parses --key=value pairs', () => {
    assert.deepEqual(parseArgs(['--format=json']), { format: 'json' });
  });

  it('treats a trailing key as a boolean flag', () => {
    assert.deepEqual(parseArgs(['--help']), { help: true });
  });

  it('treats a key followed by another key as a boolean flag', () => {
    assert.deepEqual(parseArgs(['--dry-run', '--total', '2']), { 'dry-run': true, total: '2' });
  });

  it('ignores positional arguments', () => {
    assert.deepEqual(parseArgs(['run', '--total', '3']), { total: '3' });
  });

  it('keeps values containing an equals sign intact', () => {
    assert.deepEqual(parseArgs(['--url=http://x/?a=b']), { url: 'http://x/?a=b' });
  });
});

describe('resolveOption', () => {
  it('prefers the CLI argument over the environment', () => {
    assert.equal(
      resolveOption({ index: '3' }, 'index', ['SHARD_INDEX'], '0', { SHARD_INDEX: '9' }),
      '3',
    );
  });

  it('falls back to the first environment variable that is set', () => {
    assert.equal(
      resolveOption({}, 'index', ['SHARD_INDEX', 'JOB_COMPLETION_INDEX'], '0', {
        JOB_COMPLETION_INDEX: '7',
      }),
      '7',
    );
  });

  it('respects the order of the env name list', () => {
    assert.equal(
      resolveOption({}, 'index', ['SHARD_INDEX', 'JOB_COMPLETION_INDEX'], '0', {
        SHARD_INDEX: '1',
        JOB_COMPLETION_INDEX: '7',
      }),
      '1',
    );
  });

  it('ignores empty values', () => {
    assert.equal(resolveOption({ index: '' }, 'index', ['SHARD_INDEX'], '0', { SHARD_INDEX: '' }), '0');
  });

  it('returns undefined when nothing is set and there is no default', () => {
    assert.equal(resolveOption({}, 'weights', ['SHARD_WEIGHTS'], undefined, {}), undefined);
  });
});

describe('requireInteger', () => {
  it('parses a valid integer', () => {
    assert.equal(requireInteger('42', '--total'), 42);
  });

  it('rejects a partially numeric string rather than silently truncating', () => {
    assert.throws(() => requireInteger('4abc', '--total'), /must be an integer/);
  });

  it('rejects a missing value', () => {
    assert.throws(() => requireInteger(undefined, '--total'), /is required/);
  });

  it('rejects a float', () => {
    assert.throws(() => requireInteger('1.5', '--total'), /must be an integer/);
  });
});
