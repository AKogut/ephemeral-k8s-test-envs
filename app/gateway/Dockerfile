# syntax=docker/dockerfile:1.7
#
# Multi-stage build for gateway. This is the smallest of the three images: the
# proxy is written against the runtime's own fetch, so express is the only
# production dependency and no native module is involved.

ARG NODE_VERSION=22.22.0

# ---------------------------------------------------------------- deps --------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# --------------------------------------------------------------- build --------
FROM deps AS build
WORKDIR /app

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

LABEL org.opencontainers.image.title="gateway" \
      org.opencontainers.image.description="Edge reverse proxy for the ephemeral test environment stack" \
      org.opencontainers.image.source="https://github.com/AKogut/ephemeral-k8s-test-envs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${SERVICE_VERSION}"

ENV NODE_ENV=production \
    PORT=3000 \
    SERVICE_NAME=gateway \
    SERVICE_VERSION=${SERVICE_VERSION} \
    GIT_SHA=${GIT_SHA} \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
