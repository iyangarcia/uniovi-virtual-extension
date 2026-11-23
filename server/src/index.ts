import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttp } from "./http.ts";
import { createMcpServer } from "./mcp.ts";
import { REMOTE_PORT, remoteToken, startRemote } from "./remote.ts";
import { loadRemoteState, saveRemoteState } from "./store.ts";
import { startTunnel } from "./tunnel.ts";

// Three modes, one process:
//   default      MCP over stdio (spawned by Claude Code / Claude Desktop) + HTTP ingest if the port is free
//   --http-only  just the HTTP ingest bridge, for syncing while Claude is not running
//   --remote     HTTP ingest + MCP over Streamable HTTP at /mcp/<token> + a Cloudflare quick tunnel,
//                so web chat AIs (ChatGPT, Gemini, claude.ai) can use it as a custom connector.
//                --rotate-token makes a new secret URL (the old one stops working).
// stdout is the MCP channel in the default mode: log to stderr only.

const httpOnly = process.argv.includes("--http-only");
const remote = process.argv.includes("--remote");

const http = await startHttp();
if (remote) {
  await runRemote();
} else if (httpOnly) {
  if (!http) {
    console.error("Bridge already running in another process.");
    process.exit(1);
  }
} else {
  await createMcpServer().connect(new StdioServerTransport());
  console.error("[mcp] uniovi-virtual ready on stdio");
  // The HTTP listener would keep us alive after Claude closes the pipe; exit with the client.
  process.stdin.on("close", () => process.exit(0));
}

async function runRemote() {
  const token = await remoteToken(process.argv.includes("--rotate-token"));
  if (!(await startRemote(token))) process.exit(1);
  console.error(`[remote] MCP endpoint on http://127.0.0.1:${REMOTE_PORT}/mcp/<token>`);

  const publish = async (publicUrl?: string) => {
    const state = (await loadRemoteState()) ?? { token };
    await saveRemoteState({ ...state, token, publicUrl, pid: publicUrl ? process.pid : undefined });
  };

  const tunnel = startTunnel(
    `http://127.0.0.1:${REMOTE_PORT}`,
    (base) => {
      const url = `${base}/mcp/${token}`;
      void publish(url);
      console.error(
        [
          "",
          "==================================================================",
          " Uniovi Virtual connector URL (keep it private, it gives access to",
          " your campus data). Paste it into claude.ai / ChatGPT / Gemini:",
          "",
          ` ${url}`,
          "",
          " It is also shown in the extension popup. It changes every time",
          " this window is restarted. Close this window to disconnect.",
          "==================================================================",
          "",
        ].join("\n"),
      );
    },
    () => void publish(undefined),
  );

  const shutdown = () => {
    tunnel.stop();
    void publish(undefined).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
