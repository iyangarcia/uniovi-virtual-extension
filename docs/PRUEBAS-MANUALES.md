# Manual test checklist (maintainer)

Things automated tests can't cover: the real relay, real Chrome, the real campus, real AI chats, a real
non-technical student, and whether the answers are actually *useful*. Tick as you go. For each failure, note
**what you did, what you expected, what happened**, and the `sync_status` warnings.

Never test against a public relay with fixture data that looks real, and never point a test helper or
test profile at your real campus data except in the checks below that are about the real campus.

## 0. Release (once per version)

**First time only:**
- [ ] Deploy the relay: follow [relay/DESPLIEGUE.md](../relay/DESPLIEGUE.md) (Cloudflare account, `npx wrangler login`, `npx wrangler deploy`). `curl https://<relay>/` shows a short "Uniovi Virtual" page (its icon is at `/icon.png`).
- [ ] Put that URL in `RELAY_URL` in `shared/relay.ts` (no trailing slash). Never change it afterwards: every student's pasted link depends on it.
- [ ] Make the GitHub repository **public** (Settings → General → Danger Zone → Change visibility). Pages and the unauthenticated releases API (the update check) need it.
- [ ] Enable GitHub Pages: Settings → Pages → Source "Deploy from a branch", branch `gh-pages`, folder `/ (root)`. That branch holds only a manual copy of `docs/index.html` and `docs/img/` (see "Publicar la guía" below). After a minute, <https://iyangarcia.github.io/uniovi-virtual-extension/> shows the download page with its pictures.
- [ ] Push the installer backup tag: `git push origin v0.1.0-instalador`. Optionally create a release on that tag and attach the old `UnioviVirtual-Setup-0.1.0.exe` (rebuild it with `git checkout v0.1.0-instalador && npm ci && npm run package` if you no longer have it; mark it as not latest).

