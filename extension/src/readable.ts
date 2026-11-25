// Which campus files the extension downloads into its own storage (pure; server/test imports it).
// Only what the AI or the "Mis apuntes" viewer can use is stored: PDF, Office/OpenDocument, text and
// code, and images. Archives, executables, disk images and media stay campus links in
// snapshot.resources (they cost space and nobody can read them inside the extension).

const READABLE_EXT = new Set([
  // documents
  "pdf", "doc", "docx", "ppt", "pptx", "pps", "ppsx", "xls", "xlsx", "odt", "ods", "odp", "rtf",
  // text
  "txt", "md", "csv", "tsv", "json", "xml", "html", "htm", "tex", "bib", "log", "yaml", "yml",
  // code
  "c", "h", "cc", "cpp", "hpp", "cs", "java", "kt", "py", "ipynb", "js", "mjs", "ts", "sql", "r", "m",
  "sh", "bat", "ps1", "php", "rb", "go", "rs", "swift", "css", "scss", "asm", "s", "pl", "hs", "scala",
  // images
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp",
]);

const SKIPPED_EXT = new Set([
  // archives
  "zip", "gz", "tgz", "tar", "rar", "7z", "bz2", "xz", "z", "cab",
  // binaries / installers / disk images
  "exe", "msi", "dll", "bin", "iso", "img", "dmg", "apk", "jar", "war", "deb", "rpm", "class", "o",
  // video / audio
  "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpg", "mpeg", "mp3", "wav", "ogg", "m4a", "aac", "flac", "wma",
]);

const READABLE_MIME = [
  /^application\/pdf\b/,
  /^text\//,
  /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp)\b/,
  /^application\/(json|xml|rtf)\b/,
  /^application\/msword\b/,
  /^application\/vnd\.ms-(powerpoint|excel)\b/,
  /^application\/vnd\.openxmlformats-officedocument\./,
  /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)\b/,
];

/** Lower-case extension of a file name or URL path ("" when there is none). */
export function fileExt(name: string | undefined): string {
  if (!name) return "";
  const base = name.split(/[?#]/)[0]!.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Should this file be stored? Decided by extension first, then by mimetype.
 * Returns undefined when neither is known yet (e.g. `/mod/resource/view.php?id=` before the
 * redirect): the caller looks at the response headers and asks again with what they say.
 */
export function isReadableFile(f: { filename?: string; mimetype?: string }): boolean | undefined {
  const ext = fileExt(f.filename);
  if (READABLE_EXT.has(ext)) return true;
  if (SKIPPED_EXT.has(ext)) return false;
  const mime = f.mimetype?.toLowerCase().trim();
  if (mime) return READABLE_MIME.some((re) => re.test(mime));
  // An unknown extension with no type information: not something the AI or viewer can open.
  return ext ? false : undefined;
}

/** A file on the campus (not a link, page or forum): what the collector may download. activity-file: linked from a page, an assignment... (activity.ts). */
export const isCampusFile = (r: { modname: string }) => ["resource", "folder", "section-file", "activity-file"].includes(r.modname);
