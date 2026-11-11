# The gateway on this machine, in Docker: workerd through `wrangler dev`, with a local D1 and local secrets.
# Not the production runtime (that is Cloudflare Workers).
#
#   corepack pnpm run build          # the console (dist/), on the host: needs the GitHub Packages token
#   docker compose up --build        # http://localhost:8787
#
# Secrets come from .dev.vars (git-ignored), mounted read-only; see README.
FROM node:24-bookworm-slim
WORKDIR /app
ENV WRANGLER_SEND_METRICS=false CI=1
# workerd needs the system CA store (the slim image has none).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN chown node:node /app
USER node
COPY --chown=node:node docker/package.json ./
RUN npm install --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node wrangler.jsonc tsconfig.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node worker ./worker
COPY --chown=node:node dist ./dist
# Owned by node, so the mounted volume for the local D1 is writable.
RUN mkdir -p .wrangler/state
EXPOSE 8787
CMD ["sh", "-c", "npx wrangler d1 migrations apply xdev-llm --local && exec npx wrangler dev --ip 0.0.0.0 --port 8787"]