**Each version:**
- [ ] Bump `version` in `extension/manifest.json` and in the root `package.json` (a test checks they match). Do **not** touch the manifest `key` (the ID, and with it the students' stored files and links, depends on it).
- [ ] `npm run typecheck && npm test && npm run build && npm run package`. This writes `release/uniovi-virtual-<version>.zip` and `release/uniovi-virtual.zip` (same bytes). It refuses while `RELAY_URL` is still the `example.workers.dev` placeholder (deploy the relay first). For a local test zip only: `ALLOW_PLACEHOLDER_RELAY=1 npm run package` (never publish that zip).
- [ ] Create a GitHub Release with tag `v<version>` and attach **both** zips. It must be marked *latest*: the download button points at `releases/latest/download/uniovi-virtual.zip`, and the extension's daily update check reads `releases/latest`.
- [ ] Click **Descargar** on the Pages site: the new zip downloads.

### Publicar la guía

Pages does not follow `master`: after changing `docs/index.html` or `docs/img/`, copy them to `gh-pages` by hand (Git Bash, from the repo root):

```sh
git fetch origin
test "$(git rev-parse gh-pages)" = "$(git rev-parse origin/gh-pages)"
git worktree add .claude/worktrees/gh-pages gh-pages && cd .claude/worktrees/gh-pages
cp ../../../docs/index.html . && rm -rf img && cp -r ../../../docs/img img
git add -A index.html img && git status --porcelain   # only index.html / img/*
git commit -m "Guide: ..."
git -c push.default=nothing push origin gh-pages:gh-pages   # pushes only gh-pages, never master
cd ../../.. && git worktree remove .claude/worktrees/gh-pages
```

If the `test` line fails, local `gh-pages` and `origin/gh-pages` differ: find out why before publishing.

## 1. A fresh student (the real test)

On a Windows PC that has never had the extension, on **campus Wi-Fi** (eduroam / Uniovi). Ideally a non-technical friend does it while you **watch without helping**; write down every place they hesitate.

- [ ] Starting from the Pages URL only, they download, extract to Documentos, enable Modo Desarrollador, Cargar descomprimida, pick the folder. Note the time taken and any step where they got stuck (the native folder picker and nested `uniovi-virtual\uniovi-virtual` are the likely spots).
- [ ] The welcome page opens by itself. Its first check is ✓.
- [ ] They log in to the campus; the "Entra en el Campus Virtual" step turns ✓ after the first sync. Note the time.
- [ ] They connect an AI using only the welcome page.
- [ ] They ask "¿qué exámenes tengo esta semana?" and get a correct answer.
- [ ] No "Errores" button on the extension card in `chrome://extensions` after the first sync (a red Errores button scares students).

## 2. Each AI answers

For **claude.ai** (free plan), **ChatGPT** (free plan works) and **Gemini** (Developer Mode, `gemini.google.com/devmode`; note the plan):

- [ ] The connector is added with the student's link, no authentication, and lists about 11 tools.
- [ ] "¿Qué exámenes tengo esta semana?" Matches the campus calendar and announcements. Forum dates are quoted with a link. Record client, plan, the tool calls and the result.
- [ ] "Busca en mis apuntes dónde se explica <a concept you know>." Right file and page/slide.
- [ ] "Explícame el tema N de <asignatura> y hazme un mini test." Uses that course's material and cites (file, page).
- [ ] A long PDF (100+ pages) is read in chunks (nextOffset) without the client cutting it off.
- [ ] Something not in the data: it says it doesn't know instead of inventing.
- [ ] No answer shows a local path or the data folder.

## 3. Auto-fill

On the real sites, logged in:

- [ ] claude.ai: **Conectar automáticamente** asks for the claude.ai permission only at click time, opens the connector page and fills name + URL. Only the AI's own confirm button is left. Confirm → it works in a chat.
- [ ] chatgpt.com: the same, on a free account (the student ticks the trust checkbox and presses Create).
- [ ] Gemini (Developer Mode):
  - [ ] Auto-fill opens `gemini.google.com/devmode?hl=en` (also with a Spanish Google account: without `hl=en` it redirects to `/app`), clicks **Create new**, fills **MCP Server URL** and presses **Next**.
  - [ ] The risk checkbox is left unticked for the student.
  - [ ] After the student's **Connect**, the name «Uniovi Virtual» is filled automatically (description left empty).
  - [ ] The extension never presses the final **Connect**.
  - [ ] Then `@Uniovi Virtual` works in a normal chat (answer «Permitir siempre»).
- [ ] After each fill (done or not), `chrome://extensions` → Uniovi Virtual → Detalles → Acceso a sitios no lists the AI site any more (the permission is given back at once).
- [ ] On a page that also shows another form or dialog with an "Add" / "Create" button, auto-fill never presses it.
- [ ] Deny the permission, or break a selector on purpose (edit the selector file, rebuild): it falls back to Copiar with a note.
- [ ] Installing the extension showed no extra permission warning for the AI sites.

## 4. Chrome closed

- [ ] Close every Chrome window (and check Task Manager: no `chrome.exe` left). Ask the AI something: it shows the Spanish "Uniovi Virtual no está conectado: abre Chrome…" message, not a generic error.
- [ ] Open Chrome (without opening the campus). Within about a minute the same question works.
- [ ] Turn off **Conectar con mi IA** in the side panel (Ajustes): the AI gets the same message. Turn it on: it works again.
- [ ] Laptop suspended for an hour, then resumed: it reconnects by itself.

## 5. Update v1 → v2

With a real install that has synced and has a connected AI:

- [ ] Note the link (Copiar enlace) and the file count in Mis apuntes.
- [ ] Publish v2 (section 0). Within a day (or after reloading the extension), the side panel and welcome page show "Hay una versión nueva".
- [ ] Follow the 2 pictured steps: extract over the same `Documentos\uniovi-virtual` (Reemplazar), press ⟳ in `chrome://extensions`.
- [ ] The version is v2; the extension ID is still `amagekgnbkaeigjhbenkilkhoklkdieo`; the link is unchanged; Mis apuntes shows the same files; the AI still answers without re-pasting.
- [ ] From 0.3.0 (popup) to the side-panel version: after ⟳ the icon opens the side panel (no popup), with the same files and link.

## 6. The side panel (home.html) and Mis apuntes

- [ ] Clicking the extension icon opens the side panel; the badge still shows «…» while syncing and «!» on an error.
- [ ] Fresh profile: the panel shows the «Conecta tu IA» card; «Conectar mi IA» opens the welcome page. After the AI's first request the card becomes the status line with Copiar enlace, and the welcome page's step 3 shows «Desde ahora, pulsa el icono…».
- [ ] The panel stays open when switching tabs.
- [ ] On the campus `/my/`, «Abrir Uniovi Virtual» opens the side panel (or, if Chrome refuses, home.html as a tab). The welcome page's «Abrir el panel de Uniovi Virtual» does the same.
- [ ] «Ajustes»: Conectar con mi IA, Sincronizar ahora, every sync setting, «Dejar que mi IA vea mis notas», Tu enlace + Copiar enlace, Cambiar enlace (two-step), Conectar otra IA, Espacio usado, version line.
- [ ] Courses → sections → files match the campus.
- [ ] Sort by name, date and course; the filter box narrows the list; text search finds a phrase inside a PDF.
- [ ] "Nuevo" marks appear for files since the last visit and clear after it.
- [ ] Clicking a PDF's title opens it in the viewer tab. Open two PDFs (e.g. exercises and solutions) with **⋯ → Ventana nueva** and snap them side by side (Win + ←/→). Both render in Chrome's viewer.
- [ ] Clicking a .docx / .pptx title downloads one copy (also **⋯ → Descargar**). A zip's title links to the campus.
- [ ] **Añadir archivo**: download the exam-calendar .xlsx from uniovi.es and add it (button and drag and drop): it shows under «Mis archivos»; a .zip, a .xls and a .ods are refused with a message; the AI answers «¿cuándo es el examen de…?» from it; **⋯ → Borrar** (click twice) removes it, and a sync doesn't bring it back. (Automated: `cd scripts/shots && node verify-uploads.mjs`.)

## 7. Sync on the real campus

- [ ] After reloading the extension and the campus tab, the dashboard panel appears on `/my/` and nowhere else.
- [ ] `sync_status` shows the right course count and a recent `lastSync`. Read every warning; only disabled WS functions are expected.
- [ ] Every course you're enrolled in this term appears.
- [ ] Materials: compare 2–3 courses on the campus with Mis apuntes / `list_materials` (folders, PDFs, slides, links).
- [ ] Downloaded files open and are not HTML login pages (the real redirect path is not covered by tests).
- [ ] A second sync is incremental: noticeably faster, no re-download of unchanged files.
- [ ] Notifications: a new important announcement triggers one notification when «Avisarme de anuncios nuevos» is on (side panel → Ajustes).

## 8. Efficiency (time it)

| Check | Target | Measured |
|---|---|---|
| Install, from Pages to extension card (non-technical person) | < 5 min | |
| Full first sync, all in-progress courses | < 5 min | |
| Incremental sync | < 1 min | |
| `get_deadlines` / `search_forums` reply in chat | a few seconds | |
| First `search_materials` over all files (cold text cache) | < 30 s | |
| Same search again | < 3 s | |
| `read_material` of a 100-page PDF, first call | < 15 s | |
| Tool calls the AI needs for "mi semana" | ≤ 5 | |

Also watch: Chrome's CPU while idle with the AI connection on (Task Manager → Chrome's own task manager, Shift+Esc), and how much the extension stores after several syncs.

## 9. Privacy and safety

- [ ] Nothing in the chats shows the campus password or session cookie.
- [ ] Cambiar enlace (side panel → Ajustes): the old link now gives the "Uniovi Virtual no está conectado" message in the AI (it points at an id nobody answers any more), even with Chrome open; the new one works after pasting it.
- [ ] The extension never posts or submits anything on the campus.
- [ ] Cloudflare dashboard → the Worker: logs/observability are off; the Durable Object stores only the secret hash.

## 10. Claude Code (developers)

- [ ] `npm run build`, then `claude` in the repo: `.mcp.json` starts `server/dist/index.js`; the tools work against `~/uniovi-data`, filled by the extension's optional bridge POST while the server runs.
- [ ] `npm run serve` keeps the bridge up while Claude is closed.

## Reporting

Open an issue or note with: client (claude.ai / ChatGPT / Gemini + plan), the prompt, the tool calls the chat shows, the expected vs. actual result, and `sync_status` output.
