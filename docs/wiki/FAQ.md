# FAQ

The questions this design invites, answered directly.

## Why not just use `playwright test --shard=2/4`?

For many projects that *is* the right answer, and if the weight table is deleted
this project degrades to roughly that behaviour.

Two reasons it is not the answer here:

1. **Playwright's sharding splits by test count.** Count is a poor proxy for
   duration — `user-journey.spec.ts` costs about five times what
   `platform-health.spec.ts` costs — and a run is only as fast as its slowest
   shard.
2. **The whole point is the infrastructure.** `--shard` is a flag. Deciding how
   work is divided, how a pod learns which slice is its own, where results go and
   who merges them is the engineering this project exists to demonstrate.

## Isn't a shared cluster with one namespace per PR still a shared resource?

Yes, and that is the trade. A cluster per PR is stronger isolation and costs
minutes and money per environment. A namespace gives you isolated names, RBAC,
quotas and — with a NetworkPolicy — traffic, in milliseconds and for free.

What a namespace does *not* isolate is node resources. One environment can starve
another on a busy cluster. The answer there is a `ResourceQuota` and a
`LimitRange` per namespace, which is noted as the first thing to add the day this
runs anywhere shared.

## Why is the application so small? It barely does anything.

On purpose. The application is scaffolding: it exists to make a multi-pod
namespace and a genuine service-to-service call *necessary*. A single service
would not exercise anything a single pod could not, so there would be nothing
worth deploying to a namespace and nothing worth sharding a suite against.

Every feature it does have earns its place — filtering, pagination, tag
statistics and ownership scoping exist because they give the suite ~100 genuinely
different things to assert.

## Why does notes-service call auth-service when it could verify the token itself?

It could — it shares the signing secret, and `authMode: jwt-only` does exactly
that. The default is the other mode because a local HMAC check would make the
three services a distributed system in name only.

With `verify-with-auth-service`, the deployment exercises cluster DNS between two
Services, a bounded verification cache, a timeout, and a readiness gate that
returns `503` rather than `401` when the upstream is unreachable — because "I
cannot tell" is not "you are unauthorised". Those are the behaviours a
multi-service environment is supposed to test.

## Why SQLite? Isn't that a toy?

SQLite is a real database with real transactions, real constraints and real SQL —
the `LIKE`/`ESCAPE` bug the suite caught is a genuine SQL bug, not a toy one.
What it is not is a *networked* database, which is why the data services run a
single replica.

Adding Postgres would mean a StatefulSet, a PVC, migrations, a readiness gate and
a seeding step to build, wait for and tear down — all in service of a persistence
layer that is not the subject of this project.
See [ADR 0006](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0006-single-replica-data-services.md).

## Why is `replicaCount: 1` on two of the three services? That looks unfinished.

Because SQLite is pod-local. Two replicas of `auth-service` would each have their
own database, a user registered against pod A would not exist for pod B, and the
Service would round-robin between them — producing tests that fail roughly half
the time with a message pointing at the login code rather than at the topology.

Scaling a service whose state lives in the pod is not a demonstration of
horizontal scaling; it is a demonstration of not having thought about state. The
gateway is genuinely stateless, so it runs two replicas and every run exercises
the multi-pod path where it means something.

## Why not an operator or a CRD? That is the "real" Kubernetes way.

An operator would be a long-lived controller to build, deploy, secure, monitor
and upgrade. It would buy no guarantee that Jobs, a TTL and a self-destruct Job
do not already provide.

"Could this be an operator?" is a good question. "Should this be an operator?"
has a clear answer when the entire scope is *spin up, test, tear down*.

## What stops a namespace leaking if the workflow is cancelled?

That specific case is why there are three layers rather than one. A cancelled
workflow does not run its `if: always()` steps to completion, so the pipeline's
own cleanup is a promise made by a process that has already died.

The self-destruct Job covers it: it sleeps for a TTL and then deletes its own
namespace through the API, using a ClusterRole pinned by `resourceNames` to
exactly that namespace. Deleting the namespace deletes the Job, so the pod is
removed by its own last action.
See [`docs/cost-and-cleanup.md`](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/cost-and-cleanup.md).

## The `verify-teardown.sh` checks look like overkill. The namespace is gone.

Three of its four checks are for things a namespace deletion does **not** remove:

- `ClusterRole` and `ClusterRoleBinding` are cluster-scoped.
- A `PersistentVolume` with a `Retain` reclaim policy survives its claim — on a
  cloud cluster, that is a disk still being billed.
- The Helm release record is stored separately and blocks reinstalling under the
  same name.

Those are exactly how a cluster fills with junk from hundreds of PR environments
while everyone believes cleanup is working.

## Why does the aggregator not just render the Allure HTML?

`allure generate` is a Java application. Adding a JRE to the aggregator image
roughly triples it, to produce HTML that is immediately copied out of the cluster.

The valuable output — totals, per-shard timings, the speedup, the failure list —
is produced in-cluster and readable with `kubectl logs`. Rendering is a
presentation concern and belongs where the report is published.
See [ADR 0004](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0004-aggregate-in-cluster-render-in-ci.md).

## How do 4 pods share one database without the tests interfering?

They do not reset state — two pods would race. Instead every test provisions its
own user with a UUID email, and `notes-service` scopes every query to the
authenticated owner. Tests are isolated by the application's own tenancy model.

The pleasant side effect is that the multi-tenant path is exercised on every
single run rather than in one dedicated test. The rule for contributors is
therefore: never assert on a global count, only on your own data.

## Why HS256 with a shared secret rather than JWKS?

Because the property being demonstrated — one service validating a token another
service issued, including issuer and audience — survives the simplification, and
JWKS would add a key-pair generator, a JWKS endpoint, fetch-and-cache logic, `kid`
handling and a rotation story whose payoff is entirely in the application layer.

The honest cost is real and worth stating: `notes-service` holds the signing key,
so it *could* mint tokens.
See [ADR 0003](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0003-shared-secret-jwt.md).

## Lowering the scrypt cost in tests weakens security, doesn't it?

In the environment, yes — deliberately, for accounts that exist for seconds and
are destroyed with the namespace. The application default stays at the production
value, so a deployment that sets nothing gets the safe number, and `auth-service`
refuses to start with `NODE_ENV=production` and no explicit `JWT_SECRET`.

The alternative people usually reach for is worse: swapping the KDF for something
fast in test builds, which means the production hashing path is never exercised
at all.
See [ADR 0005](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0005-test-tuned-kdf-cost.md).

## How would this change on EKS or GKE?

The design has no provider dependency, but four things move:

| | kind | Cloud |
|---|---|---|
| Cluster | created per run | long-lived; the *namespace* is the ephemeral unit |
| Images | `kind load` | pulled from a registry with credentials |
| Result volume | RWO local-path | RWX, or object storage |
| Ingress | `port-forward` | a route per namespace, `pr-123.preview.example.com` |

And the teardown story stops being a tidiness concern and starts being a billing
one.

## What would you do next?

In order:

1. **Object storage for results**, removing the shared-volume constraint entirely
   and letting shards run on any node.
2. **Per-namespace `ResourceQuota`**, so one runaway environment cannot starve a
   shared cluster.
3. **Weights regenerated automatically** from each run's JUnit output, so shard
   balance improves on its own as the suite grows.
4. **A preview URL per environment** — the piece that makes these useful to people
   who are not running the tests.
