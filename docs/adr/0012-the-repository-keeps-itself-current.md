# ADR 0012 — The repository keeps itself current, and says when it cannot

**Status:** accepted
**Date:** 2026-11-19

## Context

From 2026-10-20 the repository ran with no planned work, as maintenance. The
month after showed how much of keeping it healthy still depended on someone
watching:

- **Merges came from outside.** Nine Dependabot pull requests were merged, all
  by `kogut-agent`, an agent outside the repository. One `@types/node` patch
  alone took five pull requests, one per npm package.
- **The base images never moved.** Dependabot's docker job finished in about a
  second without checking anything: it cannot read
  `FROM node:${NODE_VERSION}-trixie-slim`. From 2026-11-09 every image carried
  fixable `zlib1g` and `libapt-pkg` advisories: 25 open code-scanning alerts,
  20 of them HIGH.
- **Seven pins drifted unseen.** versitygw, Calico, the Traefik chart, Helm,
  busybox, curl and the Node patch release all fell behind. Nothing tracked
  versions written into workflow env, chart values or scripts.
- **Flakes needed a person.** A `kind` download that came back without a
  checksum turned two runs of `main` red. A GHCR pull failed a Dependabot pull
  request. Nothing reran either.
- **Nothing checked `main` between commits.** In October, MinIO's image
  disappearing and two new criticals against the base images had left every
  pull request red for three weeks before anyone opened one.
  [ci-pipeline.md](../ci-pipeline.md) had argued that scheduled runs had
  "nothing to catch".

## Decision

The policy lives in the repository and runs on GitHub's own machinery, with no
external agent and no stored secret:

1. Every action is pinned to a commit SHA (#181).
2. Base images are named by tag and digest, so Dependabot can follow them
   weekly. Every runtime stage runs `apt-get upgrade` (#182).
3. CI runs `main` every Monday. A failed run gets one automatic retry, and a
   `main` that is still red opens one `main-red` issue, which closes itself
   when `main` is green again (#183).
4. Dependabot groups its updates: one pull request per kind of update. It
   auto-merges minor, patch and digest updates once the required checks pass,
   and labels majors for a person (#189).
5. Renovate covers only what Dependabot cannot see: versions pinned in
   workflow env, chart values and scripts. Postgres in compose and in the chart
   moves together, and a CI step fails if they differ (#190).
6. [MAINTENANCE.md](../../MAINTENANCE.md) says what runs by itself, what needs
   a person, and which repository settings all of this depends on.

## Rationale

Auto-merge is safe here because of what a merge has to pass. The 23 required
checks build, scan and start every image, run the suite against compose with
both databases, and stand up five kind clusters. Those clusters prove the
NetworkPolicy, the preview URL, self-destruct, Postgres and a sharded run with
a verified teardown. A dependency update that gets through all of that has
earned the merge more than a person glancing at a version number would.

Weekly rather than nightly: upstream moves on a scale of weeks, and every
failure above would have surfaced within a week instead of three.

`apt-get upgrade` rather than waiting for the official image: on 2026-11-19 the
newest `node:26.13.1-trixie-slim` still shipped a `zlib1g` with fixable HIGH and
MEDIUM advisories. With the upgrade, all five images scanned clean at the same
compressed size.

## Consequences

**Good**

- Updates of every kind arrive as at most one pull request each, and merge
  without a person when they pass.
- A new advisory reaches code scanning within a week even if nothing is
  committed. A red `main` becomes an issue someone is notified about, not a
  badge someone has to look at.
- The repository no longer depends on an agent outside it to stay current.

**Bad**

- A merge made by auto-merge with the workflow token does not start a `push`
  run on `main`. That is GitHub's rule against workflow loops. The pull request
  ran the full pipeline, and the Monday run covers `main` as merged.
- Two builds of one commit can differ in Debian patch versions.
- Renovate is a third-party GitHub App. It is free for public repositories,
  and it has to be installed for item 5 to do anything.
- Auto-merge trusts CI completely. A regression the suite cannot see merges as
  readily as a good update. That has always been true of what CI does not test.
- Every merge spends runner minutes, which are free for a public repository.

## Alternatives rejected

**Keep merging with an external agent.** It worked, and the policy then exists
only in that agent's configuration, invisible to anyone reading the
repository. An agent is a good place to handle the cases
[MAINTENANCE.md](../../MAINTENANCE.md) lists as needing a person, and a poor
place for the routine.

**Renovate for everything.** It could replace Dependabot entirely. Dependabot
is built in, needs no app, already handled the security alerts well, and keeps
the grouping and majors policy in a file GitHub validates. Splitting by "what
Dependabot can see" keeps each tool's job unambiguous.

**A token that lets auto-merges trigger CI on `main`.** A personal access token
or an app key stored as a secret would make every merge run the pipeline again
on `main`. It is a long-lived credential in a public repository, for a run the
pull request has already done.

**Nightly runs.** Seven times the runner time for failures that arrive on a
scale of weeks.
