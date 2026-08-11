# ADR 0007 — Shard results go to object storage, and the shared volume is removed

**Status:** Accepted · **Date:** 2026-08-11 · **Supersedes part of** [ADR 0001](0001-namespace-per-environment.md)

## Context

Four shard pods produce Allure results that one aggregator has to merge. Until
now they shared a `ReadWriteOnce` PersistentVolumeClaim: every shard wrote
`/results/shard-<n>/`, the aggregator read them all back, and a long-lived
results-exporter pod held the volume open so CI could `kubectl cp` the merged
report out.

`ReadWriteOnce` attaches a volume to exactly one node. Every pod that mounts it
therefore has to be scheduled onto that node.

On the single-node `kind` cluster this project has always used, that costs
nothing and cannot be observed. Given more than one node it is measurable, and
the measurement is the reason for this decision. On a 3-node cluster with two
schedulable workers:

```
shards-r1-0  worker      shards-r1-2  worker
shards-r1-1  worker      shards-r1-3  worker
```

105/105 passed, in 2.9s, reported as a 3.4× speedup. All four shards on one of
the two available machines.

The run is **green**. That is what makes it serious. A failure announces itself;
this does not. Nodes get added, paid for, and the report keeps claiming a
speedup while the parallelism has quietly collapsed onto a single machine. The
metric looks healthy because it is measuring wall clock, and wall clock is real —
it simply is not measuring the thing anyone thinks it is.

Sharding exists to use more than one machine. A storage choice that silently
prevents that contradicts the point of the project.

## Decision

Shard results go to S3-compatible object storage. Each shard writes to a local
`emptyDir` and uploads its directory when it finishes; the aggregator downloads
the run, merges it exactly as before, and uploads the merged report back.
`fetch-results.sh` reads that from the bucket through a port-forward.

An environment brings its own MinIO — one replica, `emptyDir`, no
PersistentVolume — or is pointed at a real bucket with
`tests.results.s3.endpoint`. The chart refuses to render with neither.

**The `pvc` backend is removed rather than kept as an option.** So are
`pvc-results.yaml`, `pod-results-exporter.yaml`, and the `tests.results`
settings that configured them.

The S3 client is written out — SigV4 and four requests — rather than pulled in.
The AWS SDK is ~15 MB of dependencies and would have to ship in two images, the
test runner and the aggregator, which is the same trade already made for the
Kubernetes API in `k8s.ts`.

## Rationale

The access path is what matters here, not durability. Results live for the
length of a pull request and are copied out before the namespace goes, so MinIO
on an `emptyDir` loses nothing — a PersistentVolume would only re-introduce what
this replaces. What changes is that pods reach storage **over a Service**, and a
Service does not constrain scheduling.

The `pvc` backend was removed rather than demoted because it is only safe where
its cost cannot be observed. Keeping it would mean shipping a setting whose
failure mode is a green build — the one kind of failure this repository is
otherwise built to prevent — and a code path exercised only by a render test,
which is how paths rot unnoticed.

## Consequences

**Good**

- Shard pods are scheduled on any node. Measured on the same cluster as above:
  both workers used, with shards reading and writing storage that lives on the
  other node.
- CI asserts it. The environment job runs on two workers and fails if every
  shard lands on one node — false before this change, true after.
- No PersistentVolume, no `ReadWriteMany` storage class to arrange on a cloud
  cluster, and no results-exporter pod. `fetch-results.sh` lost 41 lines.
- Results can outlive the cluster when an external bucket is used, which is what
  a real deployment would want.

**Bad**

- An environment now runs a fourth workload. MinIO costs a pod, an image pull
  and a few seconds of startup that the volume did not.
- Storage is a network dependency. A shard that finishes its tests can still
  fail on upload, and it is written to do exactly that — results that never
  arrive would otherwise become a green report over part of the suite.
- The credentials are one more secret per environment, generated per release.
- With the in-cluster MinIO the results die with the namespace, so `--keep` is
  the only way to inspect them afterwards. The volume had the same property; it
  is simply no longer hidden behind a pod that outlived the Job.
- SigV4 is now this repository's code to maintain. It is covered against AWS's
  own published vectors and against a live MinIO on every CI run, which is the
  price of not taking the SDK.

## Alternatives considered

**Keep the volume and require `ReadWriteMany`.** Works, and moves the problem
into infrastructure: it needs a storage class the cluster may not have (EFS,
Filestore, NFS, Longhorn), which is a dependency a chart cannot assume and a
per-provider decision for anyone adopting this.

**Keep both backends, default to s3.** The middle path, and rejected above: a
backend whose failure is a passing test is not a safe default to leave selectable,
and a render-only test does not keep a path working.

**Have each shard send results to the aggregator directly.** Requires the
aggregator to be running and reachable while shards finish, which reintroduces
ordering between two Jobs — the thing the `wait-for-shards` initContainer exists
to avoid.

**Use the AWS SDK.** Rejected on image size in two images for four requests, per
the reasoning in ADR 0002 and `k8s.ts`. The cost is the maintenance noted above.
