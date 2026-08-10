# ADR 0001 — A namespace is the unit of an environment, and Helm does not template it

**Status:** Accepted · **Date:** 2026-08-10

## Context

Every ephemeral environment needs an isolation boundary. The candidates:

1. **A cluster per environment.** Perfect isolation. Minutes to create, expensive
   on a cloud provider, and impractical for more than a handful of open PRs.
2. **A namespace per environment.** Isolates names, RBAC, quotas and (with a
   NetworkPolicy) traffic. Created in milliseconds. Deleted with one call that
   cascades to everything inside it.
3. **A name prefix inside one shared namespace.** No isolation at all — one
   `kubectl delete` with a slightly wrong selector takes out someone else's run.

Namespaces are the obvious answer. The real decision is *who creates the
namespace* — the chart, or the thing installing the chart.

The original brief suggested `helm install --set namespace=pr-123`, which implies
the chart templating a `Namespace` object.

## Decision

The namespace is created by Helm's own `--create-namespace` flag and referenced
through `.Release.Namespace`. **The chart does not contain a `Namespace`
template.**

```bash
helm install pr-123 ./charts/test-env \
  --namespace pr-123 --create-namespace \
  --set image.tag=$GITHUB_SHA
```

`envId` defaults to `.Release.Namespace`, so nothing has to be passed twice.

## Rationale

A chart that templates its own namespace creates a resource that contains the
chart's other resources. That inversion causes concrete problems:

- **`helm uninstall` deletes the namespace, and with it everything inside** —
  including objects Helm did not create, such as a PVC annotated
  `helm.sh/resource-policy: keep` holding results CI has not copied out yet.
- **Ordering becomes fragile.** Helm has to create the namespace before anything
  in it, which works by luck of alphabetical ordering rather than by design.
- **Reinstalling is unreliable.** A namespace stuck in `Terminating` blocks the
  next install with an error about a resource that already exists.
- **It fights `kubectl apply`.** Anyone rendering the chart with `helm template`
  and applying it gets a namespace they did not ask for.

Keeping the namespace outside the release makes teardown explicit and ordered:

```bash
helm uninstall pr-123 -n pr-123     # remove the release
kubectl delete namespace pr-123     # then the boundary
```

Two commands instead of one, and both appear in the CI log — which is what lets
the teardown verification added in Phase 4 check them independently.

## Consequences

**Good**

- Teardown is explicit and verifiable; the two steps can fail independently and
  be reported separately.
- The chart works identically under `helm install`, `helm template | kubectl apply`
  and `helm upgrade`.
- Results survive `helm uninstall` long enough to be copied out.

**Bad**

- Callers must remember `--create-namespace`. Mitigated by every documented
  command including it, and by `local-demo.sh` and the CI workflow both doing it.
- Deleting the namespace is a second step that could be forgotten. Mitigated by
  layer 3 of [cost-and-cleanup.md](../cost-and-cleanup.md) and by the verification
  script failing the build if it is skipped.

## Notes

Cluster-scoped objects — the self-destruct `ClusterRole` and `ClusterRoleBinding` —
are *not* removed by deleting the namespace. They carry the namespace name as a
suffix, and the Phase 4 verification checks for them explicitly. This is the
failure mode a namespace-per-environment design most often misses.
