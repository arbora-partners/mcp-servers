/**
 * The memory server's HTTP surface: `POST /mcp` (MCP over streamable HTTP,
 * stateless, bearer-authenticated) and `GET /healthz` (unauthenticated, for
 * Cloud Run's probes; it does not touch the store).
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  type Authenticator,
  authenticatorFromEnv,
  requireAgent,
} from "@arbora/mcp-auth";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MemoryStore } from "./store.ts";
import { memoryServer } from "./tools.ts";

export interface MemoryHttpOptions {
  authenticator: Authenticator;
  store: MemoryStore;
  version: string;
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

export function memoryHttpServer({
  authenticator,
  store,
  version,
}: MemoryHttpOptions): Server {
  // Stateless: a fresh MCP server per request, built for the caller the token
  // names, so no request can act as anyone else.
  const mcp = requireAgent(authenticator, "memory", async (req, res, agent) => {
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
    const server = memoryServer(store, agent, version);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz" && req.method === "GET") {
      json(res, 200, { status: "ok", version });
    } else if (path === "/mcp") {
      mcp(req, res).catch((error: unknown) => {
        console.error(error);
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
 * "Environment"): `MCP_TOKEN_<AGENT>` or `MCP_TOKEN_<AGENT>_FILE` per admitted
 * agent, `SPARQL_QUERY_URL`, `SPARQL_UPDATE_URL` and an optional `PORT`
 * (default 8080). `env` is `process.env` in `main` and a literal in tests, and
 * `now` times the token files' re-reads. Throws, naming every problem, rather
 * than start misconfigured.
 */
export function memoryHttpServerFromEnv(
  env: Env,
  version: string,
  now: () => number = Date.now,
): { server: Server; port: number } {
  const problems: string[] = [];
  const url = (name: string): string => {
    const value = env[name] ?? "";
    if (!URL.canParse(value)) problems.push(`${name}: not set to a URL`);
    return value;
  };
  const query = url("SPARQL_QUERY_URL");
  const update = url("SPARQL_UPDATE_URL");
  const portText = env.PORT ?? "8080";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    problems.push(`PORT: not a port: ${portText}`);
  if (problems.length > 0)
    throw new Error(`invalid environment:\n  ${problems.join("\n  ")}`);
  const server = memoryHttpServer({
    authenticator: authenticatorFromEnv(env, now),
    store: new MemoryStore({ query, update }),
    version,
  });
  return { server, port };
}
