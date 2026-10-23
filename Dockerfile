FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
COPY mcp/package.json ./mcp/package.json
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PATH="/opt/yt-dlp/bin:${PATH}"
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/client/package.json ./client/package.json
COPY --from=build --chown=node:node /app/client/dist ./client/dist
COPY --from=build --chown=node:node /app/mcp/package.json ./mcp/package.json
COPY --from=build --chown=node:node /app/mcp/dist ./mcp/dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules

RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
