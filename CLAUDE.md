# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
npm run build        # esbuild: extension/dist (load unpacked in Chrome) + server/dist/index.js
npm run watch        # rebuild on change
npm run typecheck    # tsc -p extension && tsc -p server && tsc -p relay (tsc never emits; esbuild builds)
npm test             # node --test on server/test/**/*.test.ts and relay/test/**/*.test.ts (Node runs .ts natively)
node --test server/test/dates.test.ts                 # single file
node --test --test-name-pattern="ISO" server/test/dates.test.ts   # single test
npm run package      # clean build + release/uniovi-virtual-<version>.zip and release/uniovi-virtual.zip (same bytes)
npm run mcp          # dev: MCP over stdio + HTTP bridge (what Claude Code launches via .mcp.json)
npm run serve        # dev: HTTP ingest bridge only (sync while Claude is closed)
cd relay && npm install && npx wrangler dev   # local relay on http://127.0.0.1:8787, no account needed
```

`typecheck` needs `npm install` inside `relay/` first. Deploying the relay: `relay/DESPLIEGUE.md`. Releasing: `docs/PRUEBAS-MANUALES.md` section 0.

After changing extension code, run `npm run build`, click reload on the extension in `chrome://extensions`, then reload the campus tab so the new content script is injected.

## Architecture

Students install **only the extension** (a zip from GitHub Pages, loaded unpacked). It syncs the campus into its own IndexedDB and answers the student's AI itself, through a relay:

```
AI (claude.ai / ChatGPT) ── POST https://<relay>/mcp/<id>/<token> ──► Cloudflare Worker + Durable Object "agent:<id>"
                                                                          └─ WebSocket ──► extension service worker → MCP over IndexedDB
```

`shared/` holds code used by more than one part:
- `types.ts`: the data model (`Snapshot`, `Resource`, `ForumPost`, ..., `BridgeStatus`).
- `dates.ts` (Spanish date detection) and `digest.ts` (`upcoming()` merges calendar, assignments and forum-detected dates with dedupe; `unseen()`/`seenAll()`; `isImportant()`).
- `relay.ts`: the relay contract (protocol v1, URL shape, limits 8 MB / 16 in flight / 60 s, header allow-lists, the Spanish 503 body, `RELAY_URL`).
- `release.ts`: GitHub repo, Pages URL, latest-release API, `zipName()`.
- `mcp/`: the **shared MCP core**: tools, prompts, server instructions, text extraction and search, behind the `DataStore` interface (`store.ts`). No `node:` imports; per-store state lives in WeakMaps. Two stores implement it: IndexedDB (extension) and the filesystem (dev server).

Tests live in `server/test/` (shared logic, the MCP core against an in-memory store, the agent against a fake relay in `helpers/fake-relay.ts`, the dev server) and `relay/test/`.

