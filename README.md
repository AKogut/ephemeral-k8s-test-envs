# Ephemeral Kubernetes test environments

[![Verify](https://github.com/AKogut/ephemeral-k8s-test-envs/actions/workflows/verify.yml/badge.svg)](https://github.com/AKogut/ephemeral-k8s-test-envs/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Helm](https://img.shields.io/badge/helm-v3-0f1689?logo=helm&logoColor=white)](https://helm.sh/)
[![Node](https://img.shields.io/badge/node-22-5fa04e?logo=node.js&logoColor=white)](https://nodejs.org/)

**Every pull request gets its own Kubernetes namespace. The API suite runs
sharded across parallel Jobs inside it. The results become one report. Then the
namespace is destroyed — and the pipeline proves it.**

No shared staging environment to queue for. No "it passed on staging" where
staging was in an unknown state. No leftover namespaces quietly costing money
after the PR is merged.

> **Status: Phase 2 of 5.** Built in the open, one phase per pull request. The
> plan is [6 epics and 42 tasks](#roadmap); this branch delivers
> sharding: the suite split across parallel Kubernetes Jobs.

---

## Phase 2 — sharding at the infrastructure level

`--workers=4` is one pod with four processes, bounded by that pod's CPU limit.
This is **four pods**, scheduled independently:

```yaml
completionMode: Indexed
completions: 4      # done when indexes 0,1,2,3 have all succeeded
parallelism: 4      # …and they may all run at once
```

Kubernetes injects a distinct `JOB_COMPLETION_INDEX` into each pod. That single
variable is the **only** difference between them. Each pod independently
recomputes the same deterministic plan and takes its own slice:

```
JOB_COMPLETION_INDEX=2 ──► shard-tests --index 2 --total 4 ──► playwright test <its files>
```

**No queue, no broker, no leader.** Nothing is negotiated at runtime, so nothing
can deadlock or double-assign. A rescheduled pod recomputes exactly the slice its
predecessor had.

### The split is weight-aware, not round-robin

A run is only as fast as its slowest shard, so balancing by *file count* is the
wrong objective when one file costs five times another. The planner does LPT
greedy bin-packing weighted by historical duration:

```
$ npm run shard:plan

Shard plan: 11 files across 4 shards
Ideal weight per shard: 12.22 | makespan: 12.50 | balance: 97.8%

  shard 0: 2 file(s), weight 11.90     ← two files, not three
      - auth-me.spec.ts
      - user-journey.spec.ts           ← the 9.5s file gets a shard nearly to itself
  shard 1: 3 file(s), weight 12.50
  shard 2: 3 file(s), weight 12.40
  shard 3: 3 file(s), weight 12.10
```

97.8% of a perfect split. Assigning files to minimise the slowest shard is
multiway number partitioning — NP-hard — and LPT is guaranteed within
4/3 − 1/(3k) of optimal. **The unit tests assert that bound directly**, along with
completeness, determinism across input permutations, and that the plan beats
round-robin when one file dominates.

→ [docs/sharding-strategy.md](docs/sharding-strategy.md)

### The suite

105 black-box API tests across 11 spec files. Four pods hit **one** database, so
isolation cannot come from resetting state between tests — two pods would race.
Instead every test provisions its own user and relies on the service's own
ownership scoping, which means the multi-tenant path is exercised on every run
rather than in one dedicated test.

**Two bugs the suite caught while it was being written**, both now regression-tested:

- `PATCH /notes/:id` silently wiped `body` and `tags`. Zod's `.partial()` makes
  keys optional but **keeps the `.default()` wrappers**, so an absent field still
  resolved to its default. PUT wants that; PATCH must not.
- Searching for `100%` returned nothing. The `%` was escaped with a backslash, but
  **SQLite ignores backslash escapes in `LIKE` unless `ESCAPE '\'` is declared** —
  so the escaping was inert and the filter matched nothing.

### A runner image with no browsers in it

The documented base for a Playwright suite is `mcr.microsoft.com/playwright`,
which is **923 MB compressed** because it ships Chromium, Firefox and WebKit. This
suite never opens a browser — it speaks HTTP through Playwright's `request`
fixture — so the runner is built on `node:22-slim` (**79 MB compressed**) with
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. That saving is multiplied by the shard count
on every run, and CI fails if browsers ever creep back in.
→ [ADR 0002](docs/adr/0002-browserless-test-runner-image.md)

---

## Phase 1 — one command, one isolated environment

```bash
./scripts/local-demo.sh
```

Creates a kind cluster, builds the three images, side-loads them, installs the
chart into its own namespace, waits for readiness, runs a register → login →
create-note journey **from inside the cluster** so it travels through real
Service DNS, and cleans up afterwards. No cloud account.

The same chart produces `pr-123`, `pr-456` and `demo-local` with nothing edited:

```bash
helm install pr-123 ./charts/test-env \
  --namespace pr-123 --create-namespace \
  --set image.tag=$GITHUB_SHA
```

Eight objects: three Deployments, three Services, a generated Secret, and a
ServiceAccount that holds no permissions and mounts no token. Full value
reference in [charts/test-env/README.md](charts/test-env/README.md).

### Defaults the chart applies — and CI asserts

- Non-root, read-only root filesystem, all capabilities dropped,
  `seccompProfile: RuntimeDefault`. Anything that needs to write gets an explicit
  `emptyDir`.
- Application pods mount **no** service account token. A reverse proxy and two
  CRUD services have no business holding a cluster credential.
- Startup, liveness and readiness probes on every container — with liveness never
  touching the database, so a slow query cannot cause a restart loop.
- A JWT signing key generated per release and **preserved across upgrades**, so
  redeploying a PR environment does not invalidate tokens mid-run.
- The gateway runs two replicas; the data services run one, because SQLite is
  pod-local. Scaling a service whose state lives in the pod is not a
  demonstration of scaling.

CI does not take the chart's word for any of it. It renders the manifests and
asserts the security context is genuinely there
([`scripts/assert-security-defaults.py`](scripts/assert-security-defaults.py)),
and asserts the chart **refuses** to render invalid values — because a guard that
quietly stopped guarding looks exactly like one that still works.

---

## Phase 0 — the application under test

The application is not the point of this project; the environment lifecycle is.
But a single service would not exercise anything a single pod could not, so there
would be nothing worth deploying to a namespace and nothing worth sharding a test
suite against.

The smallest system that justifies the infrastructure is an identity service, a
resource service that must trust tokens it did not issue, and an edge that routes
to both.

| Service | Role | Endpoints |
|---|---|---|
| `gateway` | Reverse proxy, request-id propagation | `/auth/*` → auth, `/notes/*` → notes |
| `auth-service` | JWT issuer, SQLite, scrypt via `node:crypto` | `POST /register`, `POST /login`, `GET /me` |
| `notes-service` | Notes CRUD, per-owner scoping, SQLite | `GET/POST/PUT/PATCH/DELETE /notes`, `/notes/stats` |

### The design detail that matters

`notes-service` **could** verify JWTs entirely on its own — it shares the signing
secret, so the check is a local HMAC. It is configured not to.

With `AUTH_MODE=verify-with-auth-service`, the first use of each token triggers a
real `GET /me` against auth-service. That is what turns three co-located pods into
a system that exercises cluster DNS, a bounded verification cache, a timeout, and
a readiness gate that returns **503, not 401**, when the upstream is unreachable —
because "I cannot tell" is not "you are unauthorised".

### Images built for the job they actually do

Three-stage builds. The compiler, the type definitions and the native toolchain
for `better-sqlite3` all stay in the discarded stages.

| Image | Naive single-stage (`node:22`) | This repo (`node:22-slim`, 3-stage) | Reduction |
|---|---:|---:|---:|
| `auth-service` | 1.71 GB | **378 MB** | **78%** |
| `gateway` | 1.67 GB | **351 MB** | **79%** |
| `notes-service` | — | 378 MB | |
| `api-tests` | — | 404 MB | |

<sub>Uncompressed image size as reported by `docker images`, measured rather than
estimated. Both columns use the same measurement, so the comparison is
like-for-like.</sub>

---

## Roadmap

Planned as 6 epics and 42 tasks, delivered one pull request per phase.

| Phase | Epic | Delivers | Status |
|---|---|---|---|
| 0 | [#1](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/1) | Three containerised services | done |
| 1 | [#2](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/2) | A Helm chart that stands up one isolated environment | done |
| 2 | [#3](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/3) | The suite sharded across parallel Kubernetes Jobs | **this PR** |
| 3 | [#4](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/4) | Per-shard results merged into one report | planned |
| 4 | [#5](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/5) | Teardown guarantees, and a step that proves them | planned |
| 5 | [#6](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/6) | The end-to-end CI pipeline, docs and wiki | planned |

Board: [Ephemeral K8s test environments](https://github.com/users/AKogut/projects/18)

## Commands

```bash
npm run install:all      # dependencies for all five packages
npm run demo             # kind cluster → build → deploy → 4 sharded pods → clean up
npm run demo:shards      # …with 8 shards
npm run test:unit        # 46 unit tests for the shard planner, no cluster needed
npm run shard:plan       # print the plan the pods will compute
npm run demo:keep        # …but leave the environment running
npm run demo:cleanup     # remove a previous run's leftovers

npm run helm:lint        # lint the chart with both value sets
npm run helm:template    # render it
npm run compose:up       # the application under docker compose, no cluster
```

## Repository layout

```
app/
  auth-service/     JWT issuer — Express + SQLite + scrypt
  notes-service/    Notes CRUD — per-owner scoping, upstream token verification
  gateway/          Reverse proxy — hand-rolled on fetch, zero proxy dependencies
tests/api/          105 Playwright API tests + the shard entrypoint
scripts/            shard-tests planner (+46 unit tests), local-demo.sh
charts/test-env/    The Helm chart — one isolated environment per release
```

## License

MIT — see [LICENSE](LICENSE).
