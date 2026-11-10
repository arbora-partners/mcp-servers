/**
 * The shared auth layer: one bearer token per (server, agent), and the token
 * a request presents is the caller's identity. Nothing downstream takes an
 * identity from anywhere else.
 *
 * The token map is read from an environment object the caller passes in, one
 * variable per agent: `MCP_TOKEN_<AGENT>` holds the token, or
 * `MCP_TOKEN_<AGENT>_FILE` names a file holding it. A file is re-read once its
 * last read is `TOKEN_FILE_TTL_MS` old, so a Secret Manager volume mounted at
 * `latest` makes a rotation take effect without a restart (IaC#694). See the
 * README for the contract.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/** The env-var prefix of a token. The rest of the name is the agent id. */
const TOKEN_ENV_PREFIX = "MCP_TOKEN_";

/** The suffix of a variable naming a token file rather than holding a token. */
const TOKEN_FILE_SUFFIX = "_FILE";

/**
 * How old a token file's last read may be before a request re-reads it. Each
 * read of a Secret Manager volume is a Secret Manager access, so files are
 * not read per request; this bounds how long a rotated-out token still works.
 */
export const TOKEN_FILE_TTL_MS = 30_000;

/** Shortest token accepted: 32 characters, e.g. 24 random bytes in base64. */
const MIN_TOKEN_LENGTH = 32;

/** An authenticated caller: the agent id the presented token belongs to. */
export type AgentId = string & { readonly __brand: "AgentId" };

class TokenConfigError extends Error {
  override name = "TokenConfigError";
}

/**
 * Whether `id` is a kebab slug (`cmo`, `research-2`): lowercase letters and
 * digits, single hyphens between them. Agent ids end up in graph IRIs and
 * env-var names, so the alphabet is kept this narrow.
 */
