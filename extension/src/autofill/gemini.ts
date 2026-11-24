import type { AutofillSpec } from "./types.ts";

// Gemini (2026): "Add a custom app" by MCP URL (Settings → Connected Apps). Reportedly only for US
// adults with personal accounts, in English, so it may not exist for Spanish students yet.
// Verified only against server/test/fixtures/autofill/gemini.html; the real site is a manual check.
export const gemini: AutofillSpec = {
  id: "gemini",
  label: "Gemini",
  origin: "https://gemini.google.com/*",
  startUrl: "https://gemini.google.com/customize/connectors",
  steps: [
    {
      texts: ["add a custom app", "add custom app", "custom app", "anadir una aplicacion personalizada", "aplicacion personalizada", "app personalizada"],
      openers: ["=add", "=+", "=anadir", "=add app", "=anadir app"],
    },
  ],
  urlField: ["url", "server", "servidor"],
  nameField: ["name", "nombre"],
};
