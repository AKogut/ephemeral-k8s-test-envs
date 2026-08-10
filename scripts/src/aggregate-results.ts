#!/usr/bin/env node
/**
 * Merges the per-shard Allure result directories into one.
 *
 * Layout it expects on the shared volume, written by the shard pods:
 *
 *   /results/shard-0/allure-results/*.json
 *   /results/shard-1/allure-results/*.json
 *   ...
 *
 * and what it produces:
 *
 *   /results/merged/allure-results/     <- every shard's files, ready for `allure generate`
 *   /results/merged/summary.json        <- machine-readable run summary
 *   /results/merged/summary.md          <- pasted into the GitHub step summary
 *
 * Note what this does *not* do: it never runs `allure generate`. Doing so needs
 * a JRE, which would roughly triple the aggregator image for a step that CI can
 * do just as well on the runner. See docs/adr/0004-aggregate-in-cluster-render-in-ci.md.
 */

import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, resolveOption } from './cli.js';
import {
  buildSummary,
  renderMarkdownSummary,
  type AllureTestResult,
  type ShardInput,
} from './aggregate.js';

const USAGE = `
Usage: aggregate-results [options]

  --input <dir>       Directory holding shard-<n>/ subdirectories  (default: /results)
  --output <dir>      Where to write the merged results            (default: <input>/merged)
  --results-subdir    Per-shard results folder name                (default: allure-results)
  --env-id <id>       Environment identifier recorded in the report
  --expect-shards <n> Fail if fewer than n shard directories are found
  --fail-on-empty     Exit non-zero when no results were found at all (default: true)
  --help              Show this message

Exit codes: 0 all tests passed, 1 aggregation error, 2 aggregation fine but tests failed.
`.trim();

interface ShardDirectory {
  index: number;
  resultsDir: string;
}

async function findShardDirectories(input: string, subdir: string): Promise<ShardDirectory[]> {
  const entries = await readdir(input, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && /^shard-\d+$/.test(entry.name))
    .map((entry) => ({
      index: Number.parseInt(entry.name.slice('shard-'.length), 10),
      resultsDir: path.join(input, entry.name, subdir),
    }))
    .sort((a, b) => a.index - b.index);
}

async function readShardResults(dir: string): Promise<AllureTestResult[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    // A shard that produced no directory at all (crashed before writing) is
    // reported by the caller rather than silently treated as zero tests.
    return [];
  }

  const results: AllureTestResult[] = [];
  for (const file of files.filter((name) => name.endsWith('-result.json'))) {
    try {
      results.push(JSON.parse(await readFile(path.join(dir, file), 'utf8')) as AllureTestResult);
    } catch (error) {
      process.stderr.write(
        `  warning: skipping unreadable result ${file}: ${error instanceof Error ? error.message : error}\n`,
      );
    }
  }
  return results;
}

/** Copies every Allure artefact (results, containers, attachments) into one folder. */
async function copyArtifacts(from: string, to: string): Promise<number> {
  let files: string[];
  try {
    files = await readdir(from);
  } catch {
    return 0;
  }

  let copied = 0;
  for (const file of files) {
    // Allure identifies files by UUID, so a collision means two shards emitted
    // the same uuid — worth shouting about rather than silently overwriting.
    await copyFile(path.join(from, file), path.join(to, file));
    copied += 1;
  }
  return copied;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const input = resolveOption(args, 'input', ['RESULTS_DIR'], '/results')!;
  const output = resolveOption(args, 'output', ['MERGED_DIR'], path.join(input, 'merged'))!;
  const subdir = resolveOption(args, 'results-subdir', ['RESULTS_SUBDIR'], 'allure-results')!;
  const envId = resolveOption(args, 'env-id', ['ENV_ID'], 'unknown')!;
  const expectShards = Number.parseInt(
    resolveOption(args, 'expect-shards', ['SHARD_TOTAL'], '0')!,
    10,
  );
  const failOnEmpty = args['fail-on-empty'] !== 'false';

  const mergedResults = path.join(output, 'allure-results');
  await mkdir(mergedResults, { recursive: true });

  const shardDirs = await findShardDirectories(input, subdir);
  process.stdout.write(`Found ${shardDirs.length} shard director(ies) under ${input}\n`);

  if (expectShards > 0 && shardDirs.length < expectShards) {
    process.stderr.write(
      `Expected ${expectShards} shard directories but found ${shardDirs.length}. ` +
        `A shard pod probably failed before writing results.\n`,
    );
    return 1;
  }

  const shardInputs: ShardInput[] = [];
  let filesCopied = 0;

  for (const shard of shardDirs) {
    const results = await readShardResults(shard.resultsDir);
    filesCopied += await copyArtifacts(shard.resultsDir, mergedResults);
    shardInputs.push({ index: shard.index, results });
    process.stdout.write(`  shard ${shard.index}: ${results.length} test result file(s)\n`);
  }

  if (filesCopied === 0 && failOnEmpty) {
    process.stderr.write('No Allure artefacts were found in any shard directory.\n');
    return 1;
  }

  const summary = buildSummary(shardInputs);

  // Allure renders these two files as the report's "Environment" and
  // "Executor" panels — cheap context that makes a downloaded report
  // self-describing months later.
  await writeFile(
    path.join(mergedResults, 'environment.properties'),
    [
      `Environment=${envId}`,
      `Shards=${shardDirs.length}`,
      `Tests=${summary.totals.tests}`,
      `Node=${process.version}`,
      `GitCommit=${process.env.GIT_SHA ?? 'unknown'}`,
      `ImageTag=${process.env.IMAGE_TAG ?? 'unknown'}`,
    ].join('\n') + '\n',
    'utf8',
  );

  await writeFile(
    path.join(mergedResults, 'executor.json'),
    JSON.stringify(
      {
        name: 'GitHub Actions',
        type: 'github',
        buildName: `${envId} — ${shardDirs.length} shards`,
        buildUrl: process.env.BUILD_URL ?? '',
        reportName: 'Ephemeral environment API suite',
      },
      null,
      2,
    ),
    'utf8',
  );

  await writeFile(
    path.join(output, 'summary.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), envId, ...summary }, null, 2),
    'utf8',
  );

  const markdown = renderMarkdownSummary(summary, {
    Environment: envId,
    Shards: String(shardDirs.length),
    Commit: process.env.GIT_SHA ?? 'unknown',
  });
  await writeFile(path.join(output, 'summary.md'), markdown, 'utf8');

  process.stdout.write(`\n${markdown}\n`);
  process.stdout.write(`Merged ${filesCopied} artefact(s) into ${mergedResults}\n`);

  // Distinguishes "aggregation broke" (1) from "aggregation worked, tests
  // failed" (2) so CI can tell an infrastructure problem from a real failure.
  return summary.passed ? 0 : 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
