/**
 * The one tool, `fetch`. The caller is the `agent` the server was built for,
 * from its bearer token; no input names one. Every call writes one structured
 * log line: agent, url, status, bytes, duration. Tokens never reach this code.
 */
import type { AgentId } from "@arbora/mcp-auth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { FetchError, type FetcherDeps, fetchPage } from "./fetcher.ts";

export interface FetchLogLine {
  event: "fetch";
  agent: string;
  url: string;
  /** The final response's status; null when none was received. */
  status: number | null;
  bytes: number;
  duration_ms: number;
  outcome: "ok" | "refused" | "failed";
  /** Where redirects ended, when not at `url`. */
  final_url?: string;
  error?: string;
}

/**
 * Where output goes: `out` takes one structured line (JSON text), `err` a
 * diagnostic message. Both are injected, so tests capture exactly what would
 * reach stdout and stderr. Nothing here writes to the console but the default.
 */
export interface Sinks {
  out(line: string): void;
  err(message: string): void;
}

/** Cloud Run ingests a JSON line on stdout as structured. */
export const consoleSinks: Sinks = {
  out: (line) => console.log(line),
  err: (message) => console.error(message),
};

/** A cap on fetches in flight, shared by every request of the process. */
export interface Gate {
  /** A release function, or undefined when the cap is reached. */
  tryEnter(): (() => void) | undefined;
}

export function createGate(max: number): Gate {
  let inFlight = 0;
  return {
    tryEnter() {
      if (inFlight >= max) return undefined;
      inFlight++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          inFlight--;
        }
      };
    },
  };
}

/** Longest URL the tool accepts, and the longest the log line keeps. */
export const MAX_URL_LENGTH = 8192;
const MAX_LOGGED_URL = 2048;
const clip = (url: string): string =>
  url.length <= MAX_LOGGED_URL ? url : `${url.slice(0, MAX_LOGGED_URL)}...`;

/** An MCP server whose `fetch` acts as `agent`. */
export function fetchServer(
  agent: AgentId,
  version: string,
  deps: FetcherDeps,
  sinks: Sinks,
  gate: Gate,
  signal: AbortSignal,
): McpServer {
  const server = new McpServer({ name: "arbora-fetch", version });

  server.registerTool(
    "fetch",
    {
      title: "Fetch",
      description:
        "Fetch a public web page over https (GET, port 443) and return it as text; HTML is converted to " +
        "readable text. Addresses on private or internal networks are refused, at most 3 redirects are " +
        "followed, and the result is cut at about 100,000 characters (it says so when it is). " +
        "Every fetch is logged against your agent id.",
      inputSchema: {
        url: z.string().max(MAX_URL_LENGTH).describe("The https URL to fetch"),
      },
      annotations: {
        title: "Fetch",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url }): Promise<CallToolResult> => {
      const started = performance.now();
      const line = (
        rest: Omit<FetchLogLine, "event" | "agent" | "url" | "duration_ms">,
      ) =>
        sinks.out(
          JSON.stringify({
            event: "fetch",
            agent,
            url: clip(url),
            duration_ms: Math.round(performance.now() - started),
            ...rest,
          }),
        );
      const release = gate.tryEnter();
      if (release === undefined) {
        const error = "refused: too many fetches in flight; retry shortly";
        line({ status: null, bytes: 0, outcome: "refused", error });
        return { isError: true, content: [{ type: "text", text: error }] };
      }
      try {
        const page = await fetchPage(url, { ...deps, signal });
        line({
          status: page.status,
          bytes: page.bytes,
          outcome: "ok",
          ...(page.finalUrl !== url && { final_url: clip(page.finalUrl) }),
        });
        return { content: [{ type: "text", text: page.text }] };
      } catch (error) {
        const known = error instanceof FetchError;
        const message = known ? error.message : "fetch failed";
        line({
          status: known ? (error.detail.status ?? null) : null,
          bytes: known ? (error.detail.bytes ?? 0) : 0,
          outcome: known ? error.kind : "failed",
          ...(known &&
            error.detail.finalUrl !== undefined && {
              final_url: clip(error.detail.finalUrl),
            }),
          error: message,
        });
        if (!known)
          sinks.err(
            `fetch: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          );
        return { isError: true, content: [{ type: "text", text: message }] };
      } finally {
        release();
      }
    },
  );

  return server;
}
