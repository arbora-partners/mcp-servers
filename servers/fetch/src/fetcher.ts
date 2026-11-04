/**
 * The fetcher: one https GET, redirects followed by hand so that every hop is
 * checked again, and the connection made to the very address that was checked.
 *
 * The policy, in the order it is applied to each hop:
 *  1. the URL is https, carries no credentials, and names port 443;
 *  2. the host resolves (an IP literal resolves to itself), and EVERY address
 *     it resolves to is public unicast (addresses.ts);
 *  3. the connection goes to the first of those addresses, with the host name
 *     kept for SNI, certificate verification and the Host header. Nothing is
 *     resolved a second time, so there is no gap between check and connect.
 *
 * DNS and TLS trust are parameters (`FetcherDeps`), so tests reach nothing
 * outside the machine. Nothing here reads the environment.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { isPublicAddress } from "./addresses.ts";
import { htmlToText } from "./text.ts";

export interface FetchLimits {
  /** Redirects followed before giving up. */
  maxRedirects: number;
  /** Body bytes read; the rest is dropped and the result says so. */
  maxReadBytes: number;
  /** Characters of text returned; the rest is dropped and the result says so. */
  maxChars: number;
  /** Wall-clock budget for the whole fetch, redirects included. */
  timeoutMs: number;
}

export const DEFAULT_LIMITS: FetchLimits = {
  maxRedirects: 3,
  maxReadBytes: 1_000_000,
  maxChars: 100_000,
  timeoutMs: 15_000,
};

export interface FetcherDeps {
  /** Every address `hostname` resolves to. Defaults to the system resolver. */
  lookup?: (hostname: string) => Promise<string[]>;
  /**
   * Where to actually dial for a checked `address` and the URL's `port`.
   * Defaults to those themselves; tests use it to reach a local server while
   * the policy still sees a public address.
   */
  route?: (address: string, port: number) => { host: string; port: number };
  /** Extra CA certificate(s) to trust, e.g. a test server's. */
  ca?: string | Buffer;
  limits?: Partial<FetchLimits>;
  /** Aborts the fetch, e.g. when the caller hangs up. */
  signal?: AbortSignal;
}

/** A fetch the policy or a limit stopped, or that failed in transit. */
export class FetchError extends Error {
  override name = "FetchError";
  constructor(
    message: string,
    readonly kind: "refused" | "failed",
    readonly detail: {
      status?: number;
      bytes?: number;
      finalUrl?: string;
    } = {},
  ) {
    super(message);
  }
}

export interface FetchResult {
  status: number;
  finalUrl: string;
  /** Bytes of body read from the wire. */
  bytes: number;
  /** The page as text, with a trailing note when it was cut short. */
  text: string;
  truncated: boolean;
}

const ALLOWED_PORT = 443;

const defaultLookup = async (hostname: string): Promise<string[]> =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(
    (a) => a.address,
  );

/** Refuses unless `url` may be requested at all; returns the host to dial. */
async function checkHop(
  url: URL,
  lookup: (hostname: string) => Promise<string[]>,
): Promise<{ hostname: string; address: string }> {
  if (url.protocol !== "https:")
    throw new FetchError(
      `refused: only https is allowed, not ${url.protocol}`,
      "refused",
    );
  if (url.username !== "" || url.password !== "")
    throw new FetchError(
      "refused: URLs with credentials are not allowed",
      "refused",
    );
  const port = url.port === "" ? ALLOWED_PORT : Number(url.port);
  if (port !== ALLOWED_PORT)
    throw new FetchError(
      `refused: only port ${ALLOWED_PORT} is allowed`,
      "refused",
    );

  // `hostname` keeps the brackets of an IPv6 literal.
  const hostname = url.hostname.replace("[", "").replace("]", "");
  let addresses: string[];
  try {
    addresses = isIP(hostname) !== 0 ? [hostname] : await lookup(hostname);
  } catch {
    throw new FetchError(`could not resolve ${hostname}`, "failed");
  }
  if (addresses.length === 0)
    throw new FetchError(`refused: ${hostname} does not resolve`, "refused");
  for (const address of addresses) {
    if (!isPublicAddress(address))
      throw new FetchError(
        `refused: ${hostname} resolves to a non-public address (${address})`,
        "refused",
      );
  }
  return { hostname, address: addresses[0] as string };
}

const TEXTUAL_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

