import type { AutofillSpec } from "./types.ts";

// ChatGPT (2026, Plus or higher): chatgpt.com/plugins → "+" → "Add custom MCP server" → form with
// Name, Description, MCP server URL and authentication; the student ticks the trust box and presses
// the final button herself. Older menus: Settings → Connectors → Advanced → Developer mode → Create.
// Verified only against server/test/fixtures/autofill/chatgpt.html; the real site is a manual check.
export const chatgpt: AutofillSpec = {
  id: "chatgpt",
  label: "ChatGPT",
  origin: "https://chatgpt.com/*",
  startUrl: "https://chatgpt.com/plugins",
  steps: [
    {
      texts: [
        "add custom mcp server",
        "custom mcp server",
        "custom mcp",
        "anadir servidor mcp personalizado",
        "servidor mcp personalizado",
        "mcp personalizado",
        "=create connector",
        "=crear conector",
        "=create",
        "=crear",
      ],
      openers: ["=+", "=add", "=anadir", "=new", "=nuevo", "=add plugin", "=anadir plugin"],
    },
  ],
  urlField: ["url", "mcp server", "servidor mcp"],
  nameField: ["name", "nombre"],
};
