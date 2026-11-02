import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["servers/*/test/**/*.test.ts"],
    // Starts one Oxigraph container for the run and removes it after.
    globalSetup: ["test/oxigraph.ts"],
    // A first image pull can take a while on a cold runner.
    hookTimeout: 120_000,
  },
});
