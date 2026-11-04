# mcp-servers

The [MCP](https://modelcontextprotocol.io) servers Arbora owns. Each server
builds its own container image here; the infrastructure that runs them is
declared in `arbora-partners/IaC`, which pins each image by digest. This repo
holds no secrets.

Licensed under the [Apache License 2.0](LICENSE).

## Layout

| Path | What |
|------|------|
| `packages/auth/` | `@arbora/mcp-auth`, the shared auth layer: one bearer token per (server, agent), resolved to the caller's agent id |
| `servers/memory/` | The memory server ([IaC ADR 0032](https://github.com/arbora-partners/IaC/blob/main/docs/adr/0032-agent-memory-is-oxigraph-on-an-internal-vm-behind-our-own-mcp-server.md)): generic memory tools over Oxigraph |
| `servers/fetch/` | The fetch server ([agents#43](https://github.com/arbora-partners/agents/issues/43)): public web pages as text, with an SSRF guard |
| `test/oxigraph.ts` | Test setup: one real Oxigraph container, digest-pinned |
| `.github/workflows/` | `checks.yml` (every PR and push), `release-memory.yml` and `release-fetch.yml` (image and release on merge) |

## The memory server

Agents reach it over **MCP streamable HTTP** at `POST /mcp`. It is stateless:
no session, every request carries its bearer token. `GET /healthz` answers
`200` without a token and does not touch the store, for Cloud Run's probes.

### Tools

The same names and inputs as
[`mcp-neo4j-memory`](https://github.com/neo4j-contrib/mcp-neo4j/tree/main/servers/mcp-neo4j-memory),
so a change of store changes no agent:

`create_entities`, `create_relations`, `add_observations`, `delete_entities`,
`delete_observations`, `delete_relations`, `read_graph`, `search_memories`,
`find_memories_by_name`.

Where it differs, on purpose:

- **Every fact shows its writer.** An entity reads back as
  `{ name, types: [{ type, writer }], observations: [{ observation, writer }] }`
  and a relation as `{ source, target, relationType, writer }`.
- **The writer is the caller.** It comes from the bearer token. No input
  names a writer or a graph, and an extra argument that tries to is stripped
  before any handler sees it.
- **An agent retracts only its own facts.** The `delete_*` tools act on the
  caller's graph. A request naming a fact that only other agents hold is
  refused whole, nothing is retracted, and the error names the writers. To
  dispute another agent's fact, write a contradicting one.
- **Writes need the entity.** `add_observations` and `create_relations` refuse
  an entity that no agent has created, where `mcp-neo4j-memory`'s `MATCH`
  would write nothing and say nothing.
- **Search is substring, not full-text.** `search_memories` matches entities
  whose name, type or an observation contains any of the query's words,
  ignoring case.

### Data model

Each agent writes into its own named graph, and reads span every agent graph:

| | IRI |
|---|---|
| An agent's graph | `urn:arbora:memory:agent:<agent id>` |
| An entity | `urn:arbora:memory:entity:<percent-encoded name>` |
| A relation type | `urn:arbora:memory:relation:<percent-encoded type>` |

An entity's facts are `mem:name`, `mem:entityType` and `mem:observation`
literals (`mem:` is `urn:arbora:memory:`), and each relation is a triple
between two entities. Only graphs under `urn:arbora:memory:agent:` are memory;
the server ignores anything else in the store.

Every query is built by a tagged template whose holes take only RDF/JS terms,
serialized by `@rdfjs/to-ntriples` (`servers/memory/src/sparql.ts`). No tool
argument is ever spliced into SPARQL as text.

### Environment

The server reads these variables at startup, and refuses to start if any is
wrong, naming each problem:

| Variable | Required | Value |
|----------|----------|-------|
| `MCP_TOKEN_<AGENT>` | at least one | The bearer token of agent `<agent>`, one variable per admitted agent. `<AGENT>` is the agent id in upper snake case: `cmo` → `MCP_TOKEN_CMO`, `research-2` → `MCP_TOKEN_RESEARCH_2`. At least 32 characters, and no two agents may share a token. |
| `SPARQL_QUERY_URL` | yes | Oxigraph's SPARQL query endpoint, e.g. `http://10.0.0.5:7878/query` |
| `SPARQL_UPDATE_URL` | yes | Oxigraph's SPARQL update endpoint, e.g. `http://10.0.0.5:7878/update` |
| `PORT` | no | Listen port, default `8080`. Cloud Run sets it. |

An agent id is a kebab slug: lowercase letters and digits, single hyphens
between them. A variable starting `MCP_TOKEN_` that doesn't spell one in upper
snake case (`MCP_TOKEN_cmo`, `MCP_TOKEN_A__B`) is an error, not ignored.

**For IaC.** Use one variable per agent, so each maps onto one Secret Manager
secret through Cloud Run's `env[].valueSource.secretKeyRef`. The memory
server's token for agent `cmo` is the IaC Secret `mcp_memory_cmo`, exposed as
`MCP_TOKEN_CMO`. Adding or removing an agent is adding or removing a variable,
then a new revision. A request with no token gets a `401` with
`WWW-Authenticate: Bearer realm="memory"`, and an unknown token gets the same
plus `error="invalid_token"`.

### Correcting a fact by hand

A human corrects memory outside the agents' tools by running SPARQL Update
against Oxigraph directly. Oxigraph has no public address and no
authentication of its own, so the only way in is from inside the VPC. For
example, tunnel to the memory VM over IAP, using the VM name and zone IaC
declares:

```bash
gcloud compute ssh <memory-vm> --zone <zone> --tunnel-through-iap -- -N -L 7878:localhost:7878
```

Then, in another shell, retract one of `cio`'s observations:

```bash
curl -fsS -X POST http://localhost:7878/update \
  -H 'content-type: application/sparql-update' \
  --data-binary @- <<'SPARQL'
DELETE DATA { GRAPH <urn:arbora:memory:agent:cio> {
  <urn:arbora:memory:entity:Acme%20Inc> <urn:arbora:memory:observation> "Closes in June"
} }
SPARQL
```

Write the IRIs as the data model above spells them. An entity name is
percent-encoded as JavaScript's `encodeURIComponent` encodes it. To see what
is there first, `POST` a `SELECT` to `/query` instead.

## The fetch server

The controlled alternative to Claude Code's `WebFetch`, which cannot be limited
to a domain under a host that auto-approves every tool not denied
([agents#43](https://github.com/arbora-partners/agents/issues/43)). Same shape
as the memory server: **MCP streamable HTTP** at `POST /mcp`, stateless, bearer
auth from `@arbora/mcp-auth` (realm `fetch`), and `GET /healthz` without a
token.

### The tool

One tool, `fetch`, with input `{ url: string }`. It returns the page as text;
HTML is converted to readable text with
[`html-to-text`](https://github.com/html-to-text/node-html-to-text) (scripts,
styles and images dropped, link targets kept). A non-text content type is
refused.

| Rule | Value |
|------|-------|
| Scheme, method | `https` only, `GET` only, no credentials in the URL |
| Port | 443 only |
| Redirects | at most 3, each hop checked again from the start |
| Read | at most 1 MB of body; compression is not requested |
| Returned | at most 100,000 characters; a note at the end says when the page was cut, in bytes or characters |
| Time | 15 s for the whole fetch, redirects included |

**SSRF guard.** The host is resolved, and the fetch is refused if *any*
address it resolves to is not public unicast: private, loopback, link-local
(including `169.254.169.254`), CGNAT, multicast, unspecified, reserved,
documentation and benchmarking ranges, and for IPv6 unique-local, site-local,
and every IPv4-mapped, NAT64 and 6to4 form. IP literals in a URL
(`https://2130706433/` included, which `URL` normalizes) get the same check.
The connection then goes to the address that was checked, with the host name
kept for SNI, certificate verification and the `Host` header; nothing is
resolved twice. The ranges are in `servers/fetch/src/addresses.ts`.

**Load.** At most 8 fetches run at once in a process (`maxInFlight`); the
next is refused at once with "too many fetches in flight". A JSON-RPC batch
carrying more than one `tools/call` is refused with `400`, and a caller that
hangs up aborts its fetch. A URL is at most 8192 characters.

**Audit.** Every call writes one JSON line to stdout with `agent` (from the
token), `url`, `status`, `bytes`, `duration_ms`, `outcome` (`ok`, `refused`
or `failed`), plus `final_url` after redirects and `error` on failure (URLs
longer than 2048 characters are cut in the line). Tokens
are never logged. The domain allow or deny list from agents#43 is not here
yet.

### Environment

`MCP_TOKEN_<AGENT>` and `PORT`, exactly as for the memory server. There are
no other settings. **Sizing:** one fetch holds up to about 1 MB of body plus
its decoded string and, for HTML, a parse tree, so budget roughly 25 MB per
fetch in flight: 8 fetches and the Node baseline fit in 512 MiB. Conversion
runs synchronously, so give the service at least one full vCPU and set Cloud
Run's per-instance concurrency to 8 or less, so the cap is not what refuses
agents. The IaC Secret for agent `cio` is `mcp_fetch_cio`, exposed
as `MCP_TOKEN_CIO`. The service needs egress to the internet and nothing
internal.

The tests inject DNS and TLS trust as parameters (`FetcherDeps`) and reach a
local TLS server only; they need `openssl` for a throwaway certificate.

## Development

The devshell (`nix develop`, or direnv with `.envrc`) provides node, pnpm,
biome and just at the versions CI uses. The tests need Docker.

```bash
pnpm install
just check          # lint, typecheck, test: the gates checks.yml runs
just lint           # biome check .
just typecheck      # tsc --noEmit
just test           # vitest run
just image-memory   # docker build -f servers/memory/Dockerfile .
just image-fetch    # docker build -f servers/fetch/Dockerfile .
```

The tests drive each server through its MCP interface over streamable HTTP,
using the SDK's own client, with per-agent bearer tokens. They run against a
real Oxigraph that `test/oxigraph.ts` starts once per run, pinned by digest,
and removes afterwards. The auth layer is tested only through a server. Bump
the Oxigraph digest together with the one IaC deploys on the memory VM.

Dependencies are exact pins. TypeScript, vitest and `@types/node` match the
versions arbora-partners/IaC resolves.

## Releases and how IaC consumes an image

Every merge to `main` that touches a server runs the checks and then that
server's workflow (`release-memory.yml`, `release-fetch.yml`; the text below
says memory, and fetch is the same with `fetch` for `memory`). The workflow:

1. builds `servers/memory/Dockerfile` for `linux/amd64`;
2. pushes `ghcr.io/arbora-partners/mcp-servers/memory`, tagged
   `sha-<commit>` and `latest`;
3. attests the build's provenance to the registry;
4. publishes a GitHub release `memory-<12-char commit>` whose notes record the
   image digest.

A re-run for a commit whose release already exists stops before building, so
the tags never move away from the digest a release records.

IaC never pins a tag. It pins the digest from the release notes in its config,
the way it pins the cache's images:

```toml
# config/gcp.toml
[agent_memory.images]
server = { upstream = "ghcr", path = "arbora-partners/mcp-servers/memory", digest = "sha256:…" }
```

**Once, after the first publish:** GHCR creates the package
`mcp-servers/memory` private, and IaC pulls it anonymously. An org owner sets
it public under the package's settings (Package settings → Danger Zone →
Change visibility → Public), and confirms it is linked to this repository.
Until then IaC's pull fails.

Moving to a new release is a reviewed edit of that digest in IaC. Verify an
image first with:

```bash
gh attestation verify oci://ghcr.io/arbora-partners/mcp-servers/memory@sha256:… --repo arbora-partners/mcp-servers
```

The image is distroless (`gcr.io/distroless/nodejs22-debian13:nonroot`) and
runs as a non-root user. It holds one bundled file, `/app/main.mjs`.
