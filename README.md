# Uniovi Virtual → Claude

A Chrome extension for **Uniovi Virtual** (Moodle). It does three things:

1. **Panel on your dashboard.** At the top of *Área personal* it shows exams and deadlines for the next 21 days across all your courses, plus what's new since your last visit. Exam dates come from the calendar and from teachers' forum announcements; forum-detected dates are tagged *del foro*, and hovering shows the sentence they came from.
2. **Notifications.** When a sync finds a new announcement that mentions an exam, a deadline or a date, you get a desktop notification. Clicking it opens the post.
3. **Study help with Claude.** Your slides and PDFs are copied to `~/uniovi-data`, and Claude can read them through MCP. Ready-made commands:
   - `semana`: your week, covering deadlines, exams, new announcements and priorities
   - `preparar_examen <asignatura>`: exam details from the announcements, a study plan, condensed notes and practice questions, citing slides and pages
   - `estudiar_tema <asignatura> <tema>`: summary, key concepts, flashcards and a mini quiz

The extension syncs when you open the campus, if the last sync is older than 6 hours, using your normal login. 1 and 2 don't need Claude or anything else installed.

## For students: use it from claude.ai, ChatGPT or Gemini (Windows)

Run **`UnioviVirtual-Setup-<version>.exe`** (per user, no admin; SmartScreen: *Más información → Ejecutar de todas formas*). It installs the extension folder and a small hidden helper that starts with Windows, keeps your files on your PC, and opens a public tunnel so a web AI can read them through a secret connector URL. Load the extension from `%LOCALAPPDATA%\UnioviVirtual\extension`, sync once, then copy the URL from the extension popup into your AI as a custom connector.

Step-by-step guide in Spanish, including privacy and what to do when the URL changes: **[docs/USO-CON-IA-WEB.md](docs/USO-CON-IA-WEB.md)**.

## Developer setup

```sh
npm install
npm run build
```

1. **Extension:** open `chrome://extensions`, enable *Developer mode*, click *Load unpacked*, and pick `extension/dist`. Then open Uniovi Virtual; the first sync takes about 20 seconds.
2. **Claude Code:** run `claude` in this folder; `.mcp.json` registers the server. To use it from any folder:
   `claude mcp add --scope user uniovi-virtual -- node C:/dev/uniovi_virtual_extension/server/dist/index.js`
3. **Claude Desktop:** add this to `%APPDATA%\Claude\claude_desktop_config.json`:
   ```json
   { "mcpServers": { "uniovi-virtual": { "command": "node", "args": ["C:/dev/uniovi_virtual_extension/server/dist/index.js"] } } }
   ```

Data lives in `~/uniovi-data` (override with `UNIOVI_DATA_DIR`). To pin the bridge to your extension's ID, set `UNIOVI_EXTENSION_ID`.

Web AIs without the installer: `npm run remote` (or `start-remote.bat`) runs the bridge, the remote MCP endpoint and a tunnel (localhost.run → tunnelmole → pinggy → cloudflared if installed) until you close it.

**Building the installer:** `npm run package` (Windows, Inno Setup 6: `winget install --id JRSoftware.InnoSetup -e --scope user`) builds everything, downloads and verifies a portable `node.exe`, and writes `release/UnioviVirtual-Setup-<version>.exe`. Manual test checklist: [docs/PRUEBAS-MANUALES.md](docs/PRUEBAS-MANUALES.md).
