// Minimal Moodle client that runs inside a content script on the campus site.
// It piggybacks on the logged-in browser session: requests are same-origin, so the
// MoodleSession cookie is sent automatically, and AJAX calls are authorised by the
// page's sesskey. No Moodle token or password is ever needed.

export class MoodleError extends Error {
  readonly errorcode: string | undefined;
  constructor(message: string, errorcode?: string) {
    super(message);
    this.errorcode = errorcode;
  }
}

export interface PageConfig {
  wwwroot: string;
  sesskey: string;
}

/** Reads M.cfg values that Moodle inlines into every page as JSON. */
export function readPageConfig(doc: Document = document): PageConfig | null {
  const html = doc.documentElement.innerHTML;
  const sesskey =
    /"sesskey"\s*:\s*"([^"]+)"/.exec(html)?.[1] ??
    /[?&]sesskey=([A-Za-z0-9]+)/.exec(html)?.[1];
  const wwwrootRaw = /"wwwroot"\s*:\s*"([^"]+)"/.exec(html)?.[1];
  if (!sesskey) return null;
  const wwwroot = wwwrootRaw ? wwwrootRaw.replace(/\\\//g, "/") : location.origin;
  return { wwwroot, sesskey };
}

export class MoodleClient {
  readonly wwwroot: string;
  private readonly sesskey: string;
  /** Functions the site reported as unavailable; not retried for the rest of the sync. */
  private readonly disabled = new Set<string>();

  constructor(cfg: PageConfig) {
    this.wwwroot = cfg.wwwroot.replace(/\/$/, "");
    this.sesskey = cfg.sesskey;
  }

  /** Calls an AJAX-enabled external function through /lib/ajax/service.php. */
  async call<T>(methodname: string, args: Record<string, unknown>): Promise<T> {
    if (this.disabled.has(methodname)) {
      throw new MoodleError(`${methodname}: not available on this site`, "servicenotavailable");
    }
    try {
      return await this.rawCall<T>(methodname, args);
    } catch (err) {
      if (err instanceof MoodleError && err.errorcode === "servicenotavailable") {
        this.disabled.add(methodname);
        throw new MoodleError(`${methodname}: not available on this site`, "servicenotavailable");
      }
      throw err;
    }
  }

  private async rawCall<T>(methodname: string, args: Record<string, unknown>): Promise<T> {
    const url = `${this.wwwroot}/lib/ajax/service.php?sesskey=${encodeURIComponent(this.sesskey)}&info=${encodeURIComponent(methodname)}`;
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ index: 0, methodname, args }]),
    });
    if (!res.ok) throw new MoodleError(`${methodname}: HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    // Session-level failures come back as a single object instead of an array.
    if (!Array.isArray(body)) {
      const e = body as { error?: string; errorcode?: string };
      throw new MoodleError(`${methodname}: ${e.error ?? "unknown error"}`, e.errorcode);
    }
    const [first] = body as Array<{ error: boolean; data?: T; exception?: { message: string; errorcode: string } }>;
    if (!first) throw new MoodleError(`${methodname}: empty response`);
    if (first.error) {
      throw new MoodleError(`${methodname}: ${first.exception?.message ?? "error"}`, first.exception?.errorcode);
    }
    return first.data as T;
  }

  /**
   * Fetches a site page and parses it, for fallbacks when a WS function is not AJAX-enabled.
   * Index pages use relative hrefs ("view.php?f=12"), so the parsed document gets a <base>
   * and callers should resolve links with `link.href`, not getAttribute("href").
   */
  async page(path: string): Promise<Document> {
    const url = this.absolute(path);
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new MoodleError(`GET ${path}: HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const base = doc.createElement("base");
    base.href = res.url || url;
    doc.head.prepend(base);
    return doc;
  }

  absolute(pathOrUrl: string): string {
    return new URL(pathOrUrl, this.wwwroot + "/").toString();
  }

  /**
   * File URLs from core_course_get_contents point at webservice/pluginfile.php, which
   * needs a token. The plain pluginfile.php endpoint accepts the session cookie instead.
   */
  sessionFileUrl(fileurl: string): string {
    const u = new URL(fileurl, this.wwwroot + "/");
    u.pathname = u.pathname.replace("/webservice/pluginfile.php", "/pluginfile.php");
    u.searchParams.delete("token");
    return u.toString();
  }
}

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6").forEach((el) => el.append("\n"));
  return (doc.body.textContent ?? "").replace(/[ \t ]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}
