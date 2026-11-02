/**
 * The memory model over a SPARQL 1.1 store (Oxigraph).
 *
 * Every fact is a triple in the named graph of the agent that wrote it, so a
 * fact's writer is its graph and needs no convention of its own:
 *
 *   graph      urn:arbora:memory:agent:<agent id>
 *   entity     urn:arbora:memory:entity:<percent-encoded name>
 *   relation   urn:arbora:memory:relation:<percent-encoded type>
 *
 *   <entity> mem:name "<name>"          the writer refers to this entity
 *   <entity> mem:entityType "<type>"    the writer says it is of this type
 *   <entity> mem:observation "<text>"   the writer observed this
 *   <entity> <relation> <entity>        the writer relates the two
 *
 * Writes and retractions go to the caller's own graph only; reads span every
 * agent graph. The graph is chosen from the authenticated agent passed to
 * `forAgent`, never from a tool argument.
 */
import type { AgentId } from "@arbora/mcp-auth";
import rdf from "@rdfjs/data-model";
import type { Literal, NamedNode, Quad_Object, Term } from "@rdfjs/types";
import { type Fragment, sparql } from "./sparql.ts";

const NS = "urn:arbora:memory:";
const GRAPH_PREFIX = `${NS}agent:`;
const ENTITY_PREFIX = `${NS}entity:`;
const RELATION_PREFIX = `${NS}relation:`;

const NAME = rdf.namedNode(`${NS}name`);
const TYPE = rdf.namedNode(`${NS}entityType`);
const OBSERVATION = rdf.namedNode(`${NS}observation`);

const lit = (value: string): Literal => rdf.literal(value);

const graphOf = (agent: string): NamedNode =>
  rdf.namedNode(GRAPH_PREFIX + agent);
const entity = (name: string): NamedNode =>
  rdf.namedNode(ENTITY_PREFIX + encodeURIComponent(name));
const relation = (type: string): NamedNode =>
  rdf.namedNode(RELATION_PREFIX + encodeURIComponent(type));

function suffix(iri: string, prefix: string): string | undefined {
  return iri.startsWith(prefix) ? iri.slice(prefix.length) : undefined;
}
/**
 * The percent-decoded rest of `iri` after `prefix`; undefined when `iri` is
 * not under `prefix`, or when its encoding is malformed (a hand-edited IRI,
 * say). Callers skip such a row, so one bad IRI cannot break every agent's
 * reads; the warning names no content.
 */
function decoded(iri: string, prefix: string): string | undefined {
  const s = suffix(iri, prefix);
  if (s === undefined) return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    console.warn(
      `memory: skipping a fact whose ${prefix.slice(NS.length, -1)} IRI is malformed`,
    );
    return undefined;
  }
}
const entityName = (iri: string) => decoded(iri, ENTITY_PREFIX);

/** Restricts `?g` to agent graphs: anything else in the store is not memory. */
const IN_AGENT_GRAPH = sparql`FILTER(STRSTARTS(STR(?g), ${lit(GRAPH_PREFIX)}))`;

// ---- shapes (the tools' inputs and outputs) --------------------------------

interface EntityInput {
  name: string;
  type: string;
  observations: string[];
}
interface RelationInput {
  source: string;
  target: string;
  relationType: string;
}
interface ObservationsInput {
  entityName: string;
  observations: string[];
}

interface Entity {
  name: string;
  types: { type: string; writer: string }[];
  observations: { observation: string; writer: string }[];
}
interface Relation extends RelationInput {
  writer: string;
}
interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

/** A request the memory model refuses; the message is for the calling agent. */
export class MemoryError extends Error {
  override name = "MemoryError";
}

class StoreError extends Error {
  override name = "StoreError";
}

// ---- the SPARQL protocol ---------------------------------------------------

export interface Endpoints {
  /** SPARQL 1.1 query endpoint, e.g. `http://oxigraph:7878/query`. */
  query: string;
  /** SPARQL 1.1 update endpoint, e.g. `http://oxigraph:7878/update`. */
  update: string;
  /** How long one store call may take, response body included. Default 10 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface Binding {
  type: "uri" | "literal" | "bnode" | "triple";
  value: string;
}
type Row = Record<string, Binding | undefined>;

class Sparql {
  constructor(private readonly endpoints: Endpoints) {}

  async select(query: Fragment): Promise<Row[]> {
    const res = await this.post(
      this.endpoints.query,
      "application/sparql-query",
      query,
      {
        accept: "application/sparql-results+json",
      },
    );
    const body = (await this.read(() => res.json())) as {
      results: { bindings: Row[] };
    };
    return body.results.bindings;
  }

  async update(update: Fragment): Promise<void> {
    await this.post(this.endpoints.update, "application/sparql-update", update);
  }

  private async post(
    url: string,
    contentType: string,
    body: Fragment,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const res = await this.read(() =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": contentType, ...headers },
        body: body.text,
        signal: AbortSignal.timeout(
          this.endpoints.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ),
      }),
    );
    if (!res.ok) {
      const text = await this.read(() => res.text());
      throw new StoreError(`memory store answered ${res.status}: ${text}`);
    }
    return res;
  }

  /** Runs one step of a store call, turning a timeout or network failure into a StoreError. */
  private async read<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (cause) {
      const timedOut =
        cause instanceof DOMException && cause.name === "TimeoutError";
      throw new StoreError(
        timedOut ? "memory store timed out" : "memory store unreachable",
        { cause },
      );
    }
  }
}

