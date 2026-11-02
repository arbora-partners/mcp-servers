/**
 * Vitest global setup: one real Oxigraph, in memory, for the whole run.
 *
 * The image is pinned here by digest and nowhere else. CI runs this same
 * setup (the runner has Docker), rather than declaring an Actions service
 * container that would be a second copy of the pin. Bump it together with the
 * Oxigraph digest arbora-partners/IaC deploys on the memory VM, so the tests
 * run against the store memory actually uses.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

const run = promisify(execFile);

/** ghcr.io/oxigraph/oxigraph:0.5.13 (the multi-arch index). */
export const OXIGRAPH_IMAGE =
  "ghcr.io/oxigraph/oxigraph@sha256:260454ee29c091d2cdb99dd156212594ff3127850627adb4cfdcd9b1e425d480";

declare module "vitest" {
  export interface ProvidedContext {
    /** Base URL of the test Oxigraph, e.g. `http://127.0.0.1:55001`. */
    oxigraph: string;
  }
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", args);
  return stdout.trim();
}

async function waitUntilReady(base: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/query`, {
        method: "POST",
        headers: { "content-type": "application/sparql-query" },
        body: "ASK {}",
      });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline)
      throw new Error(`Oxigraph did not come up at ${base}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  // No --location: an in-memory store, gone with the container.
  const id = await docker(
    "run",
    "--detach",
    "--rm",
    "--publish",
    "127.0.0.1::7878",
    OXIGRAPH_IMAGE,
    "serve",
    "--bind",
    "0.0.0.0:7878",
  );
  const teardown = async () => {
    await docker("rm", "--force", id);
  };
  try {
    const mapped = await docker("port", id, "7878/tcp");
    const port = mapped.slice(mapped.lastIndexOf(":") + 1);
    const base = `http://127.0.0.1:${port}`;
    await waitUntilReady(base);
    project.provide("oxigraph", base);
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
