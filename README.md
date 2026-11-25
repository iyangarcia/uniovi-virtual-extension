# Uniovi Virtual for your AI

A Chrome extension for **Uniovi Virtual** (Moodle). It does four things:

1. **Panel on your dashboard.** At the top of *Área personal* it shows exams and deadlines for the next 21 days across all your courses, plus what's new since your last visit. Exam dates come from the calendar and from teachers' forum announcements; forum-detected dates are tagged *del foro*, and hovering shows the sentence they came from.
2. **Notifications.** When a sync finds a new announcement that mentions an exam, a deadline or a date, you get a desktop notification. Clicking it opens the post.
3. **Your AI reads your campus.** claude.ai or ChatGPT connect to the extension with one permanent personal link (a custom MCP connector). They can search your slides and PDFs, list deadlines and exam dates, and read announcements. Ready-made prompts: `semana`, `preparar_examen`, `estudiar_tema`.
4. **Mis apuntes.** A page inside the extension to browse, search and open every synced file, e.g. two PDFs side by side.

The extension syncs when you open the campus, if the last sync is older than 6 hours, using your normal login. Nothing else needs to be installed.

## For students

Download page, with pictures: **<https://iyangarcia.github.io/uniovi-virtual-extension/>**. Download the zip, extract it to Documentos, then in `chrome://extensions` turn on *Modo Desarrollador* → *Cargar descomprimida* → pick the `uniovi-virtual` folder. A welcome page guides the rest.

Full guide in Spanish (connecting each AI, Mis apuntes, updates, privacy, troubleshooting): **[docs/USO-CON-IA-WEB.md](docs/USO-CON-IA-WEB.md)**.

Which AI: Claude (claude.ai, free plan: 1 custom connector), ChatGPT (free plan too), Gemini (advanced: Developer Mode, in English). The AI can only read your files while Chrome is open.

## How it works

```
AI (claude.ai / ChatGPT)
  └─ POST https://<relay>.workers.dev/mcp/<id>/<token>     permanent, per student
       Cloudflare Worker + one Durable Object per student (relay/), stores nothing but a secret hash
         └─ WebSocket, opened by the extension's service worker
              extension: checks the token, runs the MCP server over its IndexedDB copy of the campus
```

Files stay in the extension's IndexedDB on the student's PC. Questions and answers pass through the relay, which stores nothing. The MCP tools, prompts and text extraction live in `shared/mcp/` and run both in the extension and in the Node dev server.

## Developer setup

```sh
npm install
npm run build        # extension/dist + server/dist
npm run typecheck
npm test
npm run package      # release/uniovi-virtual-<version>.zip + release/uniovi-virtual.zip
```

1. **Extension:** open `chrome://extensions`, enable *Developer mode*, click *Load unpacked*, and pick `extension/dist`. Then open Uniovi Virtual; the first sync takes a minute or so.
2. **Relay (local, no account):** `cd relay && npm install && npx wrangler dev`. Deploying it for real: [relay/DESPLIEGUE.md](relay/DESPLIEGUE.md).
3. **Claude Code:** run `claude` in this folder; `.mcp.json` starts the stdio server (`npm run mcp`). It reads `~/uniovi-data` (override with `UNIOVI_DATA_DIR`), which the extension fills through the optional local bridge on `127.0.0.1:47823` whenever this server (or `npm run serve`) is running. To use it from any folder:
   `claude mcp add --scope user uniovi-virtual -- node C:/dev/uniovi_virtual_extension/server/dist/index.js`
4. **Claude Desktop:** add this to `%APPDATA%\Claude\claude_desktop_config.json`:
   ```json
   { "mcpServers": { "uniovi-virtual": { "command": "node", "args": ["C:/dev/uniovi_virtual_extension/server/dist/index.js"] } } }
   ```

To pin the bridge to your extension's ID, set `UNIOVI_EXTENSION_ID`.

Releasing a version and the manual checks (relay deploy, Pages, a fresh student, each AI): [docs/PRUEBAS-MANUALES.md](docs/PRUEBAS-MANUALES.md).

The earlier Windows installer (helper + tunnels) is kept in the git tag `v0.1.0-instalador`.
