# The CI pipeline

One workflow — [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — takes a
pull request from "opened" to "environment destroyed and proven gone".

```
verify ──► build (5 images, matrix) ──► ephemeral-environment
                                          │
                                          ├─ kind create cluster
                                          ├─ helm install → namespace pr-N
                                          ├─ 4 shard pods run 105 tests
                                          ├─ aggregator merges results
                                          ├─ report → artifact + PR comment
                                          ├─ helm uninstall + delete namespace   (always)
                                          ├─ verify-teardown.sh                  (always)
                                          └─ kind delete cluster                 (always)
```

## Job 1 — `verify`

Everything that does not need a cluster, so a typo fails in under a minute rather
than after a five-minute deploy.

| Step | Catches |
|---|---|
| `npm run lint` | ESLint with type-aware rules across all five packages |
| `npm run typecheck` | Type errors across all five packages |
| `npm run test:coverage` | 90 unit tests — sharding, aggregation, CLI parsing, the cluster client — **gated** at 99% lines / 94% branches / 100% functions |
| `shellcheck scripts/*.sh` | Shell bugs, which are otherwise found in production |
| `npm run helm:lint` | Chart syntax, with default and CI values |
| Render at 1, 2, 4, 8, 16 shards | A chart that only works at the default shard count |
| Assert invalid values are **rejected** | Guards that silently stopped guarding |
| `npm run shard:plan` | Prints the plan into the log, so a bad split is visible |

That fifth row is the one worth copying. It is easy to test that a chart renders;
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

The three image-building jobs each run Trivy against the image they just loaded —
no rebuild, no separate job pulling from a registry. Two passes:

- **Record** — fixable `HIGH` and `CRITICAL` into GitHub code scanning, one
  category per image. Never fails the build; it is the trend line.
- **Gate** — fixable `CRITICAL` only, `exit-code: 1`.

The gate is narrower than the record on purpose. A build that goes red because a
new advisory landed in an untouched base image trains people to merge past a red
check, which costs more than the advisory. `--ignore-unfixed` follows the same
logic: a vulnerability with no available fix is information, not a decision.

See [SECURITY.md](../SECURITY.md#vulnerability-scanning) for what the first run
found and what was changed because of it.

## Job 2 — `build`

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

Each build records its image size into the job summary, which is where the
numbers in the README come from.

## Job 3 — `ephemeral-environment`

### Naming

```bash
pr-<number>     for a pull request
run-<run_id>    for a push or manual dispatch
```

The name is both the namespace and the Helm release, so every object in the
cluster can be traced back to what created it.

### Images go in through the side door

```bash
docker pull "$ref"
kind load docker-image --name ephemeral-test-envs "$ref"
```

Pulling once on the host and side-loading beats configuring registry credentials
inside the kind cluster and having four shard pods each pull the same image.

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
  contents: read          # workflow default

# build:
  packages: write         # push to GHCR

# ephemeral-environment:
  packages: read
  pull-requests: write    # post the summary comment
```

## A pull request from a fork

A `pull_request` event from a fork gets a **read-only** `GITHUB_TOKEN` no matter
what the `permissions:` block asks for. That is deliberate on GitHub's part and
cannot be overridden — otherwise anyone could open a pull request that pushes an
image to your registry.

So the workflow computes once, at the top, whether it is holding a token that can
write anything:

```yaml
CAN_WRITE: ${{ github.event_name != 'pull_request'
            || github.event.pull_request.head.repo.full_name == github.repository }}
```

and four steps are gated on it — the registry push, the layer cache **write**,
the code-scanning upload, and the summary comment. Everything else runs
identically.

| | Branch in this repository | Fork |
|---|---|---|
| Images built, scanned, gated on fixable criticals | yes | yes |
| Where the image goes | pushed to GHCR | `type=docker` archive → artifact |
| How the cluster gets it | `docker pull` + `kind load docker-image` | `kind load image-archive` |
| Layer cache | read and written | read only |
| Trivy findings in code scanning | yes | job log only |
| Report | job summary + PR comment | job summary |
| `Deploy, test, aggregate, tear down` | runs | **runs** |

That last row is the point of the whole arrangement. The obvious fix — skip the
jobs that cannot work on a fork — is worse than the failure it removes: a
skipped job satisfies a required status check, so the most important check in
the pipeline would report success without having run, on precisely the pull
requests that deserve the most scrutiny. The registry is a convenience for
moving five tarballs between two jobs. Nothing about *testing* the change needs
it.

Both cluster jobs get their images through one composite action,
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

## Local equivalence

`./scripts/local-demo.sh` performs the same sequence against a local cluster and
shares `verify-teardown.sh` and `fetch-results.sh` with CI. Reproducing a CI
failure locally is one command, not a re-derivation of what the workflow does.

## What is not here

- **Deployment to a persistent cluster.** Out of scope — see the cloud table in
  [architecture.md](architecture.md#what-a-cloud-deployment-would-change).
- **A matrix over Kubernetes versions.** Valuable for a chart meant for public
  consumption; noise here — and this chart is deliberately not meant for it, see
  [ADR 0009](adr/0009-reference-implementation-not-a-platform.md).
- **A `workflow_call` interface.** Same decision: the pipeline is meant to be
  read and reimplemented, not called.
- **Nightly runs.** Nothing to catch: there is no long-lived environment to drift.
