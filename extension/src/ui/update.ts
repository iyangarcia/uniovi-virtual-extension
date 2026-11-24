import { DOWNLOAD_PAGE, zipName } from "../../../shared/release.ts";

// Update notice for the unpacked extension (it can't auto-update). Pure: no chrome APIs.
//
// chrome.storage.local:
//   update             UpdateInfo { version, url }: a newer release exists (removed when there is none).
//   updateCheckedAt    Date.now() of the last check attempt (success or not), for the once-a-day throttle.
//   devLatestReleaseApi  dev/test only: replaces LATEST_RELEASE_API; setting it forces a check.

export const UPDATE_KEYS = { update: "update", checkedAt: "updateCheckedAt", devApi: "devLatestReleaseApi" } as const;
export const CHECK_EVERY_MS = 24 * 3600_000;

export interface UpdateInfo {
  version: string;
  url: string;
}

/** "v1.2.3" / "1.2" / "1.2.3-beta" → [1, 2, 3]; undefined when it isn't a version. */
export function parseVersion(v: unknown): number[] | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?\s*$/i.exec(v);
  if (!m) return undefined;
  return [m[1], m[2], m[3], m[4]].map((n) => Number(n ?? 0));
}

/** True when `latest` is a strictly newer version than `current`. Unparseable → false. */
export function isNewer(latest: unknown, current: unknown): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** At most once a day; a clock that went backwards also allows a check. */
export function shouldCheck(checkedAt: unknown, now: number): boolean {
  return typeof checkedAt !== "number" || now - checkedAt >= CHECK_EVERY_MS || now < checkedAt;
}

const safeUrl = (u: unknown): u is string => typeof u === "string" && /^https:\/\/(github\.com|[a-z0-9-]+\.github\.io)\//i.test(u);

/**
 * From a GitHub `releases/latest` JSON body: the update to offer, or undefined when it isn't newer
 * (or the body is not a release). Prefers the zip asset, then the release page, then the download page.
 */
export function updateFromRelease(release: unknown, current: string): UpdateInfo | undefined {
  if (!release || typeof release !== "object") return undefined;
  const r = release as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (r.draft === true || r.prerelease === true || !isNewer(r.tag_name, current)) return undefined;
  const version = (r.tag_name as string).trim().replace(/^v/i, "");
  const assets = Array.isArray(r.assets) ? (r.assets as { name?: unknown; browser_download_url?: unknown }[]) : [];
  const zip = assets.find((a) => a?.name === zipName(version)) ?? assets.find((a) => typeof a?.name === "string" && a.name.endsWith(".zip"));
  const zipUrl = zip?.browser_download_url;
  const url = safeUrl(zipUrl) ? zipUrl : safeUrl(r.html_url) ? r.html_url : DOWNLOAD_PAGE;
  return { version, url };
}

/** What the popup / welcome page show: the stored update, only if still newer than the running version. */
export function pendingUpdate(stored: unknown, current: string): UpdateInfo | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const u = stored as Partial<UpdateInfo>;
  return typeof u.version === "string" && safeUrl(u.url) && isNewer(u.version, current) ? { version: u.version, url: u.url } : undefined;
}
