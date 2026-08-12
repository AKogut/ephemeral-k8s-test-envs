# Contributing

This is a portfolio project, but it is set up the way a working repository should
be, and pull requests are welcome.

## Before you spend time on a pull request

This is a public repository, so anyone may fork it and open a pull request —
GitHub works that way and there is no setting that changes it. What *is*
restricted is what happens next:

**No workflow runs on a pull request from outside this repository until a
maintainer approves it.** The setting is *Fork pull request workflows from
outside collaborators → require approval for all outside collaborators*, not the
default of "first-time contributors". Until that approval, every check sits
pending and nothing you pushed has executed.

The reason is what this pipeline does. A run creates a Kubernetes cluster, builds
five images, and runs a suite against them. That is not a sandbox worth handing to
an unreviewed branch.

Once approved, **the run is the same one a maintainer's branch gets**, with one
difference you may notice in the logs: your run cannot push to the registry or
publish to code scanning, because a fork's token is read-only whatever the
workflow asks for. So it doesn't try. The images are built exactly as usual and
carried to the cluster job as artifacts instead, and every check that decides
anything — the vulnerability gate, the chart assertions, the enforced
NetworkPolicy, the sharded suite, the teardown proof — runs and is enforced.

Two things are still worth knowing before you start:

- **Merging needs write access.** The `main` ruleset requires a pull request,
  squash merges only, linear history, every review thread resolved, and 23
  passing checks — every job in the workflow — with no bypass actors. An outside
  contributor cannot merge their own work here even after approval.
- **The summary comment will not appear on your pull request.** Posting a comment
  is a write too. The identical report is in the run's job summary.

So: **open an issue first.** For anything beyond a typo it is the faster path,
and it saves you writing a branch nobody had agreed to.

## Getting set up

```bash
npm install              # the linter, at the root
npm run install:all      # dependencies for all five packages
npm run build            # compile the three services and the scripts
npm run test:unit        # 210 unit tests, no cluster required
```

Both installs are needed before linting: the rules are type-aware, so ESLint
builds a TypeScript program per package and a missing `node_modules` turns every
import into `any` — which makes the interesting rules pass silently.

For a full run against a real cluster you also need `docker`, `kind`, `kubectl`
and `helm`:

```bash
./scripts/local-demo.sh
```

See [docs/local-development.md](docs/local-development.md) for the three ways to
run this and a full configuration reference.

## Before opening a pull request

```bash
npm run lint             # ESLint, type-aware, all five packages
npm run typecheck        # all five packages
npm run test:coverage    # the unit tests, with the thresholds CI enforces
npm run helm:lint        # if the chart changed
shellcheck scripts/*.sh  # if a shell script changed
```

`test:coverage` is the one CI runs. The thresholds sit at what the suite already
achieves — 99% lines, 94% branches, **100% functions** — so adding a function
without a test fails the build rather than quietly lowering the number.

`npm run lint:fix` applies what can be fixed mechanically. Disable comments are
allowed where a rule is genuinely wrong about this code, but they must carry a
reason on the line above — and a directive whose rule has stopped firing is an
error, not a leftover.

If you touched the chart, the Jobs or anything on the teardown path, run the full
lifecycle:

```bash
./scripts/local-demo.sh
```

It ends with `verify-teardown.sh`, which is the check that matters most.

## Conventions

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(sharding): weight shards by historical duration
fix(notes): declare ESCAPE so LIKE honours escaped wildcards
docs(adr): record why the runner image ships no browsers
chore(deps): bump express to 5.1.0
```

Scopes in use: `auth`, `notes`, `gateway`, `tests`, `sharding`, `aggregation`,
`chart`, `ci`, `docs`.

**Comments explain why, not what.** The code already says what it does. A comment
earns its place by recording a decision, a constraint or a trap:

```ts
// LIKE wildcards in user input are escaped so a search for "100%" cannot
// silently turn into a match-everything query. SQLite only honours the
// backslash if the ESCAPE clause is spelled out.
```

**Tests assert on contracts, not on prose.** Error codes (`VALIDATION_FAILED`)
are stable; messages are not. Assert on the code so messages can be reworded.

**Decisions with a real alternative get an ADR.** If someone could reasonably
have chosen otherwise, write it down in `docs/adr/`. Nine exist; follow their
shape — context, decision, rationale, consequences (both directions), and the
alternatives that were rejected.

## Adding a test

Add a `.spec.ts` under `tests/api/specs/`. Sharding picks it up automatically —
no registration anywhere.

Two rules keep the suite safe to run across an arbitrary number of pods:

1. **Provision your own data.** Use the `user` / `authed` fixtures. Never assume a
   shared account or a particular starting state; another pod is running at the
   same time against the same database.
2. **Never assert on global counts.** `GET /notes` returns *your* notes, so
   counting them is fine. Anything that counts across users will fail
   intermittently and only under parallelism.

A new file needs no entry in `tests/api/test-weights.json` — the planner weights
an unknown file at the median of the known ones rather than guessing "cheapest".
After a run, regenerate the table from what actually happened:

```bash
npm run weights:update              # blends the measurement into the stored numbers
npm run weights:update -- --dry-run # show the drift, write nothing
```

It refuses input covering more than an hour, because results accumulate if a
download directory is reused and weights taken from several runs at once are
inflated by however many were in there — a wrong number that looks entirely
plausible. Getting weights wrong costs shard balance, never correctness.

## Changing the chart

- Every new value needs a comment in `values.yaml` saying what it is for.
- Anything that could be set to nonsense should be checked in the
  `test-env.validate` helper, so it fails at render time rather than as a Pending
  pod.
- Add the invalid case to the "Helm rejects invalid values" step in
  `.github/workflows/ci.yml`.
- If you add a workload, decide whether it needs a service account token. The
  default is `automountServiceAccountToken: false`, and it should stay that way
  unless the workload genuinely calls the API.

## Documentation

The wiki lives in `docs/wiki/` and is mirrored to the GitHub wiki on merge. Edit
the files here, not the wiki in the browser — a browser edit is overwritten by
the next push to `main`.

**Link between wiki pages with the `.md` extension** — `[Runbook](Runbook.md)`,
not `[Runbook](Runbook)`. The two renderers disagree: `docs/wiki/` is browsed as
ordinary files in the repository, where the extension is required, and the wiki
serves pages without it. The publish workflow strips the extension on the way in,
so writing it the repository's way is what makes the link work in both places.
It also checks that every target exists, because a link to a missing page renders
as plain text in the wiki rather than failing.

## Reporting a bug

Use the bug template. The two most useful things to include are the
`x-request-id` from the failing response and the output of
`kubectl -n <namespace> get pods`.