const value = (row: Row, name: string): string => {
  const b = row[name];
  if (b === undefined) throw new StoreError(`unbound ?${name} in a result row`);
  return b.value;
};

// ---- the memory model ------------------------------------------------------

type Triple = readonly [NamedNode, NamedNode, Quad_Object];
const triples = (ts: readonly Triple[]) =>
  ts.map(([s, p, o]) => sparql`${s} ${p} ${o} .`);
const key = ([s, p, o]: Triple) =>
  JSON.stringify([s.value, p.value, o.termType, o.value]);

function graphFromRows(rows: Row[]): KnowledgeGraph {
  const entities = new Map<string, Entity>();
  const relations: Relation[] = [];
  const entry = (name: string): Entity => {
    let e = entities.get(name);
    if (e === undefined) {
      e = { name, types: [], observations: [] };
      entities.set(name, e);
    }
    return e;
  };
  for (const row of rows) {
    const writer = suffix(value(row, "g"), GRAPH_PREFIX);
    const source = entityName(value(row, "s"));
    if (writer === undefined || source === undefined) continue;
    const p = value(row, "p");
    const o = value(row, "o");
    if (p === NAME.value) entry(source);
    else if (p === TYPE.value) entry(source).types.push({ type: o, writer });
    else if (p === OBSERVATION.value)
      entry(source).observations.push({ observation: o, writer });
    else {
      const relationType = decoded(p, RELATION_PREFIX);
      const target = entityName(o);
      if (relationType === undefined || target === undefined) continue;
      entry(source);
      relations.push({
        source,
        target,
        relationType,
        writer,
      });
    }
  }
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const e of entities.values()) {
    e.types.sort((a, b) => byText(a.writer + a.type, b.writer + b.type));
    e.observations.sort(
      (a, b) =>
        byText(a.writer, b.writer) || byText(a.observation, b.observation),
    );
  }
  return {
    entities: [...entities.values()].sort((a, b) => byText(a.name, b.name)),
    relations: relations.sort((a, b) =>
      byText(
        [a.source, a.relationType, a.target, a.writer].join("\0"),
        [b.source, b.relationType, b.target, b.writer].join("\0"),
      ),
    ),
  };
}

/** Every agent graph's facts, or those touching `subjects` when given. */
async function readFacts(
  store: Sparql,
  subjects?: readonly NamedNode[],
): Promise<KnowledgeGraph> {
  if (subjects !== undefined && subjects.length === 0)
    return { entities: [], relations: [] };
  const query =
    subjects === undefined
      ? sparql`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } ${IN_AGENT_GRAPH} }`
      : sparql`SELECT DISTINCT ?g ?s ?p ?o WHERE {
          VALUES ?e { ${subjects} }
          { GRAPH ?g { ?e ?p ?o } BIND(?e AS ?s) } UNION { GRAPH ?g { ?s ?p ?e } BIND(?e AS ?o) }
          ${IN_AGENT_GRAPH}
        }`;
  return graphFromRows(await store.select(query));
}

/** Entity names (of `names`) that no agent graph refers to. */
async function unknownEntities(
  store: Sparql,
  names: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(names)];
  if (wanted.length === 0) return [];
  const rows = await store.select(sparql`SELECT DISTINCT ?e WHERE {
    VALUES ?e { ${wanted.map(entity)} }
    GRAPH ?g { ?e ${NAME} ?n } ${IN_AGENT_GRAPH}
  }`);
  const known = new Set(rows.map((r) => value(r, "e")));
  return wanted.filter((n) => !known.has(entity(n).value));
}

