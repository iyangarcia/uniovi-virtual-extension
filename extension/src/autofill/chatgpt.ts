import type { AutofillSpec } from "./types.ts";

// ChatGPT (2026, free plan too): chatgpt.com/plugins → «Añadir» / "Add" → «Añadir servidor MCP
// personalizado» / "Add custom MCP server" → form with Icono, Nombre, Descripción, «URL del servidor»
// and «Autenticación»; the student ticks the trust box and presses «Crear» herself. Older menus:
// Settings → Connectors → Advanced → Developer mode → Create. Labels checked live in Spanish and
// English on 2026-11-25 (fixtures chatgpt.html, chatgpt-es.html); re-check the real site before releases.
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
      ],
      // A bare "Create" is too generic to be a step (it may confirm something else); as an opener it
      // is tried once, after 4 s, and never inside a form or a dialog with fields (engine.ts).
      openers: ["=+", "=add", "=anadir", "=new", "=nuevo", "=add plugin", "=anadir plugin", "=create", "=crear"],
    },
  ],
  urlField: ["url", "mcp server", "servidor mcp"],
  nameField: ["name", "nombre"],
  // «Autenticación» defaults to «OAuth» (seen live, 2026-11-25); the link has no login, so ChatGPT
  // can't connect unless it is «Sin autenticación». «OAuth o sin autenticación» is not picked.
  choice: {
    field: ["autenticacion", "authentication"],
    option: ["=sin autenticacion", "=no authentication", "=none", "=ninguna"],
    hint: "En «Autenticación» elige «Sin autenticación».",
  },
  // «Icono (opcional)»: PNG, max 10 KB.
  icon: true,
};
