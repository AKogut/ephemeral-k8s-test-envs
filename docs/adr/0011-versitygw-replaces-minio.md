# ADR 0011 — The object store is versitygw, because MinIO stopped shipping images

**Status:** accepted
**Date:** 2026-10-20 · **Amends** [ADR 0007](0007-object-storage-for-shard-results.md)

## Context

[ADR 0007](0007-object-storage-for-shard-results.md) moved shard results to
S3-compatible object storage and gave every environment its own MinIO. The
decision was about the access path — a Service instead of a shared volume — and
MinIO was simply the obvious server to put behind it.

That server stopped being available. MinIO ended community builds in 2025,
archived its repository in April 2026, and removed `minio/minio` from Docker
Hub in September 2026. The pinned image this repository used,
`quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z`, was the last community push
to quay.io, and quay.io now refuses it to anonymous clients:

```
docker: Error response from daemon: unauthorized: access to the requested resource is not authorized
```

Checked again on 2026-10-20: `docker.io/minio/minio` answers 404 and
`quay.io/minio/minio` answers 401 for the repository, the token and the manifest.

Every pull request opened since 2026-10-01 is red on `Shard planner`, which
starts the server for the live S3 tests. The cluster jobs never got that far,
but they would have failed the same way: the chart pulls the same image for
every environment. Pinning, which exists so that an upstream change cannot look
like a regression, could not help with an upstream that is gone.

## Decision

The in-cluster object store is the [Versity S3 Gateway](https://github.com/versity/versitygw)
(`versitygw`), pinned to `ghcr.io/versity/versitygw:v1.9.0`, serving its
`posix` backend from the same `emptyDir` on the same port, 9000, with an
unauthenticated `GET /health` for the probes.

The chart's `minio` values become `objectStore`, and the Service, the component
label and the NetworkPolicy follow. The key named the product rather than the
role, which is how a swap like this one turns into a value that lies about what
it deploys.

Nothing else in ADR 0007 changes: one replica, no PersistentVolume, the same
hand-written client, the same `tests.results.s3.endpoint` escape hatch.

## Rationale

The server has one job in this repository that a stub cannot do: reject what a
real server would reject. That ruled out anything that accepts a request without
checking its signature, and it is the first thing that was measured:

- the full unit suite, including the live S3 tests, passes against it: 219 of
  219, none skipped;
- the same run with a wrong secret fails at the first request — `could not
  create bucket: 403` — and an anonymous listing is refused;
- a listing of 1005 keys comes back as a truncated page of 1000 and a second
  page, which is what the client's continuation loop is written against.

It runs under the chart's security defaults without an exception: uid 1000, a
read-only root filesystem, every capability dropped, no privilege escalation.
Verified with exactly those settings in Docker and then in a kind cluster.

The image is small — 36 MB compressed — and it is published to GHCR, so the
kubelet pulls it without touching Docker Hub's anonymous rate limit, which is
the reason the Postgres image is side-loaded in CI.

It is maintained by a company that ships it, under Apache 2.0, with eleven
releases so far in 2026. That is the property MinIO turned out not to have, and it is the
one this decision is mostly buying.

## Consequences

**Good**

- CI and the chart work again, with no change to what the tests assert.
- The credentials no longer need a fixed prefix. MinIO read a root user that
  began with a lowercase `env` as a reference to resolve rather than as a
  value; versitygw starts with `envABCDEFGHIJKLMNOPQ` and passes the live suite
  with it, so the generated key is plain random text again.
- A shard no longer fails because the store came up after its tests finished.
  The first run of this change on a fresh cluster lost all four shards that way
  — tests green, then `fetch failed` on upload while the store's image was
  still being pulled. The race predates versitygw; a cold pull only made it
  likelier. The uploader now waits up to two minutes for the endpoint to answer
  and then names it and the cause, and was run both ways: a store started 18
  seconds late was waited for and the run passed, and one that never started
  failed every shard with that message.
- The NetworkPolicy test now probes the store's real health path, and its
  control checks the store as well as the two services. Before, the object
  store's "blocked" result came from a path MinIO does not serve, which it would
  have refused with or without a policy.

**Bad**

- versitygw is far less widely known than MinIO. A reader adapting this has to
  trust a smaller project, and the alternatives below are there so that the
  trade can be re-made rather than inherited.
- The `posix` backend stores object metadata in extended attributes. Every
  filesystem this has run on so far supports them; one that does not would
  need the `--sidecar` option.
- It logs every request. That is about 650 lines for one run of the suite, and
  it is left on because "the results vanished" is the failure those lines
  explain.

## Alternatives rejected

**A community MinIO fork** (`pgsty/minio`). The smallest diff — same binary,
same variables, same health paths — and the same exposure that caused this:
it follows an upstream that is archived, almost every commit since October 2025
is one person's, and its last release was in August 2026.

**Build MinIO from source.** Possible from the archived repository, and it would
make this project the maintainer of an object store image, which is the
opposite of what a test fixture should cost.

**RustFS.** The closest look-alike to MinIO, and a reasonable choice once it has
more history: 1.0 shipped on 2026-09-16, and the image is three times the size.

**SeaweedFS or Garage.** Both are real object stores built for clusters, with
the setup that implies — several components, or a layout and key bootstrap
before the first request — for a bucket that lives for one pull request.

**LocalStack.** Its default image needs an auth token to start since 2026.03.0,
and its S3 accepts requests signed with any credentials by default, which would
turn the live tests back into the stub they exist to go beyond.
