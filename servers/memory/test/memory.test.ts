/**
 * The memory server through its one seam: MCP over streamable HTTP, driven by
 * the SDK's own client, against a real Oxigraph (test/oxigraph.ts), with the
 * server configured exactly as the environment contract says. The auth layer
 * is exercised here and nowhere else.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_FILE_TTL_MS } from "@arbora/mcp-auth";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { memoryHttpServerFromEnv } from "../src/http.ts";

const token = () => randomBytes(32).toString("base64url");
const TOKENS = {
  cmo: token(),
  cio: token(),
  cfo: token(),
  "research-2": token(),
} as const;
type Agent = keyof typeof TOKENS;

const oxigraph = inject("oxigraph");
const { server } = memoryHttpServerFromEnv(
  {
    MCP_TOKEN_CMO: TOKENS.cmo,
    MCP_TOKEN_CIO: TOKENS.cio,
    MCP_TOKEN_CFO: TOKENS.cfo,
    MCP_TOKEN_RESEARCH_2: TOKENS["research-2"],
    SPARQL_QUERY_URL: `${oxigraph}/query`,
    SPARQL_UPDATE_URL: `${oxigraph}/update`,
    UNRELATED: "ignored",
  },
  "0.0.0-test",
);
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function connect(authorization?: string): Promise<Client> {
  const headers: Record<string, string> = authorization
    ? { authorization }
    : {};
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers },
  });
  const client = new Client({ name: "memory-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const clients = new Map<Agent, Client>();
async function as(agent: Agent): Promise<Client> {
  let c = clients.get(agent);
  if (c === undefined) {
    c = await connect(`Bearer ${TOKENS[agent]}`);
    clients.set(agent, c);
  }
  return c;
}
afterAll(async () => {
  for (const c of clients.values()) await c.close();
});

interface Result {
  isError: boolean;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: a tool's JSON reply, asserted on by shape
  json: any;
}
async function call(
  agent: Agent,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Result> {
  const result = await (await as(agent)).callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const text = content.map((c) => c.text).join("");
  return {
    isError: result.isError === true,
    text,
    json: result.isError ? undefined : JSON.parse(text),
  };
}

/** A call that must succeed: setup, or a read whose result is asserted on. */
async function must(
  agent: Agent,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Result> {
  const result = await call(agent, name, args);
  expect(result.isError, result.text).toBe(false);
  return result;
}

/** Straight to the store, past the server: for asserting what it holds. */
async function store(kind: "query" | "update", body: string): Promise<boolean> {
  const res = await fetch(`${oxigraph}/${kind}`, {
    method: "POST",
    headers: {
      "content-type": `application/sparql-${kind}`,
      accept: "application/sparql-results+json",
    },
    body,
  });
  expect(res.ok, await res.clone().text()).toBe(true);
  return (
    kind === "query" && ((await res.json()) as { boolean: boolean }).boolean
  );
}
const ask = (q: string) => store("query", q);

/** A name no other test uses, so tests share one store without interfering. */
const unique = (label: string) => `${label} ${randomUUID()}`;

async function entityAs(reader: Agent, name: string) {
  const { json } = await must(reader, "find_memories_by_name", {
    names: [name],
  });
  return json.entities.find((e: { name: string }) => e.name === name);
}

describe("authentication", () => {
  it("rejects a request with no token, before any MCP exchange", async () => {
    await expect(connect()).rejects.toMatchObject({ code: 401 });

    const res = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="memory"');
  });

  it("rejects an unknown token, and a known one under another scheme", async () => {
    await expect(connect(`Bearer ${token()}`)).rejects.toMatchObject({
      code: 401,
    });
    await expect(connect(`Basic ${TOKENS.cmo}`)).rejects.toMatchObject({
      code: 401,
    });

    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.cmo}x` },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="memory", error="invalid_token"',
    );
  });

  it("admits each configured agent, a hyphenated id included", async () => {
    const tools = await (await as("research-2")).listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "add_observations",
      "create_entities",
      "create_relations",
      "delete_entities",
      "delete_observations",
      "delete_relations",
      "find_memories_by_name",
      "read_graph",
      "search_memories",
    ]);
  });

  it("refuses to start with a weak, shared or missing token map", () => {
    const urls = {
      SPARQL_QUERY_URL: `${oxigraph}/query`,
      SPARQL_UPDATE_URL: `${oxigraph}/update`,
    };
    expect(() => memoryHttpServerFromEnv(urls, "t")).toThrow(
      /would admit nobody/,
    );
    expect(() =>
      memoryHttpServerFromEnv({ ...urls, MCP_TOKEN_CMO: "short" }, "t"),
    ).toThrow(/MCP_TOKEN_CMO: token shorter than 32/);
    const shared = token();
    expect(() =>
      memoryHttpServerFromEnv(
        { ...urls, MCP_TOKEN_CMO: shared, MCP_TOKEN_CIO: shared },
        "t",
      ),
    ).toThrow(/same token as/);
    expect(() =>
      memoryHttpServerFromEnv({ ...urls, MCP_TOKEN_cmo: token() }, "t"),
    ).toThrow(/MCP_TOKEN_cmo: not MCP_TOKEN_ followed by an agent id/);
    expect(() =>
      memoryHttpServerFromEnv({ MCP_TOKEN_CMO: token() }, "t"),
    ).toThrow(/SPARQL_QUERY_URL: not set to a URL/);
    expect(() =>
      memoryHttpServerFromEnv({ ...urls, MCP_TOKEN_CFO: `${token()}\n` }, "t"),
    ).toThrow(/MCP_TOKEN_CFO: token has leading or trailing whitespace/);
    expect(() =>
      memoryHttpServerFromEnv({ ...urls, MCP_TOKEN_CFO: ` ${token()}` }, "t"),
    ).toThrow(/MCP_TOKEN_CFO: token has leading or trailing whitespace/);
  });

  it("refuses to start on a token file it can't use, or an agent given twice", () => {
    const urls = {
      SPARQL_QUERY_URL: `${oxigraph}/query`,
      SPARQL_UPDATE_URL: `${oxigraph}/update`,
    };
    const dir = mkdtempSync(join(tmpdir(), "mcp-tokens-"));
    try {
      const missing = join(dir, "missing");
      expect(() =>
        memoryHttpServerFromEnv({ ...urls, MCP_TOKEN_CMO_FILE: missing }, "t"),
      ).toThrow(/MCP_TOKEN_CMO_FILE: cannot read /);
      const newline = join(dir, "newline");
      writeFileSync(newline, `${token()}\n`);
      expect(() =>
        memoryHttpServerFromEnv({ ...urls, MCP_TOKEN_CMO_FILE: newline }, "t"),
      ).toThrow(/MCP_TOKEN_CMO_FILE: token has leading or trailing whitespace/);
      const good = join(dir, "good");
      writeFileSync(good, token());
      expect(() =>
        memoryHttpServerFromEnv(
          { ...urls, MCP_TOKEN_CMO: token(), MCP_TOKEN_CMO_FILE: good },
          "t",
        ),
      ).toThrow(/MCP_TOKEN_CMO_FILE: agent cmo already has MCP_TOKEN_CMO/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("follows a rotated token file without a restart, once its read is stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-tokens-"));
    const path = join(dir, "token");
    const old = token();
    writeFileSync(path, old);
    let clock = 0;
    const { server: rotating } = memoryHttpServerFromEnv(
      {
        MCP_TOKEN_CMO_FILE: path,
        SPARQL_QUERY_URL: `${oxigraph}/query`,
        SPARQL_UPDATE_URL: `${oxigraph}/update`,
      },
      "t",
      () => clock,
    );
    await new Promise<void>((r) => rotating.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(rotating.address() as AddressInfo).port}/mcp`;
    const status = async (t: string) =>
      (
        await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${t}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "rotation-test", version: "0" },
            },
          }),
        })
      ).status;
    try {
      expect(await status(old)).toBe(200);

      const rotated = token();
      writeFileSync(path, rotated);
      clock = TOKEN_FILE_TTL_MS - 1;
      expect(await status(old)).toBe(200);
      clock = TOKEN_FILE_TTL_MS;
      expect(await status(old)).toBe(401);
      expect(await status(rotated)).toBe(200);

      // An unreadable file admits nobody, and a fixed one admits again.
      rmSync(path);
      clock = 2 * TOKEN_FILE_TTL_MS;
      expect(await status(rotated)).toBe(401);
      writeFileSync(path, rotated);
      clock = 3 * TOKEN_FILE_TTL_MS;
      expect(await status(rotated)).toBe(200);
    } finally {
      await new Promise((r) => rotating.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves the health check without a token", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "0.0.0-test" });
  });
});

