# Manual test checklist

Things automated tests can't cover: real Chrome, the real campus, real AI chats, and whether the answers are actually *useful*.
Tick as you go. For each failure, note **what you did, what you expected, what happened**, and the `sync_status` warnings.

Setup once: `npm install && npm run build`, load `extension/dist` unpacked in `chrome://extensions`, log in to Uniovi Virtual.

## 1. Extension and sync

- [ ] After reloading the extension and the campus tab, the dashboard panel appears on `/my/` and nowhere else.
- [ ] "Sync now" in the popup: the status shows progress and finishes without error. Badge and status text update.
- [ ] `sync_status` (Claude Code, or a web chat once connected) shows the right course count and a recent `lastSync`. Read every warning and confirm it's expected (disabled WS functions only).
- [ ] Courses: every course you're enrolled in this term appears. With the "All (incl. past)" setting, past courses appear too.
- [ ] Materials: open 2–3 courses on the campus and compare with `list_materials`. Check folders, PDFs, slides, and links (links have no download).
- [ ] Files land in `~/uniovi-data/files/<curso>/<sección>/`. Open a couple and check they're not HTML login pages.
- [ ] Second sync is incremental: noticeably faster, and doesn't re-upload unchanged files.
- [ ] Notifications: a new announcement (or one you mark unseen) triggers a notification only if "Notify me" is on.
- [ ] Sync with Claude and the bridge closed. Open Claude later: within about a minute the data arrives (`bridge-flush`).

## 2. Remote connector (start-remote, developers)

- [ ] `start-remote.bat` prints a URL ending in `/mcp/<token>` within about 30 s (providers in order: localhost.run, tunnelmole, pinggy, cloudflared if installed).
- [ ] Popup shows "Usar con ChatGPT / Gemini / Claude web" with the same URL. **Copiar** copies it and the button says "Copiada ✓".
- [ ] Opening the URL root (`https://<tunnel host>/`) in a browser gives "Not found". The URL with one character changed also gives "Not found".
- [ ] Close the window: the popup section disappears (reopen the popup). Restart: a new URL appears.
- [ ] `start-remote.bat --rotate-token`: the URL path changes, and the old full URL no longer works in the chat.

## 3. Each AI client

Do this block for **claude.ai**, **ChatGPT** (developer mode) and **Gemini** (custom app), wherever your account allows it.

- [ ] The connector can be added with "no authentication" and shows the tool list (about 11 tools, including `search` and `fetch`).
- [ ] "¿Qué entregas y exámenes tengo en las próximas dos semanas?" Compare against the campus calendar. No invented dates, and forum-detected dates are marked as such, with a link.
- [ ] "¿Ha habido avisos nuevos esta semana en los foros?" Matches what you see on the campus.
- [ ] "Busca en mis apuntes dónde se explica <un concepto que sepas en qué tema está>." The right file and a page/slide number.
- [ ] "Explícame el tema N de <asignatura> y hazme un mini test." Uses that course's slides and cites (file, page). It waits for your answers before correcting.
- [ ] "Prepárame el próximo examen de <asignatura>." The date, format and covered topics match the announcement. The plan runs up to the exam date.
- [ ] Long PDF (100+ pages): it reads in chunks (nextOffset) without the client cutting it off or erroring.
- [ ] Ask about something not in your data ("¿cuándo es el examen de una asignatura que no tengo?"). It says it doesn't know instead of inventing.
- [ ] Answers come in Spanish by default.
- [ ] No answer exposes a local path (`C:\Users\…`) or the data folder.

## 4. Efficiency (time it)

| Check | Target | Measured |
|---|---|---|
| Full first sync, all in-progress courses | < 5 min | |
| Incremental sync | < 1 min | |
| `get_deadlines` / `search_forums` reply in chat | a few seconds | |
| First `search` / `search_materials` over all files (cold text cache) | < 30 s | |
| Same search again (warm cache) | < 3 s | |
| `read_material` of a 100-page PDF, first call | < 15 s | |
| Number of tool calls the AI needs for "mi semana" | ≤ 5 | |

