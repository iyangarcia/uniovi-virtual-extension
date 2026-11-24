// Auto-fill of an AI's "add custom connector" form. Each AI has one AutofillSpec (claude.ts,
// chatgpt.ts, gemini.ts): plain JSON data, because it is passed as an argument to the injected
// fillConnector() (engine.ts), which chrome.scripting serialises without its closure.
//
// Text patterns are compared lower-cased and without accents. "=add" means the whole text must be
// "add"; anything else is a substring match. The engine never clicks the AI's final confirm button.

export type AiId = "claude" | "chatgpt" | "gemini";

export interface AutofillStep {
  /** Buttons / menu items that lead towards the form, most specific first. */
  texts: string[];
  /** Clicked only when none of `texts` shows up (e.g. a "+" that opens a menu holding them). */
  openers?: string[];
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
}

export interface FillArgs {
  spec: AutofillSpec;
  name: string;
  url: string;
  /** Overall budget in ms (page rendering + clicks + form). */
  timeoutMs: number;
}

export interface FillResult {
  ok: boolean;
  /** Which fields were filled. */
  url: boolean;
  name: boolean;
  /** Step-by-step trace, for diagnostics in tests (never shown to the student). */
  trace: string[];
}

export const CONNECTOR_NAME = "Uniovi Virtual";
