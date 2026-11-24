import type { UpdateInfo } from "./update.ts";

// Small DOM helpers shared by the popup and the welcome page. textContent only: no innerHTML.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Copies text; falls back to execCommand when the async clipboard is unavailable (unfocused page). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { readonly: "", style: "position:fixed;opacity:0;pointer-events:none" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** Shows `done` on the button for a moment, then puts the original label back. */
export function flash(button: HTMLElement, done: string, ms = 1800) {
  const original = button.dataset.label ?? button.textContent ?? "";
  button.dataset.label = original;
  button.textContent = done;
  setTimeout(() => (button.textContent = original), ms);
}

/** "Hay una versión nueva" box with the two steps (popup and welcome page). */
export function updateNotice(update: UpdateInfo): HTMLElement {
  const link = h("a", { href: update.url, target: "_blank", rel: "noopener" }, "Descarga el zip");
  return h(
    "div",
    { class: "update", role: "status" },
    h("strong", {}, `Hay una versión nueva (${update.version})`),
    h(
      "ol",
      {},
      h("li", {}, link, " y descomprímelo ", h("b", {}, "encima de la misma carpeta"), " (reemplazar)."),
      h("li", {}, "En chrome://extensions pulsa ⟳ en Uniovi Virtual."),
    ),
    h("p", {}, "Tus apuntes y tu enlace se mantienen."),
  );
}
