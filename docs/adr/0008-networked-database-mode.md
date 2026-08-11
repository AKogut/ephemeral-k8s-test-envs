# ADR 0008 — A networked database mode, alongside the pod-local one

**Status:** accepted
**Date:** 2026-08-11
**Supersedes nothing.** [ADR 0006](0006-single-replica-data-services.md) is still
right about the default; this adds the mode it rules out.

## Context

`auth-service` and `notes-service` keep their data in SQLite, inside the pod.
ADR 0006 argues that choice and it holds: an environment that stands up in
three minutes and needs no database to wait for is worth a great deal, and the
data lives for the length of a pull request.

What it also means is that `replicaCount: 1` is forced — two replicas would
each hold their own database — and that nothing in this project ever exercises
the part of a deployment most people find hardest:

- a `StatefulSet`, or a volume claim template
- a database whose readiness has to be waited on before the application starts
- a schema migration that must run **exactly once**, before the rollout
- a connection pool, and what it does when the database restarts underneath it
- a service that genuinely scales horizontally against shared state

"How do you stand up an environment" is the question this repository answers,
and it was answering it while stepping around the difficult half.

## Decision

Add a **second backend**, selected by `DB_BACKEND`, with SQLite as the default.

- `DB_BACKEND=sqlite` — unchanged. `local-demo.sh` stays a three-minute command
  and `docker compose up` stays three containers.
- `DB_BACKEND=postgres` — the store is a connection pool against Postgres, one
  database per service, schema owned by a migration that runs before the
  application does.

Four decisions inside that:

**The backend is named, not inferred.** Selecting Postgres by "is `DATABASE_URL`
set" makes a misspelled variable mean *quietly use SQLite* — an environment that
works, passes, and is not testing what it claims. `DB_BACKEND` is validated and
an unknown value refuses to boot.

**The service never migrates its own database.** A process that ensures its
schema on startup has no answer for the second replica doing the same thing at
the same time, and no way to fail a deployment rather than the request that
happened to arrive first. Migrations are a numbered, append-only list applied
under a `pg_advisory_lock` and recorded in `schema_migrations`, by a separate
entrypoint (`node dist/migrate.js`) that the chart runs as a Job and compose
runs as a one-shot container. Running it twice applies nothing; running two at
once makes the second wait and then find its work done.

**One database per service, not one shared database.** This was not the first
attempt. Both services started out pointed at the same database, and the first
run failed on `duplicate key value violates unique constraint
"schema_migrations_pkey"` — each service numbers its migrations from 1 and they
were sharing one ledger. Splitting the ledger would have fixed the symptom;
splitting the databases fixes what the symptom was pointing at, and makes each
service's advisory lock correct without coordination, since those locks are
scoped to a database.

**The interface became async first, in its own change** ([#103](https://github.com/AKogut/ephemeral-k8s-test-envs/pull/103)).
`better-sqlite3` is synchronous and the store interface was too. That shape is
what decides whether a networked backend is a swap or a rewrite of every call
site.

## Consequences

**Good**

- The environment can exercise a `StatefulSet`, an ordered start, a migration
  that runs exactly once, and a pool — the things that were missing.
- Both data services can run more than one replica. Verified: two
  `auth-service` replicas behind the gateway, 20 of 20 logins succeeding
  against accounts registered through whichever replica answered.
- A lost race on a unique index is now a **409, not a 500**, on both backends.
  Checking "is this email taken" and then inserting is two statements, and with
  two replicas the gap between them is real. The index decides; its error is
  translated.
- The API contract did not move. The full suite — 105 tests — passes unchanged
  against Postgres.

**Bad**

- Two implementations of each store, which can drift. The suite runs against
  both in CI, which is the only reason this is a cost rather than a trap.
- Three places where the obvious translation would have changed behaviour, all
  of them silent: SQLite's `LIKE` is case-insensitive for ASCII and Postgres'
  is not (`ILIKE`), tags are an array rather than a JSON string, and a bare
  parameter next to a `NULL` leaves Postgres unable to infer its type.
- Tag ordering is done in JavaScript on both backends, because Postgres would
  order by collation and the SQLite path by `localeCompare`, and the two
  disagree on case.
- An environment in Postgres mode is no longer three minutes and no longer
  self-contained: there is a database to schedule, wait for and migrate.
- `pg` is a new dependency in two images.

## Alternatives rejected

**Replace SQLite outright.** It would cost the property that makes this project
demonstrable — an environment anyone can stand up in three minutes with no
infrastructure — to remove a mode nobody is forced to use.

**Infer the backend from `DATABASE_URL`.** Covered above: the failure is silent
and looks like success.

**Migrate on boot, guarded by `IF NOT EXISTS`.** It works right up to the second
replica, and then produces an error inside a request path that reads like an
application bug. It also leaves no answer to "did this deployment's schema
change apply?" other than reading logs.

**An ORM or a migration framework.** Two tables and one migration each. The
runner is sixty lines, and what it does — a lock, a ledger, a transaction per
step — is the part worth showing.
