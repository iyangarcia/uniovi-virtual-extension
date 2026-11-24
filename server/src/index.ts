import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttp } from "./http.ts";
import { createMcpServer } from "./mcp.ts";

// Development companion for Claude Code / Claude Desktop (students don't need it: the extension
// itself answers web AIs through the relay). Two modes, one process:
//   default      MCP over stdio + the HTTP ingest bridge if the port is free
//   --http-only  just the HTTP ingest bridge, for syncing while Claude is not running
// stdout is the MCP channel in the default mode: log to stderr only.

const httpOnly = process.argv.includes("--http-only");

const http = await startHttp();
if (httpOnly) {
  if (!http) {
    console.error("Bridge already running in another process.");
    process.exit(1);
  }
} else {
  await createMcpServer().connect(new StdioServerTransport());
  console.error("[mcp] uniovi-virtual ready on stdio");
  // The HTTP listener would keep us alive after Claude closes the pipe; exit with the client.
  process.stdin.on("close", () => process.exit(0));
}
