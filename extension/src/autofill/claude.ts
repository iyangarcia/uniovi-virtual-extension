import type { AutofillSpec } from "./types.ts";

// claude.ai (2026): Customize → Connectors → "Add custom connector" (sometimes behind an "Add" / "+"
// menu) → dialog with Name and "Remote MCP server URL", then the student presses Add.
// Free plan: one custom connector. Verified only against server/test/fixtures/autofill/claude.html;
// the real site is a manual check (docs/PRUEBAS-MANUALES.md).
export const claude: AutofillSpec = {
  id: "claude",
  label: "Claude",
  origin: "https://claude.ai/*",
  startUrl: "https://claude.ai/settings/connectors",
  steps: [
    {
      texts: ["add custom connector", "anadir conector personalizado", "agregar conector personalizado", "conector personalizado", "custom connector"],
      openers: ["=add", "=add connector", "=+", "=anadir", "=agregar", "=anadir conector", "=agregar conector"],
    },
  ],
  urlField: ["url", "server", "servidor"],
  nameField: ["name", "nombre"],
};
