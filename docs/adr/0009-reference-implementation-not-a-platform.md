# ADR 0009 — A reference implementation, not a platform

**Status:** accepted
**Date:** 2026-08-11

## Context

Everything here works, and none of it can be used by another repository without
copying files. The workflow is a single `ci.yml` with this repository's job
names and image list baked in; the chart lives in `charts/test-env/` and is
never packaged; the planner and aggregator ship as images built from this
repository, tagged with this repository's commits.

That is the correct shape for something meant to be *read*, and the wrong shape
for something meant to be *adopted*. The question ([#88](https://github.com/AKogut/ephemeral-k8s-test-envs/issues/88))
was whether to close that gap: publish the chart as an OCI artifact, expose a
`workflow_call` interface, version the planner and aggregator as tools, and
prove the seam with a second consumer whose application is nothing like this
one.

## Decision

**This repository is a reference implementation. It is not a reusable platform
and will not be published as one.**

Adopting the pattern means reading this repository and reimplementing it in
yours. That is the intended path, and the code is arranged to make it possible:
every decision is written down next to the thing it affects, and nothing is
hidden behind an abstraction whose source is somewhere else.

## Rationale

**The cost of a platform is not the packaging.** It is the obligation. Once a
chart is published and a workflow is callable, every change becomes somebody
else's build breaking, and the interface — not the demonstration — becomes the
thing that must be maintained. Compatibility statements, migration notes and a
deprecation policy are the actual work, and they continue forever.

**A bad abstraction is more expensive than none.** The seam is not obvious: the
suite is Playwright-specific, the planner needs only a list of files and their
weights, the chart assumes three services and one gateway. Drawing that line
without a second, genuinely different consumer would produce an interface shaped
entirely by this repository's assumptions — and #88 correctly identified that
finding the assumptions requires the second consumer, which does not exist.

**Clarity is the product here.** The reason `ci.yml` is one file with every job
visible, and the chart is in-tree rather than a dependency, is that a reader can
follow the whole lifecycle without chasing versions across repositories. Making
it reusable would trade exactly that property for portability nobody has asked
for.

**Saying so is better than leaving it ambiguous.** An unstated intention gets
decided by accumulated small choices — a value renamed here, a job name assumed
there — until the answer is "not reusable" without anyone having chosen it. This
is that choice, made deliberately.

## Consequences

**Good**

- No compatibility surface. A value can be renamed when a better name is found,
  and a job can be restructured when the pipeline learns something — which has
  happened repeatedly and would each time have been a breaking change.
- The chart stays specific. It renders three services, a gateway, a bucket and a
  database because that is what this environment is, not because a generic
  chart needed a shape.
- Effort goes into making the reasoning legible rather than into an interface.

**Bad**

- Anyone adopting the pattern copies and adapts it, and their copy drifts from
  this one. There is no upgrade path, because there is nothing to upgrade from.
- The work that would make it reusable — packaging, versioning, a second
  consumer — is genuinely interesting and is not being done.
- "Reference implementation" is easy to say and easy to use as cover for an
  abstraction that was never attempted. The defence is that the reasoning is
  written down, here and in the eight ADRs before it.

## What this does not change

The engineering standard. Being a demonstration is not a licence for a
demonstration-quality pipeline: the teardown is still proved on every run, the
NetworkPolicy is still enforced against a CNI that means it, the coverage gate
still holds, and a claim that cannot be verified still does not get made.

## Alternatives rejected

**Publish the chart and a reusable workflow.** The interface would be a guess in
the absence of a second consumer, and the obligation would outlive the interest.

**Leave it undecided.** Named in #88 as the worst option, and it is: the decision
gets made anyway, by drift, without the argument being had.
