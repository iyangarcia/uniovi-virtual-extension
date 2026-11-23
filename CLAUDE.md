# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
npm run build        # esbuild: extension/dist (load unpacked in Chrome) + server/dist/index.js
npm run watch        # rebuild on change
npm run typecheck    # tsc -p extension && tsc -p server (tsc never emits; esbuild builds)
npm test             # node --test on server/test/**/*.test.ts (Node runs .ts natively)
node --test server/test/dates.test.ts                 # single file
node --test --test-name-pattern="ISO" server/test/dates.test.ts   # single test
npm run serve        # HTTP ingest bridge only (sync while Claude is closed)
npm run mcp          # MCP over stdio + HTTP bridge (what Claude launches)
npm run remote       # HTTP bridge + remote MCP (/mcp/<token> on :47824) + public tunnel, for web AIs (dev; start-remote.bat)
npm run package:helper   # release/app/helper.js (every package bundled, ESM) + package.json {"type":"module"}
npm run package:host     # release/app/host.cjs + host.cmd + es.uniovi.virtual.json (native-messaging host)
npm run package          # build + both of the above + verified portable node.exe + Inno Setup -> release/UnioviVirtual-Setup-<version>.exe
```

After changing extension code, run `npm run build`, click reload on the extension in `chrome://extensions`, then reload the campus tab so the new content script is injected.

## Architecture

There are two halves, joined by the data model in `shared/types.ts` (`Snapshot`, `Resource`, `ForumPost`, ...) and the bridge port `47823`.

The extension is useful on its own: the dashboard panel and notifications work from `chrome.storage.local` with no server. Claude (via the bridge + MCP) is for study help. `shared/` holds pure logic used by both halves: `dates.ts` (Spanish date detection) and `digest.ts` (`upcoming()` merges calendar, assignments and forum-detected dates with dedupe; `unseen()`/`seenAll()`; `isImportant()`). Tests live in `server/test/` and cover `shared/`.

1. **Chrome MV3 extension (`extension/`)**: the producer.
   - `content.ts` runs on `campusvirtual.uniovi.es` pages and does all the Moodle work there. Requests are same-origin, so the session cookie is sent. AJAX calls go to `/lib/ajax/service.php` with the page's `sesskey`, which `readPageConfig` scrapes from the inlined `M.cfg`. No Moodle token is used.
   - `collector.ts` builds the `Snapshot`. Every web-service call has a fallback, because Uniovi may not have every function AJAX-enabled. Course contents, forums and courses fall back to HTML parsing (`client.page()` + DOMParser). Assignment due dates also arrive through the calendar functions. Failures are recorded in `snapshot.warnings` and don't abort the sync. Users and Claude can see them through the `sync_status` tool.
   - File URLs from `core_course_get_contents` are rewritten from `webservice/pluginfile.php` to `pluginfile.php` (`sessionFileUrl`), so the session cookie works instead of a token.
   - Sync flow: content collects → `snapshot-collected` → background stores `snapshot` locally, notifies about new important posts (compared with the previous snapshot), sets `pendingBridge`, and tries to POST to the bridge. A 1-minute `bridge-flush` alarm retries, so data reaches Claude whenever it next opens. On the very first sync, `seen` is set to everything, so the panel doesn't open with hundreds of "new" items.
   - `panel.ts` is mounted by the content script on `/my/` only: a shadow-DOM panel built with `textContent` (site strings are untrusted) that re-renders on `chrome.storage.onChanged`.
   - Only `background.ts` talks to `http://127.0.0.1:47823`; content scripts are subject to page network restrictions. Files need the campus tab (same-origin fetch), so they're uploaded during a sync, or a few seconds after any campus page load when the bridge is up. Files travel content → background as base64, one message per file. Incremental sync compares `Resource.key` / `timemodified` against `knownFiles` from `GET /api/status`.
   - Popup helper section: `native.ts` probes the host (`sendNativeMessage`) and `helperState.ts` (pure, tested) derives not-installed / stopped / connecting / ready / error from that plus `/api/status`. The background notifies once per new connector URL (`remoteUrlChange`, storage key `knownRemoteUrl`).
   - `messages.ts` defines the popup/content/background message union, `Settings`, and `SyncState`, which is persisted in `chrome.storage.local` and drives the popup and badge.
