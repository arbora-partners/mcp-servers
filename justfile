# Default: show available recipes
default:
    @just --list

# Run every gate checks.yml runs
check: lint typecheck test

# Lint and format-check with biome
lint:
    biome check .

# Fix lint and formatting issues
fix:
    biome check --write .

# Type-check every package, tests included
typecheck:
    pnpm exec tsc --noEmit

# Run the tests; they start a digest-pinned Oxigraph container (needs Docker)
test:
    pnpm exec vitest run

# Run the tests in watch mode
test-watch:
    pnpm exec vitest

# Bundle the memory server to servers/memory/dist/main.mjs
build-memory:
    pnpm --filter @arbora/mcp-memory run build

# Build the memory server's image locally, as the release workflow does
image-memory tag="mcp-memory:local":
    docker build -f servers/memory/Dockerfile -t {{tag}} .

# Install dependencies
install:
    pnpm install
