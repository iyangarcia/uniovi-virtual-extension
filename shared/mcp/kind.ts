import type { StoredFile } from "./store.ts";

// Which extractor a stored file needs. Kept apart from extract.ts (which pulls in unpdf) so the
// "Mis apuntes" page can filter files without bundling the PDF parser.

/** Extension of the last path segment, with the dot ("" if none), like node:path's extname. */
export function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

export type FileKind = "pdf" | "pptx" | "docx" | "text" | "other";

export function kindOf(f: Pick<StoredFile, "path" | "contentType">): FileKind {
  const ext = extname(f.path).toLowerCase();
  if (ext === ".pdf" || f.contentType.includes("pdf")) return "pdf";
  if (ext === ".pptx") return "pptx";
  if (ext === ".docx") return "docx";
  if ([".txt", ".md", ".csv", ".json", ".c", ".java", ".py", ".js", ".ts", ".sql", ".xml", ".html"].includes(ext)) return "text";
  if (f.contentType.startsWith("text/")) return "text";
  return "other";
}
