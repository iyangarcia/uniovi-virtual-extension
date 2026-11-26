// Pure helpers for the IndexedDB store (no browser APIs; server/test imports them).

/** One label segment: no slashes or control characters, whitespace collapsed, bounded length. */
export function labelSegment(s: string, max = 80): string {
  const cleaned = [...s.replace(/\s+/g, " ").replace(/[/\\\u0000-\u001f]/g, "_").trim()].slice(0, max).join("").trim();
  return cleaned || "_";
}

/** Display path of a stored file: `files/<course shortname>/<section>/<filename>`. */
export function fileLabel(courseShortname: string, section: string, filename: string): string {
  return ["files", labelSegment(courseShortname || "Curso"), labelSegment(section || "General"), labelSegment(filename, 150)].join("/");
}

/** Display path of a file the student added herself: `files/Mis archivos/<filename>` (no course level). */
export function uploadLabel(uploadSection: string, filename: string): string {
  return ["files", labelSegment(uploadSection), labelSegment(filename, 150)].join("/");
}

/** Prefixes the file name with a short stable hash of the key, to tell apart same-named files. */
export function withClashTag(path: string, key: string): string {
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  const tag = (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  return path.replace(/([^/]+)$/, `${tag}-$1`);
}

/** Key of the extracted-text cache: one entry per version of a file. */
export const textKey = (f: { key: string; timemodified: number; size: number }) => `${f.key}|${f.timemodified}|${f.size}`;
