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

> **Status: Phase 1 of 5.** Built in the open, one phase per pull request. The
> plan is [6 epics and 42 tasks](#roadmap); this branch delivers the Helm chart
> that turns the application into an isolated, repeatable environment.

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

<sub>Measured with `docker image inspect`, not estimated.</sub>

---

## Roadmap

Planned as 6 epics and 42 tasks, delivered one pull request per phase.

| Phase | Epic | Delivers | Status |
|---|---|---|---|
| 0 | [#1](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/1) | Three containerised services | done |
| 1 | [#2](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/2) | A Helm chart that stands up one isolated environment | **this PR** |
| 2 | [#3](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/3) | The suite sharded across parallel Kubernetes Jobs | planned |
| 3 | [#4](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/4) | Per-shard results merged into one report | planned |
| 4 | [#5](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/5) | Teardown guarantees, and a step that proves them | planned |
| 5 | [#6](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/6) | The end-to-end CI pipeline, docs and wiki | planned |

Board: [Ephemeral K8s test environments](https://github.com/users/AKogut/projects/18)

## Commands

```bash
npm run install:all      # dependencies for the three services
npm run demo             # kind cluster → build → deploy → smoke test → clean up
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
charts/test-env/    The Helm chart — one isolated environment per release
scripts/            local-demo.sh, assert-security-defaults.py
```

## License

MIT — see [LICENSE](LICENSE).
