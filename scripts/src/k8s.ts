/**
 * A very small in-cluster Kubernetes client.
 *
 * The chart needs two cluster operations: "wait until the shard Job has
 * finished" and "delete this namespace". The usual way to get those is an
 * initContainer running a kubectl image, which means a second image to pull,
 * pin and keep patched. Both operations are two REST calls, and every pod
 * already has the credentials mounted, so they are done directly here instead.
 *
 * TLS is handled by pointing NODE_EXTRA_CA_CERTS at the service account CA
 * bundle in the pod spec, which keeps certificate verification on without
 * needing a custom HTTPS agent.
 */

import { readFile } from 'node:fs/promises';

const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface ClusterAccess {
  apiServer: string;
  token: string;
  namespace: string;
}

export async function loadInClusterAccess(
  env: NodeJS.ProcessEnv = process.env,
  dir = SERVICE_ACCOUNT_DIR,
): Promise<ClusterAccess> {
  const host = env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
  const port = env.KUBERNETES_SERVICE_PORT_HTTPS ?? env.KUBERNETES_SERVICE_PORT ?? '443';

  let token: string;
  try {
    token = (await readFile(`${dir}/token`, 'utf8')).trim();
  } catch {
    throw new Error(
      `No service account token at ${dir}/token — this command only runs inside a pod ` +
        'with a mounted service account.',
    );
  }

  const namespace =
    env.POD_NAMESPACE ?? (await readFile(`${dir}/namespace`, 'utf8').catch(() => 'default')).trim();

  return { apiServer: `https://${host}:${port}`, token, namespace };
}

export interface JobStatus {
  name: string;
  succeeded: number;
  failed: number;
  active: number;
  /** `completions` from the spec: how many indexes must succeed. */
  wanted: number;
  complete: boolean;
  failedTerminally: boolean;
}

interface RawJob {
  spec?: { completions?: number; backoffLimit?: number };
  status?: {
    succeeded?: number;
    failed?: number;
    active?: number;
    conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
  };
}

/**
 * Interprets a Job's status.
 *
 * Kept pure and exported so the state machine can be unit tested — getting
 * "finished" wrong means either an aggregator that starts too early and reports
 * half a run, or one that hangs until the pipeline times out.
 */
export function interpretJob(name: string, raw: RawJob): JobStatus {
  const status = raw.status ?? {};
  const conditions = status.conditions ?? [];
  const wanted = raw.spec?.completions ?? 1;

  const hasCondition = (type: string): boolean =>
    conditions.some((condition) => condition.type === type && condition.status === 'True');

  return {
    name,
    succeeded: status.succeeded ?? 0,
    failed: status.failed ?? 0,
    active: status.active ?? 0,
    wanted,
    complete: hasCondition('Complete') || (status.succeeded ?? 0) >= wanted,
    // A Job that exhausted its backoffLimit is finished too — the aggregator
    // must run on the partial results rather than wait for a retry that will
    // never come.
    failedTerminally: hasCondition('Failed'),
  };
}

async function apiRequest(
  access: ClusterAccess,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${access.apiServer}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${access.token}`,
      accept: 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
}

export async function getJob(
  access: ClusterAccess,
  namespace: string,
  name: string,
): Promise<JobStatus | undefined> {
  const response = await apiRequest(access, `/apis/batch/v1/namespaces/${namespace}/jobs/${name}`);

  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GET job ${namespace}/${name} failed: ${response.status} ${await response.text()}`);
  }

  return interpretJob(name, (await response.json()) as RawJob);
}

export async function deleteNamespace(access: ClusterAccess, namespace: string): Promise<void> {
  const response = await apiRequest(access, `/api/v1/namespaces/${namespace}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    // Foreground propagation so the call does not return until the contained
    // objects are actually being removed.
    body: JSON.stringify({ propagationPolicy: 'Foreground' }),
  });

  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(`DELETE namespace ${namespace} failed: ${response.status} ${await response.text()}`);
  }
}

export interface WaitOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  onPoll?: (status: JobStatus | undefined, elapsedMs: number) => void;
}

export async function waitForJob(
  access: ClusterAccess,
  namespace: string,
  name: string,
  options: WaitOptions,
): Promise<JobStatus> {
  const startedAt = Date.now();

  for (;;) {
    const status = await getJob(access, namespace, name);
    const elapsed = Date.now() - startedAt;
    options.onPoll?.(status, elapsed);

    if (status && (status.complete || status.failedTerminally)) return status;

    if (elapsed > options.timeoutMs) {
      throw new Error(
        `Timed out after ${Math.round(elapsed / 1000)}s waiting for job ${namespace}/${name}` +
          (status ? ` (succeeded ${status.succeeded}/${status.wanted}, failed ${status.failed})` : ' (job not found)'),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}
