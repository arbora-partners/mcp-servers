/**
 * The memory tools, named and shaped after `mcp-neo4j-memory` so a change of
 * store changes no agent (ADR 0032 §2). Two deliberate differences:
 *
 * - Reads report each fact's writer: an entity carries `types` and
 *   `observations` as `{ …, writer }` lists rather than one `type` and a list
 *   of strings, and each relation carries its `writer`.
 * - Deletions retract only the caller's own facts. A request naming a fact
 *   held only by other agents is refused whole, and nothing is retracted.
 *
 * No input names a writer or a graph. The caller is the `agent` the server was
 * built for, from its bearer token; an extra argument is stripped by schema
 * validation before any handler sees it.
 */
import type { AgentId } from "@arbora/mcp-auth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MemoryError, type MemoryStore } from "./store.ts";

// mcp-neo4j-memory's identifier pattern for entity and relation types.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Every input string: well-formed Unicode (a lone surrogate is refused), then
 * normalized to NFC, so the same name always builds the same IRI and an
 * observation can be retracted however the caller's text was composed.
 */
const text = () =>
  z
    .string()
    .refine((s) => s.isWellFormed(), "must be well-formed Unicode")
    .overwrite((s) => s.normalize("NFC"));

const entityName = text().min(1).describe("Exact name of the entity");
const Entity = z.object({
  name: text().min(1).describe("Unique, descriptive name of the entity"),
  type: text()
    .regex(IDENTIFIER)
    .describe(
      "Category of the entity: 'person', 'company', 'location', 'concept', 'event'…",
    ),
  observations: z
    .array(text().min(1))
    .describe("Facts about the entity, each a complete, standalone statement"),
});
const Relation = z.object({
  source: entityName.describe("Name of the source entity (must exist)"),
  target: entityName.describe("Name of the target entity (must exist)"),
  relationType: text()
    .regex(IDENTIFIER)
    .describe(
      "Type of the relationship, uppercase with underscores: WORKS_AT, LOCATED_IN…",
    ),
});
const Observations = z.object({
  entityName,
  observations: z.array(text().min(1)).min(1),
});

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof MemoryError) {
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
    console.error(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "the memory store failed; the request may not have applied",
        },
      ],
    };
  }
}

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const RETRACT = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** An MCP server whose every tool acts as `agent`. */
export function memoryServer(
  store: MemoryStore,
  agent: AgentId,
  version: string,
): McpServer {
  const memory = store.forAgent(agent);
  const server = new McpServer({ name: "arbora-memory", version });

  server.registerTool(
    "read_graph",
    {
      title: "Read Graph",
      description:
        "Read the whole shared memory: every entity and relation, from every agent, each fact with its writer.",
      annotations: { title: "Read Graph", ...READ },
    },
    () => run(() => memory.readGraph()),
  );

  server.registerTool(
    "create_entities",
    {
      title: "Create Entities",
      description:
        "Create entities with their type and observations, written as you. An entity that already exists " +
        "(from any agent) gains your type and observations beside the others'.",
      inputSchema: { entities: z.array(Entity).describe("Entities to create") },
      annotations: { title: "Create Entities", ...WRITE },
    },
    ({ entities }) => run(() => memory.createEntities(entities)),
  );

  server.registerTool(
    "create_relations",
    {
      title: "Create Relations",
      description:
        "Create relations between existing entities, written as you.",
      inputSchema: {
        relations: z.array(Relation).describe("Relations to create"),
      },
      annotations: { title: "Create Relations", ...WRITE },
    },
    ({ relations }) => run(() => memory.createRelations(relations)),
  );

  server.registerTool(
    "add_observations",
    {
      title: "Add Observations",
      description:
        "Add observations to existing entities, written as you. To dispute another agent's fact, add a " +
        "contradicting observation of your own.",
      inputSchema: {
        observations: z
          .array(Observations)
          .describe("Observations to add, by entity"),
      },
      annotations: { title: "Add Observations", ...WRITE },
    },
    ({ observations }) => run(() => memory.addObservations(observations)),
  );

  server.registerTool(
    "delete_entities",
    {
      title: "Delete Entities",
      description:
        "Retract everything you wrote about these entities, relations included. Refused, with nothing " +
        "retracted, when an entity has facts only from other agents. Facts other agents wrote stay, and " +
        "`stillHeldBy` names them.",
      inputSchema: {
        entityNames: z
          .array(entityName)
          .describe("Exact names of the entities"),
      },
      annotations: { title: "Delete Entities", ...RETRACT },
    },
    ({ entityNames }) => run(() => memory.deleteEntities(entityNames)),
  );

  server.registerTool(
    "delete_observations",
    {
      title: "Delete Observations",
      description:
        "Retract observations you wrote. Refused, with nothing retracted, when one was written only by " +
        "other agents; dispute it with an observation of your own instead.",
      inputSchema: {
        deletions: z
          .array(Observations)
          .describe("Exact observation texts to retract, by entity"),
      },
      annotations: { title: "Delete Observations", ...RETRACT },
    },
    ({ deletions }) => run(() => memory.deleteObservations(deletions)),
  );

  server.registerTool(
    "delete_relations",
    {
      title: "Delete Relations",
      description:
        "Retract relations you wrote. Refused, with nothing retracted, when one was written only by other agents.",
      inputSchema: {
        relations: z.array(Relation).describe("Relations to retract"),
      },
      annotations: { title: "Delete Relations", ...RETRACT },
    },
    ({ relations }) => run(() => memory.deleteRelations(relations)),
  );

  server.registerTool(
    "search_memories",
    {
      title: "Search Memories",
      description:
        "Find entities whose name, type or an observation contains any of the query's words " +
        "(case-insensitive), with their relations.",
      inputSchema: { query: text().describe("Words to search for") },
      annotations: { title: "Search Memories", ...READ },
    },
    ({ query }) => run(() => memory.searchMemories(query)),
  );

  server.registerTool(
    "find_memories_by_name",
    {
      title: "Find Memories by Name",
      description: "Find entities by exact name, with their relations.",
      inputSchema: {
        names: z.array(entityName).describe("Exact entity names"),
      },
      annotations: { title: "Find Memories by Name", ...READ },
    },
    ({ names }) => run(() => memory.findMemoriesByName(names)),
  );

  return server;
}
