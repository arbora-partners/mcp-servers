/**
 * The fetch server's entry point: the one place `process.env` is read.
 * Everything below takes what it needs as arguments (README, "The fetch server").
 */
import pkg from "../package.json" with { type: "json" };
import { fetchHttpServerFromEnv } from "./http.ts";

const { server, port } = fetchHttpServerFromEnv(process.env, pkg.version);

server.listen(port, () => {
  console.log(`fetch MCP server ${pkg.version} listening on :${port}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
