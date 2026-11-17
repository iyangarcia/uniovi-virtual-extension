import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttp } from "./http.ts";
import { createMcpServer } from "./mcp.ts";

// Two modes, one process:
//   default      MCP over stdio (spawned by Claude Code / Claude Desktop) + HTTP ingest if the port is free
//   --http-only  just the HTTP ingest bridge, for syncing while Claude is not running
// stdout is the MCP channel: log to stderr only.

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
