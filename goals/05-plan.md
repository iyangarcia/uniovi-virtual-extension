# Plan: Goal 05, "just the extension": no installer, no Node, no red warning

## Context
Goal 04 needs a Windows installer. An unsigned `.exe` always triggers the red SmartScreen screen ("Windows
protegió tu PC"), and that will put off many of the ~100 law students we're aiming for. Free signing doesn't
get around it. The user's very first goal was "installing the extension is all a student needs". This
plan gets there:
- **The extension itself serves the AI.** It keeps an outgoing WebSocket open to a **free Cloudflare Worker
  relay** that the user owns. That gives a **permanent URL**: works on 443, so on campus; no student account;
  no IP in the URL; paste once.
- **Files stay on her PC,** in the extension's local storage (IndexedDB). Text extraction runs inside the extension.
- **Connecting the AI:** "Conectar con Claude/ChatGPT/Gemini" opens the AI's connector page and **fills in the
  form**. If that fails, Copiar plus screenshots.
- **Getting it:** a GitHub Pages page with "Descargar" (a zip) and three pictures: developer mode → Cargar descomprimida → folder.

The rule for every choice is **simplicity first** for non-technical students.

Accepted trade-offs:
- The AI only reaches her files while Chrome is open.
- Questions and answers pass through the relay, as they did through the tunnels. The relay stores nothing.
- The user maintains one small Worker.
- Removing the extension deletes its data. They are copies of campus files, so the next sync downloads them again.
  Files are browsed and opened from the "Mis apuntes" page, not from an Explorer folder, so there is no second copy.

## Architecture
```
AI (claude.ai / ChatGPT / Gemini)
  └─ POST https://<relay>.workers.dev/mcp/<id>/<token>   (stable per student)
       Worker → Durable Object "agent:<id>" (one per student, WebSocket hibernation)
         └─ forwards {rid, method, headers(allow-list), body} over the WebSocket
              Extension service worker: checks token, runs MCP (WebStandardStreamableHTTPServerTransport,
              stateless) over IndexedDB data → {rid, status, headers, body}
```
- **Contract** (`shared/relay.ts`, written first): the message types; limits (8 MB body, 16 requests in flight,
  60 s timeout → 504); "agent not connected" → 503 with a JSON-RPC error that says, in Spanish, "abre Chrome
  con la extensión"; ping every 20 s with the Durable Object's `setWebSocketAutoResponse`, so idle students
  don't wake it, and Chrome 116+ keeps the service worker alive while the socket is active.
- **Identity:** the extension creates `id` (128-bit) and `secret` once (in `chrome.storage.local`). The first
  connection makes the Durable Object store sha256(secret), and later connections must match it, so nobody can
  take over an id. `token` (in the URL path) is checked by the extension; "Cambiar enlace" rotates it.
- **Shared MCP core:**
  - Move the tool, prompt and instruction definitions from `server/src/mcp.ts` (608 lines) and the
    format-independent part of `extract.ts` into `shared/mcp/`, behind a `DataStore` interface: `snapshot()`,
    `index()`, `bytes(f)`, `cachedText` / `saveText`.
  - Two implementations: Node fs (`server/`, which keeps the Claude Code stdio mode working for development) and
    IndexedDB (`extension/`).
  - Output always uses remote mode: no local paths.
- **Extension storage:** background `PUT files` writes into IndexedDB instead of (or as well as, when a local
  server is up) the bridge. `knownFiles` comes from IndexedDB. The first run re-downloads from the campus;
  there is no migration.

## Work items (GOAL.md goal 05)
**0. First, the flaky test:** `server/test/tunnel.test.ts:224` "every provider fails" checks 15 ms after the timeout,
so it fails when the full suite runs on a busy machine. It passes 5/5 on its own. Fix: widen the timings (check at
~80 ms, retry after ~120 ms).

**0. Spikes, done by me before splitting the work; findings go in the Log:**
- unpdf + fflate + MCP SDK web transport bundled into the MV3 module service worker. Dynamic `import()` is banned
  there, and esbuild without splitting inlines it. Fallback: an offscreen document for extraction.
- A WebSocket with a 20 s ping keeps the service worker alive for 30+ minutes (log timestamps).
- Gemini web: does it accept custom MCP connectors today? ChatGPT and claude.ai: on which plans? This decides what the cards say.

**1. Relay (`relay/`, its own package.json + wrangler devDependency)**
- A Worker plus a Durable Object as described above, with no storage except the secret hash and no logs of bodies.
- Header allow-list in both directions.
- Unit tests on the pure routing and limit functions.
- End-to-end locally with `wrangler dev`, no account needed: a Node agent runs the same agent code as the
  extension, and an MCP SDK client gets 10/10 over `http://localhost:8787/mcp/<id>/<token>`. A wrong
  token, a wrong secret or other paths get 404/401; when no agent is connected the answer is 503.

**2. Shared MCP core**
- Refactor into `shared/mcp/` + `DataStore`. The server's existing tests keep passing unchanged, with new
  tests against an in-memory store.

**3. Extension serves MCP**
- IndexedDB store, background file ingest into it, agent connection with reconnect and backoff, token check, and
  a cap on requests in flight.
- Test: the e2e from item 1 also runs against the built extension in Chrome, through Claude in Chrome on a
  fixture profile, with no real campus data.

**4. UX for non-technical users**
- The welcome page opens on install with three live checks:
  - extension loaded;
  - "Entra en el Campus Virtual", turning into ✓ after the first sync;
  - "Conecta tu IA": a card per AI with **Conectar automáticamente**, plus Copiar and screenshots.
- Auto-fill: request `optional_host_permissions` for that one AI only at click time, so installing shows no
  warning. Open its connector settings page, fill in name + URL, and leave the AI's own confirm button to her.
  Selectors live in one file per AI, and failure falls back to Copiar with a note.
- The popup has one plain sentence ("✓ Tu IA puede ver tus apuntes" / "Abre el Campus para sincronizar"), the
  switch "Conectar con mi IA", Copiar, "Mis apuntes" and "Cómo conectarla". Under "Opciones avanzadas": Cambiar enlace. The words server, tunnel, relay and Node don't appear.

**4b. "Mis apuntes": file browser inside the extension. No folder and no second copy.**
- An extension page (`extension/files.html`) opened from the popup ("Mis apuntes") and from the campus panel.
  It reads the same IndexedDB store the AI uses, so nothing is duplicated.
- Courses → sections → files, plus:
  - sorting by name, date or course;
  - a filter box, and a search inside the text ("buscar en mis apuntes", reusing the `search_materials` logic from `shared/mcp/`);
  - "Nuevo" marks for files since the last visit.
- Clicking a file opens it in a **new tab** from a blob URL. PDFs, images and text open in Chrome's own viewer, so two
  PDFs (e.g. an exercise sheet and its solutions) can sit side by side; "Abrir en ventana nueva" lets her snap two windows.
  Word/PowerPoint can't be previewed in Chrome, so they get "Descargar", which saves one copy, only when she asks.
- Use `textContent` only. Tested with a fake store: sorting, filtering, and opening builds the right blob type.

**Storage scope.** Store only what the AI or the viewer can use: PDF, Office (docx/pptx/xlsx/doc/xls), text/code,
and images. zip/gz/rar/exe are not downloaded; the file list shows them as a link to the campus. On the user's real data this is
~250 MB of the current 297 MB (measured from `files-index.json`: 343 files over 7 courses; 44 MB of archives/exe).

**5. Distribution + docs**
- `npm run package` → `release/uniovi-virtual-<version>.zip` (the extension only).
- `docs/index.html` for GitHub Pages: a big Descargar button, 3 screenshots, and "¿Qué IA puedo usar?".
- Rewrite `docs/USO-CON-IA-WEB.md` and `docs/PRUEBAS-MANUALES.md`, covering: a fresh student on campus Wi-Fi, each AI, auto-fill, Chrome closed → 503 message.
- Human steps, in a short `relay/DESPLIEGUE.md`: Cloudflare account, `npx wrangler deploy`, and putting the URL in `shared/relay.ts`.

**5b. Updates for an unpacked extension.** It doesn't auto-update.
- **Keep the manifest `key`.** Without it, an unpacked extension's ID comes from its folder path. A new folder would mean a new ID,
  so the stored files and the relay identity would be lost, and she'd have to paste the URL again.
- The background checks the latest GitHub Release about once a day (`releases/latest`, no token). When a newer version exists,
  the popup and welcome page show "Hay una versión nueva", with 2 pictured steps: extract the zip over the same folder, then
  press ⟳ in chrome://extensions. Data survives because the ID stays the same.
- Verify: load v1 with fixture data, extract v2 over it, reload, and check the data and URL are unchanged.

**6. Retire the installer path**
- Backup first: tag the current master as `v0.1.0-instalador` and upload the built
  `UnioviVirtual-Setup-0.1.0.exe` to a GitHub Release with that tag, after asking before pushing. Recovering it is then one checkout or one download.
- Delete `installer/`, `nativehost.ts`, `service.ts`, `tunnel*`, `remote.ts`, `config.ts`, `log.ts`,
  `shared/helper.ts`, `native.ts`, `helperState.ts`, `scripts/package.mjs` and `scripts/build-host.mjs`, and
  their tests, plus the `nativeMessaging` permission. **Keep the `key`.** The tag keeps them.
- Keep stdio `npm run mcp` plus the bridge for Claude Code.
- Update CLAUDE.md and README.

**7. Gate**
- `npm run typecheck && npm test && npm run build && npm run package` pass, and the relay tests pass.
- Stop every process started (wrangler, Chrome profiles).

## How it runs (approved 2026-11-24: "run the goal until it's completed, multiple agents, then a review agent")
- The review agent looks for bugs, possible fixes **and simplifications**. I fix what holds up.
- Steps for the user go in `docs/PRUEBAS-MANUALES.md` and `relay/DESPLIEGUE.md`: manual checks, the Cloudflare
  account plus `wrangler deploy`, pushing the backup tag/release. Everything else gets implemented.
As with goal 04:
- I write the contract (`shared/relay.ts`, the `DataStore` interface) and do the spikes on master.
- Wave 1, three agents in parallel worktrees:
  - **A** relay;
  - **B** shared MCP core + server;
  - **C** extension storage + agent.
- Wave 2: **D** welcome page, popup, auto-fill + distribution + retirement; **E** the "Mis apuntes" page (owns
  `extension/files.*`).
- I re-check each wave's evidence, then one review agent goes over the whole diff.
- I unlink the node_modules junctions before `git worktree remove`.
- First action after approval: save a feedback memory, "simplicity first; the targets are non-technical law students; avoid installers and warnings".

## Verification
- The relay e2e, locally and then on the deployed URL once the user has run `wrangler deploy`.
- An MCP client gets 10/10 through the relay against a loaded extension holding fixture data.
- The GitHub Pages zip, loaded unpacked in a fresh Chrome profile, shows the welcome page.
- Campus Wi-Fi and the three AIs remain manual checks in PRUEBAS-MANUALES.
