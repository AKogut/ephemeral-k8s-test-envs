#!/usr/bin/env node
/**
 * Regenerates tests/api/test-weights.json from a finished run.
 *
 *   npm run weights:update -- --input results/merged/allure-results
 *
 * The weights decide how spec files are distributed across shards. They were
 * maintained by hand, and the file told readers to run exactly this command —
 * which did not exist. Nothing measured them, and nothing noticed when they
 * stopped being true: the planner falls back to the median for a file it has
 * not seen, so a new spec is assumed average and balance drifts down with no
 * symptom other than a slower run.
 *
 * Exit codes: 0 written, 1 error, 4 nothing usable in the input.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AllureTestResult } from './aggregate.js';
import { parseArgs, resolveOption } from './cli.js';
import { blendWeights, describeChanges, runSpan, weightsFromResults } from './weights.js';

const USAGE = `
Usage: update-weights [options]

  --input <dir>        Merged allure-results from one run   (default: results/merged/allure-results)
  --weights <path>     File to update                        (default: tests/api/test-weights.json)
  --alpha <0..1>       How much of the measurement to keep   (default: 0.5)
  --max-span-minutes   Refuse input covering longer than this (default: 60)
  --dry-run            Print what would change, write nothing
  --help               Show this message

Blending rather than replacing: one run on a loaded machine is noisy, and taking
it whole would swing the plan for no good reason. --alpha 1 replaces outright.
`.trim();

async function readResults(dir: string): Promise<AllureTestResult[]> {
  const entries = await readdir(dir).catch(() => {
    throw new Error(`cannot read ${dir} — run the suite first, or pass --input`);
  });

  const results: AllureTestResult[] = [];
  for (const file of entries.filter((name) => name.endsWith('-result.json'))) {
    try {
      results.push(JSON.parse(await readFile(path.join(dir, file), 'utf8')) as AllureTestResult);
    } catch {
      process.stderr.write(`  warning: skipping unreadable ${file}\n`);
    }
  }
  return results;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const input = resolveOption(args, 'input', ['WEIGHTS_INPUT'], 'results/merged/allure-results')!;
  const target = resolveOption(args, 'weights', ['WEIGHTS_FILE'], 'tests/api/test-weights.json')!;
  const alpha = Number.parseFloat(resolveOption(args, 'alpha', ['WEIGHTS_ALPHA'], '0.5')!);
  const maxSpanMinutes = Number.parseInt(
    resolveOption(args, 'max-span-minutes', ['WEIGHTS_MAX_SPAN_MINUTES'], '60')!,
    10,
  );
  const dryRun = args['dry-run'] === true;

  if (Number.isNaN(alpha)) throw new Error('--alpha must be a number between 0 and 1');

  const results = await readResults(input);
  if (results.length === 0) {
    process.stderr.write(`No results found in ${input}.\n`);
    return 4;
  }

  // Results accumulate when a download directory is reused, and weights taken
  // from several runs at once are inflated by however many happened to be in
  // there. That is a wrong number which looks entirely plausible, so it is
  // refused rather than rounded.
  const span = runSpan(results);
  if (span && span.spanMs > maxSpanMinutes * 60_000) {
    process.stderr.write(
      `The results in ${input} cover ${Math.round(span.spanMs / 60_000)} minutes, which is longer ` +
        `than one run of this suite (--max-span-minutes ${maxSpanMinutes}).\n` +
        `That usually means more than one run is present. Clear the directory and fetch again.\n`,
    );
    return 1;
  }

  const measured = weightsFromResults(results);
  if (Object.keys(measured).length === 0) {
    process.stderr.write(`No spec files could be identified in ${input}.\n`);
    return 4;
  }

  const existingRaw = JSON.parse(await readFile(target, 'utf8').catch(() => '{}')) as Record<
    string,
    unknown
  >;
  const comment = typeof existingRaw._comment === 'string' ? existingRaw._comment : undefined;
  const previous: Record<string, number> = {};
  for (const [key, value] of Object.entries(existingRaw)) {
    if (key !== '_comment' && typeof value === 'number') previous[key] = value;
  }

  const next = blendWeights(previous, measured, alpha);

  process.stdout.write(
    `${results.length} result(s) over ${(span?.spanMs ?? 0) / 1000}s, ` +
      `${Object.keys(measured).length} spec file(s), alpha ${alpha}\n\n`,
  );
  process.stdout.write(`  ${'spec'.padEnd(28)} ${'before'.padStart(8)} ${'after'.padStart(8)}   drift\n`);
  for (const change of describeChanges(previous, next)) {
    const before = change.before === undefined ? '—' : change.before.toFixed(2);
    const drift = change.driftPercent === undefined ? 'new' : `${change.driftPercent > 0 ? '+' : ''}${change.driftPercent}%`;
    process.stdout.write(
      `  ${change.spec.padEnd(28)} ${before.padStart(8)} ${change.after.toFixed(2).padStart(8)}   ${drift}\n`,
    );
  }

  if (dryRun) {
    process.stdout.write(`\nDry run: ${target} not written.\n`);
    return 0;
  }

  const body: Record<string, unknown> = {};
  if (comment) body._comment = comment;
  Object.assign(body, next);
  await writeFile(target, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nWrote ${target}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