/** For each triple, the agents whose graphs hold it. */
async function holders(
  store: Sparql,
  ts: readonly Triple[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>(ts.map((t) => [key(t), new Set()]));
  if (ts.length === 0) return out;
  const rows = await store.select(sparql`SELECT ?g ?s ?p ?o WHERE {
    VALUES (?s ?p ?o) { ${ts.map(([s, p, o]) => sparql`(${s} ${p} ${o})`)} }
    GRAPH ?g { ?s ?p ?o } ${IN_AGENT_GRAPH}
  }`);
  for (const row of rows) {
    const t: Triple = [
      rdf.namedNode(value(row, "s")),
      rdf.namedNode(value(row, "p")),
      row.o?.type === "uri"
        ? rdf.namedNode(value(row, "o"))
        : lit(value(row, "o")),
    ];
    const writer = suffix(value(row, "g"), GRAPH_PREFIX);
    if (writer !== undefined) out.get(key(t))?.add(writer);
  }
  return out;
}

interface Retraction<T> {
  /** What was retracted from the caller's graph. */
  retracted: T[];
  /** What no agent's graph holds; nothing to retract. */
  notFound: T[];
}

/**
 * Splits `items` into those the caller holds and those no one does, or
 * refuses the whole request when any item is held only by other agents.
 */
function partition<T>(
  agent: AgentId,
  items: readonly T[],
  writersOf: (item: T) => Set<string>,
  describe: (item: T) => string,
): Retraction<T> {
  const retracted: T[] = [];
  const notFound: T[] = [];
  const foreign: string[] = [];
  for (const item of items) {
    const writers = writersOf(item);
    if (writers.has(agent)) retracted.push(item);
    else if (writers.size === 0) notFound.push(item);
    else
      foreign.push(
        `${describe(item)} (written by ${[...writers].sort().join(", ")})`,
      );
  }
  if (foreign.length > 0) {
    throw new MemoryError(
      `refused: an agent retracts only its own facts, and these are not in ${agent}'s graph: ` +
        `${foreign.join("; ")}. Nothing was retracted. To dispute a fact, write a contradicting one.`,
    );
  }
  return { retracted, notFound };
}

/** The memory model as seen by one authenticated agent. */
interface AgentMemory {
  readGraph(): Promise<KnowledgeGraph>;
  searchMemories(query: string): Promise<KnowledgeGraph>;
  findMemoriesByName(names: readonly string[]): Promise<KnowledgeGraph>;
  createEntities(
    entities: readonly EntityInput[],
  ): Promise<(EntityInput & { writer: string })[]>;
  createRelations(relations: readonly RelationInput[]): Promise<Relation[]>;
  addObservations(
    additions: readonly ObservationsInput[],
  ): Promise<
    { entityName: string; addedObservations: string[]; writer: string }[]
  >;
  deleteEntities(
    names: readonly string[],
  ): Promise<
    Retraction<string> & { stillHeldBy: { name: string; writers: string[] }[] }
  >;
  deleteObservations(
    deletions: readonly ObservationsInput[],
  ): Promise<Retraction<{ entityName: string; observation: string }>>;
  deleteRelations(
    relations: readonly RelationInput[],
  ): Promise<Retraction<RelationInput>>;
}

export class MemoryStore {
  private readonly sparql: Sparql;

  constructor(endpoints: Endpoints) {
    this.sparql = new Sparql(endpoints);
  }

  /** The memory as `agent` reads and writes it: writes land in its graph only. */
  forAgent(agent: AgentId): AgentMemory {
    const store = this.sparql;
    const own = graphOf(agent);
    const insert = async (ts: readonly Triple[]) => {
      if (ts.length > 0)
        await store.update(
          sparql`INSERT DATA { GRAPH ${own} { ${triples(ts)} } }`,
        );
    };
    const remove = async (ts: readonly Triple[]) => {
      if (ts.length > 0)
        await store.update(
          sparql`DELETE DATA { GRAPH ${own} { ${triples(ts)} } }`,
        );
    };
    const requireKnown = async (names: readonly string[]) => {
      const unknown = await unknownEntities(store, names);
      if (unknown.length > 0) {
        throw new MemoryError(
          `no such entities: ${unknown.map((n) => JSON.stringify(n)).join(", ")}; create them first`,
        );
      }
    };
    const named = (name: string): Triple => [entity(name), NAME, lit(name)];
    const relationTriple = (r: RelationInput): Triple => [
      entity(r.source),
      relation(r.relationType),
      entity(r.target),
    ];

    return {
      readGraph: () => readFacts(store),

      async searchMemories(query) {
        const needles = words(query);
        if (needles.length === 0) return { entities: [], relations: [] };
        const rows = await store.select(sparql`SELECT DISTINCT ?s WHERE {
          VALUES ?needle { ${needles.map(lit)} }
          GRAPH ?g { ?s ?p ?v } ${IN_AGENT_GRAPH}
          FILTER(?p IN (${NAME}, ${TYPE}, ${OBSERVATION}))
          FILTER(CONTAINS(LCASE(STR(?v)), LCASE(?needle)))
        }`);
        const hits = rows.map((r) => value(r, "s"));
        const g = await readFacts(
          store,
          hits.map((iri) => rdf.namedNode(iri)),
        );
        return onlyEntities(
          g,
          new Set(hits.map((iri) => entityName(iri) ?? "")),
        );
      },

      async findMemoriesByName(names) {
        const g = await readFacts(store, [...new Set(names)].map(entity));
        return onlyEntities(g, new Set(names));
      },

      async createEntities(entities) {
        await insert(
          entities.flatMap((e): Triple[] => [
            named(e.name),
            [entity(e.name), TYPE, lit(e.type)],
            ...e.observations.map(
              (o): Triple => [entity(e.name), OBSERVATION, lit(o)],
            ),
          ]),
        );
        return entities.map((e) => ({ ...e, writer: agent }));
      },

      async createRelations(relations) {
        await requireKnown(relations.flatMap((r) => [r.source, r.target]));
        await insert(
          relations.flatMap((r): Triple[] => [
            named(r.source),
            named(r.target),
            relationTriple(r),
          ]),
        );
        return relations.map((r) => ({ ...r, writer: agent }));
      },

      async addObservations(additions) {
        await requireKnown(additions.map((a) => a.entityName));
        await insert(
          additions.flatMap((a): Triple[] => [
            named(a.entityName),
            ...a.observations.map(
              (o): Triple => [entity(a.entityName), OBSERVATION, lit(o)],
            ),
          ]),
        );
        return additions.map((a) => ({
          entityName: a.entityName,
          addedObservations: a.observations,
          writer: agent,
        }));
      },

      async deleteObservations(deletions) {
        const items = deletions.flatMap((d) =>
          d.observations.map((observation) => ({
            entityName: d.entityName,
            observation,
          })),
        );
        const triple = (i: (typeof items)[number]): Triple => [
          entity(i.entityName),
          OBSERVATION,
          lit(i.observation),
        ];
        const held = await holders(store, items.map(triple));
        const result = partition(
          agent,
          items,
          (i) => held.get(key(triple(i))) ?? new Set(),
          (i) =>
            `observation ${JSON.stringify(i.observation)} on ${JSON.stringify(i.entityName)}`,
        );
        await remove(result.retracted.map(triple));
        return result;
      },

      async deleteRelations(relations) {
        const held = await holders(store, relations.map(relationTriple));
        const result = partition(
          agent,
          relations,
          (r) => held.get(key(relationTriple(r))) ?? new Set(),
          (r) =>
            `relation ${JSON.stringify(r.source)} ${r.relationType} ${JSON.stringify(r.target)}`,
        );
        await remove(result.retracted.map(relationTriple));
        return result;
      },

      async deleteEntities(names) {
        const wanted = [...new Set(names)];
        const writers = new Map<string, Set<string>>(
          wanted.map((n) => [n, new Set()]),
        );
        if (wanted.length > 0) {
          const rows = await store.select(sparql`SELECT DISTINCT ?g ?e WHERE {
            VALUES ?e { ${wanted.map(entity)} }
            { GRAPH ?g { ?e ?p ?o } } UNION { GRAPH ?g { ?s ?p ?e } }
            ${IN_AGENT_GRAPH}
          }`);
          for (const row of rows) {
            const name = entityName(value(row, "e"));
            const writer = suffix(value(row, "g"), GRAPH_PREFIX);
            if (name !== undefined && writer !== undefined)
              writers.get(name)?.add(writer);
          }
        }
        const result = partition(
          agent,
          wanted,
          (n) => writers.get(n) ?? new Set(),
          (n) => `entity ${JSON.stringify(n)}`,
        );
        if (result.retracted.length > 0) {
          const es: Term[] = result.retracted.map(entity);
          await store.update(sparql`
            DELETE { GRAPH ${own} { ?e ?p ?o } } WHERE { VALUES ?e { ${es} } GRAPH ${own} { ?e ?p ?o } } ;
            DELETE { GRAPH ${own} { ?s ?p ?e } } WHERE { VALUES ?e { ${es} } GRAPH ${own} { ?s ?p ?e } }
          `);
        }
        const stillHeldBy = result.retracted
          .map((name) => ({
            name,
            writers: [...(writers.get(name) ?? [])]
              .filter((w) => w !== agent)
              .sort(),
          }))
          .filter((h) => h.writers.length > 0);
        return { ...result, stillHeldBy };
      },
    };
  }
}

/** `query`'s words: runs of characters between any Unicode whitespace. */
function words(query: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const c of query) {
    // `trim` strips exactly ECMAScript's WhiteSpace and LineTerminator set.
    if (c.trim() === "") {
      if (word !== "") out.push(word);
      word = "";
    } else word += c;
  }
  if (word !== "") out.push(word);
  return out;
}

/** Keeps the entities named in `names` and the relations touching them. */
function onlyEntities(g: KnowledgeGraph, names: Set<string>): KnowledgeGraph {
  return {
    entities: g.entities.filter((e) => names.has(e.name)),
    relations: g.relations.filter(
      (r) => names.has(r.source) || names.has(r.target),
    ),
  };
}
