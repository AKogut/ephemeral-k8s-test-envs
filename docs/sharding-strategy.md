# Sharding strategy

## What "sharding" means here

There are two ways to make a test suite finish faster, and they are not the same
thing:

```
--workers=4          one pod, four processes.  Bounded by that pod's CPU limit.
completions: 4       four pods, scheduled independently. Bounded by the cluster.
```

The first is a configuration flag. The second requires deciding how work is
divided, how each worker learns which slice is its own, where results go, and who
puts them back together. This project does the second, and then runs the first
*inside* it — 4 shards × 2 workers is 8 concurrent test processes against one
environment.

## How a pod knows which shard it is

The shard Job uses `completionMode: Indexed`:

```yaml
completionMode: Indexed
completions: 4      # the Job is done when indexes 0,1,2,3 have all succeeded
parallelism: 4      # …and they may all run at once
```

Kubernetes creates four pods from one identical template and injects a distinct
`JOB_COMPLETION_INDEX` (`0`–`3`) into each. That single environment variable is
the *only* difference between them.

Everything else follows deterministically:

```
JOB_COMPLETION_INDEX=2
        │
        ▼
  run-shard.mjs ──► shard-tests --index 2 --total 4
        │                   │
        │                   └─► reads specs/ + test-weights.json
        │                       computes the same plan every pod computes
        │                       prints only shard 2's files
        ▼
  playwright test specs/gateway-routing.spec.ts specs/notes-authz.spec.ts …
        │
        ▼
  /results/shard-2/allure-results/
```

**There is no queue, no broker and no leader.** Each pod recomputes the identical
plan and takes its own slice. Nothing is negotiated at runtime, so nothing can go
stale, deadlock, or double-assign a file. If Kubernetes reschedules index 2 onto
another node, the replacement pod computes exactly the slice its predecessor had.

That property is what makes the design worth the effort: coordination-free
parallelism scales to any number of pods without a coordinator becoming the
bottleneck or the single point of failure.

## Why not `playwright test --shard=2/4`

Playwright ships its own sharding, and for many projects it is the right answer.
It splits by *test count* after discovering every test.

Two reasons this project does not use it:

1. **Count is a poor proxy for time.** `user-journey.spec.ts` costs roughly five
   times what `platform-health.spec.ts` costs. An even split by count produces an
   uneven split by duration, and the run is only as fast as its slowest shard.
2. **The split is invisible.** Building it explicitly means the plan can be
   printed, unit-tested, and reasoned about before anything is deployed —
   `npm run shard:plan` shows exactly what each pod will do.

The weight table is optional. With no `test-weights.json`, every file weighs the
same and the result is a balanced split by count — i.e. the `--shard` behaviour,
as the floor rather than the ceiling.

## The algorithm: LPT greedy bin-packing

Assigning files to shards to minimise the slowest shard is the classic
**multiway number partitioning** problem — NP-hard in general. The standard
approximation is *longest-processing-time-first*:

```
1. Sort files by weight, descending. Ties break on filename, ascending.
2. For each file, assign it to the shard with the smallest current load.
   Ties break on the lowest shard index.
```

Both tie-breaks exist for determinism, not aesthetics. Without them the plan
could depend on filesystem ordering, and two pods could disagree about who owns
what.

LPT is guaranteed to land within **4/3 − 1/(3k)** of the optimal makespan for
`k` shards. The unit tests assert that bound directly rather than trusting it
([`sharding.test.ts`](../scripts/src/sharding.test.ts)).

## Worked example

The real suite, real weights, 4 shards:

```
$ npm run shard:plan

Weights: tests/api/test-weights.json
Shard plan: 11 files across 4 shards
Ideal weight per shard: 8.34 | makespan: 8.65 | balance: 96.4%

  shard 0: 2 file(s), weight 7.98
      - auth-login.spec.ts
      - user-journey.spec.ts
  shard 1: 3 file(s), weight 8.56
      - auth-register.spec.ts
      - notes-listing.spec.ts
      - platform-health.spec.ts
  shard 2: 3 file(s), weight 8.65
      - gateway-routing.spec.ts
      - notes-crud.spec.ts
      - notes-validation.spec.ts
  shard 3: 3 file(s), weight 8.16
      - auth-me.spec.ts
      - notes-authz.spec.ts
      - resilience.spec.ts
```

Note shard 0: **two files, not three.** `user-journey.spec.ts` is the most
expensive file in the suite at 5.6s, so LPT places it first and then gives it only
the cheapest remaining file for company. A count-based split would have handed it
three files and made it the bottleneck.

The ideal is 8.34 and the slowest shard is 8.65 — **96.4% of a perfect split**,
against a theoretical worst case of 8.34 × (4/3 − 1/12) = 10.4.

## Handling the awkward cases

| Situation | Behaviour |
|---|---|
| More shards than files | Extra shards get an empty list, log "nothing to do", and exit 0. The entrypoint checks for this explicitly — `playwright test` with no file arguments would otherwise run the **whole suite** on every empty shard. |
| A brand-new spec file, absent from the weight table | Weighted at the **median** of the known weights, not `1`. Guessing "cheapest" would pile every new file onto one shard. |
| A stale weight table | Costs balance, never correctness. Every file still runs exactly once — and `npm run weights:update` regenerates it from a finished run. |
| A malformed weight table | Fails loudly. A missing file falls back to equal weights; a file containing `"fast"` where a number belongs is a mistake worth surfacing. |
| A shard pod crashes | The Job records a failed index and the Job as a whole does not complete. From Phase 3, the aggregator additionally refuses to report a green run over a missing shard directory. |

## Test isolation across pods

Four pods hit **one** notes-service backed by **one** SQLite file. So isolation
cannot come from resetting state between tests — two pods would race each other.

Instead, every test provisions its own user:

```ts
export function uniqueEmail(prefix = 'user'): string {
  const shard = process.env.SHARD_INDEX ?? process.env.JOB_COMPLETION_INDEX ?? '0';
  return `${prefix}-s${shard}-${randomUUID()}@example.test`;
}
```

notes-service scopes every query to the authenticated owner, so tests are
isolated by the application's own tenancy model. A test asserting "I have exactly
3 notes" is only ever counting its own.

This is why the suite can be split across any number of pods without a single
line of test code changing. It is also why the tests are worth something: they
exercise the multi-tenant path on every single run rather than in one dedicated
test.

## Regenerating the weights

`test-weights.json` holds approximate wall-clock seconds per file. To refresh it
after the suite changes shape, take the per-file durations from a full run's
JUnit output (`/results/shard-*/junit.xml`, where each `<testsuite name="…">` is a
spec file) and write them back.

Stale weights are a balance problem, never a correctness problem, so this is
worth doing occasionally rather than automatically.

## Choosing a shard count

| Shards | When |
|---|---|
| 1 | Local development. Fast feedback, no orchestration. |
| 4 | CI default. Matches a 4-vCPU GitHub runner hosting the cluster in-process. |
| 8–16 | A real cluster with real nodes, where the suite is large enough to justify the per-pod startup cost. |
| > 16 | Only if the suite has enough *files* to fill them. 64 shards over 11 files is 53 pods that start, find nothing to do, and exit. |

The chart caps the value at 64 and refuses to render outside `1…64`, because
`--set tests.shards=1000` should fail during templating rather than as a cluster
full of Pending pods.

Wall-clock is bounded from below by the heaviest single **file** — a suite where
one file costs 90 seconds cannot finish faster than 90 seconds, no matter how
many shards it is given. Splitting further requires splitting that file.
