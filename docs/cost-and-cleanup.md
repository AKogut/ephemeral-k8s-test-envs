# Cost and cleanup

Ephemeral environments are easy to create and easy to forget. A namespace that
outlives its pull request costs money every hour on a cloud cluster and quota on
every cluster. This document states exactly what guarantees exist, what they do
*not* cover, and how the claim is proven rather than asserted.

## The claim

> After a run finishes — for any reason, including failure and cancellation —
> nothing created by that run remains in the cluster.

Every word of that is tested. The last step of a CI run is not "deploy succeeded",
it is `verify-teardown.sh` asserting the namespace is gone.

## Three independent layers

No single mechanism covers every failure mode, so there are three, each catching
what the previous one misses.

```mermaid
flowchart TD
    RUN[Test run finishes] --> L1

    L1["Layer 1 — ttlSecondsAfterFinished<br/>on every Job<br/><i>Kubernetes removes finished pods</i>"]
    L2["Layer 2 — helm uninstall + kubectl delete namespace<br/>in an <code>if: always()</code> CI step<br/><i>removes the environment</i>"]
    L3["Layer 3 — self-destruct Job<br/>deletes its own namespace after a TTL<br/><i>runs even if CI never does</i>"]
    V["verify-teardown.sh<br/><i>asserts nothing remains — fails the build if it does</i>"]

    L1 --> L2 --> V
    L3 -.->|"if CI never reaches layer 2"| V
```

### Layer 1 — `ttlSecondsAfterFinished`

Every Job in the chart sets it (900s by default, 600s in CI):

```yaml
ttlSecondsAfterFinished: {{ .Values.tests.ttlSecondsAfterFinished }}
activeDeadlineSeconds: {{ .Values.tests.activeDeadlineSeconds }}
```

The TTL controller deletes the Job and its pods once they finish. `activeDeadlineSeconds`
covers the opposite case: a suite that hangs is killed rather than holding the
namespace open indefinitely.

**What this does not cover:** the Deployments, the Service, the PVC, the namespace.
A TTL on Jobs is pod hygiene, not environment cleanup. Relying on it alone is the
most common way a "self-cleaning" setup quietly leaks.

### Layer 2 — explicit teardown in the pipeline

The primary mechanism, and the one that runs in the normal case:

```yaml
- name: Tear down the environment
  if: always() && !inputs.keep_environment
  run: |
    helm uninstall "$release" -n "$ns" --wait --timeout 3m || true
    kubectl delete namespace "$ns" --wait=true --timeout=5m || true
```

Two details matter more than they look:

- **`if: always()`** — the step runs after a failed deploy, a failed test run, a
  failed aggregation. Teardown gated on success is teardown that never happens on
  the days it matters.
- **`|| true` on each command** — a failed `helm uninstall` must not prevent the
  `kubectl delete namespace` that would have cleaned up anyway. The verification
  step afterwards is what decides whether cleanup actually worked; these two
  commands only have to *try*.

The order is deliberate. `helm uninstall` first, so Helm's release record is
removed and does not linger as an orphan pointing at a namespace that no longer
exists.

**What this does not cover:** the pipeline never reaching the step at all.

### Layer 3 — the self-destruct Job

A cancelled workflow, a runner killed mid-job, a network partition between runner
and cluster: in each case nothing on the CI side ever runs again. Layer 2 is a
promise made by a process that has already died.

So the environment is given the means to remove itself:

```yaml
teardown:
  selfDestruct:
    enabled: true          # on in values-ci.yaml, off by default
    afterSeconds: 1800
```

The Job sleeps for `afterSeconds`, then asks the API server to delete its own
namespace — which also deletes the Job, so the pod is removed as a side effect of
its own last action.

The RBAC is the part worth looking at. Deleting a Namespace needs a cluster-scoped
permission, but it is pinned to exactly one:

```yaml
kind: ClusterRole
rules:
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "delete"]
    resourceNames:
      - pr-123          # this namespace and no other
```

