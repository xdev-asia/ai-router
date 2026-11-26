# Clip Studio, ai-router's studio sidecar: Node, ffmpeg (with libass for subtitles), fonts with Vietnamese glyphs.
# Builds from this folder alone: docker build -t ai-router-studio studio/
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-core fontconfig ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f

WORKDIR /studio
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack pnpm install --frozen-lockfile --prod
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production PORT=8791 STUDIO_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8791
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8791/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
