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
   - `messages.ts` defines the popup/content/background message union, `Settings`, and `SyncState`, which is persisted in `chrome.storage.local` and drives the popup and badge.
2. **Local server (`server/`)**: a single Node process.
   - `http.ts`: ingest (`GET /api/status`, `POST /api/snapshot`, `PUT /api/files?key=` with an `X-Resource` header). It binds to 127.0.0.1, requires a loopback `Host`, and rejects any `Origin` that isn't `chrome-extension://`.
   - `mcp.ts`: MCP tools plus three MCP prompts (`semana`, `preparar_examen`, `estudiar_tema`, shown as slash commands), all over stdio. They read from disk on every call, so several instances (Claude Code + Desktop) are safe. If the port is taken, the second instance skips HTTP.
   - `store.ts`: `~/uniovi-data` (`UNIOVI_DATA_DIR`) holds `snapshot.json`, `files-index.json`, `files/<course>/<section>/<file>`, and the extracted-text cache in `.cache/`.
   - `extract.ts`: text from PDF (unpdf), PPTX/DOCX (fflate unzip + XML), and plain text, with `--- page N ---` / `--- slide N ---` markers that `search_materials` uses.
   - `shared/dates.ts` (used by `get_exam_dates` and the panel): heuristic Spanish date detection in forum posts. Each date is classified by its own sentence first, then a wider window. It over-reports on purpose, and results always carry a snippet and link. Keyword lists are tuned on real posts: "práctica(s)" was removed because it also means internships. Add a test when changing them.
   - Icons are generated by `scripts/make-icon.mjs`, and the PNGs are committed.

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
