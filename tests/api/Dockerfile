# syntax=docker/dockerfile:1.7
#
# Test runner image. Build context is the repository root, because the runner
# needs two things that live in different trees: the suite (tests/api) and the
# sharder (scripts).
#
#   docker build -f tests/api/Dockerfile -t api-tests .
#
# Deliberately NOT based on mcr.microsoft.com/playwright — that image ships
# Chromium, Firefox and WebKit plus their system libraries (~2 GB) and this
# suite never opens a browser. Skipping the browser download keeps the runner
# around 250 MB, which is worth real seconds when four shard pods pull it at
# once on a cold node. See docs/adr/0002-browserless-test-runner-image.md.

ARG NODE_VERSION=22.22.0

# ------------------------------------------------------------- sharder --------
# The shard planner is compiled once and copied in as a plain JS CLI, so the
# runtime image needs neither TypeScript nor tsx.
FROM node:${NODE_VERSION}-bookworm-slim AS sharder
WORKDIR /build

COPY scripts/package.json scripts/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY scripts/tsconfig.json ./
COPY scripts/src ./src
RUN npm run build

# ---------------------------------------------------------------- deps --------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY tests/api/package.json tests/api/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ------------------------------------------------------------- runtime --------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ARG SERVICE_VERSION=dev
ARG GIT_SHA=unknown

LABEL org.opencontainers.image.title="api-tests" \
      org.opencontainers.image.description="Sharded black-box API suite for the ephemeral test environment stack" \
      org.opencontainers.image.source="https://github.com/AKogut/ephemeral-k8s-test-envs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${SERVICE_VERSION}"

ENV NODE_ENV=production \
    CI=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    SHARD_CLI=/opt/sharder/shard-tests.js \
    RESULTS_DIR=/results \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    GIT_SHA=${GIT_SHA}

COPY --from=sharder /build/dist                 /opt/sharder
COPY --from=deps    --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node tests/api/package.json tests/api/playwright.config.ts tests/api/run-shard.mjs tests/api/test-weights.json ./
COPY --chown=node:node tests/api/fixtures ./fixtures
COPY --chown=node:node tests/api/specs    ./specs

# The results volume is mounted here; owning it up front means the container
# works as a non-root user against a fresh PersistentVolume.
RUN mkdir -p /results && chown -R node:node /results /app

USER node

# The shard index arrives as JOB_COMPLETION_INDEX from the Kubernetes Job.
ENTRYPOINT ["node", "run-shard.mjs"]
