# syntax=docker/dockerfile:1
#
# The memory MCP server. Built from the repository root, which is the context:
#   docker build -f servers/memory/Dockerfile .
# Both base images are pinned by the digest of their multi-arch index; bump
# each by resolving the new digest for the tag named beside it.

# node:22-trixie-slim
FROM node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f AS build
# The pnpm `packageManager` names, installed exactly rather than through
# corepack, so the build does not depend on corepack's signing keys.
RUN npm install --global pnpm@12.3.4
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/auth/package.json packages/auth/
COPY servers/memory/package.json servers/memory/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY packages/ packages/
COPY servers/memory/ servers/memory/
# One self-contained file: the runtime image needs no node_modules.
RUN pnpm --filter @arbora/mcp-memory run build

# gcr.io/distroless/nodejs22-debian13:nonroot — no shell, no package manager,
# runs as uid 65532.
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:8ad9cc935b7843c4024b7e1487b5ef472c354ea847b97c667023e2618552607e
WORKDIR /app
COPY --from=build /src/servers/memory/dist/main.mjs ./main.mjs
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER nonroot
CMD ["/app/main.mjs"]
