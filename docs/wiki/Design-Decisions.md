# Design decisions

Ten decisions where someone could reasonably have chosen otherwise. Each is
recorded as an ADR in the repository, with context, rationale, consequences in
**both** directions, and the alternatives that were rejected.

Without these, a deliberate trade-off is indistinguishable from an oversight.

| ADR | Decision | The cost of choosing it |
|---|---|---|
| [0001](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0001-namespace-per-environment.md) | The chart does not template a `Namespace`; Helm's `--create-namespace` owns it | Teardown is two commands instead of one |
| [0002](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0002-browserless-test-runner-image.md) | The Playwright runner image ships no browsers | Adding a UI test to this suite will fail, and the error will not obviously point at the Dockerfile |
| [0003](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0003-shared-secret-jwt.md) | Shared-secret HS256 rather than JWKS | `notes-service` holds a key that can mint tokens |
| [0004](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0004-aggregate-in-cluster-render-in-ci.md) | Merge in the cluster, render the HTML in CI | `helm install` alone does not produce browsable HTML |
| [0005](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0005-test-tuned-kdf-cost.md) | The scrypt cost is lowered in ephemeral environments | A production deployment that forgets to raise it would be materially weaker |
| [0006](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0006-single-replica-data-services.md) | Data services run one replica; only the gateway scales | True of the default; `database.backend=postgres` lifts it |
| [0007](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0007-object-storage-for-shard-results.md) | Shard results go to object storage, not a shared volume | An environment runs a fourth workload, and SigV4 is this repository's code |
| [0008](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0008-networked-database-mode.md) | A Postgres mode beside SQLite, selected by name | Two store implementations that can drift; CI runs the suite against both |
| [0009](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0009-reference-implementation-not-a-platform.md) | A reference implementation, not a package | Adopting the pattern means copying and adapting, with no upgrade path |
| [0010](https://github.com/AKogut/ephemeral-k8s-test-envs/blob/main/docs/adr/0010-nothing-here-costs-money-to-run.md) | Nothing here costs money to run | "No provider dependency" stays an argument, and the preview URL has never served a person |

## The shape used

```markdown
# ADR NNNN — <the decision, as a sentence>

**Status:** Accepted · **Date:** YYYY-MM-DD

## Context      — what forced a choice, including the constraint that makes it hard
## Decision     — what was chosen, concretely, with the code or config
## Rationale    — why, in terms of the context above
## Consequences — Good / Bad. The Bad section is not optional.
## Alternatives considered — what was rejected and why
```

The **Bad** section is the part that makes an ADR worth reading. An ADR listing
only advantages is marketing.

## When a decision needs one

If someone could reasonably have chosen otherwise, and the choice would be hard
to reverse later, write it down. If the choice is obvious or trivially
reversible, a comment at the point of use is enough.

The line in practice: "why is `replicaCount: 1`?" needs an ADR, because the
answer is a real constraint someone will otherwise try to fix. "Why port 3001?"
does not.

## Decisions deliberately *not* recorded

Not every choice is architectural:

- **TypeScript over JavaScript** — no serious alternative was in play.
- **Express over Fastify** — either works; nothing in the project depends on it.
- **Allure over another reporter** — the merged directory is a standard format,
  so swapping it touches one file.
- **`node:test` for unit tests** — it ships with the runtime and the scripts
  package needed no framework.

Recording these would dilute the six that actually matter.
