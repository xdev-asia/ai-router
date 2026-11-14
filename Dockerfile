# syntax=docker/dockerfile:1
# The gateway in Docker: workerd through `wrangler dev`, with a local D1. Not the production runtime (that is
# Cloudflare Workers). CI builds this image on every push to main (ghcr.io/xdev-asia/ai-router); compose.yaml
# runs it.
#
# The console needs @xdev-asia/ui from GitHub Packages, so a build from source takes a token (read:packages):
#   NODE_AUTH_TOKEN=... docker build --secret id=npm_token,env=NODE_AUTH_TOKEN .
# or, with dist/ already built on the host (`corepack pnpm run build`):
#   docker build --build-context console=dist .

# The console (web/ -> dist/). Plain files, so built once on the build machine's platform.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS console-build
WORKDIR /src
ENV CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=secret,id=npm_token,env=NODE_AUTH_TOKEN \
    --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    corepack pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY web ./web
RUN corepack pnpm run build

# Only dist/, at the root: `--build-context console=dist` puts the host's dist/ here instead.
FROM scratch AS console
COPY --from=console-build /src/dist /

FROM node:24-bookworm-slim
WORKDIR /app
ENV WRANGLER_SEND_METRICS=false CI=1
# workerd needs the system CA store (the slim image has none).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
# Owned by node, so the volumes mounted here (local D1, first-run secrets) are writable.
RUN mkdir -p /secrets && chown node:node /app /secrets
USER node
COPY --chown=node:node docker/package.json ./
RUN npm install --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node wrangler.jsonc tsconfig.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node worker ./worker
COPY --chown=node:node docker/start.mjs docker/secrets.mjs ./docker/
COPY --from=console --chown=node:node / ./dist
RUN mkdir -p .wrangler/state
EXPOSE 8787
LABEL org.opencontainers.image.description="ai-router: LLM gateway (wrangler dev, local D1)"
CMD ["node", "docker/start.mjs"]
