// Cheaper answers (goals/06-ideas.md §4): short instructions that steer the AI to few calls, and short search snippets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { searchCachedMaterials, SNIPPET_CHARS } from "../../shared/mcp/scan.ts";
import { createMcpServer } from "../../shared/mcp/server.ts";
import type { DataStore, StoredFile } from "../../shared/mcp/store.ts";
import type { Snapshot } from "../../shared/types.ts";

const snap = { courses: [{ id: 1, shortname: "FIS", fullname: "Física", url: "" }] } as unknown as Snapshot;
const pdf: StoredFile = {
  key: "1:/tema1.pdf",
  path: "files/FIS/Tema 1/tema1.pdf",
  size: 10,
  contentType: "application/pdf",
  timemodified: 100,
  storedAt: 100,
  resource: { key: "1:/tema1.pdf", cmid: 1, courseId: 1, section: "Tema 1", name: "Tema 1", modname: "resource", url: "u", filename: "tema1.pdf" },
};
const storeWith = (text: string): DataStore => ({
  snapshot: async () => snap,
  index: async () => ({ [pdf.key]: pdf }),
  bytes: async () => assert.fail("cached text only"),
  readText: async () => text,
  writeText: async () => {},
});

test("instructions: economical, citation rule, nextOffset, only real tool names", async () => {
  const server = createMcpServer(storeWith(""), { remote: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  try {
    const text = client.getInstructions() ?? "";
    assert.match(text, /\(file name, page\/slide\/sheet\)/);
    assert.match(text, /--- page N ---/);
    assert.match(text, /nextOffset/);
    assert.match(text, /15,000 characters/);
    assert.match(text, /fewest calls/);
    assert.match(text, /never invent exam dates/);
    assert.match(text, /read-only/i);
    // Economy must not turn study tasks into answers built from 240-char snippets.
    assert.match(text, /Summaries, notes, flashcards or quizzes on a topic: snippets are not enough/);
    assert.ok(text.length < 2500, `instructions are ${text.length} chars`);
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    const named = new Set(text.match(/\b[a-z]+_[a-z_]+\b/g));
    for (const n of named) assert.ok(tools.has(n), `instructions name ${n}, which is not a tool`);
  } finally {
    await client.close();
  }
});

test("snippets: at most SNIPPET_CHARS, keep the hit even deep in a long line, page kept", async () => {
  const filler = "palabra ".repeat(60);
  const text = [
    "--- page 1 ---",
    "Intro",
    "--- page 4 ---",
    filler,
    `${filler} la entropía siempre crece en un sistema aislado ${filler}`,
    filler,
    filler,
    "La ENTROPÍA al principio de la línea",
  ].join("\n");
  const r = await searchCachedMaterials(storeWith(text), { query: "entropia", snapshot: snap });
  assert.equal(r.results.length, 2);
  for (const h of r.results) {
    assert.ok(h.snippet.length <= SNIPPET_CHARS, `snippet is ${h.snippet.length} chars`);
    assert.match(h.snippet, /entropía/i);
    assert.equal(h.location, "page 4");
  }
  assert.ok(SNIPPET_CHARS <= 240);
});

test("snippets: short context is kept whole", async () => {
  const text = "--- page 1 ---\nLa entropía crece\nen sistemas aislados\n--- page 2 ---\nOtra cosa";
  const r = await searchCachedMaterials(storeWith(text), { query: "entropia", snapshot: snap });
  assert.deepEqual(
    r.results.map((h) => [h.location, h.snippet]),
    [["page 1", "--- page 1 --- La entropía crece en sistemas aislados --- page 2 ---"]],
  );
});
