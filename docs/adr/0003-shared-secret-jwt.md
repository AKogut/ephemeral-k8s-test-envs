# ADR 0003 — Services share an HS256 secret rather than exchanging public keys

**Status:** Accepted · **Date:** 2026-08-10

## Context

`auth-service` issues JWTs. `notes-service` has to decide whether a token it did
not issue is genuine. Two standard approaches:

1. **Symmetric (HS256) with a shared secret.** Both services hold the same key.
   Verification is a local HMAC.
2. **Asymmetric (RS256/ES256) with JWKS.** auth-service signs with a private key
   and publishes the public key at `/.well-known/jwks.json`; notes-service fetches
   it, caches it, and handles rotation and `kid` selection.

JWKS is what a real multi-team system uses: the verifier never holds anything
that can mint tokens, and keys rotate without redeploying every consumer.

## Decision

HS256 with a secret shared through a Kubernetes `Secret`, generated per release by
the chart.

The secret is injected identically into all three services, and reused across
`helm upgrade` via a `lookup` so a redeploy does not invalidate tokens mid-run.

## Rationale

The point of this project is the *environment lifecycle* — sharding, aggregation,
teardown. JWKS would add machinery that serves the demo rather than the point:

- a key-pair generator, or a pre-seeded key pair in the chart
- a JWKS endpoint on auth-service
- fetch-and-cache logic in notes-service, plus its failure modes
- `kid` handling and a rotation story

That is a day of work whose payoff is entirely in the application layer, and it
would make the interesting parts of the repository harder to find.

Crucially, **the property being demonstrated survives the simplification**:
notes-service still validates a token it did not issue, still checks issuer and
audience, still returns `503` rather than `401` when auth-service is unreachable,
and still makes a real service-to-service call over cluster DNS in the default
`verify-with-auth-service` mode. Replacing the local HMAC with a JWKS lookup would
not change a single test.

## Consequences

**Good**

- Zero key-distribution machinery; the chart's `Secret` template is 30 lines.
- Verification is a local HMAC — no network hop on the fast path, so the
  `authMode` knob genuinely isolates "does this deployment make a service-to-service
  call" as a variable.
- One secret to rotate, and the chart handles it.

**Bad**

- **notes-service can mint tokens.** With the signing key in its environment,
  nothing but code stops it. In a real system that is a genuine security concern
  and the reason JWKS exists. It is acceptable here because both services are in
  the same trust boundary, deployed together, from the same repository.
- Rotation means restarting all three deployments. The chart does this correctly
  (a `checksum/secret` pod annotation rolls them), but there is no zero-downtime
  path.
- Does not demonstrate JWKS handling, which is a reasonable thing for an
  interviewer to ask about. This ADR is the answer.

## Notes

`notes-service` verifies `issuer` and `audience` in addition to the signature, and
the suite asserts that a well-formed token signed for a *different* audience is
rejected (`notes-authz.spec.ts`). Those checks are what JWKS would also need, so
they are worth having regardless of the signing scheme.

Migrating to JWKS later touches `tokens.ts` in auth-service and `auth.ts` in
notes-service, plus one chart value. The API contract does not change.
