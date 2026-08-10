#!/usr/bin/env node
/**
 * Blocks until a Kubernetes Job has finished, then exits.
 *
 * Used as the aggregator's initContainer: Kubernetes has no native "run this
 * Job after that Job" edge, so the ordering is expressed as a pod that refuses
 * to finish starting until the shard Job is done.
 *
 * Exits 0 when the Job completed *or* failed terminally — in both cases there
 * are results worth aggregating, and a failed shard should surface as failed
 * tests in the report rather than as a stuck pipeline.
 */

import { parseArgs, resolveOption } from './cli.js';
import { loadInClusterAccess, waitForJob } from './k8s.js';

const USAGE = `
Usage: wait-for-jobs --job <name> [options]

  --job <name>          Job to wait for                      (env: WAIT_FOR_JOB)
  --namespace <ns>      Namespace                            (env: POD_NAMESPACE, default: own namespace)
  --timeout <seconds>   Give up after this long              (default: 900)
  --interval <seconds>  Poll interval                        (default: 5)
  --help
`.trim();

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const jobName = resolveOption(args, 'job', ['WAIT_FOR_JOB']);
  if (!jobName) {
    process.stderr.write(`--job is required\n\n${USAGE}\n`);
    return 1;
  }

  const timeoutSeconds = Number.parseInt(resolveOption(args, 'timeout', ['WAIT_TIMEOUT_SECONDS'], '900')!, 10);
  const intervalSeconds = Number.parseInt(resolveOption(args, 'interval', ['WAIT_INTERVAL_SECONDS'], '5')!, 10);

  const access = await loadInClusterAccess();
  const namespace = resolveOption(args, 'namespace', ['POD_NAMESPACE'], access.namespace)!;

  process.stdout.write(`Waiting for job ${namespace}/${jobName} (timeout ${timeoutSeconds}s)\n`);

  let lastLine = '';
  const status = await waitForJob(access, namespace, jobName, {
    timeoutMs: timeoutSeconds * 1000,
    pollIntervalMs: intervalSeconds * 1000,
    onPoll: (current, elapsedMs) => {
      const line = current
        ? `  [${Math.round(elapsedMs / 1000)}s] active=${current.active} succeeded=${current.succeeded}/${current.wanted} failed=${current.failed}`
        : `  [${Math.round(elapsedMs / 1000)}s] job not created yet`;
      // Only log on change: a 15-minute wait should not produce 180 identical lines.
      if (line.replace(/^\s*\[\d+s\]/, '') !== lastLine) {
        process.stdout.write(`${line}\n`);
        lastLine = line.replace(/^\s*\[\d+s\]/, '');
      }
    },
  });

  process.stdout.write(
    `Job ${namespace}/${jobName} finished: ${status.succeeded}/${status.wanted} succeeded, ` +
      `${status.failed} failed${status.failedTerminally ? ' (terminal failure)' : ''}\n`,
  );

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
