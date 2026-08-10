# ADR 0005 — The password KDF cost is lowered in ephemeral environments

**Status:** Accepted · **Date:** 2026-08-10

## Context

`auth-service` hashes passwords with scrypt from `node:crypto`. The cost
parameter `N` is deliberately expensive — that is the entire point of a
password KDF. At `N = 2^14` (the production default) a single hash costs on the
order of 100 ms.

The API suite registers a fresh user for almost every test, and several tests
register two. Roughly 150 password hashes per full run.

At production cost that is ~15 seconds of pure CPU spent proving that scrypt is
slow, on top of a suite whose actual work takes about 3 seconds. Worse, it is
*serialised per shard pod*, competing with the very service under test for the
CPU limit the pod was given.

## Decision

The cost is configurable via `SCRYPT_COST_LOG2` and set to **12** (`N = 2^12`) in
`values.yaml`, `values-ci.yaml` and `docker-compose.yml`. The application default,
used when nothing sets it, stays **14**.

```yaml
auth:
  # log2 of the scrypt cost. 14 is the production figure; 12 keeps ~105 API
  # tests from spending most of their time hashing passwords.
  scryptCostLog2: 12
```

## Rationale

A KDF cost is a trade between attacker effort and user-visible latency. In an
ephemeral environment there is no attacker and no user: the accounts are created
by a test, live for seconds, hold a random UUID email and a hard-coded password,
and are destroyed with the namespace.

Lowering the cost by a factor of four buys back most of a test run without
changing a single code path. The algorithm, the salting, the constant-time
comparison and the dummy-hash-on-unknown-user timing defence are all identical —
only the work factor moves.

The alternative, which is common and worse, is to swap the KDF for something fast
in test builds. That changes the code under test, so the production hashing path
is never exercised at all.

## Consequences

**Good**

- Test runs measure the application rather than the KDF.
- Shard pods can be given a modest CPU limit without hashing becoming the
  bottleneck.
- The production code path is still the one being tested; only a parameter differs.

**Bad**

- **A production deployment that forgets to raise it would be materially weaker.**
  This is the real risk, and it is mitigated in three places: the application
  default is 14 (the safe value), the value is commented in `values.yaml`
  explaining what it is for, and `auth-service` refuses to start with
  `NODE_ENV=production` and no explicit `JWT_SECRET` — so a real deployment
  cannot be stood up by accident with test settings and no thought.
- The suite does not exercise the timing characteristics of a production-cost
  hash. Acceptable: no test asserts on hashing latency.

## Notes

scrypt was chosen over bcrypt precisely because it ships in `node:crypto`. It is
memory-hard, it needs no native module, and it keeps the runtime image free of a
compiled dependency that exists only to hash passwords. `maxmem` is raised
explicitly because Node's 32 MiB default is too small once `N` passes `2^14`,
which is a quiet failure mode worth knowing about.
