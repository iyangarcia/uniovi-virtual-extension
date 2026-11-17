# Uniovi Virtual → Claude

A Chrome extension for **Uniovi Virtual** (Moodle). It does three things:

1. **Panel on your dashboard.** At the top of *Área personal* it shows exams and deadlines for the next 21 days across all your courses, plus what's new since your last visit. Exam dates come from the calendar and from teachers' forum announcements; forum-detected dates are tagged *del foro*, and hovering shows the sentence they came from.
2. **Notifications.** When a sync finds a new announcement that mentions an exam, a deadline or a date, you get a desktop notification. Clicking it opens the post.
3. **Study help with Claude.** Your slides and PDFs are copied to `~/uniovi-data`, and Claude can read them through MCP. Ready-made commands:
   - `semana`: your week, covering deadlines, exams, new announcements and priorities
   - `preparar_examen <asignatura>`: exam details from the announcements, a study plan, condensed notes and practice questions, citing slides and pages
   - `estudiar_tema <asignatura> <tema>`: summary, key concepts, flashcards and a mini quiz

Nothing runs in the background. The extension syncs when you open the campus, if the last sync is older than 6 hours, using your normal login. 1 and 2 don't need Claude at all. Data for Claude is kept until Claude is open and then handed over automatically.

## Setup

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
