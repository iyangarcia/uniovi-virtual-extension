// Auto-fill of an AI's "add custom connector" form. Each AI has one AutofillSpec (claude.ts,
// chatgpt.ts, gemini.ts): plain JSON data, because it is passed as an argument to the injected
// fillConnector() (engine.ts), which chrome.scripting serialises without its closure.
//
// Text patterns are compared lower-cased and without accents. "=add" means the whole text must be
// "add"; anything else is a substring match. The engine never clicks the AI's final confirm button,
// nor any submit button or anything inside a form, a dialog with fields or a card with fields.

export type AiId = "claude" | "chatgpt" | "gemini";

export interface AutofillStep {
  /** Buttons / menu items that lead towards the form, most specific first. */
  texts: string[];
  /** Clicked only when none of `texts` shows up (e.g. a "+" that opens a menu holding them). */
  openers?: string[];
  /**
   * The button sits in a dialog that also has a field (Gemini's «Search apps» list with «Create new»):
   * the exact ("=") texts of this step may then be clicked inside such a dialog, which is otherwise
   * off limits. Substring texts never are, and none of the texts may be a confirm word (ux.test.ts).
   */
  inDialog?: boolean;
}

export interface AutofillSpec {
  id: AiId;
  /** Name shown to the student. */
  label: string;
  /** Optional host permission requested at click time (must be in manifest optional_host_permissions). */
  origin: string;
  /** The AI's connector settings page. */
  startUrl: string;
  steps: AutofillStep[];
  /** Words that identify the URL input (label, placeholder, aria-label, name, id). */
  urlField: string[];
  /** Words that identify the name input. */
  nameField: string[];
  /**
   * Multi-screen forms (Gemini): exact-match ("=next") forward buttons, clicked once after the URL is
   * filled and only inside the URL field's own dialog or form. Never a confirm word (ux.test.ts).
   */
  advance?: string[];
  /**
   * The name field shows up only after the student's own confirm (Gemini): keep watching for it this
   * long (ms) after fillConnector returns, fill it once if it is empty, and never click anything.
   */
  nameLaterMs?: number;
  /** The AI's confirm button label as the student sees it, quoted in the on-page note («Connect»). */
  confirmLabel?: string;
  /**
   * A dropdown to set inside the form (ChatGPT: «Autenticación» defaults to «OAuth», but the connector
   * link has no login, so it must be «Sin autenticación» or ChatGPT fails to connect). `field`
   * identifies the dropdown (label words); `option` the choice, exact ("=") patterns, most wanted first.
   * `hint` is told to the student on the page if it can't be set.
   */
  choice?: { field: string[]; option: string[]; hint: string };
  /** Upload the connector icon (FillArgs.iconPng) into the form's PNG file input, if it has one. */
  icon?: boolean;
}

export interface FillArgs {
  spec: AutofillSpec;
  name: string;
  url: string;
  /** Overall budget in ms (page rendering + clicks + form). */
  timeoutMs: number;
  /** The connector icon as base64 PNG (≤ 10 KB), for specs with `icon`. */
  iconPng?: string;
}

export interface FillResult {
  ok: boolean;
  /** Which fields were filled. */
  url: boolean;
  name: boolean;
  /** An `advance` button was pressed (multi-screen forms). */
  advanced?: boolean;
  /** The name was not there yet; a watcher keeps looking for it after this result is returned. */
  nameLater?: boolean;
  /** spec.choice was set (true) or could not be (false); absent when the spec has none. */
  choice?: boolean;
  /** The icon was put into the form's file input. */
  icon?: boolean;
  /** Step-by-step trace, for diagnostics in tests (never shown to the student). */
  trace: string[];
}

export const CONNECTOR_NAME = "Uniovi Virtual";
