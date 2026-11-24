import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { DataStore } from "../../../shared/mcp/store.ts";
import { createMcpServer } from "../../../shared/mcp/server.ts";
import type { RequestHandler } from "./protocol.ts";

/**
 * Stateless MCP over HTTP: a fresh server + transport per request (the tools read the store on
 * every call), JSON responses instead of SSE, remote mode (no local paths). The body is buffered
 * before the transport is closed.
 */
export function mcpHandler(store: DataStore, version: string): RequestHandler {
  return async (req) => {
    const server = createMcpServer(store, { remote: true, version });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(req);
      const body = await res.arrayBuffer();
      return new Response(body.byteLength ? body : null, { status: res.status, headers: res.headers });
    } finally {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    }
  };
}
