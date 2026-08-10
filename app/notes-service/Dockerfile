# syntax=docker/dockerfile:1.7
#
# Multi-stage build for notes-service. Same three-stage shape as auth-service:
# dependencies are resolved once against package-lock.json, TypeScript is
# compiled in a throwaway stage, and only dist/ plus production node_modules
# reach the runtime image.

ARG NODE_VERSION=22.22.0

# ---------------------------------------------------------------- deps --------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

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

LABEL org.opencontainers.image.title="notes-service" \
      org.opencontainers.image.description="Notes CRUD API for the ephemeral test environment stack" \
      org.opencontainers.image.source="https://github.com/AKogut/ephemeral-k8s-test-envs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${SERVICE_VERSION}"

ENV NODE_ENV=production \
    PORT=3002 \
    SERVICE_NAME=notes-service \
    SERVICE_VERSION=${SERVICE_VERSION} \
    GIT_SHA=${GIT_SHA} \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3002

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
