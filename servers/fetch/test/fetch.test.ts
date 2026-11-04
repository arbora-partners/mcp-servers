/**
 * The fetch server through its one seam: MCP over streamable HTTP, driven by
 * the SDK's own client, with per-agent bearer tokens. Nothing leaves the
 * machine: DNS is an injected table, and the dial is routed to a local TLS
 * server whose self-signed certificate is the injected CA. The policy still
 * sees the public addresses the table hands out.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { authenticatorFromEnv } from "@arbora/mcp-auth";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPublicAddress } from "../src/addresses.ts";
import { fetchHttpServer } from "../src/http.ts";
import type { FetchLogLine } from "../src/tools.ts";

const PUBLIC = "93.184.216.34";
const DNS: Record<string, string[]> = {
  "example.test": [PUBLIC],
  "internal.test": ["10.0.0.5"],
  "metadata.test": ["169.254.169.254"],
  "loopback.test": ["127.0.0.1"],
  "mapped.test": ["::ffff:7f00:1"],
  "mixed.test": [PUBLIC, "192.168.1.1"],
  "v6mapped.test": ["::ffff:8.8.8.8"],
};

const CMO_TOKEN = randomBytes(32).toString("base64url");
const CIO_TOKEN = randomBytes(32).toString("base64url");

const run = promisify(execFile);
let dir: string;
let upstream: HttpsServer;
let mcpServer: ReturnType<typeof fetchHttpServer>;
let base: string;
let mcpServer2: ReturnType<typeof fetchHttpServer>;
let base2: string;
const dialled: string[] = [];
const out: string[] = [];
const err: string[] = [];
const sinks = {
  out: (line: string) => out.push(line),
  err: (message: string) => err.push(message),
};
const logged = (): FetchLogLine[] =>
  out.map((line) => JSON.parse(line) as FetchLogLine);
const hung: (() => void)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fetch-test-"));
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=example.test",
    "-addext",
    "subjectAltName=DNS:example.test",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
  ]);
  const cert = await readFile(join(dir, "cert.pem"));
  const key = await readFile(join(dir, "key.pem"));

  upstream = createHttpsServer({ key, cert }, (req, res) => {
    const path = req.url ?? "/";
    const send = (
      status: number,
      type: string,
      body: string | Buffer,
      extra = {},
    ) => {
      res.writeHead(status, { "content-type": type, ...extra });
      res.end(body);
    };
    if (req.method !== "GET") return send(405, "text/plain", "GET only");
    switch (path) {
      case "/page":
        return send(
          200,
          "text/html; charset=utf-8",
          `<html><head><title>T</title><style>p{color:red}</style><script>var secret=1;</script></head>
           <body><h1>Series A</h1><p>Acme raised <b>$5M</b>.</p><a href="https://acme.example/team">Team</a></body></html>`,
        );
      case "/json":
        return send(200, "application/json", '{"ok":true}');
      case "/redirect-ok":
        return send(302, "text/plain", "", { location: "/page" });
      case "/redirect-internal":
        return send(302, "text/plain", "", {
          location: "https://internal.test/admin",
        });
      case "/redirect-metadata":
        return send(301, "text/plain", "", {
          location: "https://metadata.test/latest/meta-data/",
        });
      case "/redirect-http":
        return send(302, "text/plain", "", {
          location: "http://example.test/page",
        });
      case "/redirect-loop":
        return send(302, "text/plain", "", { location: "/redirect-loop" });
      case "/big":
        return send(200, "text/plain", Buffer.alloc(3_000, "a"));
      case "/long":
        return send(200, "text/plain", "b".repeat(500));
      case "/image":
        return send(200, "image/png", Buffer.from([0x89, 0x50]));
      case "/missing":
        return send(404, "text/plain", "nope");
      case "/hang":
        hung.push(() => res.destroy());
        return; // never answers
      default:
        return send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  mcpServer = fetchHttpServer({
    authenticator: authenticatorFromEnv({
      MCP_TOKEN_CMO: CMO_TOKEN,
      MCP_TOKEN_CIO: CIO_TOKEN,
    }),
    version: "0.0.0-test",
    sinks,
    fetcher: {
      lookup: async (hostname) => {
        if (hostname === "throws.test") throw new Error("resolver down");
        return DNS[hostname] ?? [];
      },
      route: (address) => {
        dialled.push(address);
        return { host: "127.0.0.1", port: upstreamPort };
      },
      ca: cert,
      limits: {
        maxReadBytes: 1_000,
        maxChars: 200,
        timeoutMs: 400,
        maxRedirects: 3,
      },
    },
  });
  mcpServer2 = fetchHttpServer({
    authenticator: authenticatorFromEnv({
      MCP_TOKEN_CMO: CMO_TOKEN,
      MCP_TOKEN_CIO: CIO_TOKEN,
    }),
    version: "0.0.0-test",
    sinks,
    maxInFlight: 2,
    fetcher: {
      lookup: async (hostname) => DNS[hostname] ?? [],
      route: () => ({ host: "127.0.0.1", port: upstreamPort }),
      ca: cert,
      limits: { timeoutMs: 20_000 },
    },
  });
  await new Promise<void>((r) => mcpServer2.listen(0, "127.0.0.1", r));
  base2 = `http://127.0.0.1:${(mcpServer2.address() as AddressInfo).port}`;
  await new Promise<void>((r) => mcpServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const h of hung) h();
  for (const server of [mcpServer, mcpServer2]) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  await rm(dir, { recursive: true, force: true });
});

const fetchAs2 = (token: string, url: string) => fetchAs(token, url, base2);

async function connect(authorization?: string, at = base): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${at}/mcp`), {
    requestInit: { headers: authorization ? { authorization } : {} },
  });
  const client = new Client({ name: "fetch-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function fetchAs(token: string, url: string, at = base) {
  const client = await connect(`Bearer ${token}`, at);
  try {
    const res = await client.callTool({ name: "fetch", arguments: { url } });
    const content = res.content as { type: string; text: string }[];
    return { isError: res.isError === true, text: content[0]?.text ?? "" };
  } finally {
    await client.close();
  }
}

describe("auth", () => {
  it("refuses a request with no token", async () => {
    const res = await globalThis.fetch(`${base}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="fetch"');
  });

  it("refuses an unknown token", async () => {
    const res = await globalThis.fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
      },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
  });

  it("answers /healthz without a token", async () => {
    const res = await globalThis.fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
  });

  it("offers one tool, fetch, taking only a url", async () => {
    const client = await connect(`Bearer ${CMO_TOKEN}`);
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name)).toEqual(["fetch"]);
    expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual([
      "url",
    ]);
  });
});

describe("happy path", () => {
  it("returns an HTML page as readable text and dials the checked address", async () => {
    dialled.length = 0;
    const { isError, text } = await fetchAs(
      CMO_TOKEN,
      "https://example.test/page",
    );
    expect(isError).toBe(false);
    expect(text).toContain("SERIES A");
    expect(text).toContain("Acme raised $5M.");
    expect(text).toContain("https://acme.example/team");
    expect(text).not.toContain("<");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("color:red");
    expect(dialled).toEqual([PUBLIC]);
  });

  it("returns non-HTML text as is", async () => {
    const { text } = await fetchAs(CMO_TOKEN, "https://example.test/json");
    expect(text).toBe('{"ok":true}');
  });

  it("follows a redirect, re-checking the hop", async () => {
    dialled.length = 0;
    const { isError, text } = await fetchAs(
      CMO_TOKEN,
      "https://example.test/redirect-ok",
    );
    expect(isError).toBe(false);
    expect(text).toContain("Acme raised");
    expect(dialled).toHaveLength(2);
  });
});

describe("refusals", () => {
  /** Asserts the fetch is refused with `why`; returns how many dials it made. */
  const refused = async (url: string, why: string) => {
    dialled.length = 0;
    const { isError, text } = await fetchAs(CMO_TOKEN, url);
    expect(isError).toBe(true);
    expect(text).toContain(why);
    return dialled.length;
  };

  it("refuses http", async () => {
    expect(await refused("http://example.test/page", "only https")).toBe(0);
  });

  it("refuses a non-443 port", async () => {
    expect(
      await refused("https://example.test:8443/page", "only port 443"),
    ).toBe(0);
  });

  it("refuses credentials in the URL", async () => {
    expect(
      await refused("https://user:pw@example.test/page", "credentials"),
    ).toBe(0);
  });

  it("refuses something that is not a URL", async () => {
    expect(await refused("example.test/page", "not a valid")).toBe(0);
  });

  it.each([
    ["private", "https://10.0.0.1/"],
    ["loopback", "https://127.0.0.1/"],
    ["metadata", "https://169.254.169.254/latest/meta-data/"],
    ["decimal-encoded loopback", "https://2130706433/"],
    ["hex-encoded loopback", "https://0x7f.1/"],
    ["IPv6 loopback", "https://[::1]/"],
    ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/"],
    ["unique-local IPv6", "https://[fd00::1]/"],
    ["IPv4-compatible IPv6", "https://[::127.0.0.1]/"],
    ["SIIT-range IPv6", "https://[::ffff:0:7f00:1]/"],
    ["Teredo", "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/"],
    ["5f00::/16", "https://[5f00::1]/"],
    ["octal IPv4", "https://0177.0.0.1/"],
    ["short IPv4", "https://127.1/"],
  ])("refuses an internal address literal: %s", async (_name, url) => {
    expect(await refused(url, "non-public address")).toBe(0);
  });

  it.each([
    ["private", "https://internal.test/"],
    ["metadata", "https://metadata.test/latest/meta-data/"],
    ["loopback", "https://loopback.test/"],
    ["IPv4-mapped", "https://mapped.test/"],
    ["one public and one private answer", "https://mixed.test/"],
  ])("refuses a hostname resolving to an internal address: %s", async (_name, url) => {
    expect(await refused(url, "non-public address")).toBe(0);
  });

  it("refuses a hostname resolving to an IPv4-mapped address, even a public one", async () => {
    expect(await refused("https://v6mapped.test/", "non-public address")).toBe(
      0,
    );
  });

  it("refuses a URL longer than the cap", async () => {
    const client = await connect(`Bearer ${CMO_TOKEN}`);
    const res = await client.callTool({
      name: "fetch",
      arguments: { url: `https://example.test/${"a".repeat(9000)}` },
    });
    await client.close();
    expect(res.isError).toBe(true);
  });

  it("refuses a hostname that does not resolve", async () => {
    expect(await refused("https://nowhere.test/", "does not resolve")).toBe(0);
  });

  it("refuses a redirect into an internal address, before connecting to it", async () => {
    // One dial, to the first hop; none for the internal target.
    expect(
      await refused(
        "https://example.test/redirect-internal",
        "non-public address",
      ),
    ).toBe(1);
    expect(
      await refused(
        "https://example.test/redirect-metadata",
        "169.254.169.254",
      ),
    ).toBe(1);
  });

  it("refuses a redirect downgrading to http", async () => {
    expect(
      await refused("https://example.test/redirect-http", "only https"),
    ).toBe(1);
  });

  it("stops a redirect loop", async () => {
    expect(
      await refused(
        "https://example.test/redirect-loop",
        "more than 3 redirects",
      ),
    ).toBe(4);
  });

  it("refuses a non-text content type", async () => {
    await refused("https://example.test/image", "image/png is not a text");
  });

  it("reports an HTTP error status", async () => {
    await refused("https://example.test/missing", "HTTP 404");
  });
});

