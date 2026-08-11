#!/usr/bin/env node
/**
 * Moves shard results between a pod's local disk and object storage.
 *
 *   sync-results --upload /results/shard-0 --prefix pr-123/shard-0
 *   sync-results --download pr-123 --into /tmp/results
 *
 * A separate entry point rather than something the runner imports, for the same
 * reason the shard planner is one: the test runner image already invokes
 * `/opt/sharder/shard-tests.js` as a subprocess, so this needs no new wiring and
 * can be run by hand against a real bucket when something looks wrong.
 *
 * Exit codes: 0 done, 1 error, 3 object storage is not configured.
 */

import { mkdir } from 'node:fs/promises';
import { parseArgs, resolveOption } from './cli.js';
import { s3FromEnv } from './s3.js';
import { downloadPrefix, environmentPrefix, uploadDirectory } from './sync.js';

const USAGE = `
Usage: sync-results (--upload <dir> | --download <prefix>) [options]

  --upload <dir>      Upload everything under <dir>
  --prefix <p>        Key prefix to upload under        (default: <env-id>/shard-<index>)
  --download <prefix> Download everything under <prefix>
  --into <dir>        Where a download is written       (default: /results)
  --env-id <id>       Environment id, used to build the default prefix
  --quiet             Only report failures
  --help              Show this message

Configured entirely by environment:

  RESULTS_S3_ENDPOINT, RESULTS_S3_BUCKET,
  RESULTS_S3_ACCESS_KEY_ID, RESULTS_S3_SECRET_ACCESS_KEY,
  RESULTS_S3_REGION            (default us-east-1)
  RESULTS_S3_FORCE_PATH_STYLE  (default true, for MinIO)

Exits 3 when those are absent, so a caller can fall back to a shared volume
without having to distinguish "not configured" from "failed".
`.trim();

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main(): Promise<number> {
  const env = process.env;
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const quiet = args.quiet === true;
  const log = (message: string): void => {
    if (!quiet) process.stdout.write(`${message}\n`);
  };

  const client = s3FromEnv(env);
  if (!client) {
    process.stderr.write('object storage is not configured; nothing to do\n');
    return 3;
  }

  const envId = resolveOption(args, 'env-id', ['ENV_ID'], undefined, env);

  const uploadDir = typeof args.upload === 'string' ? args.upload : undefined;
  const downloadPrefixArg = typeof args.download === 'string' ? args.download : undefined;

  if ((uploadDir === undefined) === (downloadPrefixArg === undefined)) {
    process.stderr.write('exactly one of --upload or --download is required\n\n');
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  // Against the MinIO an environment brings with it, the bucket does not exist
  // until something makes it. Against a real bucket the credentials usually
  // cannot create one and do not need to — hence an opt-in rather than always.
  if ((env.RESULTS_S3_CREATE_BUCKET ?? 'false') === 'true') {
    log(`bucket: ${await client.ensureBucket()}`);
  }

  if (uploadDir !== undefined) {
    let prefix = resolveOption(args, 'prefix', ['RESULTS_S3_PREFIX'], undefined, env);
    if (prefix === undefined) {
      const index = resolveOption(args, 'index', ['JOB_COMPLETION_INDEX', 'SHARD_INDEX'], '0', env);
      if (envId === undefined) {
        process.stderr.write('--prefix or --env-id is required for an upload\n');
        return 1;
      }
      prefix = `${environmentPrefix(envId)}/shard-${index}`;
    }

    const { files, bytes } = await uploadDirectory(client, uploadDir, prefix);
    log(`uploaded ${files.length} file(s), ${humanBytes(bytes)} -> ${prefix}/`);
    return 0;
  }

  const into = resolveOption(args, 'into', ['RESULTS_DIR'], '/results', env)!;
  await mkdir(into, { recursive: true });

  const { files, bytes } = await downloadPrefix(client, downloadPrefixArg!, into);
  log(`downloaded ${files.length} file(s), ${humanBytes(bytes)} <- ${downloadPrefixArg}/`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
