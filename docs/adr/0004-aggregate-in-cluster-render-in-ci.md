# ADR 0004 — Merge results in the cluster, render the Allure report in CI

**Status:** Accepted · **Date:** 2026-08-10

## Context

Producing one Allure report from N shards is two distinct operations:

1. **Merge** — collect every `*-result.json`, `*-container.json` and attachment
   from `shard-0/`…`shard-N/` into one directory, and reconcile retries so a test
   retried twice is counted once.
2. **Render** — turn that directory into browsable HTML with `allure generate`.

Merging is file copying plus some JSON reasoning. Rendering requires the Allure
commandline, **which is a Java application and needs a JRE**.

The obvious design puts both in the aggregator Job, so `helm install` alone
produces a finished report.

## Decision

The in-cluster aggregator merges and summarises. It never runs `allure generate`.
The HTML report is rendered on the CI runner, which already has a JRE:

```
in-cluster (aggregator Job)          on the runner
─────────────────────────────        ──────────────────────────────
merge shard-*/allure-results   ──►   npx allure-commandline generate
collapse retries                     → results/allure-report/
compute the summary                  → uploaded as a workflow artifact
write summary.json + summary.md
```

## Rationale

**Image size.** Adding a JRE to a Node image roughly triples it. The aggregator
image currently has *no production dependencies at all* — the merge is plain Node —
so it is a slim base plus compiled JavaScript. Pulling a JRE into the cluster to
render HTML that is immediately copied back out is work in the wrong place.

**The valuable output is not the HTML.** `summary.json` and `summary.md` — totals,
per-shard timings, the sequential-versus-sharded speedup, the failure list — are
what gets posted to the pull request and read by a human. Those are produced
in-cluster, so `kubectl logs job/…-aggregate` shows the full verdict without
downloading anything.

**Rendering is a presentation concern.** It belongs where the report is published.
Someone publishing to S3 or GitHub Pages instead of an artifact changes one CI
step and no cluster manifest.

**Allure results are the portable format.** The merged directory is the standard
Allure input, so the report can be rendered by anything — the CLI, the GitHub
action, an Allure server — without the cluster having an opinion.

## Consequences

**Good**

- The aggregator image stays minimal and dependency-free.
- The pass/fail verdict is visible in `kubectl logs` with no tooling.
- Report publishing is swappable without touching the chart.
- The same aggregator binary also hosts `wait-for-jobs` and `self-destruct`, so an
  environment needs four images, not five.

**Bad**

- `helm install` alone does not produce browsable HTML. Someone running
  `local-demo.sh` gets merged results plus a printed summary, and the script tells
  them the one command that renders the HTML. Acceptable: the summary answers
  "did it pass?" and the report answers "why did it fail?", which is the rarer
  question.
- Two places involved in producing one report. Mitigated by the boundary being
  clean — the cluster produces a directory, CI turns it into a page.

## Alternatives considered

**JRE in the aggregator image.** Self-contained, and the report exists the moment
the Job finishes. Rejected on size: a large image pulled once per run to produce
output that leaves the cluster immediately.

**A sidecar with the Allure image.** Keeps the aggregator slim but adds a second
image and a shared-volume handshake between containers, to save one CI step.

**Skip Allure; write a bespoke HTML report.** Tempting — the summary data is
already there. Rejected because Allure gives history, trends, attachments and a
format other tools understand, none of which is worth reimplementing.
