#!/usr/bin/env node
/**
 * Prints the slice of the test suite that belongs to one shard.
 *
 * Used two ways:
 *
 *   - inside a shard pod, where `JOB_COMPLETION_INDEX` is injected by the
 *     Kubernetes Job controller and the output is fed straight to Playwright:
 *
 *       npx playwright test $(shard-tests --format args)
 *
 *   - locally, to see the whole plan before running anything:
 *
 *       npm run shard -- --total 4 --format plan
 */

import path from 'node:path';
import { parseArgs, requireInteger, resolveOption } from './cli.js';
import { discoverSpecs, loadWeights } from './discover.js';
import { applyWeights, formatPlan, planShards, selectShard } from './sharding.js';

const USAGE = `
Usage: shard-tests [options]

  --dir <path>        Directory to scan for spec files      (default: tests/api/specs)
  --suffix <ext>      Spec file suffix                      (default: .spec.ts)
  --total <n>         Number of shards                      (env: SHARD_TOTAL)
  --index <n>         This shard's index, 0-based           (env: SHARD_INDEX, JOB_COMPLETION_INDEX)
  --weights <path>    JSON map of "relative/path": seconds  (default: <dir>/../test-weights.json)
  --format <fmt>      files | args | json | plan            (default: files)
  --help              Show this message

Exit codes: 0 success, 1 bad input.
`.trim();

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const dir = resolveOption(args, 'dir', ['SHARD_SPEC_DIR'], 'tests/api/specs')!;
  const suffix = resolveOption(args, 'suffix', ['SHARD_SPEC_SUFFIX'], '.spec.ts')!;
  const format = resolveOption(args, 'format', ['SHARD_FORMAT'], 'files')!;
  const total = requireInteger(resolveOption(args, 'total', ['SHARD_TOTAL'], '1'), '--total');

  // JOB_COMPLETION_INDEX is what an Indexed Job actually sets; SHARD_INDEX is
  // the friendlier name used by docker-compose and local runs.
  const indexRaw = resolveOption(args, 'index', ['SHARD_INDEX', 'JOB_COMPLETION_INDEX'], '0');
  const index = requireInteger(indexRaw, '--index');

  const weightsPath =
    resolveOption(args, 'weights', ['SHARD_WEIGHTS']) ?? path.join(dir, '..', 'test-weights.json');

  const specs = await discoverSpecs(dir, suffix);
  if (specs.length === 0) {
    process.stderr.write(`No files ending in "${suffix}" found under ${dir}\n`);
    return 1;
  }

  const { weights, source } = await loadWeights(weightsPath);
  const plan = planShards(applyWeights(specs, weights), total);
  const shard = selectShard(plan, index);

  switch (format) {
    case 'plan':
      process.stdout.write(`Weights: ${source}\n${formatPlan(plan)}\n`);
      return 0;

    case 'json':
      process.stdout.write(
        `${JSON.stringify(
          {
            weightsSource: source,
            specDir: dir,
            plan,
            selected: shard,
          },
          null,
          2,
        )}\n`,
      );
      return 0;

    case 'args':
      // Space-separated and paths-only so it can be interpolated into a
      // Playwright invocation. Empty output for an empty shard is intentional:
      // `playwright test` with no file arguments would run the *whole* suite,
      // so the shard entrypoint checks for an empty list before calling it.
      process.stdout.write(`${shard.files.join(' ')}\n`);
      return 0;

    case 'files':
      process.stdout.write(shard.files.length === 0 ? '' : `${shard.files.join('\n')}\n`);
      return 0;

    default:
      process.stderr.write(`Unknown --format "${format}"\n\n${USAGE}\n`);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
