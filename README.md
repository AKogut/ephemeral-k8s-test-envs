# Ephemeral Kubernetes test environments

[![Verify](https://github.com/AKogut/ephemeral-k8s-test-envs/actions/workflows/verify.yml/badge.svg)](https://github.com/AKogut/ephemeral-k8s-test-envs/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22-5fa04e?logo=node.js&logoColor=white)](https://nodejs.org/)

**Every pull request gets its own Kubernetes namespace. The API suite runs
sharded across parallel Jobs inside it. The results become one report. Then the
namespace is destroyed — and the pipeline proves it.**

No shared staging environment to queue for. No "it passed on staging" where
staging was in an unknown state. No leftover namespaces quietly costing money
after the PR is merged.

> **Status: Phase 0 of 5.** This is being built in the open, one phase per pull
> request. The plan is tracked as [6 epics and 42 tasks](#roadmap); this branch
> delivers the application the environments will run.

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
a system that exercises service discovery, a bounded verification cache, a
timeout, and a readiness gate that returns **503, not 401**, when the upstream is
unreachable — because "I cannot tell" is not "you are unauthorised".

### Run it

```bash
npm run install:all
npm run compose:up

curl -s localhost:3000/readyz | jq

TOKEN=$(curl -s -X POST localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.test","password":"correct-horse-battery-staple"}' >/dev/null &&
  curl -s -X POST localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.test","password":"correct-horse-battery-staple"}' | jq -r .token)

curl -s -X POST localhost:3000/notes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Hello","tags":["demo"]}' | jq

npm run compose:down
```

### Images built for the job they actually do

Every image is a three-stage build — production dependencies, compile, runtime.
The compiler, the type definitions and the native toolchain for `better-sqlite3`
all stay in the discarded stages.

| Image | Naive single-stage (`node:22`) | This repo (`node:22-slim`, 3-stage) | Reduction |
|---|---:|---:|---:|
| `auth-service` | 1.71 GB | **378 MB** | **78%** |
| `gateway` | 1.67 GB | **351 MB** | **79%** |
| `notes-service` | — | 378 MB | |

<sub>Measured with `docker image inspect`. Every container also runs as a
non-root user with a `HEALTHCHECK` that needs no extra tooling in the image.</sub>

---

## Roadmap

Planned as 6 epics and 42 tasks, delivered one pull request per phase.

| Phase | Epic | Delivers | Status |
|---|---|---|---|
| 0 | [#1](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/1) | Three containerised services | **this PR** |
| 1 | [#2](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/2) | A Helm chart that stands up one isolated environment | planned |
| 2 | [#3](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/3) | The suite sharded across parallel Kubernetes Jobs | planned |
| 3 | [#4](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/4) | Per-shard results merged into one report | planned |
| 4 | [#5](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/5) | Teardown guarantees, and a step that proves them | planned |
| 5 | [#6](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/6) | The end-to-end CI pipeline, docs and wiki | planned |

Board: [Ephemeral K8s test environments](https://github.com/users/AKogut/projects/18)

## Repository layout

```
app/
  auth-service/     JWT issuer — Express + SQLite + scrypt
  notes-service/    Notes CRUD — per-owner scoping, upstream token verification
  gateway/          Reverse proxy — hand-rolled on fetch, zero proxy dependencies
```

## License

MIT — see [LICENSE](LICENSE).