describe("limits", () => {
  it("cuts a body at the read cap and says so", async () => {
    const { isError, text } = await fetchAs(
      CMO_TOKEN,
      "https://example.test/big",
    );
    expect(isError).toBe(false);
    expect(text).toContain("cut at 1000 bytes");
    expect(text).toContain("not the whole page");
  });

  it("cuts the text at the character cap and says so", async () => {
    const { text } = await fetchAs(CMO_TOKEN, "https://example.test/long");
    expect(text).toContain("cut at 200 characters");
    expect(text.startsWith("b".repeat(200))).toBe(true);
  });

  it("gives up on a server that never answers", async () => {
    const started = Date.now();
    const { isError, text } = await fetchAs(
      CMO_TOKEN,
      "https://example.test/hang",
    );
    expect(isError).toBe(true);
    expect(text).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("logging", () => {
  it("logs one line per fetch with the agent from the token", async () => {
    out.length = 0;
    await fetchAs(CIO_TOKEN, "https://example.test/page");
    await fetchAs(CMO_TOKEN, "https://internal.test/");
    await fetchAs(CMO_TOKEN, "https://example.test/redirect-ok");
    const logs = logged();
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({
      event: "fetch",
      agent: "cio",
      url: "https://example.test/page",
      status: 200,
      outcome: "ok",
    });
    expect(logs[0]?.bytes).toBeGreaterThan(0);
    expect(logs[0]?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(logs[1]).toMatchObject({
      agent: "cmo",
      status: null,
      bytes: 0,
      outcome: "refused",
    });
    expect(logs[2]).toMatchObject({
      agent: "cmo",
      final_url: "https://example.test/page",
    });
  });

  it("never writes a token to stdout or stderr", async () => {
    out.length = 0;
    err.length = 0;
    // success, refusal, failure in transit, a 401 and a 500-path request
    await fetchAs(CMO_TOKEN, "https://example.test/page");
    await fetchAs(CMO_TOKEN, "https://internal.test/");
    await fetchAs(CMO_TOKEN, "https://example.test/missing");
    await fetchAs(CIO_TOKEN, "https://throws.test/");
    await globalThis.fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${CMO_TOKEN}` },
      body: "{not json",
    });
    // The capture works: it holds the lines for every call above.
    expect(out).toHaveLength(4);
    expect(logged().map((l) => l.outcome)).toEqual([
      "ok",
      "refused",
      "failed",
      "failed",
    ]);
    const everything = [...out, ...err].join("\n");
    for (const token of [CMO_TOKEN, CIO_TOKEN]) {
      expect(everything).not.toContain(token);
    }
  });
});

describe("limits on concurrency and batches", () => {
  async function post(token: string, body: unknown, signal?: AbortSignal) {
    return globalThis.fetch(`${base2}/mcp`, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
  }
  const call = (id: number, url: string) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "fetch", arguments: { url } },
  });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(ok()).toBe(true);
  };

  it("refuses a batch carrying more than one tools/call", async () => {
    out.length = 0;
    const res = await post(CMO_TOKEN, [
      call(1, "https://example.test/page"),
      call(2, "https://example.test/page"),
    ]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("at most one");
    expect(out).toHaveLength(0); // nothing was fetched
  });

  it("refuses beyond the in-flight cap, and a hang-up aborts the fetch", async () => {
    out.length = 0;
    const before = hung.length;
    const a = new AbortController();
    const b = new AbortController();
    const first = post(
      CMO_TOKEN,
      call(1, "https://example.test/hang"),
      a.signal,
    );
    const second = post(
      CIO_TOKEN,
      call(2, "https://example.test/hang"),
      b.signal,
    );
    first.catch(() => {});
    second.catch(() => {});
    await until(() => hung.length === before + 2);

    // The cap is 2: a third fetch, from anyone, is refused at once.
    const refused = await fetchAs2(CMO_TOKEN, "https://example.test/page");
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("too many fetches in flight");

    // Hanging up aborts the fetches, frees both slots, and says why.
    a.abort();
    b.abort();
    await until(
      () => logged().filter((l) => l.error?.includes("hung up")).length === 2,
    );
    const again = await fetchAs2(CMO_TOKEN, "https://example.test/page");
    expect(again.isError).toBe(false);
  });
});

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "224.0.0.1",
    "239.255.255.250",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe",
    "::ffff:8.8.8.8",
    "64:ff9b::7f00:1",
    "::127.0.0.1",
    "::7f00:1",
    "::ffff:0:0:0",
    "2001::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2002:7f00:1::",
    "5f00::1",
    "3fff::1",
    "not an address",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "100.63.255.255",
    "172.32.0.1",
    "2606:4700:4700::1111",
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});
