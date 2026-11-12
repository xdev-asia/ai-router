# Codex relay (codex-relay.mjs): no dependencies, so the image is node and one file.
FROM node:24-bookworm-slim
WORKDIR /relay
COPY codex-relay.mjs ./
USER node
ENV PORT=8790
EXPOSE 8790
CMD ["node", "codex-relay.mjs"]