1. **Chrome MV3 extension (`extension/`)**: the product.
   - `content.ts` runs on `campusvirtual.uniovi.es` pages and does all the Moodle work there. Requests are same-origin, so the session cookie is sent. AJAX calls go to `/lib/ajax/service.php` with the page's `sesskey`, which `readPageConfig` scrapes from the inlined `M.cfg`. No Moodle token is used.
   - `collector.ts` builds the `Snapshot`. Every web-service call has a fallback, because Uniovi may not have every function AJAX-enabled. Course contents, forums and courses fall back to HTML parsing (`client.page()` + DOMParser). Assignment due dates also arrive through the calendar functions. Failures are recorded in `snapshot.warnings` and don't abort the sync. Users and the AI see them through the `sync_status` tool.
   - File URLs from `core_course_get_contents` are rewritten from `webservice/pluginfile.php` to `pluginfile.php` (`sessionFileUrl`), so the session cookie works instead of a token.
   - Sync flow: content collects → `snapshot-collected` → background stores the snapshot in IndexedDB (and `chrome.storage.local` for the panel), notifies about new important posts (compared with the previous snapshot), and also tries the optional dev bridge (`pendingBridge` + 1-minute `bridge-flush` alarm). On the very first sync, `seen` is set to everything, so the panel doesn't open with hundreds of "new" items.
   - Files need the campus tab (same-origin fetch), so they're fetched during a sync and travel content → background as base64, one message per file, into IndexedDB (`store/idb.ts`, database `uniovi`: meta / files / blobs / texts). Incremental sync compares `Resource.key` / `timemodified` against `knownFiles` from IndexedDB. `readable.ts` decides what is downloaded: PDF, Office, text/code, images. Archives and binaries are recorded as `skipped` and shown as campus links.
   - `agent/`: the relay connection. The identity `{id, secret, token}` is created once in `chrome.storage.local` (`agent`). Hello carries the secret (the Durable Object binds sha256(secret) on first use); ping every 20 s; reconnect with backoff 1 s → 60 s plus a keepalive alarm; stop on `rejected`. Each request: constant-time token check (404), POST only, at most 16 in flight, a fresh stateless `createMcpServer(idbStore, {remote: true})` with JSON responses. The popup switch (`aiConnection`) off = disconnected. `devRelayUrl` overrides `RELAY_URL`, in tests only.
   - Pages: `welcome.*` (opens on install: extension ✓, campus ✓ after the first sync, "Conecta tu IA" cards with auto-fill + Copiar), `popup.*` (one plain sentence, "Conectar con mi IA", Copiar enlace, Mis apuntes; Cambiar enlace under advanced options), `files.*` ("Mis apuntes": browse/sort/filter/search the IndexedDB files, open in a new tab from a blob URL). Student-facing text avoids the words server, tunnel, relay and Node.
   - `panel.ts` is mounted by the content script on `/my/` only: a shadow-DOM panel built with `textContent` (site strings are untrusted) that re-renders on `chrome.storage.onChanged`. Extension pages use `textContent` for campus strings too.
   - Updates: the extension is unpacked, so it doesn't auto-update. The background checks `releases/latest` about once a day; students extract the new zip over the same folder and press ⟳.
   - `messages.ts` defines the popup/content/background message union, `Settings`, and `SyncState`, which is persisted in `chrome.storage.local` and drives the popup and badge.
2. **Relay (`relay/`, own package.json, wrangler devDependency)**: a Cloudflare Worker plus one `AgentRoom` Durable Object per student id (SQLite migration, so it runs on the free plan). WebSocket hibernation with ping/pong auto-response, so idle students don't wake it. It stores only `secretHash`, and a newer socket replaces an older one. Limits: 413 / 429 (120 per minute per student) / 503 (agent not connected: the Spanish "abre Chrome" JSON-RPC error) / 504 / 502; anything else is 404. Observability is off and bodies are never logged. Pure logic is in `relay/src/logic.ts`; the end-to-end test is `relay/test/e2e.mjs` against `wrangler dev`.
3. **Dev server (`server/`)**: for Claude Code / Claude Desktop during development, not for students.
   - `index.ts`: default = MCP over stdio + the HTTP bridge if its port is free; `--http-only` = bridge only.
   - `http.ts`: ingest (`GET /api/status`, `POST /api/snapshot`, `PUT /api/files?key=` with an `X-Resource` header). It binds to 127.0.0.1, requires a loopback `Host`, and rejects any `Origin` that isn't `chrome-extension://` (pinned with `UNIOVI_EXTENSION_ID`).
   - `store.ts`: `UNIOVI_DATA_DIR` or `~/uniovi-data` holds `snapshot.json`, `files-index.json`, `files/<course>/<section>/<file>`, and the extracted-text cache in `.cache/`. It exports `nodeStore` (the `DataStore`). `mcp.ts` / `extract.ts` are thin wrappers over `shared/mcp/`. Local mode shows `localPath`/`dataDir`; remote mode (the extension) hides them.
   - Several instances (Claude Code + Desktop) are safe: tools read from disk on every call, and a second instance skips HTTP if the port is taken.
