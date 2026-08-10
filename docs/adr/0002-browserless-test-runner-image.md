# ADR 0002 — The Playwright runner image ships no browsers

**Status:** Accepted · **Date:** 2026-08-10

## Context

The API suite is written with `@playwright/test`. The documented base image for
Playwright in CI is `mcr.microsoft.com/playwright:v1.xx-noble`, which bundles
Chromium, Firefox, WebKit and the system libraries all three need — roughly 2 GB.

This suite never opens a browser. Every test speaks HTTP through Playwright's
`request` fixture:

```ts
const response = await authed.post('/notes', { data: { title: 'Shopping list' } });
expect(response.status()).toBe(201);
```

Image size matters more here than in a typical CI job, because **N shard pods
pull the image simultaneously**. On a cold node, four pods pulling 2 GB is minutes
of wall clock before a single test runs — and that cost is paid on every run of
every PR.

## Decision

Build the runner on `node:22-bookworm-slim` with browser downloads suppressed:

```dockerfile
FROM node:22.22.0-bookworm-slim AS deps
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
```

`@playwright/test` is installed as a normal npm package. The test runner, fixtures,
assertions, reporters, retries and the `request` API all work; only
`browser.launch()` would fail, and nothing calls it.

## Rationale

- **Startup dominates a sharded run.** The suite itself takes seconds. Pulling and
  extracting 2 GB per pod does not.
- **Smaller attack surface.** Three browser engines and their font, audio and X11
  dependencies are a large amount of code to ship for something that makes HTTP
  requests.
- **Nothing is given up.** Playwright's `request` fixture is a first-class API,
  not a workaround — it exists precisely for API testing.

## Consequences

**Good**

- The runner image is roughly an order of magnitude smaller than the
  browser-bearing alternative, and that saving is multiplied by the shard count.
- Faster cold starts, less disk pressure on the node, quicker `kind load`.

**Bad**

- **Adding a UI test to this suite will fail**, and the error (a missing browser
  executable) will not obviously point at the Dockerfile. Mitigated by the comment
  at the top of `tests/api/Dockerfile` saying so directly.
- Two images would be needed if UI tests are ever added. That is the right shape
  anyway: UI and API suites shard differently and have very different runtimes.

## Alternatives considered

**Use the Playwright image and accept the size.** Simplest, and defensible if UI
tests were imminent. Rejected because the cost is paid per pod per run for
something the suite does not use.

**Install only Chromium (`npx playwright install chromium`).** Still ~400 MB of
browser plus system libraries, still unused.

**Drop Playwright for `node:test` + `fetch`.** Smaller still, but loses retries,
reporters, fixtures, the Allure integration and the trace tooling — all things
that make the suite readable and its failures diagnosable. The runner is not
where the weight is; the browsers are.