Also watch: is the PC's CPU or fan busy while start-remote is idle? (It shouldn't be.) Does `~/uniovi-data` grow unreasonably after several syncs?

## 5. Privacy and safety

- [ ] Nothing in the chats or the window log shows your campus password or session cookie.
- [ ] With start-remote closed, the connector fails in the chat (no access).
- [ ] The extension never posts or submits anything on the campus (read-only).

## 6. Installer, helper and tunnels (goal 04)

Build with `npm run package` → `release/UnioviVirtual-Setup-<version>.exe`. Student guide: `docs/USO-CON-IA-WEB.md`.

**Fresh Windows user** (a new local account with no Node, no dev tools):
- [ ] Download the Setup.exe through a browser. SmartScreen shows "Windows protegió su PC"; **Más información → Ejecutar de todas formas** works. No UAC/admin prompt.
- [ ] Wizard is in Spanish; the info page explains loading the extension. Finish with both boxes ticked: the extension folder opens, and no console window appears (Task Manager shows `node.exe` under the user, no `conhost`/Terminal window).
- [ ] Load `%LOCALAPPDATA%\UnioviVirtual\extension` unpacked. Its ID is `amagekgnbkaeigjhbenkilkhoklkdieo`.
- [ ] Log in to the campus; first sync completes. Data lands in `Documents\Uniovi` (no `~/uniovi-data` on a fresh user).

**Popup states** (click through each; note what the popup says):
- [ ] Not installed: on a PC/profile without the installer → "no instalado" message, panel and notifications still work.
- [ ] Stopped: **Detener** → state "Detenido", `/api/status` no longer answers, no `node.exe`/`ssh.exe` left.
- [ ] Connecting → Ready: **Iniciar** → "Conectando…" then "Listo" with a URL; note the time to ready and the provider shown.
- [ ] Error: disconnect the network while starting → "Error" with a readable reason; reconnect → recovers alone.
- [ ] Untick "Conector para IAs web" → helper restarts, no URL, local bridge still syncs. Tick it again → URL returns.
- [ ] **Cambiar** the data folder to a new path → config saved, helper restarted, next sync writes there; an invalid path (`relative`, `\\server\x`) is refused with a Spanish message.
- [ ] A helper started with **Iniciar** keeps running after closing **all** Chrome windows (Chrome's job object must not kill it); the URL still answers from the AI.

**Campus Wi-Fi** (eduroam / Uniovi on campus):
- [ ] Which provider wins (popup / `logs\helper.log`), and how long until "Listo". Expected: localhost.run (22) or tunnelmole (8083) may be blocked → pinggy (443).
- [ ] If pinggy: after ~60 min the URL changes, the notification appears once, and pasting the new URL works.

**Each AI** (claude.ai, ChatGPT developer mode, Gemini where the account allows custom MCP connectors; note plan):
- [ ] Paste the URL with no authentication; tools are listed.
- [ ] "¿Qué exámenes tengo esta semana?" — answer matches the campus calendar and announcements, forum dates quoted with link. Record client, plan, tool calls and result. (If Gemini offers no custom connector option, write down the plan/country.)

**Reboot → URL change:**
- [ ] Reboot and log in: the helper starts by itself (Run value `UnioviVirtual`), with no window. Within a minute the popup shows "Listo".
- [ ] The URL differs from before the reboot → one notification "pega la nueva URL en tu IA"; clicking/copying and editing the connector restores access. The old URL gives 404 / no answer.

**Uninstall:**
- [ ] *Configuración → Aplicaciones → Uniovi Virtual → Desinstalar*: the running helper and its tunnel client are stopped first; `%LOCALAPPDATA%\UnioviVirtual` is gone; no `es.uniovi.virtual` key under `HKCU\Software\Google\Chrome\NativeMessagingHosts` / `Microsoft\Edge\...`; no `UnioviVirtual` Run value. The data folder is untouched.
- [ ] After uninstall, the popup says "no instalado" and the panel still works.

## Reporting

Open an issue or note with: client (claude.ai / ChatGPT / Gemini + plan), the prompt, the tool calls the chat shows, the expected vs. actual result, and `sync_status` output.
