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
import { deleteNamespace, loadInClusterAccess } from './k8s.js';

const USAGE = `
Usage: self-destruct [options]

  --namespace <ns>    Namespace to delete   (env: POD_NAMESPACE, default: own namespace)
  --after <seconds>   Wait before deleting  (env: SELF_DESTRUCT_AFTER_SECONDS, default: 0)
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

  if (args['dry-run'] === true) {
    process.stdout.write(`[dry run] would delete namespace ${namespace} after ${afterSeconds}s\n`);
    return 0;
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

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
