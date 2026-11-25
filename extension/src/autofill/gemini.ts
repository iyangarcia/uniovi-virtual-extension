import type { AutofillSpec } from "./types.ts";

// Gemini (2026): from Spain it works through Developer Mode (gemini.google.com/devmode → «Create new» →
// «MCP Server URL»), checked by hand on 2026-11-25. The US-only «Add a custom app» texts are kept as fallback.
// Verified only against server/test/fixtures/autofill/gemini.html; the real site is a manual check.
export const gemini: AutofillSpec = {
  id: "gemini",
  label: "Gemini",
  origin: "https://gemini.google.com/*",
  startUrl: "https://gemini.google.com/devmode",
  steps: [
    {
      texts: ["create new", "crear nueva", "add a custom app", "add custom app", "custom app", "anadir una aplicacion personalizada", "aplicacion personalizada", "app personalizada"],
      openers: ["=add", "=+", "=anadir", "=add app", "=anadir app"],
    },
  ],
  urlField: ["mcp server url", "url", "server", "servidor"],
  nameField: ["name", "nombre"],
};
