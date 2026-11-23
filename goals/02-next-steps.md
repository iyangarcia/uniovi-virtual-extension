# Goal 02: real-world bring-up of the remote connector

Tick an item only once it is done AND verified. Record evidence (command + result) under "Log".

- [ ] cloudflared installed (`winget install --id Cloudflare.cloudflared`) and runnable (`cloudflared --version`, or via CLOUDFLARED env with the full path if PATH isn't refreshed)
- [ ] `npm run build` passes
- [ ] `--remote` started against a **temporary fixture data dir** (UNIOVI_DATA_DIR, never the real ~/uniovi-data over a public tunnel); tunnel URL parsed and printed; remote.json gets publicUrl + pid
- [ ] Over the **public https URL**: MCP SDK client (StreamableHTTPClientTransport) initializes, lists tools, calls get_deadlines, search, fetch successfully
- [ ] Over the public URL: wrong token and other paths return 404; root returns 404
- [ ] /api/status on 127.0.0.1:47823 returns remoteUrl while running (if 47823 is owned by another instance, verify via liveRemoteUrl logic or a temp run of the bridge) and stops returning it after shutdown
- [ ] Shutdown (Ctrl+C / SIGTERM) clears publicUrl; tunnel restart-on-crash observed (kill cloudflared child, URL republished)
- [ ] Real-data local check (NO tunnel, http://127.0.0.1 only): every tool against ~/uniovi-data returns sensible output; note latency of search_materials / search on the real corpus
- [ ] Any bugs found are fixed with a regression test; `npm run typecheck && npm test && npm run build` pass
- [ ] All spawned processes (node, cloudflared) stopped at the end

## Log
