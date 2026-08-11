# Local development

Three ways to run this, from fastest feedback to closest to production.

| | Startup | What it exercises | Use it for |
|---|---|---|---|
| **1. Bare Node** | ~2s | Application logic | Writing a service or a test |
| **2. docker compose** | ~40s first time | Images, container config, service DNS | Checking a Dockerfile change |
| **3. kind + Helm** | ~3min first time | Everything — sharding, aggregation, RBAC, teardown | Checking a chart change; the demo |

## Prerequisites

- Node 22+ (`node --version`)
- Docker (for 2 and 3)
- `kind`, `kubectl`, `helm` (for 3)

```bash
brew install kind helm kubectl        # macOS
npm run install:all                   # dependencies for all five packages
```

## 1. Bare Node — the fast loop

```bash
npm run build

export JWT_SECRET=dev-secret SCRYPT_COST_LOG2=12

(cd app/auth-service  && PORT=3001 DATABASE_PATH=:memory: npm start) &
(cd app/notes-service && PORT=3002 DATABASE_PATH=:memory: \
   AUTH_MODE=verify-with-auth-service AUTH_SERVICE_URL=http://127.0.0.1:3001 npm start) &
(cd app/gateway       && PORT=3000 \
   AUTH_SERVICE_URL=http://127.0.0.1:3001 NOTES_SERVICE_URL=http://127.0.0.1:3002 npm start) &

# The whole suite against them
cd tests/api
BASE_URL=http://127.0.0.1:3000 AUTH_URL=http://127.0.0.1:3001 NOTES_URL=http://127.0.0.1:3002 \
  npx playwright test
```

The full 105-test suite takes about a second this way. Useful subsets:

```bash
npx playwright test specs/notes-crud.spec.ts     # one file
npx playwright test -g "cross-user"              # by name
npx playwright test --ui                         # interactive
```

**All three services must share `JWT_SECRET`.** Symptom of getting it wrong:
everything returns `TOKEN_INVALID` even though login succeeds.

## 2. docker compose — checking the images

```bash
npm run compose:up        # build + start all three, wait for health checks
curl -s localhost:3000/readyz | jq

npm run compose:test      # run the suite as a container against the stack
npm run compose:down      # stop and remove volumes
```

This is the quickest way to confirm a Dockerfile change works — a multi-stage
build that compiles on your machine can still fail in a slim runtime stage
because a native module or a file was left behind in the build stage.

### …with the database a network away

```bash
npm run compose:postgres       # the same stack on Postgres, migrations first
npm run compose:postgres:down
```

An overlay, so the default stays three containers and no database to wait for.
It starts Postgres, creates one database per service, runs each service's
migrations as a one-shot container, and only then starts the services — the
same ordering the chart uses, for the reason given in
[ADR 0008](adr/0008-networked-database-mode.md): a process that migrates its own
database on boot has no answer for the second replica doing it at the same time.

`DB_BACKEND` selects the backend and is validated; an unknown value refuses to
boot rather than falling back to SQLite, because a silent fallback means an
environment that passes without testing what it claims.

## 3. kind + Helm — the real thing

```bash
./scripts/local-demo.sh
```

One command: creates the cluster, builds all five images, side-loads them,
installs the chart, runs four shard pods, aggregates, copies results out,
tears everything down, and verifies the teardown.

```bash
./scripts/local-demo.sh --keep          # leave it running to poke at
./scripts/local-demo.sh --shards 8      # more shards
./scripts/local-demo.sh --no-tests      # just the environment
./scripts/local-demo.sh --cleanup-only  # clean up a previous --keep
```

With `--keep`, reach the environment from your machine:

```bash
kubectl -n demo-local port-forward svc/demo-test-env-gateway 8080:80
curl -s localhost:8080/readyz | jq
```

### Rebuilding one service without recreating the cluster

```bash
docker build -t akogut/ephemeral-k8s-test-envs/notes-service:local app/notes-service
kind load docker-image --name ephemeral-test-envs \
  akogut/ephemeral-k8s-test-envs/notes-service:local
kubectl -n demo-local rollout restart deployment/demo-test-env-notes
```

`imagePullPolicy` is `Never` in the local demo, so the cluster only ever uses
side-loaded images — no registry involved.

