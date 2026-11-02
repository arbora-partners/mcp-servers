/**
 * The memory server's entry point: the one place `process.env` is read.
 * Everything below takes what it needs as arguments (README, "Environment").
 */
import pkg from "../package.json" with { type: "json" };
import { memoryHttpServerFromEnv } from "./http.ts";

const { server, port } = memoryHttpServerFromEnv(process.env, pkg.version);

server.listen(port, () => {
  console.log(`memory MCP server ${pkg.version} listening on :${port}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
