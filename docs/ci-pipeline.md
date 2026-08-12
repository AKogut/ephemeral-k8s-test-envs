# The CI pipeline

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) takes a pull request
from "opened" to "environment destroyed and proven gone". It is the only
workflow a pull request runs; the other two are
[`fleet.yml`](../.github/workflows/fleet.yml), weekly, and
[`publish-wiki.yml`](../.github/workflows/publish-wiki.yml), on merge.

```
        no cluster needed — all at once                  one cluster each
┌──────────────────────────────────┐              ┌──────────────────────────┐
│ Helm chart          Lint         │              │ NetworkPolicy enforced   │
│ Shard planner       Typecheck    │   Package    │ Preview URL              │
│ API suite typecheck Shell scripts│ ──► ×5 ────► │ Self-destruct            │
│ 3× build image + scan            │   images     │ Environment on Postgres  │
│ compose stack   compose+Postgres │              │ Deploy, test, aggregate, │
└──────────────────────────────────┘              │ tear down                │
                                                  └──────────────────────────┘
```

Seventeen jobs, in three ranks. Nothing in the first rank depends on anything
else, so it all starts at once; `Package` waits for **all** of it; the five
cluster jobs then run in parallel, each creating and destroying its own kind
cluster.

The shape is deliberate. A guarantee that is only checked as a step inside the
main environment job is a guarantee that stops being checked the moment that job
fails earlier for an unrelated reason. So each of the four properties worth
promising — the policy is enforced, the URL works, the environment destroys
itself, it runs on a real database — is a job that stands on its own and says in
its name what it proves.

## Rank 1 — everything that needs no cluster

Split across eleven jobs rather than gathered into one, so a typo in a shell
script does not wait behind a coverage run, and the run page names what broke.

| Job | Catches |
|---|---|
| `Lint` | ESLint with type-aware rules across all five packages |
| `Typecheck and build` | Type errors, and a build that no longer compiles |
| `API suite typecheck` | The same, for the Playwright suite |
| `Shell scripts` | `shellcheck` — shell bugs are otherwise found in production |
| `Shard planner` | 210 unit tests, **gated** at 99% lines / 94% branches / 100% functions, with MinIO alongside so the storage client is tested against a real endpoint; then asserts the plan covers every spec file exactly once |
| `Helm chart` | Lint with both value sets; render at 1, 2, 4, 8, 16 shards; the quota tracks the shard count; no shared volume survives anywhere in the chart; invalid values are **rejected**; security defaults are actually applied |
| `Build <service> image` ×3 | The image builds, is scanned, and starts, serves and shuts down cleanly |
| `Build the test runner image` | The planner works *inside* the image, and no browsers came with it |
| `Build the aggregator image` | It carries no production dependencies, all three entrypoints respond, it merges a synthetic sharded run correctly, a missing shard directory fails aggregation, and the self-destruct entrypoint refuses to run outside a pod |
| `docker compose stack` | The three services agree they are one environment |
| `docker compose stack on Postgres` | Migrations ran, ran *before* the services, and applying them twice changes nothing; the whole suite passes; two replicas share one database |

The chart job is the one worth copying. It is easy to test that a chart renders;
it is more useful to test that it *refuses* to render nonsense:

```bash
for bad in "tests.shards=0" "tests.shards=999" "notes.authMode=nope"; do
  if helm template ci charts/test-env --set "$bad" >/dev/null 2>&1; then
    echo "::error::chart accepted invalid value: $bad"
    exit 1
  fi
done
```

### Every image is scanned where it is built

Each of the five image builds runs Trivy against the image it just loaded — no
rebuild, no separate job pulling from a registry. Two passes:

- **Record** — fixable `HIGH` and `CRITICAL` into GitHub code scanning, one
  category per image. Never fails the build; it is the trend line.
- **Gate** — fixable `CRITICAL` only, `exit-code: 1`.