function isAgentId(id: string): boolean {
  if (id.length === 0 || id.startsWith("-") || id.endsWith("-")) return false;
  let previous = "";
  for (const c of id) {
    const alnum = (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
    if (!alnum && c !== "-") return false;
    if (c === "-" && previous === "-") return false;
    previous = c;
  }
  return true;
}

/**
 * `MCP_TOKEN_RESEARCH_2` → `research-2`, `MCP_TOKEN_CMO_FILE` → `cmo` as a
 * file; undefined when not a token var. So no agent id may end in `-file`.
 */
function parseTokenEnvName(
  name: string,
): { agent: string; base: string; file: boolean } | undefined {
  if (!name.startsWith(TOKEN_ENV_PREFIX)) return undefined;
  const file = name.endsWith(TOKEN_FILE_SUFFIX);
  const base = file ? name.slice(0, -TOKEN_FILE_SUFFIX.length) : name;
  const suffix = base.slice(TOKEN_ENV_PREFIX.length);
  return { agent: suffix.toLowerCase().split("_").join("-"), base, file };
}

/** The env-var name holding `agent`'s token: `research-2` → `MCP_TOKEN_RESEARCH_2`. */
function tokenEnvName(agent: string): string {
  return TOKEN_ENV_PREFIX + agent.toUpperCase().split("-").join("_");
}

const digest = (token: string): Buffer =>
  createHash("sha256").update(token, "utf8").digest();

/** What is wrong with `token` as a token, or undefined when nothing is. */
function tokenProblem(token: string): string | undefined {
  if (token !== token.trim()) return "token has leading or trailing whitespace";
  if (token.length < MIN_TOKEN_LENGTH)
    return `token shorter than ${MIN_TOKEN_LENGTH} characters`;
  return undefined;
}

/** One admitted agent's token: fixed, or from a file read at `readAt`. */
interface Entry {
  agent: AgentId;
  name: string;
  /** Undefined while the file is unreadable or holds no valid token. */
  digest: Buffer | undefined;
  file?: { path: string; readAt: number };
}

/** The token in `path`, or the reason it can't be used. */
function readTokenFile(path: string): { token: string } | { problem: string } {
  let token: string;
  try {
    token = readFileSync(path, "utf8");
  } catch (error) {
    return {
      problem: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const problem = tokenProblem(token);
  return problem === undefined ? { token } : { problem };
}

/** Resolves a bearer token to the agent it belongs to. */
export interface Authenticator {
  /** The agent whose token this is, or undefined for an unknown one. */
  identify(token: string): AgentId | undefined;
}

/**
 * Builds the authenticator from an environment object (`process.env` in
 * `main`, a literal in tests). Throws `TokenConfigError` naming every bad
 * variable, and when no agent is admitted at all: a server that admits nobody
 * is a misconfiguration, not a quiet state. A token file is read once here,
 * so a bad one stops the server starting; `now` is the clock its re-reads
 * are timed by.
 */
export function authenticatorFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  now: () => number = Date.now,
): Authenticator {
  const problems: string[] = [];
  const entries: Entry[] = [];
  const seen = new Map<string, string>();
  const agents = new Map<string, string>();

  for (const name of Object.keys(env).sort()) {
    const parsed = parseTokenEnvName(name);
    if (parsed === undefined) continue;
    const { agent, base, file } = parsed;
    const value = env[name] ?? "";
    if (!isAgentId(agent) || tokenEnvName(agent) !== base) {
      problems.push(
        `${name}: not MCP_TOKEN_ followed by an agent id in upper snake case`,
      );
      continue;
    }
    const other = agents.get(agent);
    if (other !== undefined) {
      problems.push(`${name}: agent ${agent} already has ${other}`);
      continue;
    }
    agents.set(agent, name);
    let token = value;
    if (file) {
      const read = readTokenFile(value);
      if ("problem" in read) {
        problems.push(`${name}: ${read.problem}`);
        continue;
      }
      token = read.token;
    } else {
      const problem = tokenProblem(token);
      if (problem !== undefined) {
        problems.push(`${name}: ${problem}`);
        continue;
      }
    }
    const d = digest(token);
    const key = d.toString("hex");
    const twin = seen.get(key);
    if (twin !== undefined) {
      problems.push(
        `${name}: same token as ${twin}; a token must name one agent`,
      );
      continue;
    }
    seen.set(key, name);
    entries.push({
      agent: agent as AgentId,
      name,
      digest: d,
      ...(file ? { file: { path: value, readAt: now() } } : {}),
    });
  }

  if (problems.length === 0 && entries.length === 0) {
    problems.push(
      `no ${TOKEN_ENV_PREFIX}<AGENT> variable is set; the server would admit nobody`,
    );
  }
  if (problems.length > 0) {
    throw new TokenConfigError(
      `invalid token configuration:\n  ${problems.join("\n  ")}`,
    );
  }

  /** Re-reads a token file whose last read is stale; a bad one admits nobody. */
  const refresh = (entry: Entry, at: number) => {
    const file = entry.file;
    if (file === undefined || at - file.readAt < TOKEN_FILE_TTL_MS) return;
    file.readAt = at;
    const read = readTokenFile(file.path);
    if ("problem" in read) {
      if (entry.digest !== undefined)
        console.error(
          `${entry.name}: ${read.problem}; refusing agent ${entry.agent} until it is fixed`,
        );
      entry.digest = undefined;
    } else {
      entry.digest = digest(read.token);
    }
  };

  return {
    identify(token: string): AgentId | undefined {
      const at = now();
      for (const entry of entries) refresh(entry, at);
      // Compare digests, so every comparison is over equal-length buffers,
      // and visit every entry, so the time taken says nothing about which
      // (if any) matched. A token two agents hold after a rotation names
      // neither.
      const presented = digest(token);
      let match: AgentId | undefined;
      let matches = 0;
      for (const entry of entries) {
        if (entry.digest === undefined) continue;
        if (timingSafeEqual(presented, entry.digest)) {
          match = entry.agent;
          matches += 1;
        }
      }
      return matches === 1 ? match : undefined;
    },
  };
}

/** The token in an `Authorization: Bearer <token>` header, else undefined. */
function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const space = header.indexOf(" ");
  if (space < 0) return undefined;
  if (header.slice(0, space).toLowerCase() !== "bearer") return undefined;
  const token = header.slice(space + 1).trim();
  return token.length > 0 ? token : undefined;
}

type AuthenticatedHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  agent: AgentId,
) => void | Promise<void>;

/**
 * Wraps a request handler so it runs only for a caller presenting a known
 * token, and receives that caller's agent id. A missing or unknown token is
 * answered `401` with a `WWW-Authenticate: Bearer` challenge (RFC 6750) and
 * never reaches the handler.
 */
export function requireAgent(
  authenticator: Authenticator,
  realm: string,
  handler: AuthenticatedHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const token = bearerToken(req.headers.authorization);
    const agent =
      token === undefined ? undefined : authenticator.identify(token);
    if (agent === undefined) {
      const error = token === undefined ? "" : ', error="invalid_token"';
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="${realm}"${error}`,
      });
      res.end(
        JSON.stringify({
          error:
            token === undefined
              ? "missing bearer token"
              : "unknown bearer token",
        }),
      );
      return;
    }
    await handler(req, res, agent);
  };
}
