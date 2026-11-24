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
- [x] Worker + Durable Object per student id implementing shared/relay.ts: hello/secret-hash binding, WebSocket hibernation + ping auto-response, request forwarding with rid, header allow-lists, limits (413/503/504), 404 elsewhere, nothing stored but the secret hash, no body logging
- [x] Unit tests for the pure parts (routing, validation, header filtering, limits)
- [x] Local end-to-end with `wrangler dev` (no account): a Node agent + MCP SDK client get 10/10 calls through `http://localhost:8787/mcp/<id>/<token>`; wrong secret rejected; no agent → 503 with the Spanish message; wrong path → 404
- [x] relay/DESPLIEGUE.md: account, `npx wrangler login`, `npx wrangler deploy`, put the URL in shared/relay.ts, free-plan limits

## 2. Shared MCP core
- [x] Tools, prompts, instructions and text extraction moved to shared/mcp/ over DataStore; no node: imports there
- [x] Node server uses it (server/src/store.ts implements DataStore); all existing MCP/search tests pass unchanged in behaviour; new tests run the core against an in-memory DataStore

## 3. Extension serves MCP
- [x] IndexedDB DataStore in the extension; ingest stores snapshot + files there (bridge POST kept as optional extra when a local server answers); knownFiles from IndexedDB; only readable types are downloaded (pdf, office, text/code, images); archives/exe skipped and listed as campus links
- [x] Agent: id/secret/token generated once, WebSocket to the relay with hello, ping, reconnect with backoff (+ alarm fallback), token check (404), in-flight cap, stateless MCP per request via WebStandardStreamableHTTPServerTransport (JSON responses), remote mode (no local paths)
- [x] Verified in Chrome for Testing (puppeteer, fixture data, local wrangler relay): MCP client 10/10 through the relay to the loaded extension; service worker stays connected ≥ 30 min (or reconnects within 60 s)

## 4. UX for non-technical students
- [x] Welcome page opens on install: extension ✓, "Entra en el Campus Virtual" ✓ after first sync, "Conecta tu IA" cards (Claude / ChatGPT / Gemini) with Conectar automáticamente + Copiar + steps, honest plan notes
- [x] Auto-fill: optional host permission requested per AI on click; opens its connector page and fills name + URL; leaves the AI's own confirm to her; falls back to Copiar with a note; selectors isolated per AI
- [x] Popup: one plain sentence, switch "Conectar con mi IA", Copiar enlace, Mis apuntes, Cómo conectarla; advanced: Cambiar enlace; no "servidor/túnel/relay/Node" words outside advanced
- [x] "Mis apuntes" page: course → section → files, sort (name/date/course), filter, text search, "Nuevo" marks, open in new tab via blob URL (PDF/images/text), "Abrir en ventana nueva", Descargar for Office files; textContent only; tests for sort/filter/blob type
- [x] Update notice: daily check of the latest GitHub release; "Hay una versión nueva" with the 2 steps; manifest `key` kept so the ID (and data) survive extracting over the same folder — verified v1 → v2 keeps data and link

## 5. Distribution + docs
- [x] `npm run package` → release/uniovi-virtual-<version>.zip (extension only)
- [x] docs/index.html (GitHub Pages): Descargar button, 3 steps with pictures (developer mode → Cargar descomprimida → folder), "¿Qué IA puedo usar?"
- [x] docs/USO-CON-IA-WEB.md and docs/PRUEBAS-MANUALES.md rewritten for the new flow (fresh student, each AI, auto-fill, Chrome closed message, update flow, deploy relay)

