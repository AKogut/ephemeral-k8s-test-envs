#!/usr/bin/env node
/**
 * Entrypoint for one shard pod.
 *
 * Responsibilities, in order:
 *
 *   1. Work out which shard this is (`JOB_COMPLETION_INDEX` from the Indexed Job).
 *   2. Wait until the environment under test is actually ready.
 *   3. Ask the sharder which spec files belong to this index.
 *   4. Run Playwright on exactly those files, writing results to
 *      <RESULTS_DIR>/shard-<index>/ on the shared volume.
 *
 * Step 2 matters more than it looks: a Job's pods are scheduled as soon as the
 * Job is created, which can easily be before the Deployments finish rolling out.
 * Without the wait, shard 0 fails on connection-refused and the whole run is red
 * for reasons that have nothing to do with the code under test.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const shardIndex = process.env.SHARD_INDEX ?? process.env.JOB_COMPLETION_INDEX ?? '0';
const shardTotal = process.env.SHARD_TOTAL ?? '1';
const resultsRoot = process.env.RESULTS_DIR ?? path.join(repoRoot, 'results');
const baseUrl = process.env.BASE_URL ?? 'http://localhost:3000';
const readyTimeoutMs = Number.parseInt(process.env.READY_TIMEOUT_MS ?? '120000', 10);
const readyIntervalMs = Number.parseInt(process.env.READY_INTERVAL_MS ?? '2000', 10);

const shardDir = path.join(resultsRoot, `shard-${shardIndex}`);
const allureDir = path.join(shardDir, 'allure-results');
const junitFile = path.join(shardDir, 'junit.xml');

function log(message) {
  process.stdout.write(`[shard ${shardIndex}/${shardTotal}] ${message}\n`);
}

/**
 * Locates the sharder CLI. Compiled inside the runner image; run through tsx
 * from a developer checkout so `npm run test:shard` works without a build step.
 */
function sharderCommand() {
  if (process.env.SHARD_CLI) return ['node', [process.env.SHARD_CLI]];

  const candidates = [
    '/opt/sharder/shard-tests.js',
    path.join(repoRoot, 'scripts', 'dist', 'shard-tests.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return ['node', [candidate]];
  }

  return ['npx', ['--yes', 'tsx', path.join(repoRoot, 'scripts', 'src', 'shard-tests.ts')]];
}

async function waitForReady() {
  const target = `${baseUrl.replace(/\/+$/, '')}/readyz`;
  const deadline = Date.now() + readyTimeoutMs;
  let lastError = 'no attempt made';

  log(`waiting for ${target} (timeout ${readyTimeoutMs}ms)`);

  while (Date.now() < deadline) {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        log(`environment ready after ${readyTimeoutMs - (deadline - Date.now())}ms`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, readyIntervalMs));
  }

  throw new Error(`Environment at ${target} never became ready. Last attempt: ${lastError}`);
}

function resolveShardFiles() {
  const [command, baseArgs] = sharderCommand();
  const args = [
    ...baseArgs,
    '--dir',
    path.join(here, 'specs'),
    '--index',
    String(shardIndex),
    '--total',
    String(shardTotal),
    '--weights',
    path.join(here, 'test-weights.json'),
    '--format',
    'files',
  ];

  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Sharder failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function main() {
  mkdirSync(allureDir, { recursive: true });

  const files = resolveShardFiles();

  if (files.length === 0) {
    // Legitimate when there are more shards than spec files. Playwright would
    // interpret "no file arguments" as "run everything", so this exits instead.
    log('no spec files assigned to this shard — nothing to do');
    writeFileSync(
      path.join(shardDir, 'shard-info.json'),
      JSON.stringify({ shardIndex, shardTotal, files: [], skipped: true }, null, 2),
    );
    return 0;
  }

  log(`assigned ${files.length} spec file(s):\n${files.map((f) => `    - ${f}`).join('\n')}`);

  await waitForReady();

  writeFileSync(
    path.join(shardDir, 'shard-info.json'),
    JSON.stringify({ shardIndex, shardTotal, files, baseUrl, skipped: false }, null, 2),
  );

  const startedAt = Date.now();
  // The binary is invoked directly rather than through npx: npx wants a
  // writable cache directory, and the shard container runs with a read-only
  // root filesystem.
  const playwrightBin = path.join(here, 'node_modules', '.bin', 'playwright');
  const [command, leadingArgs] = existsSync(playwrightBin)
    ? [playwrightBin, []]
    : ['npx', ['--yes', 'playwright']];

  const playwright = spawnSync(
    command,
    [...leadingArgs, 'test', ...files.map((file) => path.join('specs', file))],
    {
      cwd: here,
      stdio: 'inherit',
      env: {
        ...process.env,
        SHARD_INDEX: String(shardIndex),
        SHARD_TOTAL: String(shardTotal),
        ALLURE_RESULTS_DIR: allureDir,
        JUNIT_OUTPUT: junitFile,
        PW_OUTPUT_DIR: path.join(shardDir, 'test-results'),
      },
    },
  );

  log(`finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s with exit code ${playwright.status}`);

  // The exit code is deliberately propagated: the Job should record a failed
  // shard as a failed pod, and the aggregator reports the detail.
  return playwright.status ?? 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`[shard ${shardIndex}] ${error instanceof Error ? error.stack : error}\n`);
    process.exit(1);
  });
