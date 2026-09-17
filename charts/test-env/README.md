# test-env

An ephemeral test environment in one chart: three services, the sharded API suite
that tests them and the storage its results pass through, in an isolated
namespace, parameterised so the same chart produces `pr-123`, `pr-456` and
`demo-local` without editing anything.

## Install

```bash
helm install pr-123 ./charts/test-env \
  --namespace pr-123 --create-namespace \
  --set image.tag=$GITHUB_SHA
```

The namespace is created by Helm rather than templated by the chart — see
[ADR 0001](../../docs/adr/0001-namespace-per-environment.md).

## Uninstall

Both commands, in this order:

```bash
helm uninstall pr-123 -n pr-123
kubectl delete namespace pr-123
```

Uninstall first, so Helm's release record does not linger pointing at a namespace
that no longer exists.

## What it creates

With the default values:

| Kind | Count | Notes |
|---|---:|---|
| Deployment | 4 | gateway (2 replicas), auth-service, notes-service, MinIO for shard results |
| Service | 4 | ClusterIP, one per Deployment |
| Job | 2 | The `Indexed` shard Job running the API suite, and the aggregator that merges its results |
| Secret | 2 | JWT signing key and MinIO credentials, both generated per release |
| ServiceAccount | 2 | The application's, with no permissions and no mounted token; the aggregator's |
| Role + RoleBinding | 1 | The aggregator may `get` the one named shard Job |
| NetworkPolicy | 8 | Default-deny plus the flows the stack needs |
| ResourceQuota + LimitRange | 1 | Summed from what the release declares, so raising `tests.shards` raises it too |

And when asked for:

| Value | Adds |
|---|---|
| `teardown.selfDestruct.enabled=true` | A Job that deletes the namespace after `afterSeconds`, its ServiceAccount, and a `ClusterRole` + `ClusterRoleBinding` pinned to this one namespace |
| `database.backend=postgres` | A Postgres `StatefulSet` and Service, a Secret with a generated password, a ConfigMap init script, one migration Job per service, and two more NetworkPolicies |
| `gateway.ingress.enabled=true` | An `Ingress` at `<namespace>.<domain>` |

## Values

Only the ones worth knowing about. Everything else is commented in
[`values.yaml`](values.yaml).

| Key | Default | |
|---|---|---|
| `envId` | `.Release.Namespace` | Echoed on `x-env-id` by every service |
| `image.registry` | `ghcr.io` | Set empty for locally-built images |
| `image.tag` | `.Chart.AppVersion` | **Set this to the commit SHA in CI** |
| `image.pullPolicy` | `IfNotPresent` | `Never` when side-loading with `kind load` |
| `notes.authMode` | `verify-with-auth-service` | `jwt-only` skips the service-to-service hop |
| `auth.scryptCostLog2` | `12` | Production is 14 — [ADR 0005](../../docs/adr/0005-test-tuned-kdf-cost.md) |
| `gateway.replicaCount` | `2` | The only service that scales by default — [ADR 0006](../../docs/adr/0006-single-replica-data-services.md) |
| `tests.shards` | `4` | Pods in the shard Job; the chart refuses anything outside `1…64` |
| `database.backend` | `sqlite` | `postgres` lets auth and notes scale — [ADR 0008](../../docs/adr/0008-networked-database-mode.md) |
| `gateway.ingress.enabled` | `false` | Requires `gateway.ingress.domain` |
| `teardown.selfDestruct.enabled` | `false` | CI turns it on; interactive use should not |
| `networkPolicy.enabled` | `true` | Inert on a CNI that does not enforce NetworkPolicy, such as kind's default |

## Validation

The chart refuses to render rather than producing a broken environment:

```bash
helm template t charts/test-env --set notes.authMode=nope   # error: must be jwt-only or …
```

CI asserts that invalid values are rejected, because a guard that quietly stopped
guarding looks exactly like one that works.

## Security defaults

- Every pod: `runAsNonRoot`, uid 1000, `fsGroup` set, `seccompProfile: RuntimeDefault`.
- Every container: read-only root filesystem, all capabilities dropped,
  `allowPrivilegeEscalation: false`. Paths that need writing get an explicit
  `emptyDir`.
- Application pods do not mount a service account token.
- The JWT signing key is generated per release and **preserved across upgrades**,
  so redeploying a PR environment does not invalidate tokens mid-run.

## Local use

```bash
helm install demo ./charts/test-env \
  --namespace demo-local --create-namespace \
  --set image.registry= \
  --set image.tag=local \
  --set image.pullPolicy=Never
```

Or run [`scripts/local-demo.sh`](../../scripts/local-demo.sh), which creates the
cluster, builds and side-loads the images, installs the chart and cleans up
afterwards.

## Teardown guarantees

The shard and aggregator Jobs set `ttlSecondsAfterFinished`, the self-destruct Job,
when enabled, removes the namespace if nothing else does, and
[`scripts/verify-teardown.sh`](../../scripts/verify-teardown.sh) proves nothing
survived — see [cost-and-cleanup.md](../../docs/cost-and-cleanup.md).
