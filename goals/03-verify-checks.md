# Goal 03: are the checks actually checking? (current branch)

Audit the tests and the Stop-hook gate on the current branch by mutation: break the code on purpose and
confirm a check fails. Work in an isolated worktree; never leave a mutation in place.

- [ ] Inventory: list every test in server/test/ and what behaviour it pins; list what `goal-gate.mjs` checks
- [ ] Mutations on server/src/remote.ts (e.g. tokenMatches always true, drop the 404, remove rate limit, accept longer token) → each caught? record which survive
- [ ] Mutations on server/src/mcp.ts remote mode (leak localPath/dataDir, break search/fetch shape, wrong fetch id handling) → caught?
- [ ] Mutations on store.ts liveRemoteUrl, tunnel.ts parseTunnelUrl, http.ts status remoteUrl → caught?
- [ ] Mutations on shared/dates.ts and shared/digest.ts (a few representative ones) → caught?
- [ ] Gate hook: verify it blocks with an unchecked box, blocks on a failing test, allows stop when done, honours the 25 cap, and handles CRLF GOAL.md
- [ ] For each surviving mutation that matters: add or strengthen a test so it is caught; re-run to confirm
- [ ] `npm run typecheck && npm test && npm run build` pass with the new tests
- [ ] Report: table of mutation → caught/not caught → test added, plus remaining known gaps

## Log
