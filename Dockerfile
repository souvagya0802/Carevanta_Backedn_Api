# syntax=docker/dockerfile:1.7
# Carevanta API / worker image. One image, two entrypoints:
#   docker run carevanta-api                      → HTTP API (node dist/src/server.js)
#   docker run carevanta-api node dist/src/worker.js → background worker
# Secrets are never baked in: every setting comes from the environment at run time (see .env.example).

# ── 1. Install all dependencies (prisma generate runs in postinstall and needs the schema + manifest script) ──
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json .npmrc ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY scripts/generate-index-manifest.mjs ./scripts/
RUN mkdir -p src/lib && npm ci

# ── 2. Compile TypeScript (src + generated Prisma client + scripts) into dist/ ──
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ── 3. Production dependencies only (no scripts: the client is already generated and compiled) ──
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ── 4. Runtime: non-root, read-only code, writable storage volume ──
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    APP_ENV=production \
    PORT=4000 \
    STORAGE_LOCAL_DIR=/data/storage
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl curl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/storage \
  && chown -R node:node /data
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# The query engine is a native library next to the generated client; tsc does not copy it.
COPY --from=build --chown=node:node /app/generated/prisma/*.node ./dist/generated/prisma/
COPY --chown=node:node package.json ./
USER node
EXPOSE 4000
VOLUME ["/data/storage"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health/ready" || exit 1
CMD ["node", "dist/src/server.js"]