## Working on the sharder

The plan is pure logic and needs no cluster:

```bash
npm run shard:plan                       # the plan for 4 shards
npm --prefix scripts test                # 90 unit tests
npm --prefix scripts run shard -- --dir tests/api/specs --total 8 --format plan
npm --prefix scripts run shard -- --index 2 --total 4 --format json | jq
```

Rehearse a sharded run without Kubernetes — four processes writing to the same
layout the pods use:

```bash
for i in 0 1 2 3; do
  (cd tests/api && SHARD_INDEX=$i SHARD_TOTAL=4 RESULTS_DIR=/tmp/results \
     BASE_URL=http://127.0.0.1:3000 AUTH_URL=http://127.0.0.1:3001 \
     NOTES_URL=http://127.0.0.1:3002 node run-shard.mjs) &
done
wait
node scripts/dist/aggregate-results.js --input /tmp/results --expect-shards 4
```

## Working on the chart

```bash
npm run helm:lint
helm template preview charts/test-env --namespace preview -f charts/test-env/values-ci.yaml
helm template preview charts/test-env --set tests.shards=16 | grep -E 'completions|parallelism'
```

The chart validates its own inputs, so mistakes fail at render time rather than
as Pending pods:

```bash
helm template t charts/test-env --set tests.shards=0        # rejected
helm template t charts/test-env --set notes.authMode=nope   # rejected
```

## Configuration reference

### auth-service

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | |
| `DATABASE_PATH` | `:memory:` | Chart sets `/data/auth.sqlite` |
| `JWT_SECRET` | dev default | **Required** when `NODE_ENV=production` |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `ephemeral-test-envs/…` | Must match notes-service |
| `JWT_TTL_SECONDS` | `3600` | |
| `SCRYPT_COST_LOG2` | `14` | 12 in test environments — [ADR 0005](adr/0005-test-tuned-kdf-cost.md) |
| `LOG_LEVEL` | `info` | |

### notes-service

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3002` | |
| `DATABASE_PATH` | `:memory:` | Chart sets `/data/notes.sqlite` |
| `AUTH_MODE` | `jwt-only` | Chart sets `verify-with-auth-service` |
| `AUTH_SERVICE_URL` | `http://localhost:3001` | |
| `AUTH_CACHE_TTL_MS` | `5000` | Positive-verification cache |
| `MAX_PAGE_SIZE` | `100` | |

### gateway

| Variable | Default |
|---|---|
| `PORT` | `3000` |
| `AUTH_SERVICE_URL` | `http://localhost:3001` |
| `NOTES_SERVICE_URL` | `http://localhost:3002` |
| `PROXY_TIMEOUT_MS` | `10000` |

### Test runner

| Variable | Default | Notes |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | The gateway |
| `AUTH_URL` / `NOTES_URL` | localhost | For the direct-to-service health specs |
| `SHARD_INDEX` | `JOB_COMPLETION_INDEX`, else `0` | |
| `SHARD_TOTAL` | `1` | |
| `RESULTS_DIR` | `./results` | |
| `PW_WORKERS` | `2` | Processes *inside* one shard |
| `PW_RETRIES` | `1` | |

## Troubleshooting

**Every request returns `TOKEN_INVALID`.** The services do not share
`JWT_SECRET`. Check with
`kubectl -n <ns> get secret <release>-test-env-jwt -o jsonpath='{.data.jwt-secret}' | base64 -d`.

**A port is already in use.** A previous run is still going:
`pkill -f 'dist/index.js'`.

**Shard pods sit in `Pending`.** Not enough CPU on the node. Lower
`tests.shards`, or use `values-ci.yaml`, which is sized for a 4-vCPU machine.

**Shards fail with connection refused.** The environment was not ready. The
runner waits for `/readyz` up to `READY_TIMEOUT_MS`; raise it, or check whether a
deployment is actually failing with `kubectl -n <ns> get pods`.

**`kind load` says the image is not present.** The build failed. Rerun the
`docker build` without `--quiet` to see why.

**A namespace is stuck in `Terminating`.** Usually a finalizer on a pod. Check
`kubectl get all -n <ns>`; `kubectl delete pod --all -n <ns> --force` clears it.