4. **Distribution**: `scripts/package.mjs` zips `extension/dist` (no `.map` files) under one top folder `uniovi-virtual/`, so Windows "Extraer todo" into Documentos gives `Documentos\uniovi-virtual\manifest.json`. Both zip names go on the GitHub Release; the Pages button (`docs/index.html`) links to `releases/latest/download/uniovi-virtual.zip`. Student guide: `docs/USO-CON-IA-WEB.md`; screenshots in `docs/img/`.
   - Icons (`extension/icons/icon{16,48,128}.png`) are the circular Uniovi Virtual logo mark, cropped from the official banner and committed. `scripts/build.mjs` copies them into `dist`.

The goal-04 Windows installer (helper, native-messaging host, tunnels) was retired; it is kept in the git tag `v0.1.0-instalador`.

## Conventions and gotchas

- In the server, **stdout is the MCP channel**: log with `console.error` only.
- Relative imports use explicit `.ts` extensions, and the code sticks to `erasableSyntaxOnly` (no enums or parameter properties), so Node can run the tests directly. esbuild bundles everything else.
- `content.ts` is bundled as IIFE, because content scripts can't be ES modules. Background and popup are ESM.
- Moodle timestamps are Unix **seconds** throughout. MCP output formats dates in `Europe/Madrid`.
- The campus host appears in both `extension/manifest.json` and `CAMPUS_TAB_PATTERNS` in `background.ts`; keep them in sync.
- What Uniovi Virtual actually allows, verified live on 2026-11-17:
  - **AJAX-enabled:** `core_course_get_enrolled_courses_by_timeline_classification`, both calendar functions, `mod_forum_get_discussion_posts`.
  - **Disabled (`servicenotavailable`):** `core_course_get_contents`, `mod_forum_get_forum_discussions`, `mod_forum_get_forums_by_courses`, `mod_assign_get_assignments`.
  - So materials come from `/course/resources.php?id=` (folders via `/mod/folder/view.php`), and forums from `/mod/forum/index.php?id=` → `view.php?f=` → discussion links, with posts fetched through the WS.
  - `MoodleClient` remembers disabled functions, so each costs one call and one warning per sync.
- Courses use the **Onetopic** format: `/course/view.php` renders only the current tab, so never scrape it for contents.
- Index pages use **relative** hrefs (`view.php?f=12`). `client.page()` injects a `<base>`, so resolve links with `a.href`. CSS `[href*=...]` selectors match the raw attribute, so don't include `/mod/...` in them for relative links.
- On discussion pages, one post matches both `[data-region="post"]` and an inner `.forumpost`, and replies nest inside their parent: dedupe by `data-post-id`.
- When something comes back empty, check the `sync_status` warnings first.
- **MV3 module service workers can't use dynamic `import()`.** The background bundle (MCP SDK, unpdf, fflate, ~3.7 MB) is built with `splitting: false`, so esbuild inlines everything. Don't add code splitting or lazy imports there.
- **An open WebSocket keeps the service worker alive** (Chrome 116+, while messages flow): the 20 s ping is what keeps the agent connected. Measured: one socket for 32 min with nothing attached. The keepalive alarm reconnects after a forced stop.
- **Keep the manifest `key`.** It fixes the extension ID (`amagekgnbkaeigjhbenkilkhoklkdieo`). Without it an unpacked extension's ID comes from its folder path, so a new folder would lose the IndexedDB files and the relay identity, and the student would have to paste a new link.
- **Never put real campus data near a public relay in tests.** Use fixture data with a local `wrangler dev` or the fake relay (`server/test/helpers/fake-relay.ts`) and a fresh Chrome profile (`devRelayUrl` points the extension at it). For the dev server, point `UNIOVI_DATA_DIR` at a temp dir and `UNIOVI_BRIDGE_PORT` at a free port.
- Windows reserves port ranges (`netsh int ipv4 show excludedportrange protocol=tcp`); a port inside one fails with EACCES, not EADDRINUSE. The bridge treats it like "in use" (log + continue) instead of crashing the stdio server. `UNIOVI_BRIDGE_PORT` moves the dev server's bridge for parallel or test runs (the extension always uses 47823).