If that token leaked, the worst it could do is delete the namespace it was
already going to delete.

**And a ClusterRole is not deleted with the namespace it names.** That is the
whole reason its name carries the namespace — so a leftover can be found — and
it was also a leak, in the one scenario this layer exists for. When CI comes
back, `helm uninstall` removes the ClusterRole and its binding. When CI never
comes back, nothing did: the namespace went and two grants stayed, each
pointing at a namespace that no longer existed.

The Job now hands both objects to the namespace as an owner, before it sleeps,
and Kubernetes' garbage collector removes them with it:

```yaml
ownerReferences:
  - apiVersion: v1
    kind: Namespace
    name: pr-123
    uid: aa72c739-…        # the uid matters: it distinguishes this namespace
    blockOwnerDeletion: false
```

An ownerReference rather than a second `delete` call, because the Job cannot
remove its own permissions and keep them — deleting the binding first revokes
the right to delete the namespace, and deleting it afterwards races the
invalidation of its own token. The grant it needs for this is `patch` on
exactly those two objects, by name.

### Measured over time, not only per run

Each of the three layers is asserted inside a run. That says nothing about
whether they keep holding, so a scheduled workflow reads the pipeline's own
history — the only fleet this project has, since no environment outlives the
run that made it:

```
| Environments stood up          | 13     |
| Teardown proved                | 13     |
| Self-destruct proved           | 2      |
| Never reached the check        | 2      |
| Median environment lifetime    | 1m 30s |
| Longest                        | 1m 37s |
```

It goes red on a **broken guarantee** — an environment never proved gone, a
self-destruct that failed, a lifetime far enough out to mean something changed
— and not on a run that was merely slower. A report that turns red because a
runner had a bad day is a report people learn to ignore.

That third row exists because the first scheduled run got this wrong. It went
red on *"1 run failed to prove the self-destruct layer fires"*, which was true
of the job and false of the guarantee: the job had died on `docker pull …
denied` before reaching a single assertion. A run that never got to the check
is now counted separately and shown as `?`, and it is never fatal — the report
reads the assertion step rather than the job's conclusion.

Run it against any window by hand:

```bash
npm run fleet -- --runs 20 --max-lifetime 900
```

Two things it deliberately does not measure. **Live environment count**: always
zero, because the cluster is destroyed with the job, so a namespace-age check
would look like observability and measure nothing. **Cost in node-hours**: the
minutes are free on a public repository and the `timing` endpoint reports zero;
wall clock is the honest proxy until there is a cluster somebody pays for.

**This layer is now exercised on every pull request.** A job installs one
environment that destroys itself and one that does not, waits for the first to
disappear with nobody deleting it, runs `verify-teardown.sh` against it, and
requires the second to still be standing — otherwise "the namespace vanished"
would not be evidence of anything. Before that job existed, layer 3 had never
once been observed to work: layer 2 always reached the namespace first.

**Off by default.** Pointing this at an environment somebody is using
interactively via `local-demo.sh` would delete it out from under them. CI turns it
on because CI environments are unattended by definition.

## Proving it, rather than claiming it

Cleanup that is asserted in a README is cleanup nobody has verified.
[`verify-teardown.sh`](../scripts/verify-teardown.sh) runs as the final CI step and
checks four things — three of which survive a namespace deletion:

| Check | Why it is not redundant |
|---|---|
| The namespace does not exist | The headline claim. Waits through `Terminating`, because deletion is not instant. |
| No leftover `ClusterRole` / `ClusterRoleBinding` | **Cluster-scoped.** Deleting the namespace does *not* remove them. This is exactly how a cluster slowly fills with junk from hundreds of PR environments. |
| No `PersistentVolume` still bound to the namespace | A `Retain` reclaim policy leaves released PVs behind. On a cloud cluster each one is a disk that is still being billed. |
| No Helm release record | An orphaned release blocks reinstalling under the same name. |

A failure in any of them fails the build. That is what turns "ephemeral" from a
design intention into a tested property.

## Cost, concretely

