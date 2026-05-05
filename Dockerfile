# Multi-stage. Runtime is node:20-bookworm-slim for shell/curl access while
# debugging. Spec §2 calls for distroless — restore before next prod deploy.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY types ./types
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates dnsutils iputils-ping \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
