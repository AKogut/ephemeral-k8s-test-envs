# test-env

An ephemeral test environment in one chart: three services in an isolated
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

| Kind | Count | Notes |
|---|---:|---|
| Deployment | 3 | gateway (2 replicas), auth-service, notes-service |
| Service | 3 | ClusterIP |
| Secret | 1 | JWT signing key, generated per release |
| ServiceAccount | 1 | No permissions, no mounted token |

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
| `gateway.replicaCount` | `2` | The only service that scales — [ADR 0006](../../docs/adr/0006-single-replica-data-services.md) |
| `networkPolicy.enabled` | `false` | kind's CNI does not enforce it |

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

## Coming in later phases

| Phase | Adds to this chart |
|---|---|
| 2 | An `Indexed` Job that runs the API suite across N shard pods, and the shared results volume |
| 3 | An aggregator Job that merges the per-shard results out of object storage |
| 4 | Job TTLs and a self-destruct Job with namespace-scoped RBAC |
