# Multi-stage. Final image is distroless (spec §2).
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY types ./types
RUN npm run build && npm prune --omit=dev

FROM gcr.io/distroless/nodejs20-debian12
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER nonroot
EXPOSE 3000
CMD ["dist/src/server.js"]
