# Goal 05: just the extension — no installer, no Node, no red warning

A non-technical student (think: a law student who doesn't know what Node is) loads the extension, signs in to
the campus, and connects claude.ai / ChatGPT / Gemini with one permanent link. The extension itself answers the
AI through a free Cloudflare Worker relay owned by the maintainer; files stay on her PC (extension storage), and
she browses/opens them in a "Mis apuntes" page. Simplicity first. Plan: goals/05-plan.md. The goal-04 installer is kept as tag `v0.1.0-instalador`.

Tick an item only when implemented AND verified; log evidence (command + result) under "Log". Steps only the
user can do (Cloudflare account + `wrangler deploy`, pushing, campus Wi-Fi, logging into the AIs, watching a
non-technical person install it) go in docs/PRUEBAS-MANUALES.md or relay/DESPLIEGUE.md, not here.

## 0. Groundwork
- [x] Flaky "every provider fails" tunnel test fixed (wider timings) and the gate is green
- [x] Spike: unpdf + fflate + MCP SDK web-standard transport run inside an MV3 module service worker (Chrome for Testing via puppeteer)
- [x] Spike: what each AI accepts today (claude.ai / ChatGPT / Gemini custom connectors, plans, menu paths) — recorded in Log
- [x] Contracts committed: shared/relay.ts (protocol, limits, URL shape) and shared/mcp/store.ts (DataStore)
- [x] Backup: local tag `v0.1.0-instalador` on the last goal-04 commit (pushing it + the .exe release is a user step)

## 1. Relay (relay/)
- [ ] Worker + Durable Object per student id implementing shared/relay.ts: hello/secret-hash binding, WebSocket hibernation + ping auto-response, request forwarding with rid, header allow-lists, limits (413/503/504), 404 elsewhere, nothing stored but the secret hash, no body logging
- [ ] Unit tests for the pure parts (routing, validation, header filtering, limits)
- [ ] Local end-to-end with `wrangler dev` (no account): a Node agent + MCP SDK client get 10/10 calls through `http://localhost:8787/mcp/<id>/<token>`; wrong secret rejected; no agent → 503 with the Spanish message; wrong path → 404
- [ ] relay/DESPLIEGUE.md: account, `npx wrangler login`, `npx wrangler deploy`, put the URL in shared/relay.ts, free-plan limits

## 2. Shared MCP core
- [x] Tools, prompts, instructions and text extraction moved to shared/mcp/ over DataStore; no node: imports there
- [x] Node server uses it (server/src/store.ts implements DataStore); all existing MCP/search tests pass unchanged in behaviour; new tests run the core against an in-memory DataStore

## 3. Extension serves MCP
- [ ] IndexedDB DataStore in the extension; ingest stores snapshot + files there (bridge POST kept as optional extra when a local server answers); knownFiles from IndexedDB; only readable types are downloaded (pdf, office, text/code, images); archives/exe skipped and listed as campus links
- [ ] Agent: id/secret/token generated once, WebSocket to the relay with hello, ping, reconnect with backoff (+ alarm fallback), token check (404), in-flight cap, stateless MCP per request via WebStandardStreamableHTTPServerTransport (JSON responses), remote mode (no local paths)
- [ ] Verified in Chrome for Testing (puppeteer, fixture data, local wrangler relay): MCP client 10/10 through the relay to the loaded extension; service worker stays connected ≥ 30 min (or reconnects within 60 s)

## 4. UX for non-technical students
- [ ] Welcome page opens on install: extension ✓, "Entra en el Campus Virtual" ✓ after first sync, "Conecta tu IA" cards (Claude / ChatGPT / Gemini) with Conectar automáticamente + Copiar + steps, honest plan notes
- [ ] Auto-fill: optional host permission requested per AI on click; opens its connector page and fills name + URL; leaves the AI's own confirm to her; falls back to Copiar with a note; selectors isolated per AI
- [ ] Popup: one plain sentence, switch "Conectar con mi IA", Copiar enlace, Mis apuntes, Cómo conectarla; advanced: Cambiar enlace; no "servidor/túnel/relay/Node" words outside advanced
- [ ] "Mis apuntes" page: course → section → files, sort (name/date/course), filter, text search, "Nuevo" marks, open in new tab via blob URL (PDF/images/text), "Abrir en ventana nueva", Descargar for Office files; textContent only; tests for sort/filter/blob type
- [ ] Update notice: daily check of the latest GitHub release; "Hay una versión nueva" with the 2 steps; manifest `key` kept so the ID (and data) survive extracting over the same folder — verified v1 → v2 keeps data and link

## 5. Distribution + docs
- [ ] `npm run package` → release/uniovi-virtual-<version>.zip (extension only)
- [ ] docs/index.html (GitHub Pages): Descargar button, 3 steps with pictures (developer mode → Cargar descomprimida → folder), "¿Qué IA puedo usar?"
- [ ] docs/USO-CON-IA-WEB.md and docs/PRUEBAS-MANUALES.md rewritten for the new flow (fresh student, each AI, auto-fill, Chrome closed message, update flow, deploy relay)

## 6. Retire the installer path
- [ ] Removed: installer/, nativehost, service, tunnel*, remote, config, log, shared/helper.ts, native.ts, helperState.ts, package/build-host scripts and their tests, nativeMessaging permission (key kept); stdio `npm run mcp` + bridge still work for Claude Code
- [ ] CLAUDE.md and README describe the new architecture

## 7. Review + gate
- [ ] One review agent over the whole goal diff (bugs, fixes, simplifications); what holds up is fixed with tests
- [ ] typecheck, test, build, package and relay tests pass; every process started (wrangler, Chrome for Testing) is stopped

## Log

### 2026-11-24 groundwork (coordinator)
- Flaky test: `server/test/tunnel.test.ts` "every provider fails" checked the error state 15 ms after the provider timeout; on a busy full run it still read `connecting`. Now retryDelayMs 250, checks at 100 ms and +300 ms. `npm test`: 105 pass, 0 fail; `npm run typecheck` clean.
- Spike, service worker: a throwaway MV3 extension whose module service worker bundles unpdf + fflate + McpServer + WebStandardStreamableHTTPServerTransport (esbuild esm, platform browser, no splitting: 3.9 MB, no real dynamic `import()` left) was loaded in Chrome for Testing 148 through puppeteer 24 (`enableExtensions`). In the worker: a generated one-page PDF → `["Hola examen spike"]`; fflate zip round trip OK; MCP initialize → 200; stateless tools/call with `enableJsonResponse` → 200 `{"result":{"content":[{"type":"text","text":"echo:hey"}]}…}`. Total 97 ms. Harness: `%CLAUDE_JOB_DIR%/tmp/pptr` (puppeteer + Chrome for Testing in ~/.cache/puppeteer).
- Spike, AI clients (web sources, 2026):
  - claude.ai: Customize → Connectors → Add → Add custom connector (name + URL). **Free plan: 1 custom connector**; changing it = remove + re-add; URL must be https on 443. Best path for most students.
  - ChatGPT: free plan has **no** custom MCP. Plus/Pro: chatgpt.com/plugins → "+" → Add custom MCP server (was Settings → Connectors → Advanced → Developer mode until July 2026); personal plans likely read/fetch-only (fine: our tools are read-only).
  - Gemini app: "Add a custom app" by MCP URL (Settings → Connected Apps / gemini.google.com/customize/connectors), Streamable HTTP only, reportedly limited to US adults with personal accounts and English — likely unavailable to Spanish students for now. The welcome card must say so.
- Contracts: `shared/relay.ts` (protocol v1, URL shape `/mcp/<id>/<token>`, hello+secret hash, ping/pong auto-response, limits 8 MB / 16 in flight / 60 s, header allow-lists, Spanish 503 body) and `shared/mcp/store.ts` (DataStore + StoredFile).
- Backup: `git tag v0.1.0-instalador ab0dbc6` (local). Pushing the tag and attaching `UnioviVirtual-Setup-0.1.0.exe` to a release is a user step (PRUEBAS-MANUALES).

### Section 2, shared MCP core (agent B, re-checked by coordinator)
- `shared/mcp/{common,extract,search,server}.ts` hold the tools, prompts, instructions, extraction and the structured `searchMaterials`, behind `DataStore`. There are no `node:` imports (`grep -n "node:" shared/mcp` is empty), and the per-store state lives in WeakMaps. `server/src/store.ts` exports `nodeStore`; `server/src/{mcp,extract}.ts` are thin wrappers that keep their old signatures.
- Re-run in the worktree, then after merging into master: `npm run typecheck` is clean (extension DOM libs + server Node libs both compile shared/mcp); `npm test` 110 pass, 0 fail (105 old tests unchanged, plus 5 in `mcp-core.test.ts` against an in-memory store: kindOf, textOf caching, structured search, cold-budget search, and an InMemoryTransport round trip that lists 11 tools and 3 prompts, with remote mode hiding localPath/dataDir); `npm run build` OK.
- Agent smoke check: the built stdio server (temp data/app dir, bridge 48911) lists the same 11 tools in the same order, then exits when stdin closes.
