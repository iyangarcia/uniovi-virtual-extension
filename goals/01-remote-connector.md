# Goal: Uniovi Virtual as a remote MCP connector (ChatGPT, Gemini, claude.ai web)

Plan: see the "Approach" sections below. Tick an item only once it is implemented AND verified.
The Stop hook (.claude/hooks/goal-gate.mjs) won't let the session end while any box is open
or `npm run typecheck && npm test && npm run build` fails.

## 1. HTTP MCP endpoint
- [x] server/src/remote.ts: listener on 127.0.0.1:47824, Streamable HTTP (stateless) at /mcp/<token>; anything else → 404; constant-time token check; body limit; rate limit
- [x] Token persisted in the data dir (remote.json), `--rotate-token` regenerates it
- [x] MCP server `instructions` (how to use the tools for semana / preparar_examen / estudiar_tema), since web clients ignore MCP prompts
- [x] `search` and `fetch` tools in OpenAI connector shape, wrapping existing material/forum logic
- [x] read_material output is bounded (page range / size cap) so web clients don't truncate

## 2. Launcher + tunnel
- [x] server/src/tunnel.ts: spawns `cloudflared tunnel --url`, parses the trycloudflare URL, restarts on crash, helpful message if cloudflared is missing
- [x] `--remote` mode in server/src/index.ts (ingest + remote MCP + tunnel), `npm run remote`, start-remote.bat
- [x] BridgeStatus.remoteUrl exposed via GET /api/status (ingest security checks unchanged)

## 3. Extension
- [x] Popup shows the connector URL with a Copiar button and a privacy note (textContent only)

## 4. Docs
- [x] docs/USO-CON-IA-WEB.md (Spanish): setup + claude.ai / ChatGPT / Gemini steps, example questions, privacy and limits
- [x] CLAUDE.md updated (remote mode, port 47824, token)

## 5. Verification
- [x] server/test/remote.test.ts: SDK client over HTTP lists tools and calls get_deadlines; wrong token/path → 404
- [x] Unit tests for search/fetch shapes and the cloudflared URL parser
- [x] npm run typecheck, npm test and npm run build all pass