On `kind` a leaked namespace costs nothing but the laptop's RAM. The numbers that
follow are for a cloud cluster, where the discipline actually pays.

One environment at the CI resource requests:

| Component | CPU requested | Memory requested |
|---|---:|---:|
| gateway × 2 | 50m | 96Mi |
| auth-service | 25m | 64Mi |
| notes-service | 25m | 64Mi |
| shard pods × 4 (transient) | 400m | 640Mi |
| aggregator (transient) | 50m | 96Mi |
| MinIO (results bucket) | 50m | 128Mi |
| **Steady state after tests finish** | **150m** | **352Mi** |

Those are requests. What an environment is *permitted* to take is a separate
number, and since [issue #83](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/83)
it is enforced rather than implied — a `ResourceQuota` per namespace, summed
from what the release declares plus 20% headroom:

| `tests.shards` | requests.cpu | requests.memory | pods |
|---:|---:|---:|---:|
| 1 | 480m | 883Mi | 11 |
| 4 (default) | 840m | 1574Mi | 14 |
| 16 | 2280m | 4339Mi | 26 |

So a 4-vCPU node fits about four default environments by request, and the ceiling
moves with the shard count rather than being a number someone has to remember to
update. A pod asking for more than the namespace has left is refused by the API
server:

```
Error from server (Forbidden): pods "hog" is forbidden: exceeded quota:
demo-test-env, requested: requests.cpu=5, used: requests.cpu=250m,
limited: requests.cpu=840m
```

That is the difference between one runaway environment and a cluster where the
pods left Pending belong to somebody else's pull request.

150 millicores is small. The problem is never one environment — it is thirty of
them, each left behind by a merged PR nobody thought about again. Thirty leaked
environments is 4.5 vCPU and 10.3 GB of memory reserved permanently, for code
that no longer exists on any branch.

Object storage made this worse, not better, and that is worth stating plainly:
MinIO is a pod that keeps running after the tests finish, where the results
volume was only disk. A leaked environment now costs half again as much CPU. It
buys the shards the ability to run on any node
([ADR 0007](adr/0007-object-storage-for-shard-results.md)), and it makes teardown
matter more rather than less.

At roughly \$0.04 per vCPU-hour, thirty leaked environments cost about **\$130 a
month**, forever, and grow with every merge.

That is the entire argument for treating teardown as a first-class, tested step
rather than a cleanup script somebody runs when the cluster gets full.

## Recovering from a leak

If an environment is left behind — teardown disabled for debugging, a bug in the
chart, a cluster outage during cleanup:

```bash
# What is out there?
kubectl get ns -l app.kubernetes.io/part-of=ephemeral-test-env

# Everything belonging to one environment
kubectl get all -n pr-123 -l app.kubernetes.io/instance=pr-123

# Remove one
helm uninstall pr-123 -n pr-123 && kubectl delete namespace pr-123
./scripts/verify-teardown.sh --namespace pr-123 --release pr-123

# Remove every environment older than a day (dry run first)
kubectl get ns -l app.kubernetes.io/part-of=ephemeral-test-env \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.creationTimestamp}{"\n"}{end}'
```

Every object the chart creates carries
`app.kubernetes.io/part-of: ephemeral-test-env` and
`ephemeral-test-envs.io/env-id: <id>` precisely so that a single label selector can
answer "what is this and who created it?" months later.

## What is deliberately not built

- **A garbage-collection controller.** A CronJob that reaps old namespaces is the
  right answer for a permanent cluster, but it is a piece of long-lived
  infrastructure, and this project's scope is "spin up, test, tear down". The
  self-destruct Job gets the same guarantee without anything permanent to operate.
- **Cost attribution labels.** On a real cluster every namespace would carry
  cost-centre labels for chargeback. Here there is nothing to charge back to.
- **Cross-namespace fairness.** The quota bounds one environment; it does nothing
  about thirty of them filling a cluster between them. That needs a per-cluster
  budget and an admission decision about who gets to create the thirty-first —
  a platform concern rather than a chart one.
