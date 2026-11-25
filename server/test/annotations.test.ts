import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../shared/mcp/server.ts";
import type { DataStore } from "../../shared/mcp/store.ts";

// Gemini asks the student before every call of a tool that isn't marked read-only.
test("every tool is annotated read-only and non-destructive", async () => {
  const store: DataStore = { snapshot: async () => null, index: async () => ({}), bytes: async () => new Uint8Array(), readText: async () => null, writeText: async () => {} };
  const server = createMcpServer(store, { remote: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 11);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.equal(t.annotations?.destructiveHint, false, t.name);
  }
  // AI sites show the server's title and icon next to the connector.
  const info = client.getServerVersion();
  assert.equal(info?.title, "Uniovi Virtual");
  assert.equal(info?.icons?.[0]?.src, "https://uniovi-relay.iyangarcias.workers.dev/icon.png");
  await client.close();
});
