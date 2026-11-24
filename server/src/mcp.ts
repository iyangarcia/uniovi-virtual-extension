import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as core from "../../shared/mcp/server.ts";
import { nodeStore } from "./store.ts";
import { VERSION } from "./version.ts";

// The Node server's MCP (Claude Code / Desktop over stdio): the shared core (shared/mcp/) over the
// files on disk. Local only, so tool output includes local paths.

export function createMcpServer(): McpServer {
  return core.createMcpServer(nodeStore, { version: VERSION });
}
