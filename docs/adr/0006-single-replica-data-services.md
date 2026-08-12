# ADR 0006 — auth-service and notes-service run one replica; only the gateway scales

**Status:** Accepted · **Date:** 2026-08-10

## Context

The chart parameterises `replicaCount` for all three services, and a reviewer
would reasonably expect an ephemeral-environment demo to show horizontal scaling.

But both data services store state in SQLite on an `emptyDir`, which is
**node-local and pod-local**. Two replicas of `auth-service` would each have their
own database file. A user registered against pod A would not exist for pod B, and
the Service would round-robin between them.

The failure that produces is the worst kind: not an error, but a test that fails
roughly half the time, with a message ("Email or password is incorrect") that
points at the login code rather than at the deployment topology.

## Decision

```yaml
auth:    { replicaCount: 1 }   # SQLite is pod-local
notes:   { replicaCount: 1 }   # SQLite is pod-local
gateway: { replicaCount: 2 }   # stateless, so this is the one that scales
```

The gateway runs two replicas by default, in CI as well as locally, so every run
exercises the multi-replica path — load balancing across pods, a
`topologySpreadConstraint`, and a readiness probe that has to be right for two
pods rather than one.

## Rationale

Scaling a service whose state lives in the pod is not a demonstration of
horizontal scaling; it is a demonstration of not having thought about state.
Setting `replicaCount: 3` on `auth-service` would make the chart *look* more
impressive and make the environment silently broken.

The honest version is to scale the component that can be scaled, and to be
explicit about why the others cannot. That is a stronger signal than a replica
count: it says the difference between stateless and stateful workloads is
understood, rather than that a number was raised until it looked good.

The gateway is genuinely stateless — it holds no data, and every request is
independent — so two replicas is a real test of the multi-pod path, not a prop.

## Consequences

**Good**

- The environment is correct at any supported configuration.
- Multi-replica behaviour is still exercised on every run, by the component where
  it is meaningful.
- The constraint is documented at the point of use, in `values.yaml`, where
  someone about to raise the number will see it.

**Bad**

- `auth-service` is a single point of failure within an environment. Irrelevant
  here: the environment lives for minutes and a pod restart is recovered by the
  suite's readiness wait.
- The *default* environment does not demonstrate a horizontally scaled stateful
  service. It took a real database to lift that, which is the substantial
  addition described below and now shipped: `database.backend=postgres` runs two
  replicas of each data service against one database, and CI asserts an account
  registered on one replica exists on the other.

## What scaling the data services would require

The chart is structured so this is a swap rather than a rewrite:

1. Replace SQLite with PostgreSQL — a `StatefulSet` plus a PVC, or a managed
   instance.
2. Point `DATABASE_URL` at it instead of `DATABASE_PATH`.
3. Raise `replicaCount`; the services are otherwise already stateless.
4. Add migrations as a `helm.sh/hook: pre-install,pre-upgrade` Job.

Three of those four are what shipped. The fourth was wrong, and finding out why
is the useful part: a `pre-install` hook runs before the chart's own objects
exist, so it looks for a database this release has not created yet. See
[ADR 0008](0008-networked-database-mode.md).

That list is no longer hypothetical — it is what
[ADR 0008](0008-networked-database-mode.md) implements, behind
`database.backend=postgres`, with SQLite still the default for exactly the
reasons argued here.

Why it stays behind a flag: it adds a database to seed, migrate, wait for and
tear down, and the subject of this project is the environment lifecycle, not the
application's persistence layer. SQLite on an `emptyDir` gives a real database
with real transactions, real constraints and real SQL, with nothing to operate.
An environment that needs the other thing asks for it, and CI asks on every pull
request so that the path stays proven rather than merely available.

Note that `notes-service` still makes a real cross-pod network call to
`auth-service` on every new token, so single-replica does not mean the deployment
is a single process pretending to be a distributed system.
