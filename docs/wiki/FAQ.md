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

The policy is on by default and default-deny. Whether it does anything depends
on the CNI: kind's ignores NetworkPolicy, Calico and Cilium enforce it. So the
rules are exercised against Calico on every pull request, including a check that
an unlabelled pod cannot reach the services and a control proving it can once
the policy is removed — otherwise "blocked" might only mean a wrong port.

What a namespace does *not* isolate is node resources. One environment can starve
another on a busy cluster. That is why every namespace now carries a
`ResourceQuota` and a `LimitRange`, summed from what the release declares — a pod
asking for more than the environment has left is refused by the API server rather
than left Pending somewhere else.

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

That was once the whole answer. It is now the answer for the *default*:
`database.backend=postgres` brings a StatefulSet, a migration Job that runs
exactly once, readiness that reflects the database, and data services that run
more than one replica. SQLite stays the default because it is what keeps an
environment a three-minute command with nothing to wait for.

See [ADR 0006](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0006-single-replica-data-services.md) for the default and
[ADR 0008](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0008-networked-database-mode.md) for the other mode and what it
costs.

## Why is `replicaCount: 1` on two of the three services? That looks unfinished.

Because SQLite is pod-local. Two replicas of `auth-service` would each have their
own database, a user registered against pod A would not exist for pod B, and the
Service would round-robin between them — producing tests that fail roughly half
the time with a message pointing at the login code rather than at the topology.

Scaling a service whose state lives in the pod is not a demonstration of
horizontal scaling; it is a demonstration of not having thought about state. The
gateway is genuinely stateless, so it runs two replicas and every run exercises
the multi-pod path where it means something.

With `database.backend=postgres` the constraint goes away and both data services
run two replicas — CI proves it by registering an account through the gateway and
requiring every subsequent login to succeed, whichever replica answers.

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
| Results | object storage, in-cluster MinIO | the same client, pointed at a real bucket |
| Ingress | in the chart, off by default | on, with DNS, TLS and a decision about who may reach it |

And the teardown story stops being a tidiness concern and starts being a billing
one.

## What would you do next?

Ten limitations of v1.0 were tracked under the
[Beyond v1.0 milestone](https://github.com/AKogut/ephemeral-k8s-test-envs/milestone/7),
each stating what broke, what "done" would mean, and what was still an open
question rather than a decided plan. **Eight are closed**, and each closed by
making the thing true rather than by rewording the claim:

| | |
|---|---|
| [#82](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/82) | results in object storage, so nothing pins a shard to a node |
| [#83](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/83) | a quota computed from the release, proved by a pod it refuses |
| [#85](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/85) | shard weights measured from a run instead of typed |
| [#87](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/87) | the guarantees measured across runs, not only inside one |
| [#88](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/88) | the direction decided: a reference implementation |
| [#89](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/89) | a networked database mode — StatefulSet, migrations, two replicas |
| [#90](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/90) | the NetworkPolicy enforced against a CNI that means it |
| [#92](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/92) | a pull request from a fork runs the whole pipeline |

Two remain, and both need something this repository cannot decide on its own:

1. **[A run on a managed cluster](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/86)** — turns "no provider dependency" from
   an argument into a result, and is the only thing that would make cost in
   node-hours mean anything. It needs a cluster somebody pays for.
2. **[A preview URL that is actually public](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/84)** — the `Ingress` exists and
   is proved in CI, off by default. Turning it on needs a domain and a decision
   about who may reach it, because a preview URL is a public deployment of
   unreviewed code.