## 6. Retire the installer path
- [x] Removed: installer/, nativehost, service, tunnel*, remote, config, log, shared/helper.ts, native.ts, helperState.ts, package/build-host scripts and their tests, nativeMessaging permission (key kept); stdio `npm run mcp` + bridge still work for Claude Code
- [x] CLAUDE.md and README describe the new architecture

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
- `shared/mcp/{common,extract,search,server}.ts` hold the tools, prompts, instructions, extraction and the structured `searchMaterials`, behind `DataStore`. There are no `node:` imports (`grep "node:" shared/mcp` matches only two comments), and the per-store state lives in WeakMaps. `server/src/store.ts` exports `nodeStore`; `server/src/{mcp,extract}.ts` are thin wrappers that keep their old signatures.
- Re-run in the worktree, then after merging into master: `npm run typecheck` is clean (extension DOM libs + server Node libs both compile shared/mcp); `npm test` 110 pass, 0 fail (105 old tests unchanged, plus 5 in `mcp-core.test.ts` against an in-memory store: kindOf, textOf caching, structured search, cold-budget search, and an InMemoryTransport round trip that lists 11 tools and 3 prompts, with remote mode hiding localPath/dataDir); `npm run build` OK.
- Agent smoke check: the built stdio server (temp data/app dir, bridge 48911) lists the same 11 tools in the same order, then exits when stdin closes.

### Section 1, relay (agent A, re-checked by coordinator)
- `relay/`: wrangler 4.159.0, workers-types 5.20261109.1. The Worker plus `AgentRoom` Durable Object (SQLite migration, so it runs on the free plan) uses hibernation with ping/pong auto-response, stores only sha256(secret) under `secretHash`, and compares in constant time. A newer socket replaces an older one (close 1000 "replaced"). Request and response headers go through allow-lists. Limits: 413 / 429 (120 per minute per student) / 503 / 504 / 502. Observability is off and nothing is logged. Pure logic is in `relay/src/logic.ts`.
- Unit tests: `relay/test/logic.test.ts`, 12 pass. The root `npm test` now includes them, and `typecheck` adds `tsc -p relay`.
- Coordinator re-run of the end-to-end against local `wrangler dev --port 8787 --var TEST_REQUEST_TIMEOUT_MS:3000`, using `node relay/test/e2e.mjs` (a Node agent running a stateless MCP server, and an MCP SDK client): **26 PASS, "All checks passed"**. The checks included: MCP SDK client tool calls 10/10, a 4 MiB response, wrong token → 404, wrong secret → rejected (close 1008), no agent → 503 with the Spanish JSON-RPC body, agent closing mid-request → immediate 503, a never-answering agent → 504, a 9 MB body → 413 (with and without content-length), the 121st request in a minute → 429, /foo and a bad id → 404. wrangler/workerd were stopped afterwards.
- After the merge into master (with `npm ci` inside relay/): typecheck clean, `npm test` 122 pass / 0 fail, build OK.
- `relay/DESPLIEGUE.md` (Spanish) covers: the account, `wrangler login`/`deploy`, setting `RELAY_URL`, a curl check, free-plan limits (100k/day, error 1027, no charges) and rollback.
- Not verifiable without an account: a real deploy, and production limits on WebSocket message size. A near-8 MB response is about 10.7 MB once base64-encoded, which is untested.

### Section 3, extension serves MCP (agent C, re-checked by coordinator)
- `extension/src/store/idb.ts`: `IdbStore implements DataStore` (DB `uniovi`: meta/files/blobs/texts), with UI helpers `putFile`, `fileBlob`, `knownFiles`, `skippedFiles`, `usage`, `clear`. `extension/src/readable.ts` decides by extension, then by mimetype; when both are unknown the content script decides after the redirect. Archives and binaries are not downloaded and are recorded as `skipped`. The background stores the snapshot and files in IndexedDB, warms the text cache, and still tries the bridge silently. `knownFiles` comes from IndexedDB.
- `extension/src/agent/`:
  - Identity: `agent {id, secret, token}`, plus `aiConnection`, `agentState`, `agentStats`, and a `devRelayUrl` used only in tests.
  - Connection: hello, ping every 20 s, the socket is dropped after 3 missed pongs, reconnect with backoff from 1 s to 60 s with jitter, stops on `rejected`, keepalive alarm every minute.
  - Requests: constant-time token check (404), non-POST → 405, at most 16 in flight. Each request gets a fresh stateless `createMcpServer(idbStore, {remote: true})` with JSON responses.
