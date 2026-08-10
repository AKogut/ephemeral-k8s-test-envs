# Runbook

Symptoms first, because that is what you have when something breaks.

## Diagnosing any environment

```bash
NS=pr-123

kubectl -n $NS get pods -o wide
kubectl -n $NS get jobs
kubectl -n $NS describe pod <pod>          # scheduling and probe failures live in Events
kubectl -n $NS logs <pod> --tail=100
kubectl -n $NS logs <pod> --previous       # after a crash loop

# Everything belonging to one environment
kubectl get all -n $NS -l app.kubernetes.io/instance=$NS
```

Every service logs one JSON object per line and stamps `x-request-id` on every
response, so a failing test in the report can be traced to the exact request:

```bash
kubectl -n $NS logs -l app.kubernetes.io/component=notes-service | grep <request-id>
```

---

## Every request returns `TOKEN_INVALID`

The services do not agree on the signing key.

```bash
kubectl -n $NS get secret ${RELEASE}-test-env-jwt -o jsonpath='{.data.jwt-secret}' | base64 -d
kubectl -n $NS get pods -l app.kubernetes.io/component=auth-service \
  -o jsonpath='{.items[0].spec.containers[0].env}' | tr ',' '\n' | grep -i jwt
```

Usually one of:

- Locally, the three processes were started with different `JWT_SECRET` values.
- A pod is left over from a previous release with an older key. The chart's
  `checksum/secret` annotation should roll them; check
  `kubectl -n $NS rollout status deployment/<name>`.
- `jwt.issuer` or `jwt.audience` was overridden for one service only. All three
  must match — the signature check is not the only check.

---

## Shard pods stay `Pending`

```bash
kubectl -n $NS describe pod <shard-pod> | tail -20
```

`Insufficient cpu` or `Insufficient memory` means the node cannot fit the
requests. On a single-node kind cluster the whole environment plus the control
plane shares one machine.

```bash
# Fewer shards
helm upgrade $RELEASE ./charts/test-env -n $NS --reuse-values --set tests.shards=2

# Or the CI values, sized for a 4-vCPU machine
helm upgrade $RELEASE ./charts/test-env -n $NS -f charts/test-env/values-ci.yaml
```

If the message mentions the volume, the results PVC is `ReadWriteOnce` and the
pods were scheduled onto different nodes. On a multi-node cluster set
`tests.results.accessMode=ReadWriteMany` with a storage class that supports it.

---

## Shards fail with `ECONNREFUSED` or the readiness wait times out

The environment was not ready in time. The runner polls `/readyz` for up to
`READY_TIMEOUT_MS` before giving up.

```bash
kubectl -n $NS get pods                    # is anything not Running?
kubectl -n $NS logs -l app.kubernetes.io/component=gateway --tail=50
kubectl -n $NS run curl --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s http://${RELEASE}-test-env-gateway/readyz
```

The gateway is only ready when **both** upstreams are, so a slow auth-service
holds the whole environment not-ready. That is intentional — shards hitting a
half-started environment produce failures that have nothing to do with the code.

Raise the budget if the cluster is just slow:

```bash
helm upgrade $RELEASE ./charts/test-env -n $NS --reuse-values \
  --set tests.readyTimeoutMs=300000
```

---

## The aggregator never finishes

Its initContainer is waiting for the shard Job.

```bash
kubectl -n $NS logs job/${RELEASE}-test-env-aggregate-r1 -c wait-for-shards
kubectl -n $NS get job ${RELEASE}-test-env-shards-r1 -o wide
```

The wait exits when the shard Job is **complete or terminally failed**, so a
genuinely stuck wait means the shard Job is neither — usually a pod still
`Pending`, or one that will never be scheduled.

`Forbidden` in the initContainer log is an RBAC problem: the aggregator's Role
grants `get` on exactly one named Job, and the Job name includes the release
revision. A hand-edited Job name breaks it.

---

## `aggregation reported "Expected 4 shard directories but found 3"`

Deliberate. A shard pod died before writing anything, and reporting a green run
over three quarters of the suite would be worse than failing.

```bash
kubectl -n $NS get pods -l batch.kubernetes.io/job-name=${RELEASE}-test-env-shards-r1
kubectl -n $NS logs <the-failed-pod>
```

Common causes: the pod was OOM-killed (raise `tests.resources.limits.memory`), or
it hit `activeDeadlineSeconds`.

---

## `fetch-results.sh` copies nothing

```bash
kubectl -n $NS get pod ${RELEASE}-test-env-results-exporter
kubectl -n $NS exec ${RELEASE}-test-env-results-exporter -- ls -la /results
```

If the pod is missing, `resultsExporter.enabled` was set to `false`. If `/results`
has `shard-*` but no `merged/`, the aggregator has not finished — check its logs
rather than the copy.

---

## A namespace is stuck in `Terminating`

```bash
kubectl get namespace $NS -o json | jq '.status.conditions'
kubectl get all -n $NS
kubectl delete pod --all -n $NS --force --grace-period=0
```

Almost always a pod with a finalizer or a stuck container runtime. On kind,
deleting the cluster is the quickest answer:

```bash
kind delete cluster --name ephemeral-test-envs
```

---

## `verify-teardown.sh` fails after a successful run

That is the script doing its job. Read which check failed:

- **Cluster-scoped RBAC survived.** The self-destruct `ClusterRole` and
  `ClusterRoleBinding` are *not* namespaced, so deleting the namespace does not
  remove them. `helm uninstall` should — if it was skipped, or the release record
  was lost, they are orphaned:

  ```bash
  kubectl get clusterrole,clusterrolebinding | grep -- "-$NS$"
  kubectl delete clusterrole,clusterrolebinding -l app.kubernetes.io/instance=$NS
  ```

- **A PersistentVolume is still bound.** A `Retain` reclaim policy leaves it
  behind. On a cloud cluster that is a disk still being billed:

  ```bash
  kubectl get pv -o json | jq -r ".items[] | select(.spec.claimRef.namespace==\"$NS\") | .metadata.name"
  ```

- **The Helm release record survived.** `kubectl delete namespace` removed the
  objects but not Helm's record, because the two commands were run in the wrong
  order. Uninstall first, then delete the namespace.

---

## CI: the workflow fails at "Prove the environment is gone"

Same causes as above, but note the ordering: the teardown steps are
`if: always()` and the build is only failed at the very end. So a red run here
means cleanup genuinely did not complete — not that a test failed.

## CI: images fail to push to GHCR

Check the `build` job has `packages: write`, and that the package visibility
allows the repository to pull it back. The first push to a new package creates it
as private and linked to the repository; if the package existed before under a
different repository, it needs to be linked manually.

---

## Finding leaked environments

```bash
kubectl get ns -l app.kubernetes.io/part-of=ephemeral-test-env

kubectl get ns -l app.kubernetes.io/part-of=ephemeral-test-env \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.creationTimestamp}{"\n"}{end}'
```

Remove one properly:

```bash
helm uninstall $NS -n $NS
kubectl delete namespace $NS
./scripts/verify-teardown.sh --namespace $NS --release $NS
```