2. **Local server (`server/`)**: a single Node process.
   - `http.ts`: ingest (`GET /api/status`, `POST /api/snapshot`, `PUT /api/files?key=` with an `X-Resource` header). It binds to 127.0.0.1, requires a loopback `Host`, and rejects any `Origin` that isn't `chrome-extension://`.
   - `mcp.ts`: MCP tools plus three MCP prompts (`semana`, `preparar_examen`, `estudiar_tema`, shown as slash commands), all over stdio. They read from disk on every call, so several instances (Claude Code + Desktop) are safe. If the port is taken, the second instance skips HTTP.
   - `remote.ts` + `tunnel.ts` (`--remote` and `--service` modes): MCP over Streamable HTTP (stateless, one `createMcpServer({ remote: true })` per request) on `127.0.0.1:47824`, exposed to ChatGPT / Gemini / claude.ai custom connectors through a public tunnel. `tunnel.ts` tries the providers in `TUNNEL_PROVIDERS` order (`shared/helper.ts`), 25 s each, and restarts from the first after a drop: localhost.run (`ssh` :22), tunnelmole (`tunnel/tunnelmole.ts`, our own client on wss :8083), pinggy (`ssh` :443, the one most likely to pass campus Wi-Fi; anonymous sessions end after 60 min, so the URL changes), cloudflared (:7844, only if installed). The URL changes per run; tunnelmole/pinggy hostnames contain the user's public IP; TLS ends at the provider. The only guard is the secret path `/mcp/<token>`, and anything else returns 404. The token is in `remote.json` in the data dir (`--rotate-token` replaces it), next to the live `publicUrl` + `pid`, which `/api/status` returns as `remoteUrl` for the popup's Copiar button. Remote mode hides `localPath`/`dataDir` from tool output. Web clients ignore MCP prompts, so the same guidance is in the server `instructions`. `search`/`fetch` follow ChatGPT's connector shape (ids `material:<key>`, `post:<id>`). Never loosen `http.ts`'s loopback checks to serve remote traffic. Student guide: `docs/USO-CON-IA-WEB.md`.
   - `service.ts` (`--service`, what the installed helper runs hidden): bridge + remote MCP + tunnel (off when `config.json` says `"tunnel": false`), logs to `<appDir>/logs/helper.log` (rotating, `log.ts`), single instance via `<appDir>/helper.pid` plus a remote-port check. `/api/status` adds `helperVersion` and `tunnel` (`TunnelStatus`, persisted in `remote.json`).
   - `config.ts`: `appDir()` = `%LOCALAPPDATA%/UnioviVirtual` (`UNIOVI_APP_DIR` overrides it; tests must set it) holding `config.json` (`HelperConfig`: `dataDir`, `tunnel`), `helper.pid`, `logs/`, `tunnel/` (ssh known_hosts). Data dir precedence: `UNIOVI_DATA_DIR` > config > existing `~/uniovi-data` > `~/Documents/Uniovi`.
   - `nativehost.ts`: native-messaging host `es.uniovi.virtual` (status / start / stop / setDataDir / setTunnel, validated strictly, 4-byte framing). Starts the helper detached and hidden; CLI flags `--stop` (installer/uninstaller) and `--print-manifest`. Bundled as **`host.cjs`**: the install folder's `package.json` is `{"type":"module"}` for the ESM `helper.js`, so a `.js` host would load as ESM and fail. Keep it free of the MCP SDK and unpdf. The allowed origin is the fixed extension ID from the manifest `key` (`EXTENSION_ID` in `shared/helper.ts`).
   - `store.ts`: `~/uniovi-data` (`UNIOVI_DATA_DIR`) holds `snapshot.json`, `files-index.json`, `remote.json`, `files/<course>/<section>/<file>`, and the extracted-text cache in `.cache/`.
   - `extract.ts`: text from PDF (unpdf), PPTX/DOCX (fflate unzip + XML), and plain text, with `--- page N ---` / `--- slide N ---` markers that `search_materials` uses.
   - `shared/dates.ts` (used by `get_exam_dates` and the panel): heuristic Spanish date detection in forum posts. Each date is classified by its own sentence first, then a wider window. It over-reports on purpose, and results always carry a snippet and link. Keyword lists are tuned on real posts: "práctica(s)" was removed because it also means internships. Add a test when changing them.
   - Icons (`extension/icons/icon{16,48,128}.png`) are the circular Uniovi Virtual logo mark, cropped from the official banner and committed. `scripts/build.mjs` copies them into `dist`.

3. **Installer (`installer/UnioviVirtual.iss`, `scripts/package.mjs`)**: Inno Setup 6, per user (no admin), fixed dir `%LOCALAPPDATA%\UnioviVirtual` (the code expects it). It ships a portable `node.exe` (pinned `NODE_VERSION`, SHA-256 checked against nodejs.org's SHASUMS256.txt, cached in `release/cache/`), `helper.js`, `host.cjs`/`host.cmd`, the host manifest (rewritten at install with the absolute `host.cmd` path, UTF-8 without BOM) and `extension\`. HKCU only: Chrome + Edge `NativeMessagingHosts\es.uniovi.virtual`, and `Run\UnioviVirtual` = `conhost.exe --headless node.exe helper.js --service` (`--headless` keeps the console app windowless, also with Windows Terminal as default; no VBScript). It never ships `config.json`, so an existing one is kept. Uninstall runs `host.cjs --stop` first, then removes the keys, the Run value and the app dir; the data folder is never touched. `/VERYSILENT` doesn't start the helper unless `/STARTHELPER` is passed. ISCC is found via the `ISCC` env var, PATH, or the per-user `winget install --id JRSoftware.InnoSetup -e --scope user`.

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
- Windows reserves port ranges (`netsh int ipv4 show excludedportrange protocol=tcp`); a port inside one fails with EACCES, not EADDRINUSE. `UNIOVI_BRIDGE_PORT` / `UNIOVI_REMOTE_PORT` move the helper for parallel or test runs (the extension always uses 47823).
- Never test a helper with the tunnel on against real campus data: point `UNIOVI_DATA_DIR` / `UNIOVI_APP_DIR` at fixtures, or set `"tunnel": false`.
- Windows PowerShell's `Start-Process -Wait` waits for the whole process tree, so it hangs on an installer run that starts the helper.