- Agent's evidence:
  - 11 + 7 unit tests, with a hand-written fake relay in `server/test/helpers/fake-relay.ts`.
  - Chrome for Testing, fixture data and the fake relay: 13/13 PASS.
  - Lifetime with nothing attached: **one socket for 32.0 min (96 pings, never more than 20 s apart, no close)**. After `ServiceWorker.stopAllWorkers` it was back in 0.48 s and 1.38 s.
- **Coordinator integrated run, real relay**: master build, `npx wrangler dev --port 8787` from `relay/`, Chrome for Testing 148 with a fresh profile and fixture data (`tmp/pptr/verify-integrated.mjs`). Result: **RESULT pass=13 fail=0**:
  - IndexedDB held 3 blobs, and the zip was skipped.
  - `agentState connected`.
  - **MCP SDK client through the Cloudflare relay to the extension: 10/10 tool calls**: sync_status, list_courses, get_deadlines, get_exam_dates, list_materials, read_material on the PDF (`--- page 2 ---`) and the docx, search_materials, search_forums, get_forum_post. No local paths appeared.
  - Wrong token → 404. `aiConnection=false` → relay 503, then back on → connected. Token rotation → the old URL gives 404 and the new one works.
- After merging into master: typecheck clean, `npm test` 140 pass / 0 fail, build OK. wrangler/workerd and every Chrome for Testing were stopped. The worktrees were removed after unlinking their node_modules junctions, and the main node_modules is intact.
- Not verified: the real campus download path after a redirect, and Edge.

### Section 4, "Mis apuntes" (agent E, re-checked by coordinator)
- What it does: `extension/src/files.{html,ts}` plus the pure `extension/src/files/model.ts`:
  - courses → sections → files, sorted by campus order, name or date; an accent-insensitive filter; "Buscar dentro de los apuntes" (`searchMaterials` over IndexedDB, with page/slide hits);
  - "Nuevo" badges since `filesLastVisit` (nothing is marked on the first visit);
  - skipped archives greyed out with "Abrir en el campus"; Office files get "Descargar";
  - deep links `?course=` and `?q=`; built with textContent only; light and dark themes.
- Opening files: a blob URL dies with the page that created it, so files open in a viewer tab, `files.html?open=<key>&page=N`, which builds its own blob and shows Chrome's PDF viewer in an iframe.
  - That tab survives closing the list and can be reloaded.
  - "Ventana nueva" opens the same viewer as `chrome.windows.create({type:"normal"})`, for side-by-side study.
  - HTML/SVG/code open as plain text, so campus HTML never runs in the extension origin.
- Evidence:
  - `server/test/files-page.test.ts`: 11 tests.
  - Coordinator re-run of `tmp/pptr/verify-files.mjs` against **master's build** after the merge, in Chrome for Testing with fixture data: **RESULT pass=45 fail=0**. The run covered grouping, the sort orders, the filter, search ("trapecio" → página 2, opened at `#page=2`), a PDF/txt/png opening in a new tab, a new window, the docx downloaded, the zip linking to the campus, "Nuevo" over 3 visits, and no horizontal scroll at 900 px.
  - Master gate: 151 pass / 0 fail, typecheck clean, build OK.
  - Screenshots: `docs/img/mis-apuntes.png`, `docs/img/mis-apuntes-busqueda.png`.
- Not verified: whether Chrome's viewer actually scrolls to page N (the URL carries `#page=N`), and performance on a large real store (about 340 files).

