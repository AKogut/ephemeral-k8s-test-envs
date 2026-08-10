import { defineConfig } from '@playwright/test';

/**
 * API-only Playwright configuration.
 *
 * No `projects` with browsers and no `webServer`: every test speaks HTTP to an
 * already-running environment through the `request` fixture. That is what lets
 * the runner image be built on node:slim instead of the ~2 GB Playwright image
 * — see docs/adr/0002-browserless-test-runner-image.md.
 *
 * Parallelism happens on two levels and they multiply:
 *
 *   shards  — one Kubernetes Job pod per shard   (SHARD_TOTAL)
 *   workers — processes inside a single pod      (PW_WORKERS)
 *
 * A 4-shard run with 2 workers each is 8 concurrent test processes against one
 * environment. `PW_WORKERS` is kept low by default because a shard pod is given
 * a modest CPU limit in values-ci.yaml.
 */

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const shardIndex = process.env.SHARD_INDEX ?? process.env.JOB_COMPLETION_INDEX ?? '0';
const shardTotal = process.env.SHARD_TOTAL ?? '1';

export default defineConfig({
  testDir: './specs',
  outputDir: process.env.PW_OUTPUT_DIR ?? './test-results',

  timeout: intFromEnv('PW_TEST_TIMEOUT_MS', 30_000),
  expect: { timeout: intFromEnv('PW_EXPECT_TIMEOUT_MS', 5_000) },
  globalTimeout: intFromEnv('PW_GLOBAL_TIMEOUT_MS', 10 * 60_000),

  fullyParallel: true,
  workers: intFromEnv('PW_WORKERS', 2),
  retries: intFromEnv('PW_RETRIES', 1),

  // A shard that runs zero tests is legitimate (more shards than spec files),
  // but a shard that was *given* files and matched none is a packaging bug.
  forbidOnly: !!process.env.CI,

  reporter: [
    ['list'],
    [
      'allure-playwright',
      {
        resultsDir: process.env.ALLURE_RESULTS_DIR ?? 'allure-results',
        detail: false,
        environmentInfo: {
          env_id: process.env.ENV_ID ?? 'local',
          shard: `${shardIndex}/${shardTotal}`,
          base_url: process.env.BASE_URL ?? 'http://localhost:3000',
          node: process.version,
        },
      },
    ],
    ['junit', { outputFile: process.env.JUNIT_OUTPUT ?? 'junit/results.xml' }],
  ],

  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    extraHTTPHeaders: {
      accept: 'application/json',
      // Tags every request with its origin so a stray request in a service log
      // can be traced back to the shard that made it.
      'x-test-shard': `${shardIndex}/${shardTotal}`,
    },
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