describe("the writer stamp", () => {
  it("records the calling agent as writer, whatever the arguments say", async () => {
    const alice = unique("Alice");
    const acme = unique("Acme");
    const spoof = {
      writer: "cio",
      graph: "urn:arbora:memory:agent:cio",
      agent: "cio",
    };

    const created = await call("cmo", "create_entities", {
      ...spoof,
      entities: [
        { name: alice, type: "person", observations: ["Founder"], ...spoof },
        { name: acme, type: "company", observations: [], ...spoof },
      ],
    });
    expect(created.isError).toBe(false);
    expect(created.json.map((e: { writer: string }) => e.writer)).toEqual([
      "cmo",
      "cmo",
    ]);

    await must("cmo", "add_observations", {
      ...spoof,
      observations: [
        { entityName: alice, observations: ["Based in Lyon"], ...spoof },
      ],
    });
    await must("cmo", "create_relations", {
      ...spoof,
      relations: [
        { source: alice, target: acme, relationType: "WORKS_AT", ...spoof },
      ],
    });

    // Read back by another agent: every fact is cmo's, none landed in cio's graph.
    const { json } = await call("cio", "find_memories_by_name", {
      names: [alice],
    });
    expect(json.entities).toEqual([
      {
        name: alice,
        types: [{ type: "person", writer: "cmo" }],
        observations: [
          { observation: "Based in Lyon", writer: "cmo" },
          { observation: "Founder", writer: "cmo" },
        ],
      },
    ]);
    expect(json.relations).toEqual([
      { source: alice, target: acme, relationType: "WORKS_AT", writer: "cmo" },
    ]);
  });

  it("stores hostile text verbatim and keeps it inside the caller's graph", async () => {
    const name = unique('Bobby"> } ; DROP ALL ; # <x>');
    const hostile = [
      '"} } ; DROP ALL ; INSERT DATA { GRAPH <urn:arbora:memory:agent:cio> { <urn:a> <urn:b> "pwned" } } #',
      "line one\nline two\r\n\ttabbed",
      "back\\slash and \\u0022 and \\n literally",
      "'''single''' and \"\"\"triple\"\"\"",
      "unicode: é 漢字 🚀 \u0000  ",
    ];
    const created = await call("cmo", "create_entities", {
      entities: [{ name, type: "person", observations: hostile }],
    });
    expect(created.isError).toBe(false);

    const entity = await entityAs("cfo", name);
    expect(
      entity.observations
        .map((o: { observation: string }) => o.observation)
        .sort(),
    ).toEqual([...hostile].sort());
    expect(
      new Set(entity.observations.map((o: { writer: string }) => o.writer)),
    ).toEqual(new Set(["cmo"]));

    // Nothing the hostile text spelled out was executed: asked of the store
    // itself, no <urn:a> triple and no "pwned" literal exists in any graph,
    // and nothing was dropped.
    expect(await ask("ASK { GRAPH ?g { <urn:a> ?p ?o } }")).toBe(false);
    expect(await ask('ASK { GRAPH ?g { ?s ?p "pwned" } }')).toBe(false);
    expect(
      await ask("ASK { GRAPH <urn:arbora:memory:agent:cmo> { ?s ?p ?o } }"),
    ).toBe(true);
  });

  it("refuses to write about an entity no agent has created", async () => {
    const ghost = unique("Ghost");
    const r = await call("cmo", "add_observations", {
      observations: [{ entityName: ghost, observations: ["boo"] }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no such entities");
    expect(await entityAs("cmo", ghost)).toBeUndefined();
  });
});

describe("input text", () => {
  it("refuses a string that is not well-formed Unicode", async () => {
    const lone = `${unique("Lone")} \uD800`;
    const r = await call("cmo", "create_entities", {
      entities: [{ name: lone, type: "concept", observations: [] }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("well-formed Unicode");

    const named = unique("Named");
    await must("cmo", "create_entities", {
      entities: [{ name: named, type: "concept", observations: [] }],
    });
    for (const [tool, args] of [
      [
        "add_observations",
        { observations: [{ entityName: named, observations: ["a\uDC00"] }] },
      ],
      ["search_memories", { query: "\uD83D" }],
      ["find_memories_by_name", { names: ["\uDFFF"] }],
    ] as const) {
      const bad = await call("cmo", tool, args);
      expect(bad.isError, tool).toBe(true);
      expect(bad.text, tool).toContain("well-formed Unicode");
    }
  });

  it("normalizes text to NFC, so composed and decomposed forms are one", async () => {
    const id = randomUUID();
    const decomposed = `Cafe\u0301 ${id}`; // e + combining acute
    const composed = `Caf\u00e9 ${id}`;
    await must("cmo", "create_entities", {
      entities: [
        { name: decomposed, type: "place", observations: ["cre\u0300me"] },
      ],
    });
    await must("cio", "add_observations", {
      observations: [{ entityName: composed, observations: ["open late"] }],
    });

    const entity = await entityAs("cfo", composed);
    expect(entity).toEqual({
      name: composed,
      types: [{ type: "place", writer: "cmo" }],
      observations: [
        { observation: "open late", writer: "cio" },
        { observation: "cr\u00e8me", writer: "cmo" },
      ],
    });

    // Retracting in the other form finds the same fact.
    const r = await must("cmo", "delete_observations", {
      deletions: [{ entityName: composed, observations: ["cr\u00e8me"] }],
    });
    expect(r.json.notFound).toEqual([]);
    const search = await must("cfo", "search_memories", {
      query: `cafe\u0301\t${id}`,
    });
    expect(search.json.entities.map((e: { name: string }) => e.name)).toEqual([
      composed,
    ]);
  });

  it("splits search words on any whitespace", async () => {
    const id = randomUUID();
    const name = `Spaced ${id}`;
    await must("cmo", "create_entities", {
      entities: [{ name, type: "concept", observations: [] }],
    });
    const r = await must("cio", "search_memories", {
      query: `\n\tnomatch\u00a0${id}\u2003`,
    });
    expect(r.json.entities.map((e: { name: string }) => e.name)).toEqual([
      name,
    ]);
  });

  it("skips a hand-edited fact with a malformed IRI rather than fail every read", async () => {
    const name = unique("Survivor");
    await must("cmo", "create_entities", {
      entities: [{ name, type: "concept", observations: [] }],
    });
    await store(
      "update",
      `INSERT DATA { GRAPH <urn:arbora:memory:agent:operator> {
        <urn:arbora:memory:entity:bad%E0%A4> <urn:arbora:memory:observation> "x" .
        <urn:arbora:memory:entity:ok> <urn:arbora:memory:relation:BAD%FF> <urn:arbora:memory:entity:ok2> .
      } }`,
    );
    try {
      for (const reader of ["cmo", "cio"] as const) {
        const { json } = await must(reader, "read_graph");
        expect(json.entities.map((e: { name: string }) => e.name)).toContain(
          name,
        );
        expect(JSON.stringify(json)).not.toContain("BAD");
      }
    } finally {
      await store(
        "update",
        "DROP SILENT GRAPH <urn:arbora:memory:agent:operator>",
      );
    }
  });
});

describe("retraction", () => {
  it("refuses to retract another agent's facts, and retracts nothing", async () => {
    const deal = unique("Deal");
    const fund = unique("Fund");
    await must("cmo", "create_entities", {
      entities: [
        {
          name: deal,
          type: "opportunity",
          observations: ["Series A", "Closes in May"],
        },
        { name: fund, type: "company", observations: [] },
      ],
    });
    await must("cmo", "create_relations", {
      relations: [{ source: fund, target: deal, relationType: "LEADS" }],
    });
    await must("cio", "add_observations", {
      observations: [{ entityName: deal, observations: ["Closes in June"] }],
    });

    // A mix of cio's own fact and cmo's: refused whole.
    const obs = await call("cio", "delete_observations", {
      deletions: [
        { entityName: deal, observations: ["Closes in June", "Closes in May"] },
      ],
    });
    expect(obs.isError).toBe(true);
    expect(obs.text).toContain("refused");
    expect(obs.text).toContain('observation "Closes in May"');
    expect(obs.text).toContain("written by cmo");

    const rel = await call("cio", "delete_relations", {
      relations: [{ source: fund, target: deal, relationType: "LEADS" }],
    });
    expect(rel.isError).toBe(true);
    expect(rel.text).toContain("written by cmo");

    const ent = await call("cio", "delete_entities", { entityNames: [fund] });
    expect(ent.isError).toBe(true);
    expect(ent.text).toContain(
      `entity ${JSON.stringify(fund)} (written by cmo)`,
    );

    const { json } = await call("cfo", "find_memories_by_name", {
      names: [deal, fund],
    });
    const dealNow = json.entities.find(
      (e: { name: string }) => e.name === deal,
    );
    expect(dealNow.observations).toEqual([
      { observation: "Closes in June", writer: "cio" },
      { observation: "Closes in May", writer: "cmo" },
      { observation: "Series A", writer: "cmo" },
    ]);
    expect(json.relations).toEqual([
      { source: fund, target: deal, relationType: "LEADS", writer: "cmo" },
    ]);
  });

  it("retracts one's own facts, leaving others' copies of the same fact", async () => {
    const topic = unique("Topic");
    await must("cmo", "create_entities", {
      entities: [
        {
          name: topic,
          type: "concept",
          observations: ["Shared view", "Mine only"],
        },
      ],
    });
    await must("cio", "add_observations", {
      observations: [{ entityName: topic, observations: ["Shared view"] }],
    });

    const r = await call("cmo", "delete_observations", {
      deletions: [
        {
          entityName: topic,
          observations: ["Shared view", "Mine only", "Never said"],
        },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({
      retracted: [
        { entityName: topic, observation: "Shared view" },
        { entityName: topic, observation: "Mine only" },
      ],
      notFound: [{ entityName: topic, observation: "Never said" }],
    });

    expect((await entityAs("cfo", topic)).observations).toEqual([
      { observation: "Shared view", writer: "cio" },
    ]);
  });

  it("retracts one's own relations", async () => {
    const a = unique("A");
    const b = unique("B");
    await must("cfo", "create_entities", {
      entities: [
        { name: a, type: "company", observations: [] },
        { name: b, type: "company", observations: [] },
      ],
    });
    await must("cfo", "create_relations", {
      relations: [{ source: a, target: b, relationType: "OWNS" }],
    });
    const r = await call("cfo", "delete_relations", {
      relations: [{ source: a, target: b, relationType: "OWNS" }],
    });
    expect(r.isError).toBe(false);
    expect(r.json.retracted).toHaveLength(1);
    const { json } = await call("cmo", "find_memories_by_name", {
      names: [a, b],
    });
    expect(json.relations).toEqual([]);
  });

  it("deletes one's own entity facts, and says who still holds the entity", async () => {
    const mine = unique("Mine");
    const shared = unique("Shared");
    await must("cmo", "create_entities", {
      entities: [
        { name: mine, type: "concept", observations: ["only cmo"] },
        { name: shared, type: "concept", observations: ["cmo says"] },
      ],
    });
    await must("cmo", "create_relations", {
      relations: [{ source: mine, target: shared, relationType: "RELATES_TO" }],
    });
    await must("cio", "add_observations", {
      observations: [{ entityName: shared, observations: ["cio says"] }],
    });

    const r = await call("cmo", "delete_entities", {
      entityNames: [mine, shared],
    });
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({
      retracted: [mine, shared],
      notFound: [],
      stillHeldBy: [{ name: shared, writers: ["cio"] }],
    });

    const { json } = await call("cfo", "find_memories_by_name", {
      names: [mine, shared],
    });
    expect(json.entities).toEqual([
      {
        name: shared,
        types: [],
        observations: [{ observation: "cio says", writer: "cio" }],
      },
    ]);
    expect(json.relations).toEqual([]);
  });
});

describe("retraction across agents", () => {
  it("refuses a delete_entities mixing one's own entity with another's, and keeps both", async () => {
    const own = unique("Own");
    const foreign = unique("Foreign");
    await must("cio", "create_entities", {
      entities: [{ name: own, type: "concept", observations: ["cio's"] }],
    });
    await must("cmo", "create_entities", {
      entities: [{ name: foreign, type: "concept", observations: ["cmo's"] }],
    });

    const r = await call("cio", "delete_entities", {
      entityNames: [own, foreign],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(
      `entity ${JSON.stringify(foreign)} (written by cmo)`,
    );
    expect(r.text).not.toContain(JSON.stringify(own));

    expect((await entityAs("cfo", own)).observations).toEqual([
      { observation: "cio's", writer: "cio" },
    ]);
    expect((await entityAs("cfo", foreign)).observations).toEqual([
      { observation: "cmo's", writer: "cmo" },
    ]);
  });

  it("keeps an entity another agent holds only through a relation", async () => {
    const a = unique("Hub");
    const b = unique("Spoke");
    await must("cmo", "create_entities", {
      entities: [
        { name: a, type: "company", observations: [] },
        { name: b, type: "company", observations: ["cmo made it"] },
      ],
    });
    await must("cio", "create_relations", {
      relations: [{ source: a, target: b, relationType: "SUPPLIES" }],
    });

    // cmo created b; cio refers to it only as a relation's target.
    const r = await must("cmo", "delete_entities", { entityNames: [b] });
    expect(r.json).toEqual({
      retracted: [b],
      notFound: [],
      stillHeldBy: [{ name: b, writers: ["cio"] }],
    });
    let read = await must("cfo", "find_memories_by_name", { names: [b] });
    expect(read.json.entities).toEqual([
      { name: b, types: [], observations: [] },
    ]);
    expect(read.json.relations).toEqual([
      { source: a, target: b, relationType: "SUPPLIES", writer: "cio" },
    ]);

    // And cio, holding it only through that relation, may retract it.
    const mine = await must("cio", "delete_entities", { entityNames: [b] });
    expect(mine.json).toEqual({
      retracted: [b],
      notFound: [],
      stillHeldBy: [],
    });
    read = await must("cfo", "find_memories_by_name", { names: [a, b] });
    expect(read.json.entities.map((e: { name: string }) => e.name)).toEqual([
      a,
    ]);
    expect(read.json.relations).toEqual([]);
  });
});

describe("reading", () => {
  it("lets every agent read every agent's graph, with each fact's writer", async () => {
    const target = unique("Investor");
    await must("cmo", "create_entities", {
      entities: [
        { name: target, type: "company", observations: ["Invests in seed"] },
      ],
    });
    await must("cio", "add_observations", {
      observations: [
        { entityName: target, observations: ["Invests in Series A, not seed"] },
      ],
    });
    await must("cfo", "create_entities", {
      entities: [{ name: target, type: "fund", observations: [] }],
    });

    const expected = {
      name: target,
      types: [
        { type: "fund", writer: "cfo" },
        { type: "company", writer: "cmo" },
      ],
      observations: [
        { observation: "Invests in Series A, not seed", writer: "cio" },
        { observation: "Invests in seed", writer: "cmo" },
      ],
    };
    const word = target.split(" ")[1];
    for (const reader of ["cmo", "cio", "cfo", "research-2"] as const) {
      const all = await call(reader, "read_graph");
      expect(all.json.entities).toContainEqual(expected);

      const byName = await call(reader, "find_memories_by_name", {
        names: [target],
      });
      expect(byName.json.entities).toEqual([expected]);

      const search = await call(reader, "search_memories", {
        query: `nomatch ${word?.toUpperCase()}`,
      });
      expect(search.json.entities).toEqual([expected]);
    }
  });
});
