# Vasta server image: the API plus the built web app, data in /data.
#   docker build -t vasta .
#   docker run -v ./data:/data -p 127.0.0.1:5174:5174 vasta
# Manage accounts inside the container: docker exec -it vasta vasta user add <username>

# Everything but the last stage runs on the build machine: the server has no native modules, so its
# node_modules work on any architecture and an arm64 image needs no emulated pnpm install.
FROM --platform=$BUILDPLATFORM node:24-slim AS base
RUN npm install -g pnpm@10.14.0 && npm cache clean --force
WORKDIR /app
# Only the manifests, so dependency layers are cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/editor-schema/package.json packages/editor-schema/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/importer-capacities/package.json packages/importer-capacities/

FROM base AS web
RUN pnpm install --frozen-lockfile --filter "@vasta/web..."
# The commit or version (setup/deploy.sh and the release workflow write REVISION; package.json keeps the COPY valid without it).
COPY package.json REVISION* ./
COPY packages/core packages/core
COPY packages/editor-schema packages/editor-schema
COPY packages/web packages/web
# Read (not built) for the icon names the server puts in captured blocks; see vite.config.ts.
COPY packages/server/src packages/server/src
RUN pnpm --filter @vasta/web build

FROM base AS server-deps
RUN pnpm install --frozen-lockfile --prod --filter "@vasta/server..."

FROM node:24-slim
# Lets deploys prune old Vasta images without touching anything else on the host.
LABEL app=vasta
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5174 VASTA_DATA=/data VASTA_WEB_DIR=/app/web
COPY --from=server-deps /app ./
COPY packages/core packages/core
COPY packages/editor-schema/src packages/editor-schema/src
COPY packages/server/src packages/server/src
COPY --from=web /app/packages/web/dist web
RUN printf '#!/bin/sh\nexec node --no-warnings /app/packages/server/src/cli.ts "$@"\n' > /usr/local/bin/vasta \
  && chmod +x /usr/local/bin/vasta \
  && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 5174
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:5174/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--no-warnings", "packages/server/src/main.ts"]