The gate is narrower than the record on purpose. A build that goes red because a
new advisory landed in an untouched base image trains people to merge past a red
check, which costs more than the advisory. `--ignore-unfixed` follows the same
logic: a vulnerability with no available fix is information, not a decision.

See [SECURITY.md](../SECURITY.md#vulnerability-scanning) for what the first run
found and what was changed because of it.

## Rank 2 — `Package`

Five images, built in parallel with a matrix, and delivered to the cluster jobs
by whichever route the run is allowed to use: pushed to GHCR, or exported as a
docker archive and carried between jobs as an artifact. See
[a pull request from a fork](#a-pull-request-from-a-fork) for why there are two.

**Tagged with the commit SHA, never with a branch name.** An environment must be
pinned to exactly the code that produced it; `:latest` or `:main` on a PR
environment means the report describes something other than the PR.

```yaml
tag: ${{ github.event.pull_request.head.sha || github.sha }}
```

The layer cache is scoped per component:

```yaml
cache-from: type=gha,scope=${{ matrix.component }}
cache-to:   type=gha,scope=${{ matrix.component }},mode=max
```

Without the scope, all five images share one cache key and a change to any one of
them invalidates the other four.

Each image is therefore built twice in a run — once in rank 1, where it is
scanned and exercised, and once here, where it is packaged. That reads like
waste and is not: the second build is a cache hit, and the alternative is a
single job that both gates the image and publishes it, which means an image is
pushed before anything has run against it. The size numbers in the README come
from the rank-1 build, which is the one with a `Report image size` step.

## Rank 3 — the cluster jobs

Five, each on its own kind cluster, all after `Package`. Four exist because the
property they prove would otherwise be a sentence in a document:

| Job | What it proves | How it could pass without meaning anything |
|---|---|---|
| `NetworkPolicy is enforced` | The suite passes with every packet policed, an outside pod is refused — **and reachable once the policy is removed** | Without that last step, a CNI that ignores policy looks identical to one that enforces it |
| `The preview URL reaches the gateway` | A request to `<namespace>.<domain>` reaches the gateway, and the URL dies with the environment | An Ingress that renders is not an Ingress that routes |
| `The self-destruct layer fires, and leaves nothing` | Nobody deletes the namespace and it goes anyway, leaving nothing cluster-scoped — **while a control environment is still standing** | A namespace that was never created is also "gone" |
| `An environment on Postgres` | Migrations ran once before anything served, both data services really run two replicas, an account registered on one exists on the other, the suite passes, and the volume goes with the namespace | Two replicas that never talk to each other prove nothing about a shared database |

The third column is the point. Each of these jobs contains a step whose only job
is to make a false positive impossible, because the failure mode of an
infrastructure assertion is not that it fails — it is that it passes for the
wrong reason.

## `Deploy, test, aggregate, tear down`

### Naming

```bash
pr-<number>     for a pull request
run-<run_id>    for a push or manual dispatch
```

The name is both the namespace and the Helm release, so every object in the
cluster can be traced back to what created it.

### Images go in through the side door

```yaml
- uses: ./.github/actions/load-images
  with:
    from-registry: ${{ env.CAN_WRITE }}
```

Pulling once on the host and side-loading beats configuring registry credentials
inside the kind cluster and having four shard pods each pull the same image. All
five cluster jobs get their images this way, through the one composite action
described under [a pull request from a fork](#a-pull-request-from-a-fork).

### Running the suite

The wait is written to tolerate failure:

```bash
kubectl wait --for=condition=complete --timeout=20m "job/$job" && status=0 || status=1
echo "status=$status" >> "$GITHUB_OUTPUT"
```

`continue-on-error: true`, and the status is stashed for the *final* step. That
ordering is deliberate: a failing test run must still be aggregated, reported,
commented on the PR, and torn down. Failing the job at the point of failure would
skip all four.

Each shard's logs are emitted in a collapsible `::group::`, so a failure is one
click away rather than buried in a wall of output.

### What the run asserts about itself while it is up

Three steps ask questions that only a live environment can answer:

- **The quota actually refuses something.** A pod is submitted that the
  namespace's `ResourceQuota` must reject. A quota nothing has ever bounced is a
  number in a manifest.
- **The shards actually spread across the cluster.** Asserted against the nodes
  that were *schedulable*, not against a fixed number — a run on a cluster with
  one healthy worker should report a smaller spread, not a failure.
- **The report was actually collected.** Checked after teardown, because the
  copy-out step runs against a namespace that is about to stop existing.

And `npm run weights:update` regenerates the shard weights from the durations
this run measured, so the plan the next run computes is informed by the last one.

### Reporting

- `summary.md` → `$GITHUB_STEP_SUMMARY`, so the verdict is on the run page
- `summary.md` → a PR comment, **updated in place** via a hidden marker, so a PR
  with ten pushes has one summary comment rather than ten
- Allure HTML rendered on the runner ([ADR 0004](adr/0004-aggregate-in-cluster-render-in-ci.md))
  and uploaded as an artifact

### Teardown

Every cleanup step is `if: always()`:

```yaml
- name: Tear down the environment
  if: always() && !inputs.keep_environment

- name: Prove the environment is gone
  if: always() && !inputs.keep_environment

- name: Delete the kind cluster
  if: always()
```

And the run is only allowed to go red **after** all of that:

```yaml
- name: Fail the build if any test failed
  if: always()
  run: |
    if [ "${{ steps.tests.outputs.status }}" != "0" ]; then
      echo "::error::The sharded test suite reported failures."
      exit 1
    fi
```

## Concurrency

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

A second push to the same PR cancels the first run. Without this, two runs would
fight over the namespace `pr-123` — one installing while the other tears down.

Cancellation is exactly the case layer 2 of the teardown story cannot cover: a
cancelled job does not run its `if: always()` steps to completion. That is why
`values-ci.yaml` enables the self-destruct Job, which deletes the namespace
regardless of what happens to the runner. See
[cost-and-cleanup.md](cost-and-cleanup.md).

## Permissions

Scoped per job rather than granted once at the top:

```yaml
permissions:
  contents: read            # workflow default; eight jobs never ask for more

# the three image-building jobs:
  security-events: write    # publish the vulnerability scan

# Package:
  packages: write           # push to GHCR

# the five cluster jobs:
  packages: read

# …and Deploy, test, aggregate, tear down, alone:
  pull-requests: write      # post the summary comment
```

## A pull request from a fork

A `pull_request` event from a fork gets a **read-only** `GITHUB_TOKEN` no matter
what the `permissions:` block asks for. That is deliberate on GitHub's part and
cannot be overridden — otherwise anyone could open a pull request that pushes an
image to your registry.

So the workflow computes once, at the top, whether it is holding a token that can
write anything:

```yaml
CAN_WRITE: ${{ !inputs.simulate_fork
            && (github.event_name != 'pull_request'
                || github.event.pull_request.head.repo.full_name == github.repository) }}
```

Four things are gated on it — the registry push, the layer cache **write**, the
code-scanning upload (once per image-building job) and the summary comment.
Everything else runs identically. The `simulate_fork` term is what lets this
repository run the fork path on purpose; see
[running it by hand](#running-it-by-hand).

| | Branch in this repository | Fork |
|---|---|---|
| Images built, scanned, gated on fixable criticals | yes | yes |
| Where the image goes | pushed to GHCR | `type=docker` archive → artifact |
| How the cluster gets it | `docker pull` + `kind load docker-image` | `kind load image-archive` |
| Layer cache | read and written | read only |
| Trivy findings in code scanning | yes | job log only |
| Report | job summary + PR comment | job summary |
| All five cluster jobs | run | **run** |

That last row is the point of the whole arrangement. The obvious fix — skip the
jobs that cannot work on a fork — is worse than the failure it removes: a
skipped job satisfies a required status check, so the most important check in
the pipeline would report success without having run, on precisely the pull
requests that deserve the most scrutiny. The registry is a convenience for
moving five tarballs from one job to the next. Nothing about *testing* the
change needs it.

### Which checks gate a merge

All twenty-three jobs are required by the `main` ruleset. Every one of them runs
unconditionally — no job in this workflow carries an `if:` — so a required check
here cannot be satisfied by a job that was skipped.

The one status check deliberately **not** required is `Trivy`, the code-scanning
result. It is not a job; it is GitHub reporting on a SARIF upload, and a fork
cannot upload one. Requiring it would block every fork pull request on a check
that can never report — while gating nothing, because the vulnerability *gate*
is a step inside each image job and is already required with it. The scan
findings are the trend line; the failure condition is the job.

All five cluster jobs get their images through one composite action,
[`.github/actions/load-images`](../.github/actions/load-images/action.yml), which
takes either route and then asserts that all five references are in every node's
image store — because the chart installs with `pullPolicy: Never`, where a
mislaid image surfaces minutes later as `ErrImageNeverPull` and reads like a
scheduling problem.

## Running it by hand

`workflow_dispatch` takes three inputs:

| Input | Purpose |
|---|---|
| `shards` | Try a different shard count without editing the workflow |
| `keep_environment` | Skip teardown to debug a failure — the self-destruct Job still applies, so it cannot leak permanently |
| `simulate_fork` | Force `CAN_WRITE` false, so the fork path above actually executes here |

`simulate_fork` exists because a path nothing takes is a path nobody has tested.
No pull request in this repository is from a fork, so without it the artifact
route would be exercised for the first time by a stranger's contribution.

## Everything the cluster depends on is pinned

```yaml
KIND_VERSION:    v0.32.0
KIND_NODE_IMAGE: kindest/node:v1.36.1
```

MinIO, Calico and ingress-nginx were pinned from the start, each for the same
stated reason: a dependency that changes underneath a test turns an upstream
release and a real regression into the same red build. The Kubernetes version
was the one left floating — five clusters created by an action whose default
`kind` moves on its own schedule, and a `local-demo.sh` that used whatever
`kind` was on your machine.

That is worse here than it would be elsewhere. This pipeline's subject *is*
reproducible environments, and a local reproduction of a CI failure on a
different Kubernetes than the one that produced it is not a reproduction. Both
numbers are now set in one place, `scripts/local-demo.sh` pins the same node
image, and the badge in the README states the version that actually runs rather
than a floor nothing has ever been tested against.

## Local equivalence

`./scripts/local-demo.sh` performs the same sequence against a local cluster and
shares `verify-teardown.sh` and `fetch-results.sh` with CI — on the same
Kubernetes, which is what makes the word *equivalence* honest. Reproducing a CI
failure locally is one command, not a re-derivation of what the workflow does.

## What is not here

- **Deployment to a persistent cluster.** Out of scope — see the cloud table in
  [architecture.md](architecture.md#what-a-cloud-deployment-would-change).
- **A matrix over Kubernetes versions.** Valuable for a chart meant for public
  consumption; noise here — and this chart is deliberately not meant for it, see
  [ADR 0009](adr/0009-reference-implementation-not-a-platform.md).
- **A `workflow_call` interface.** Same decision: the pipeline is meant to be
  read and reimplemented, not called.
- **Nightly runs of this workflow.** Nothing to catch: there is no long-lived
  environment to drift. What *is* scheduled is
  [`fleet.yml`](../.github/workflows/fleet.yml), weekly — it reads the run
  history rather than deploying anything, because the questions it answers
  (does teardown hold across runs, how long do environments live, is the shard
  split still balanced) cannot be asked from inside a single run.
