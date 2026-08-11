# Ephemeral Kubernetes test environments

> Every pull request gets its own Kubernetes namespace. The API suite runs sharded
> across parallel Jobs inside it. The results become one report. Then the namespace
> is destroyed — and the pipeline proves it.

This wiki is the longer-form companion to the
[repository](https://github.com/AKogut/ephemeral-k8s-test-envs). The `README` is
the five-minute version; `docs/` holds the reference material; this is where the
background, the runbooks and the questions the design invites live.

> **This wiki is generated.** Pages live in `docs/wiki/` in the repository and are
> mirrored here on merge to `main`. Editing a page in the browser works right up
> until the next push, which overwrites it. Send a pull request instead.

## Start here

| If you want to… | Go to |
|---|---|
| Run it in five minutes | [Getting started](Getting-Started.md) |
| Understand how it fits together | [`docs/architecture.md`](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/architecture.md) |
| Understand the sharding | [`docs/sharding-strategy.md`](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/sharding-strategy.md) |
| Know how cleanup is guaranteed | [`docs/cost-and-cleanup.md`](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/cost-and-cleanup.md) |
| Fix something that is broken | [Runbook](Runbook.md) |
| Ask "why did you do it that way?" | [FAQ](FAQ.md) and the [ADRs](Design-Decisions.md) |

## The problem

A shared staging environment is a queue. Two people cannot test conflicting
changes at once, a bad deploy blocks everyone, and "it passed on staging" means
"it passed against whatever state staging happened to be in".

The alternative is an environment per change: created when a pull request opens,
destroyed when the run finishes, identical in shape to every other environment,
and cheap enough that nobody thinks twice about creating one.

## What is actually being demonstrated

The application — an auth service, a notes API and a gateway — is deliberately
small. It exists to make a multi-pod namespace and a real service-to-service call
*necessary* rather than decorative. The engineering is everything around it:

1. **An environment described so it can be created N times over.** One Helm chart,
   parameterised, producing `pr-123` and `pr-456` with no editing.
2. **A suite split across pods with no coordinator.** `completionMode: Indexed`
   plus a deterministic plan every pod recomputes for itself — no queue, no
   broker, no leader.
3. **N result directories becoming one report**, with retries collapsed and a
   verdict readable from `kubectl logs`.
4. **Cleanup as a tested property.** Three independent layers, and a CI step that
   fails the build if anything survives.

## Numbers from a real run

| | |
|---|---|
| Tests | 105 across 11 spec files |
| Shards | 4 parallel pods (× 2 workers = 8 concurrent processes) |
| Shard balance | 96.4% of a perfect split |
| Speedup | 3.27× versus sequential |
| Image size | 1.71 GB → 378 MB (78% smaller) via multi-stage builds |
| Unit tests | 72, covering the planner, the merge and the Job-status logic |

## Project management

Work was planned as 6 epics and 42 tasks, delivered as one pull request per phase:

| Phase | Epic | Delivers |
|---|---|---|
| 0 | [#1](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/1) | The three containerised services |
| 1 | [#2](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/2) | The Helm chart |
| 2 | [#3](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/3) | Sharding across Indexed Jobs |
| 3 | [#4](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/4) | Result aggregation |
| 4 | [#5](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/5) | Teardown guarantees |
| 5 | [#6](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/6) | CI, documentation and this wiki |

The board is at
[Projects → Ephemeral K8s test environments](https://github.com/users/AKogut/projects/18).
