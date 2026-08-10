# Getting started

## The five-minute version

```bash
git clone https://github.com/AKogut/ephemeral-k8s-test-envs.git
cd ephemeral-k8s-test-envs
./scripts/local-demo.sh
```

Needs `docker`, `kind`, `kubectl` and `helm`. No cloud account, no configuration,
roughly three minutes.

That single command creates a cluster, builds five images, side-loads them,
installs the chart into a namespace, runs 105 tests across 4 parallel pods,
merges the results, copies the report out, destroys everything, and then asserts
that nothing survived.

```bash
brew install kind helm kubectl        # macOS, if you need them
```

## What you will see

Five phases, in order:

**1. Cluster and images**

```
==> Creating kind cluster 'ephemeral-test-envs'
    ✓ cluster ready
==> Building images (tag: local)
    ✓ built 5 images
==> Loading images into the cluster
    ✓ images available to the cluster
```

**2. The environment**

```
==> Installing the chart into namespace 'demo-local'
==> Waiting for the application to become ready
    ✓ all deployments available

NAME                                     READY   STATUS
demo-test-env-auth-79c9d8d7cd-mmzsg      1/1     Running
demo-test-env-gateway-6465789854-chhrt   1/1     Running
demo-test-env-gateway-6465789854-pcl8z   1/1     Running
demo-test-env-notes-684464c798-vxmld     1/1     Running
demo-test-env-shards-r1-0-tsrm7          1/1     Running
demo-test-env-shards-r1-1-c5rlg          1/1     Running
demo-test-env-shards-r1-2-bgqh2          1/1     Running
demo-test-env-shards-r1-3-86wcg          1/1     Running
```

Four shard pods from **one** Job object, each running a different slice.

**3. The run**

```
--- shard 0 (demo-test-env-shards-r1-0-tsrm7) ---
  ✓ specs/auth-me.spec.ts:4:3 › GET /auth/me › returns the authenticated user
  …
  13 passed (3.0s)
[shard 0/4] finished in 3.6s with exit code 0
```

**4. The report**

```
## ✅ All tests passed
| Total | Passed | Failed | Broken | Skipped | Flaky | Retries |
| 105   | 105    | 0      | 0      | 0       | 0     | 0       |

Sequential cost would have been 9.2s; the run took 2.8s
— a 3.27× speedup (81.6% shard efficiency).
```

**5. The teardown, and the proof**

```
==> Verifying teardown of namespace demo-local
    ✓ namespace 'demo-local' does not exist
    ✓ no leftover clusterroles
    ✓ no leftover clusterrolebindings
    ✓ no orphaned PersistentVolumes
✓ Teardown verified: nothing from this environment remains.
```

## Poking at a live environment

```bash
./scripts/local-demo.sh --keep

kubectl -n demo-local port-forward svc/demo-test-env-gateway 8080:80

curl -s localhost:8080/readyz | jq
curl -s -X POST localhost:8080/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.test","password":"correct-horse-battery-staple"}'

TOKEN=$(curl -s -X POST localhost:8080/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.test","password":"correct-horse-battery-staple"}' | jq -r .token)

curl -s -X POST localhost:8080/notes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Hello","tags":["demo"]}' | jq

curl -s localhost:8080/notes -H "authorization: Bearer $TOKEN" | jq
```

Clean up afterwards:

```bash
./scripts/local-demo.sh --cleanup-only
```

## Other ways in

**Without Kubernetes at all**, if you only want to see the shard planner:

```bash
npm --prefix scripts install
npm run shard:plan          # prints the plan for 4 shards
npm run test:unit           # 72 unit tests
```

**Just the application**, under docker compose:

```bash
npm run compose:up
curl -s localhost:3000/readyz | jq
npm run compose:test
npm run compose:down
```

**More shards:**

```bash
./scripts/local-demo.sh --shards 8
```

Note that wall clock is bounded from below by the heaviest single *file* — 8
shards over 11 spec files will not be twice as fast as 4.

## Where to go next

- [`docs/architecture.md`](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/architecture.md) — how it fits together
- [`docs/local-development.md`](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/local-development.md) — three dev loops and the full config reference
- [Runbook](Runbook) — when something breaks
