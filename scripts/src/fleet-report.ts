#!/usr/bin/env node
/**
 * Reads the pipeline's own run history and reports what it says about the
 * claims this project makes.
 *
 *   node dist/fleet-report.js --runs 20
 *
 * Run on a schedule, and exits non-zero when a guarantee is broken rather than
 * merely slower — see `regressions` in fleet.ts for what counts.
 *
 * The data comes from the Actions API, so this needs no cluster and no
 * infrastructure: the fleet of an ephemeral-environment project is its run
 * history, because no environment outlives the run that made it.
 */

import { parseArgs, resolveOption } from './cli.js';
import {
  type ApiJob,
  type ApiRun,
  regressions,
  renderReport,
  type RunReport,
  runReport,
  summarise,
} from './fleet.js';

const USAGE = `
Usage: fleet-report [options]

  --repo <owner/name>   Repository to read          (env: GITHUB_REPOSITORY)
  --token <token>       API token                   (env: GITHUB_TOKEN)
  --workflow <file>     Workflow file               (default: ci.yml)
  --runs <n>            How many runs to read       (default: 20)
  --max-lifetime <s>    Fail above this lifetime    (default: 900)
  --output <path>       Also write the report here
  --help
`.trim();

async function api<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const repo = resolveOption(args, 'repo', ['GITHUB_REPOSITORY'], '')!;
  const token = resolveOption(args, 'token', ['GITHUB_TOKEN'], '')!;
  const workflow = resolveOption(args, 'workflow', [], 'ci.yml')!;
  const count = Number.parseInt(resolveOption(args, 'runs', [], '20')!, 10);
  const maxLifetimeMs =
    Number.parseInt(resolveOption(args, 'max-lifetime', [], '900')!, 10) * 1000;

  if (!repo || !token) {
    process.stderr.write('A repository and a token are required. See --help.\n');
    return 2;
  }

  const base = `https://api.github.com/repos/${repo}`;
  // Completed runs only: one still in flight has no teardown to report yet and
  // would read as a broken guarantee.
  const runs = await api<{ workflow_runs: ApiRun[] }>(
    `${base}/actions/workflows/${workflow}/runs?status=completed&per_page=${count}`,
    token,
  );

  const reports: RunReport[] = [];
  for (const run of runs.workflow_runs) {
    const jobs = await api<{ jobs: ApiJob[] }>(
      `${base}/actions/runs/${run.id}/jobs?per_page=100`,
      token,
    );
    reports.push(runReport(run, jobs.jobs));
  }

  const summary = summarise(reports);
  const report = renderReport(summary, reports);
  process.stdout.write(`${report}\n`);

  const output = resolveOption(args, 'output', ['GITHUB_STEP_SUMMARY'], '');
  if (output) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(output, `${report}\n`);
  }

  const broken = regressions(summary, { maxLifetimeMs });
  if (broken.length > 0) {
    for (const problem of broken) {
      process.stdout.write(`::error::${problem}\n`);
    }
    return 1;
  }

  process.stdout.write('\nEvery environment in this window was proved gone.\n');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
