import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as search from "../../shared/mcp/search.ts";
import * as core from "../../shared/mcp/server.ts";
import type { Snapshot } from "../../shared/types.ts";
import { nodeStore } from "./store.ts";
import { VERSION } from "./version.ts";

// The Node server's MCP: the shared core (shared/mcp/) over the files on disk.

export interface McpOptions {
  /** Served to a web client (ChatGPT, Gemini, claude.ai) over a tunnel: hide local paths, which are useless there and reveal the user's folders. */
  remote?: boolean;
}

export function createMcpServer({ remote = false }: McpOptions = {}): McpServer {
  return core.createMcpServer(nodeStore, { remote, version: VERSION });
}

export { searchBudget, type MaterialHit, type SearchResult } from "../../shared/mcp/search.ts";

export const searchMaterials = (s: Snapshot, query: string, course: string | undefined, limit: number) =>
  search.searchMaterials(nodeStore, { snapshot: s, query, course, limit });
export const searchAll = (s: Snapshot, query: string, limit?: number) => search.searchAll(nodeStore, s, query, limit);
export const fetchById = (s: Snapshot, id: string) => core.fetchById(nodeStore, s, id);
