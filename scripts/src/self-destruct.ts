#!/usr/bin/env node
/**
 * Deletes the namespace it is running in, after an optional delay.
 *
 * This is the *second* layer of the teardown guarantee. The first is the
 * explicit `helm uninstall` + `kubectl delete namespace` step in CI, which
 * handles the normal case. This job handles the abnormal one: a cancelled
 * workflow, a runner that died, a network partition — any situation where the
 * pipeline never reaches its cleanup step and would otherwise leave a namespace
 * running forever.
 *
 * Deleting the namespace also deletes this Job, so the pod is removed as a side
 * effect of its own last action.
 *
 * See docs/cost-and-cleanup.md.
 */

import { parseArgs, resolveOption } from './cli.js';
import {
  adoptIntoNamespace,
  deleteNamespace,
  getNamespaceUid,
  loadInClusterAccess,
} from './k8s.js';

const USAGE = `
Usage: self-destruct [options]

  --namespace <ns>    Namespace to delete   (env: POD_NAMESPACE, default: own namespace)
  --after <seconds>   Wait before deleting  (env: SELF_DESTRUCT_AFTER_SECONDS, default: 0)
  --rbac-name <name>  ClusterRole and ClusterRoleBinding to hand to the
                      namespace, so they go with it (env: TEARDOWN_RBAC_NAME)
  --dry-run           Log what would happen and exit 0
  --help
`.trim();

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const access = await loadInClusterAccess();
  const namespace = resolveOption(args, 'namespace', ['POD_NAMESPACE'], access.namespace)!;
  const afterSeconds = Number.parseInt(
    resolveOption(args, 'after', ['SELF_DESTRUCT_AFTER_SECONDS'], '0')!,
    10,
  );

  const rbacName = resolveOption(args, 'rbac-name', ['TEARDOWN_RBAC_NAME'], '');

  if (args['dry-run'] === true) {
    process.stdout.write(`[dry run] would delete namespace ${namespace} after ${afterSeconds}s\n`);
    return 0;
  }

  // Done first, before the wait, so the namespace owns them even if this pod
  // never reaches its own deletion — killed, evicted, or the Job's
  // backoffLimit exhausted. Deleting a namespace does not delete
  // cluster-scoped objects, and this Job cannot delete its own permissions
  // and keep them; see adoptIntoNamespace.
  if (rbacName) {
    const uid = await getNamespaceUid(access, namespace);
    if (uid === undefined) {
      process.stdout.write(`Namespace ${namespace} is already gone; nothing to do.\n`);
      return 0;
    }
    for (const resource of ['clusterroles', 'clusterrolebindings'] as const) {
      const adopted = await adoptIntoNamespace(access, resource, rbacName, { namespace, uid });
      process.stdout.write(
        adopted
          ? `${resource}/${rbacName} now belongs to namespace ${namespace}.\n`
          : `${resource}/${rbacName} not found; nothing to adopt.\n`,
      );
    }
  }

  if (afterSeconds > 0) {
    process.stdout.write(
      `Namespace ${namespace} is scheduled for deletion in ${afterSeconds}s ` +
        `(${new Date(Date.now() + afterSeconds * 1000).toISOString()}).\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, afterSeconds * 1000));
  }

  process.stdout.write(`Deleting namespace ${namespace}…\n`);
  await deleteNamespace(access, namespace);
  process.stdout.write(`Namespace ${namespace} deletion accepted by the API server.\n`);

  return 0;
}

/**
 * `fetch` reports every connection-level failure as the string "fetch failed"
 * and hides what actually happened — DNS, TLS, refused, timed out — one level
 * down in `cause`. This pod's whole job is to talk to the API server, so that
 * one word was the entire diagnosis available when it could not: three separate
 * experiments went into finding out what a single line could have said.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts = [error.message];
  for (let cause = error.cause; cause instanceof Error; cause = cause.cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    parts.push(code ? `${code}: ${cause.message}` : cause.message);
  }
  return parts.join(' — caused by ');
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${describe(error)}\n`);
    process.exit(1);
  });
