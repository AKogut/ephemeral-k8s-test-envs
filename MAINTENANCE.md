# Maintaining this repository

**Status: maintenance**, since 2026-11-19. No new features are planned.
Dependencies, base images, pinned tools and security fixes are kept current
without a person, and the repository opens an issue when it cannot cope on its
own. This file says what runs by itself, what still needs someone, and which
settings all of it depends on. [ADR 0012](docs/adr/0012-the-repository-keeps-itself-current.md)
records why it is built this way.

## What runs by itself

| What | When | Does | Merges |
|---|---|---|---|
| Dependabot, npm | monthly | Minor and patch updates of all six packages in one pull request, and security updates in another | yes, once CI is green |
| Dependabot, GitHub Actions | monthly | New action releases, by commit SHA, in one pull request | yes, once CI is green |
| Dependabot, base images | weekly | A new Node patch release, or a rebuild of the same tag, by digest | yes, once CI is green |
| Renovate | monthly | Everything else that is pinned: kind, the node image, kubectl, Helm, Calico, the Traefik chart, versitygw, Postgres, and the probe images | yes, for minor and patch, once CI is green |
| `apt-get upgrade` in every runtime stage | every image build | Debian security fixes the official Node image does not carry yet | — |
| CI on `main` | Mondays 05:00 UTC | Rebuilds and rescans every image, and runs every cluster job against today's upstream | — |
| `rerun-failed-once.yml` | after any failed run | Reruns its failed jobs once, so a network flake needs no one | — |
| `Report the health of main` | after every run of `main` | Opens one `main-red` issue if `main` is still red after the retry, and closes it when `main` is green | — |
| `fleet.yml` | Mondays 07:00 UTC | Checks the run history: teardown proofs, environment lifetime, shard balance | — |
| `prune-images.yml` | weekly | Deletes old published images | — |
| `publish-wiki.yml` | on merge | Mirrors `docs/wiki/` to the wiki | — |

A merge always waits for the 23 required checks. "Merges by itself" never means
merging past a red check.

## What needs a person

**An open `main-red` issue.** The scheduled or post-merge run of `main` failed
twice. Open the run linked in the issue and read the first failing job. In this
repository's history the cause has been one of:

| Symptom | Cause | What to do |
|---|---|---|
| An image cannot be pulled (`unauthorized`, `not found`) | An upstream project stopped publishing it, as MinIO did in 2026 ([ADR 0011](docs/adr/0011-versitygw-replaces-minio.md)) | Replace it. That is a decision, so it gets an ADR |
| `Fail on a fixable critical vulnerability` | A critical advisory was published against something in an image | Usually the next Dependabot base-image PR or the next rebuild (`apt-get upgrade`) fixes it. If the fix is in an npm package, bump it |
| A cluster job fails the same way twice | A pinned tool's new release changed behaviour (Kubernetes, kind, Calico, Traefik, Helm) | Read that release's notes. Fix the chart or the job, or pin back and record why |
| `Shard planner`, `Lint` or `Typecheck` fails | A dependency update passed its own pull request but breaks with something merged after it | Fix forward |

The issue closes by itself once `main` is green.

**A pull request labelled `major-update`, or a major version in Renovate's
Dependency Dashboard issue.** Majors are migrations, not bumps. Do them one at a
time, in their own pull request:

- **Node.** Move every `FROM`, the `NODE_VERSION` in `ci.yml` and `fleet.yml`,
  `engines`, and `@types/node` together. #165 has the shape.
- **TypeScript 7.** The code already type-checks under 7. Wait until
  `typescript-eslint` accepts TypeScript 7 in its peer range (in November 2026
  it accepted only versions below 6.1).
- **Postgres.** Move compose and the chart together; CI fails if they differ
  (#148).
- **Helm, or anything else Renovate holds back.** Read the release notes, then
  run the full pipeline.

**A pull request from someone else.** Fork runs wait for approval; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Settings this depends on

These live in GitHub, not in the repository, so a change to them is not
reviewed. Check them if something above stops happening.

| Setting | Value |
|---|---|
| Pull requests: allow auto-merge | on |
| Pull requests: merge method | squash only |
| Ruleset on `main` | 23 required checks, no up-to-date requirement, 0 approvals |
| Actions: require actions to be pinned to a full-length commit SHA | on |
| Renovate GitHub App | installed on this repository |
| Dependabot security updates, secret scanning, push protection, private vulnerability reporting | on |

## Known limitations

- A merge made by auto-merge with the workflow token does not start a `push`
  run on `main`. The pull request ran the full pipeline before it merged, and
  the Monday run checks `main` as merged.
- Two builds of the same commit a week apart can differ in Debian patch
  versions, because of `apt-get upgrade`. Every build is scanned.
- Numbers quoted in the README (image sizes, test counts, timings) are dated
  measurements. They do not update themselves.