function mediaType(header: string | undefined): string {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function charset(header: string | undefined): string {
  for (const param of (header ?? "").split(";").slice(1)) {
    const [key, value] = param.split("=");
    if (key?.trim().toLowerCase() === "charset" && value !== undefined)
      return value.trim().split('"').join("").toLowerCase();
  }
  return "utf-8";
}

function isTextual(type: string): boolean {
  return (
    type === "" ||
    type.startsWith("text/") ||
    TEXTUAL_TYPES.has(type) ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

function decode(body: Buffer, label: string): string {
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

interface Hop {
  status: number;
  location?: string;
  contentType?: string;
  body: Buffer;
  readTruncated: boolean;
}

function once(
  url: URL,
  target: { hostname: string; address: string },
  deps: FetcherDeps,
  limits: FetchLimits,
  signal: AbortSignal,
): Promise<Hop> {
  const dial = (deps.route ?? ((host, port) => ({ host, port })))(
    target.address,
    ALLOWED_PORT,
  );
  return new Promise<Hop>((resolve, reject) => {
    const req = request(
      {
        host: dial.host,
        port: dial.port,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        // SNI and certificate verification use the name, not the address.
        // TLS forbids an IP as server name, so an IP literal sends none.
        servername: isIP(target.hostname) === 0 ? target.hostname : undefined,
        headers: {
          host: url.host,
          "user-agent": "arbora-mcp-fetch/0.1",
          accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1",
          // No compression: the byte cap then bounds what we hold, with no
          // decompression bomb in between.
          "accept-encoding": "identity",
        },
        ca: deps.ca,
        agent: false,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const header = (name: string) => {
          const v = res.headers[name];
          return Array.isArray(v) ? v[0] : v;
        };
        const hop = {
          status,
          location: header("location"),
          contentType: header("content-type"),
        };
        if (status >= 300 && status < 400) {
          res.destroy();
          resolve({ ...hop, body: Buffer.alloc(0), readTruncated: false });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          const room = limits.maxReadBytes - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += Math.min(chunk.length, room);
          if (chunk.length > room) {
            res.destroy();
            resolve({
              ...hop,
              body: Buffer.concat(chunks),
              readTruncated: true,
            });
          }
        });
        res.on("end", () =>
          resolve({
            ...hop,
            body: Buffer.concat(chunks),
            readTruncated: false,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Fetches `input` as the policy allows; throws `FetchError` otherwise. */
export async function fetchPage(
  input: string,
  deps: FetcherDeps = {},
): Promise<FetchResult> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const lookup = deps.lookup ?? defaultLookup;
  let hungUp = false;
  const timedOut = () =>
    hungUp
      ? new FetchError("aborted: the caller hung up", "failed")
      : new FetchError(`timed out after ${limits.timeoutMs} ms`, "failed");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const onHangUp = () => {
    hungUp = true;
    controller.abort();
  };
  if (deps.signal?.aborted) onHangUp();
  else deps.signal?.addEventListener("abort", onHangUp, { once: true });
  const aborted = new Promise<never>((_, reject) =>
    controller.signal.addEventListener("abort", () => reject(timedOut())),
  );
  aborted.catch(() => {}); // only raced; never an unhandled rejection

  try {
    if (!URL.canParse(input))
      throw new FetchError("refused: not a valid absolute URL", "refused");
    let url = new URL(input);
    for (let redirects = 0; ; redirects++) {
      const target = await Promise.race([checkHop(url, lookup), aborted]);
      let hop: Hop;
      try {
        hop = await Promise.race([
          once(url, target, deps, limits, controller.signal),
          aborted,
        ]);
      } catch (error) {
        if (error instanceof FetchError) throw error;
        if (controller.signal.aborted) throw timedOut();
        throw new FetchError(
          `request failed: ${error instanceof Error ? error.message : String(error)}`,
          "failed",
        );
      }

      if (hop.status >= 300 && hop.status < 400 && hop.location !== undefined) {
        if (redirects >= limits.maxRedirects)
          throw new FetchError(
            `refused: more than ${limits.maxRedirects} redirects`,
            "refused",
            { status: hop.status },
          );
        if (!URL.canParse(hop.location, url.href))
          throw new FetchError(
            "refused: redirect to an invalid URL",
            "refused",
            {
              status: hop.status,
            },
          );
        url = new URL(hop.location, url);
        continue;
      }

      const finalUrl = url.href;
      const bytes = hop.body.length;
      const type = mediaType(hop.contentType);
      if (hop.status < 200 || hop.status >= 300)
        throw new FetchError(`HTTP ${hop.status} from ${finalUrl}`, "failed", {
          status: hop.status,
          bytes,
          finalUrl,
        });
      if (!isTextual(type))
        throw new FetchError(
          `refused: ${type} is not a text content type`,
          "refused",
          { status: hop.status, bytes, finalUrl },
        );

      const raw = decode(hop.body, charset(hop.contentType));
      let text = HTML_TYPES.has(type) ? htmlToText(raw) : raw;
      const notes: string[] = [];
      if (hop.readTruncated)
        notes.push(`the page was cut at ${limits.maxReadBytes} bytes`);
      if (text.length > limits.maxChars) {
        text = text.slice(0, limits.maxChars).toWellFormed();
        notes.push(`the text was cut at ${limits.maxChars} characters`);
      }
      if (notes.length > 0)
        text += `\n\n[truncated: ${notes.join("; ")}. This is not the whole page.]`;
      return {
        status: hop.status,
        finalUrl,
        bytes,
        text,
        truncated: notes.length > 0,
      };
    }
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onHangUp);
    controller.abort();
  }
}
