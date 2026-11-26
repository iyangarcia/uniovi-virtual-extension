import type { AutofillSpec } from "./types.ts";

// Gemini (2026): from Spain it works through Developer Mode, a wizard in English (checked by hand on
// 2026-11-25, first screens re-checked 2026-11-26; with ?hl=es /devmode redirects to /app, so there is no
// Spanish wizard to match): gemini.google.com/devmode opens a dialog («Choose an app»: «Search apps» +
// «Create new») → «Create new» → «Connect to an MCP server»: «MCP server URL» → Next → a risk notice the
// student ticks → Connect → Name (+ Description) → Connect. Auto-fill pastes the URL and presses Next
// (`advance`); the notice and both Connects are hers. When the Name screen appears, a watcher fills it
// (`nameLaterMs`). The US-only «Add a custom app» texts are kept as fallback.
// Verified only against server/test/fixtures/autofill/gemini.html; the real site is a manual check.
// The labels below are plain data: adjust them here if Google renames a button.
export const gemini: AutofillSpec = {
  id: "gemini",
  label: "Gemini",
  origin: "https://gemini.google.com/*",
  // ?hl=en: with a Spanish Google account /devmode redirects to /app (checked live 2026-11-26); hl=en
  // opens the English wizard for that page only, without changing the account language.
  startUrl: "https://gemini.google.com/devmode?hl=en",
  steps: [
    {
      // «Create new» lives in a dialog that has a search field: only the exact texts may be clicked there.
      texts: ["=create new", "=crear nueva", "=crear nuevo", "create new", "crear nueva", "add a custom app", "add custom app", "custom app", "anadir una aplicacion personalizada", "aplicacion personalizada", "app personalizada"],
      openers: ["=add", "=+", "=anadir", "=add app", "=anadir app"],
      inDialog: true,
    },
  ],
  urlField: ["mcp server url", "url", "server", "servidor"],
  nameField: ["name", "nombre"],
  advance: ["=next", "=siguiente"], // never "Continue": that is claude.ai's confirm button
  nameLaterMs: 180_000,
  confirmLabel: "Connect",
};
