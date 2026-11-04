/**
 * The fetch server's HTTP surface: `POST /mcp` (MCP over streamable HTTP,
 * stateless, bearer-authenticated) and `GET /healthz` (unauthenticated, for
 * Cloud Run's probes).
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  type Authenticator,
  authenticatorFromEnv,
  requireAgent,
} from "@arbora/mcp-auth";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FetcherDeps } from "./fetcher.ts";
import { consoleSinks, createGate, fetchServer, type Sinks } from "./tools.ts";

export interface FetchHttpOptions {
  authenticator: Authenticator;
  version: string;
  /** DNS, TLS trust and limits; the defaults are the production ones. */
  fetcher?: FetcherDeps;
  sinks?: Sinks;
  /** Fetches in flight at once, across all requests. Default 8. */
  maxInFlight?: number;
}

export const DEFAULT_MAX_IN_FLIGHT = 8;
/** A request body larger than this is not a plausible single tool call. */
const MAX_BODY_BYTES = 64 * 1024;

class BodyError extends Error {}

/** The request's JSON body, read within a cap. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyError("request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError("request body is not JSON");
  }
}

/** How many `tools/call` requests a JSON-RPC body carries. */
function toolCalls(body: unknown): number {
  const messages = Array.isArray(body) ? body : [body];
  return messages.filter(
    (m) =>
      typeof m === "object" &&
      m !== null &&
      (m as { method?: unknown }).method === "tools/call",
  ).length;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function fetchHttpServer({
  authenticator,
  version,
  fetcher = {},
  sinks = consoleSinks,
  maxInFlight = DEFAULT_MAX_IN_FLIGHT,
}: FetchHttpOptions): Server {
  const gate = createGate(maxInFlight);
  // Stateless: a fresh MCP server per request, built for the caller the token
  // names, so no request can act as anyone else.
  const mcp = requireAgent(authenticator, "fetch", async (req, res, agent) => {
    if (req.method !== "POST") {
      json(
        res,
        405,
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        },
        { allow: "POST" },
      );
      return;
    }
    // One fetch per POST: a batch of tools/call would multiply the work a
    // single request can hold (a body, its copies and a parse tree each).
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (error) {
      json(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: (error as Error).message },
        id: null,
      });
      return;
    }
    if (toolCalls(body) > 1) {
      json(res, 400, {
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: "A batch may carry at most one tools/call.",
        },
        id: null,
      });
      return;
    }
    // A caller that hangs up before the answer is written aborts its fetch.
    const hangUp = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) hangUp.abort();
    });
    const server = fetchServer(
      agent,
      version,
      fetcher,
      sinks,
      gate,
      hangUp.signal,
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz" && req.method === "GET") {
      json(res, 200, { status: "ok", version });
    } else if (path === "/mcp") {
      mcp(req, res).catch((error: unknown) => {
        sinks.err(
          `http: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        if (!res.headersSent) json(res, 500, { error: "internal error" });
        else res.end();
      });
    } else {
      json(res, 404, { error: "not found" });
    }
  });
}

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The server as the environment contract configures it (README,
 * "The fetch server"): `MCP_TOKEN_<AGENT>` per admitted agent and an
 * optional `PORT` (default 8080). Throws rather than start misconfigured.
 */
export function fetchHttpServerFromEnv(
  env: Env,
  version: string,
): { server: Server; port: number } {
  const portText = env.PORT ?? "8080";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`invalid environment:\n  PORT: not a port: ${portText}`);
  const server = fetchHttpServer({
    authenticator: authenticatorFromEnv(env),
    version,
  });
  return { server, port };
}
