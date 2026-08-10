# syntax=docker/dockerfile:1.7
#
# Aggregator image: merges the per-shard Allure results on the shared volume.
#
#   docker build -t aggregator ./scripts
#
# It has no production dependencies at all — the merge is plain Node — so the
# runtime stage carries nothing but compiled JavaScript on a slim base.

ARG NODE_VERSION=22.23.2

# --------------------------------------------------------------- build --------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /build

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ------------------------------------------------------------- runtime --------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ARG SERVICE_VERSION=dev
ARG GIT_SHA=unknown

LABEL org.opencontainers.image.title="aggregator" \
      org.opencontainers.image.description="Merges sharded Allure results into a single report input" \
      org.opencontainers.image.source="https://github.com/AKogut/ephemeral-k8s-test-envs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${SERVICE_VERSION}"

ENV NODE_ENV=production \
    RESULTS_DIR=/results \
    GIT_SHA=${GIT_SHA}

COPY --from=build --chown=node:node /build/dist ./dist

# The entrypoint is `node` and this image has no dependencies at all, so npm is
# pure attack surface. Dropping it also removes its vendored node-tar, which
# would otherwise be the only thing an image scan ever found here.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

RUN mkdir -p /results && chown -R node:node /results /app
USER node

ENTRYPOINT ["node", "dist/aggregate-results.js"]
