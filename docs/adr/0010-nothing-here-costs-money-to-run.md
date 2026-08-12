# ADR 0010 — Nothing here costs money to run, and two claims pay for that

**Status:** accepted
**Date:** 2026-08-12

## Context

Every claim in this repository is backed by something that fails when the claim
stops being true. The teardown is proved by a script that greps the cluster for
leftovers. The NetworkPolicy is proved by a pod that must be refused and then
reachable once the policy is removed. The shard split is proved by an assertion
that counts nodes. That is the standard the whole project is built to.

Two claims cannot meet it without a cluster somebody pays for:

- **"The design has no cloud-provider dependency"**
  ([#86](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/86)). Nothing
  in the code references a cloud API, which is a reasonable reading — and it has
  never executed anywhere except `kind`.
- **"Every environment can have a preview URL"**
  ([#84](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/84)). The
  `Ingress` exists, renders from the release name, is proved in CI against a
  real controller, and dies with its namespace. It has never served a person,
  because that needs a reachable cluster and a domain.

The question was whether to buy them.

## Decision

**This project runs end to end on infrastructure that costs nothing: a laptop
and GitHub-hosted runners. The two claims above are not made.**

They are labelled instead — in the README, in the FAQ, and here — as an argument
that has not been converted into a result, with the specific thing that would
convert it.

## Rationale

**A claim with no evidence gets labelled or removed, never left ambiguous.**
Removing them would be dishonest in the other direction: the chart really does
render an `Ingress`, the code really has no provider API in it, and the cloud
table in [architecture.md](../architecture.md#what-a-cloud-deployment-would-change)
is a useful piece of design work. What it is not is a test result, and it now
says so.

**Buying one run buys one day.** A cluster stood up for a single manual run
proves the thing once, and the claim starts decaying immediately — the next
chart change is unverified again. The honest version is the scheduled run named
in #86, which is a recurring bill for a portfolio project, forever.

**Cloud credentials in a public repository's workflow are a real risk, not a
hypothetical one.** #86 anticipated this and proposed a manually dispatched
workflow behind an environment protection rule. That is the right shape, and it
is still a long-lived secret in a repository anyone can fork.

**The gap is smaller than it was, which is what the work bought instead.** Three
rows of #86's "what `kind` never exercises" table are no longer true: the CI
cluster is multi-node, the NetworkPolicy is enforced against Calico with a
negative test *and* a control, and the preview URL is served by a real ingress
controller and routed by hostname. What remains genuinely cloud-only is a real
`StorageClass` with provisioning latency, `imagePullSecrets` instead of
side-loading, a cluster that outlives the run so leaks accumulate, a stricter
PodSecurity baseline, and cost — which the fleet report can already compute in
node-hours the moment there is something to compute it from.

## Consequences

**Good**

- Anyone can reproduce every result in this repository with `git clone` and
  `./scripts/local-demo.sh`. No account, no card, no credentials.
- No secret in this repository is worth stealing.
- The boundary is stated once, in one place, instead of being re-explained
  wherever someone notices it.

**Bad**

- "No provider dependency" stays an argument. A reader is entitled to discount
  it, and should.
- The preview URL is a feature that works and has never been used. It is proved
  by a CI job, which is not the same as being useful to a reviewer.
- Nothing here has met a real `StorageClass`, an `imagePullSecret`, or a cluster
  where a leak costs money — and the leak checks were written for exactly that
  cluster.

## Alternatives rejected

**A free tier.** They exist, they need a card, and they expire. A claim whose
evidence disappears when a trial ends is worse than a claim labelled as
untested, because it looks proved in the archive.

**A long-lived local cluster instead.** More nodes on a laptop proves more about
the chart and nothing about a provider, which is the entire content of #86.

**Delete the cloud table and the `Ingress`.** That would trade a labelled gap
for a smaller project. Both are real design work; neither is a measurement, and
saying which is which costs nothing.
