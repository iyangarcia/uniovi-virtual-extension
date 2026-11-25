import type { FillArgs, FillResult } from "./types.ts";

/**
 * Injected into the AI's page with chrome.scripting.executeScript({ func: fillConnector, args }).
 * Chrome serialises only this function's source, so everything it uses is defined inside it and the
 * spec arrives as plain data. It never throws into the page: every failure becomes `ok: false`.
 *
 * 1. Walks the spec's steps (clicks "Add custom connector" or similar, opening a menu first if needed)
 *    until a URL input is visible.
 * 2. Fills URL and name the way a person typing would (native value setter + input/change events,
 *    so React/Angular forms notice).
 * 3. Multi-screen forms only (spec.advance / spec.nameLaterMs, Gemini): presses the wizard's "Next"
 *    inside the URL field's own dialog, then leaves a watcher running that writes the name once its
 *    field appears (after the student's own confirm). Risk notices and checkboxes are never touched.
 * 4. Leaves the AI's own confirm button alone, and shows a small note on the page saying what to do.
 */
export async function fillConnector(args: FillArgs): Promise<FillResult> {
  const trace: string[] = [];
  const result: FillResult = { ok: false, url: false, name: false, trace };
  const BANNER_ID = "uniovi-virtual-autofill-note";
  const confirmWord = args.spec.confirmLabel ? `«${args.spec.confirmLabel}»` : "el botón";
  const later = `Cuando aparezca el nombre lo escribiré yo (si no, escribe «${args.name}»).`;
  const NOTES = {
    filled: "he rellenado el nombre y el enlace. Revísalo y pulsa tú el botón para añadirlo.",
    pasted: "he pegado el enlace. Escribe «Uniovi Virtual» como nombre y pulsa tú el botón para añadirlo.",
    advanced: `he pegado el enlace y pulsado «Next». Marca tú el aviso y pulsa ${confirmWord}. ${later}`,
    noAdvance: `he pegado el enlace. Pulsa tú «Next», marca el aviso y pulsa ${confirmWord}. ${later}`,
    named: `he escrito el nombre «${args.name}». Revísalo y pulsa tú ${confirmWord} para terminar.`,
    fail: "No pude rellenarlo solo: el enlace está copiado, pégalo en el campo URL (Ctrl+V).",
  };
  type NoteKind = keyof typeof NOTES;
  let removeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The small note on the page, so she knows what to do next. `sticky`: no 30 s auto-removal. */
  const showNote = (kind: NoteKind, sticky = false) => {
    try {
      clearTimeout(removeTimer);
      document.getElementById(BANNER_ID)?.remove();
      // At the top while a dialog is open, so it doesn't cover the dialog's buttons.
      const dialogOpen = [...document.querySelectorAll("[role='dialog'], [role='alertdialog'], dialog[open]")].some((d) => d.getClientRects().length > 0);
      const note = document.createElement("div");
      note.id = BANNER_ID;
      note.setAttribute("role", "status");
      note.style.cssText =
        `position:fixed;z-index:2147483647;left:50%;${dialogOpen ? "top:16px" : "bottom:24px"};transform:translateX(-50%);max-width:min(560px,calc(100vw - 32px));` +
        "padding:14px 44px 14px 18px;border-radius:12px;font:16px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);" +
        (kind !== "fail" ? "background:#1b5e20;color:#fff;" : "background:#fff3cd;color:#3d2c00;border:1px solid #e0b000;");
      const title = document.createElement("strong");
      title.textContent = "Uniovi Virtual: ";
      const text = document.createElement("span");
      text.textContent = NOTES[kind];
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", "Cerrar");
      close.style.cssText = "position:absolute;top:6px;right:8px;border:0;background:none;color:inherit;font-size:22px;cursor:pointer;";
      close.addEventListener("click", () => note.remove());
      note.append(title, text, close);
      document.body.append(note);
      if (!sticky) removeTimer = setTimeout(() => note.remove(), 30_000);
    } catch {
      // The note is a nicety; never fail because of it.
    }
  };
  let noteKind: NoteKind = "fail";
  let watching = false;
  try {
    const { spec, name, url, timeoutMs } = args;
    const deadline = Date.now() + timeoutMs;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const norm = (s: unknown) =>
      String(s ?? "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const matches = (text: string, patterns: string[]) =>
      !!text && patterns.some((p) => (p.startsWith("=") ? text === norm(p.slice(1)) : text.includes(norm(p))));
    const visible = (el: Element) => {
      if (!(el instanceof HTMLElement) || el.closest(`#${BANNER_ID}`)) return false;
      if (el.hidden || el.getAttribute("aria-hidden") === "true" || el.closest("[aria-hidden='true'], [inert]")) return false;
      if ((el as HTMLButtonElement).disabled) return false;
      const style = getComputedStyle(el);
      return el.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const dialogs = () => [...document.querySelectorAll("[role='dialog'], [role='alertdialog'], dialog[open]")].filter(visible);

    const CLICKABLE = "button, [role='button'], [role='menuitem'], [role='option'], [role='tab'], [role='link'], a[href], li[tabindex], div[tabindex]";
    const FIELD = "input:not([type='hidden']), textarea, select";
    const CARD = "article, [role='article'], li, [role='listitem'], [role='group'], fieldset, [class*='card' i]";
    // Never a button that could submit or confirm something: on the real sites a generic "Add" or
    // "Create" may also be the confirm button of some other form or dialog.
    const unsafe = (el: HTMLElement) =>
      /^submit$/i.test(el.getAttribute("type") ?? "") ||
      !!el.closest("form") ||
      !!el.closest("[role='dialog'], [role='alertdialog'], dialog")?.querySelector(FIELD) ||
      !!el.closest(CARD)?.querySelector(FIELD);
    // Step.inDialog: a dialog with a field is allowed, everything else unsafe() checks still applies.
    const unsafeInDialog = (el: HTMLElement) => /^submit$/i.test(el.getAttribute("type") ?? "") || !!el.closest("form") || !!el.closest(CARD)?.querySelector(FIELD);
    // Never the sidebar: on chatgpt.com a past chat titled "Add custom MCP" matched the step text and
    // was opened instead of the menu (seen live on 2026-11-25). Steps live in the main page or a dialog.
    const NAV = "nav, aside, [role='navigation'], [role='complementary']";
    const findClickable = (patterns: string[], inDialog = false): HTMLElement | undefined => {
      let best: { el: HTMLElement; len: number } | undefined;
      for (const el of document.querySelectorAll<HTMLElement>(CLICKABLE)) {
        if (!visible(el) || el.closest(NAV) || (inDialog ? unsafeInDialog(el) : unsafe(el))) continue;
        const texts = [norm(el.innerText || el.textContent), norm(el.getAttribute("aria-label")), norm(el.getAttribute("title"))];
        const hit = texts.find((t) => matches(t, patterns));
        // The shortest matching text is the most specific element (a button, not the card around it).
        if (hit !== undefined && (!best || hit.length < best.len)) best = { el, len: hit.length };
      }
      return best?.el;
    };
    // The events of a real mouse click, in order. Some menus (Radix, on chatgpt.com) open on
    // pointerdown and ignore a bare el.click() (seen live on 2026-11-25).
    const press = (el: HTMLElement) => {
      const o = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, pointerType: "mouse", isPrimary: true, pointerId: 1 };
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...o, buttons: 0 }));
      el.click();
    };

    const describe =(el: HTMLInputElement | HTMLTextAreaElement) => {
      const parts: unknown[] = [el.getAttribute("aria-label"), el.placeholder, el.name, el.id];
      if (el.id) for (const l of document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)) parts.push(l.textContent);
      parts.push(el.closest("label")?.textContent);
      for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) parts.push(document.getElementById(id)?.textContent);
      // No explicit label: the text just before the field (its own or its wrapper's previous sibling).
      if (!parts.some((x) => typeof x === "string" && x.trim() && x !== el.id && x !== el.name)) {
        let node: Element | null = el;
        for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
          const prev = node.previousElementSibling;
          if (prev && !prev.querySelector("input, textarea")) {
            parts.push(prev.textContent);
            break;
          }
        }
      }
      return norm(parts.filter(Boolean).join(" | "));
    };
    const inputs = () => {
      const scope = dialogs().at(-1) ?? document;
      return [...scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].filter(
        (el) => visible(el) && !el.readOnly && !(el instanceof HTMLInputElement && /^(hidden|checkbox|radio|button|submit|file|search|password)$/i.test(el.type)),
      );
    };
    const findUrlInput = () => {
      const all = inputs();
      return all.find((el) => el instanceof HTMLInputElement && el.type === "url") ?? all.find((el) => matches(describe(el), spec.urlField));
    };
    const findNameInput = (urlInput: Element) => inputs().find((el) => el !== urlInput && matches(describe(el), spec.nameField));

    const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
      return el.value === value;
    };

    // ---- 1. reach the form
    let urlInput = findUrlInput();
    for (let i = 0; i < spec.steps.length && !urlInput; i++) {
      const step = spec.steps[i]!;
      const stepStart = Date.now();
      let openerTried = false;
      let clicked = false;
      while (Date.now() < deadline && !(urlInput = findUrlInput())) {
        // Only exact texts may reach into a dialog that has a field (Gemini's «Create new»).
        const exact = step.inDialog ? step.texts.filter((p) => p.startsWith("=")) : [];
        const target = findClickable(step.texts) ?? (exact.length ? findClickable(exact, true) : undefined);
        if (target) {
          trace.push(`step ${i}: click "${norm(target.innerText || target.getAttribute("aria-label"))}"`);
          press(target);
          clicked = true;
          await sleep(600);
          break;
        }
        // The page may still be rendering: give the specific button 4 s before trying a menu opener.
        if (!openerTried && step.openers?.length && Date.now() - stepStart > 4000) {
          openerTried = true;
          const opener = findClickable(step.openers);
          if (opener) {
            trace.push(`step ${i}: opener "${norm(opener.innerText || opener.getAttribute("aria-label"))}"`);
            press(opener);
            await sleep(600);
            continue;
          }
        }
        await sleep(250);
      }
      if (!clicked && !urlInput) trace.push(`step ${i}: not found`);
    }
    while (!urlInput && Date.now() < deadline) {
      await sleep(250);
      urlInput = findUrlInput();
    }

    // ---- 2. fill
    if (urlInput) {
      result.url = setValue(urlInput, url);
      await sleep(150); // let the form re-render before looking for the name field
      const nameInput = findNameInput(findUrlInput() ?? urlInput);
      if (nameInput) result.name = setValue(nameInput, name);
      // Some forms re-render after the first field; make sure the URL is still there.
      const again = findUrlInput();
      if (again && again.value !== url) result.url = setValue(again, url);
      trace.push(`filled url=${result.url} name=${result.name}`);
    } else trace.push("url field not found");
    result.ok = result.url;
    noteKind = !result.ok ? "fail" : result.name ? "filled" : "pasted";

    // ---- 3a. multi-screen form: press the wizard's own forward button ("Next"), exact text only,
    // inside the URL field's dialog (or form). The one click allowed on a submit button: these words
    // never confirm anything (ux.test.ts). Checkboxes (the risk notice) are never touched.
    const advance = (spec.advance ?? []).filter((p) => p.startsWith("="));
    if (urlInput && result.url && advance.length) {
      const field = findUrlInput() ?? urlInput;
      const root = field.closest("[role='dialog'], [role='alertdialog'], dialog") ?? field.closest("form");
      const findAdvance = () => {
        for (const el of root?.querySelectorAll<HTMLElement>("button, [role='button']") ?? []) {
          if (!visible(el) || el.getAttribute("aria-disabled") === "true") continue;
          const texts = [norm(el.innerText || el.textContent), norm(el.getAttribute("aria-label")), norm(el.getAttribute("title"))];
          if (texts.some((t) => matches(t, advance))) return el;
        }
        return undefined;
      };
      const stopAt = Date.now() + 3000;
      while (root && Date.now() < stopAt) {
        const next = findAdvance();
        if (next) {
          trace.push(`advance: click "${norm(next.innerText || next.getAttribute("aria-label"))}"`);
          press(next);
          result.advanced = true;
          break;
        }
        await sleep(200);
      }
      if (!result.advanced) trace.push(root ? "advance: not found" : "advance: no dialog or form");
      noteKind = result.advanced ? "advanced" : "noAdvance";
    }

    // ---- 3b. the name field comes only after her own confirm: a detached watcher (not awaited, so
    // autoConnect gets its answer and gives the host permission back) writes the name once, if the
    // field is empty. It never clicks, and stops when time is up, the page changes or she typed a name.
    if (urlInput && result.url && !result.name && spec.nameLaterMs) {
      result.nameLater = true;
      watching = true;
      const first = urlInput;
      const origin = location.origin;
      const stopAt = Date.now() + spec.nameLaterMs;
      const watcher = setInterval(() => {
        try {
          if (location.origin !== origin) return void clearInterval(watcher);
          if (Date.now() > stopAt) {
            clearInterval(watcher);
            return showNote(noteKind);
          }
          const field = inputs().find(
            (el) => el !== first && !(el instanceof HTMLInputElement && el.type === "url") && el.value !== url && matches(describe(el), spec.nameField),
          );
          if (!field) return;
          clearInterval(watcher);
          if (field.value.trim()) return showNote(noteKind);
          if (setValue(field, name)) showNote("named");
          else showNote(noteKind);
        } catch {
          clearInterval(watcher);
        }
      }, 500);
    }
  } catch (err) {
    trace.push(`error: ${err instanceof Error ? err.message : String(err)}`);
    result.ok = false;
    noteKind = "fail";
  }

  // ---- 4. the note; it stays while the watcher runs
  showNote(noteKind, watching);
  return result;
}