### Sections 4–6, UX + distribution + retirement (agents D and F, re-checked by coordinator)
- **Incident (coordinator), now fixed:** the user's own `npm run mcp` was listening on 127.0.0.1:47823. The extension forwards each sync to that optional dev bridge, so the fixture data from the section-3 integrated runs reached the real `~/uniovi-data`. It added 10 fake files under `files/{DCIV,CAL1,FIS}` and **overwrote `snapshot.json`** with a fixture snapshot. Agent D spotted it.
  - Cleanup: backed up to `$CLAUDE_JOB_DIR/tmp/uniovi-data-backup/`, removed the 10 index entries and the 3 folders (index back to the 343 real files), and moved the fake snapshot aside.
  - The real snapshot comes back with the next campus sync (manual step).
  - All later browser tests fail `http://127.0.0.1:47823/*` through CDP Fetch; the folder still has 343 files afterwards. CLAUDE.md gotcha added.
- **Merges:** `goal05/ux` and `goal05/retire` merged. The conflict (`nativehost.test.ts`, edited by one side and deleted by the other) was resolved by deleting it, and `shared/helper.ts` was removed (nothing imports it).
  - Master gate: typecheck clean (extension, server, relay), `npm test` **96 pass / 0 fail** (the helper/tunnel/native-host tests went away with that code; ux 7, files 11, agent 11, relay 12, mcp-core 5 …), build OK.
  - `npm run package` → `release/uniovi-virtual-0.2.0.zip` (12 files, 1.86 MB) plus `release/uniovi-virtual.zip` (same bytes).
- **Welcome, auto-fill, popup, update notice (D):**
  - Coordinator re-run of `tmp/pptr/verify-ux-master.mjs` on **master's build**, with every hostname unresolvable and the bridge blocked: **RESULT pass=31 fail=0 (bridge requests blocked: 4)**. It covered:
    - the welcome page opening on install, its 3 live steps, and the honest per-AI plan notes;
    - auto-fill on local look-alike pages of Claude, ChatGPT and Gemini: name and URL filled through input events, the confirm button clicked 0 times;
    - the fallback on a broken page: "No pude rellenarlo solo: el enlace está copiado…", with the link on the clipboard;
    - Copiar;
    - no jargon outside "Opciones avanzadas";
    - Cambiar enlace (token rotated, the old link gets 404);
    - the switch off → relay 503 → on → connected;
    - an update stub v99.1.0 → "Hay una versión nueva" with the 2 steps (an offline check stays silent).
  - Screenshots: `docs/img/{welcome,welcome-empty,popup,popup-empty,popup-advanced,popup-update}.png`.
- **v1 → v2 update (coordinator, `tmp/pptr/verify-update.mjs`):** v0.2.0 was loaded from a folder with a persistent profile and fixture data (bridge blocked). The folder was then overwritten with the build with its version bumped to 0.2.1, and loaded again. Result: same ID `amagekgnbkaeigjhbenkilkhoklkdieo`, **same id/secret/token (so the AI link is unchanged)**, and the stored file still in IndexedDB: **RESULT pass=4 fail=0**.
- **Retirement and docs (F):**
  - Removed: installer/, nativehost, service, tunnel + tunnel/, remote, config, log, the old package and build-host scripts, start-remote.bat, their tests, `nativeMessaging`; `key` kept.
  - F's smoke tests: stdio `npm run mcp` (temp data, bridge 48931) lists the same 11 tools, and `--http-only` answers `/api/status`.
  - The extracted zip loads in Chrome for Testing and its worker starts with the fixed ID.
  - `docs/index.html` is the Pages download page: Descargar → `releases/latest/download/uniovi-virtual.zip`, 3 steps with real Spanish `chrome://extensions` screenshots, "¿Qué IA puedo usar?", privacy, updates and an FAQ.
  - `docs/USO-CON-IA-WEB.md`, `docs/PRUEBAS-MANUALES.md`, CLAUDE.md and README were rewritten. The coordinator corrected the Mis apuntes viewer note in CLAUDE.md.
- **Not verified (manual):** auto-fill on the real claude.ai/chatgpt.com/gemini (start URLs and selectors come from web notes); the real `chrome.permissions.request` prompt; the toolbar popup; GitHub Pages rendering; Edge. `paso3-extension-cargada.png` still shows the old name "Uniovi Virtual → Claude" and should be retaken (`tmp/pptr/g5f-shots.mjs`).
