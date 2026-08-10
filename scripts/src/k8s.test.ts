import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  deleteNamespace,
  getJob,
  interpretJob,
  loadInClusterAccess,
  waitForJob,
  type ClusterAccess,
} from './k8s.js';

const ACCESS: ClusterAccess = {
  apiServer: 'https://kubernetes.default.svc:443',
  token: 'test-token',
  namespace: 'pr-1',
};

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Replaces the global `fetch` for the duration of one test.
 *
 * These functions talk to the API server through `fetch` directly rather than a
 * client object, which is the right call for two REST endpoints — but it means
 * the seam for a test is the global. Each helper returns the calls it recorded
 * and a `restore`, and every test that installs one restores it in a `finally`.
 */
function stubFetch(
  responses: Array<Response | (() => Response)>,
): { calls: RecordedCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  let index = 0;

  // Taken from `fetch` itself rather than named: the DOM lib is not loaded here,
  // so `RequestInfo` does not exist as a global type.
  type FetchInput = Parameters<typeof globalThis.fetch>[0];

  // `fetch` accepts three shapes and only one of them stringifies usefully, so
  // the URL is read out of each explicitly.
  const urlOf = (input: FetchInput): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  const stub = (input: FetchInput, init?: RequestInit): Promise<Response> => {
    calls.push({ url: urlOf(input), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('stubFetch ran out of responses');
    return Promise.resolve(typeof next === 'function' ? next() : next);
  };

  globalThis.fetch = stub;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

describe('loadInClusterAccess', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sa-'));
    await writeFile(path.join(dir, 'token'), '  a-token\n');
    await writeFile(path.join(dir, 'namespace'), 'pr-42\n');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the mounted token and namespace and builds the API server URL', async () => {
    const access = await loadInClusterAccess(
      { KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT_HTTPS: '443' },
      dir,
    );

    assert.equal(access.apiServer, 'https://10.96.0.1:443');
    assert.equal(access.token, 'a-token'); // trimmed — a trailing newline would break the header
    assert.equal(access.namespace, 'pr-42');
  });

  it('falls back to the in-cluster DNS name and 443 when the env is empty', async () => {
    const access = await loadInClusterAccess({}, dir);
    assert.equal(access.apiServer, 'https://kubernetes.default.svc:443');
  });

  it('prefers the HTTPS port variable over the plain one', async () => {
    const access = await loadInClusterAccess(
      { KUBERNETES_SERVICE_PORT: '8080', KUBERNETES_SERVICE_PORT_HTTPS: '6443' },
      dir,
    );
    assert.equal(access.apiServer, 'https://kubernetes.default.svc:6443');
  });

  it('uses KUBERNETES_SERVICE_PORT when only that is set', async () => {
    const access = await loadInClusterAccess({ KUBERNETES_SERVICE_PORT: '6443' }, dir);
    assert.equal(access.apiServer, 'https://kubernetes.default.svc:6443');
  });

  it('prefers POD_NAMESPACE over the mounted file', async () => {
    // The downward API is more explicit than the mount, and the chart sets it.
    const access = await loadInClusterAccess({ POD_NAMESPACE: 'from-downward-api' }, dir);
    assert.equal(access.namespace, 'from-downward-api');
  });

  it('falls back to "default" when the namespace file is missing', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'sa-bare-'));
    try {
      await writeFile(path.join(bare, 'token'), 'tok');
      const access = await loadInClusterAccess({}, bare);
      assert.equal(access.namespace, 'default');
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('explains itself when there is no token, rather than failing at the first request', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'sa-empty-'));
    try {
      await assert.rejects(
        () => loadInClusterAccess({}, empty),
        (error: Error) => {
          assert.match(error.message, /No service account token/);
          assert.match(error.message, /only runs inside a pod/);
          return true;
        },
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('getJob', () => {
  it('authenticates with the mounted token and returns the interpreted status', async () => {
    const fetchStub = stubFetch([
      jsonResponse({ spec: { completions: 4 }, status: { succeeded: 4 } }),
    ]);
    try {
      const status = await getJob(ACCESS, 'pr-1', 'shards-r1');

      assert.equal(status?.complete, true);
      assert.equal(status?.wanted, 4);
      assert.equal(
        fetchStub.calls[0]?.url,
        'https://kubernetes.default.svc:443/apis/batch/v1/namespaces/pr-1/jobs/shards-r1',
      );
      const headers = fetchStub.calls[0]?.init?.headers as Record<string, string>;
      assert.equal(headers.authorization, 'Bearer test-token');
    } finally {
      fetchStub.restore();
    }
  });

  it('returns undefined for a Job that does not exist yet', async () => {
    // Not an error: the aggregator's initContainer can start before the Job it
    // waits for has been created.
    const fetchStub = stubFetch([new Response('', { status: 404 })]);
    try {
      assert.equal(await getJob(ACCESS, 'pr-1', 'missing'), undefined);
    } finally {
      fetchStub.restore();
    }
  });

  it('surfaces the status and body when the API server refuses', async () => {
    // An RBAC mistake shows up here, and the message is the only diagnostic
    // anyone gets out of an initContainer.
    const fetchStub = stubFetch([new Response('jobs.batch "shards" is forbidden', { status: 403 })]);
    try {
      await assert.rejects(
        () => getJob(ACCESS, 'pr-1', 'shards'),
        (error: Error) => {
          assert.match(error.message, /403/);
          assert.match(error.message, /forbidden/);
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });
});

describe('deleteNamespace', () => {
  it('deletes with foreground propagation so the call waits for the contents', async () => {
    const fetchStub = stubFetch([jsonResponse({ kind: 'Status' })]);
    try {
      await deleteNamespace(ACCESS, 'pr-7');

      const call = fetchStub.calls[0];
      assert.equal(call?.url, 'https://kubernetes.default.svc:443/api/v1/namespaces/pr-7');
      assert.equal(call?.init?.method, 'DELETE');

      const body = call?.init?.body;
      assert.equal(typeof body, 'string');
      assert.deepEqual(JSON.parse(body as string), { propagationPolicy: 'Foreground' });
    } finally {
      fetchStub.restore();
    }
  });

  it('treats an already-deleted namespace as success', async () => {
    // The self-destruct Job races the pipeline's own teardown. Whichever loses
    // must not fail the build for having nothing left to do.
    const fetchStub = stubFetch([new Response('', { status: 404 })]);
    try {
      await deleteNamespace(ACCESS, 'gone');
    } finally {
      fetchStub.restore();
    }
  });

  it('throws when the delete is refused', async () => {
    const fetchStub = stubFetch([new Response('namespaces "other" is forbidden', { status: 403 })]);
    try {
      await assert.rejects(
        () => deleteNamespace(ACCESS, 'other'),
        (error: Error) => {
          assert.match(error.message, /DELETE namespace other failed: 403/);
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });
});

describe('waitForJob', () => {
  const running = (): Response =>
    jsonResponse({ spec: { completions: 4 }, status: { active: 4, succeeded: 0 } });
  const finished = (): Response =>
    jsonResponse({ spec: { completions: 4 }, status: { succeeded: 4 } });

  it('returns immediately when the Job is already complete', async () => {
    const fetchStub = stubFetch([finished()]);
    try {
      const status = await waitForJob(ACCESS, 'pr-1', 'shards', {
        timeoutMs: 1000,
        pollIntervalMs: 1,
      });

      assert.equal(status.complete, true);
      assert.equal(fetchStub.calls.length, 1);
    } finally {
      fetchStub.restore();
    }
  });

  it('polls until the Job finishes, reporting each attempt', async () => {
    const fetchStub = stubFetch([running, running, finished]);
    const seen: Array<number> = [];
    try {
      const status = await waitForJob(ACCESS, 'pr-1', 'shards', {
        timeoutMs: 5000,
        pollIntervalMs: 1,
        onPoll: (polled) => seen.push(polled?.succeeded ?? -1),
      });

      assert.equal(status.complete, true);
      assert.equal(fetchStub.calls.length, 3);
      assert.deepEqual(seen, [0, 0, 4]);
    } finally {
      fetchStub.restore();
    }
  });

  it('returns on terminal failure instead of waiting for a retry that never comes', async () => {
    const fetchStub = stubFetch([
      jsonResponse({
        spec: { completions: 4 },
        status: { succeeded: 3, failed: 1, conditions: [{ type: 'Failed', status: 'True' }] },
      }),
    ]);
    try {
      const status = await waitForJob(ACCESS, 'pr-1', 'shards', {
        timeoutMs: 1000,
        pollIntervalMs: 1,
      });

      assert.equal(status.failedTerminally, true);
      assert.equal(status.complete, false);
    } finally {
      fetchStub.restore();
    }
  });

  it('times out with the counts in the message', async () => {
    const fetchStub = stubFetch([running]);
    try {
      await assert.rejects(
        () => waitForJob(ACCESS, 'pr-1', 'shards', { timeoutMs: 0, pollIntervalMs: 1 }),
        (error: Error) => {
          assert.match(error.message, /Timed out/);
          assert.match(error.message, /succeeded 0\/4/);
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('says the Job was never found rather than reporting zero counts', async () => {
    // "not found" and "found but idle" need different fixes, so they get
    // different messages.
    const fetchStub = stubFetch([() => new Response('', { status: 404 })]);
    try {
      await assert.rejects(
        () => waitForJob(ACCESS, 'pr-1', 'never-created', { timeoutMs: 0, pollIntervalMs: 1 }),
        (error: Error) => {
          assert.match(error.message, /\(job not found\)/);
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });
});
