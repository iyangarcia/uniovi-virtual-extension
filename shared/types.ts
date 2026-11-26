// Data model shared by the extension (producer) and the local server (consumer).
// Timestamps are Unix seconds, as Moodle returns them.

export const BRIDGE_PORT = 47823;
export const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

export interface Course {
  id: number;
  shortname: string;
  fullname: string;
  url: string;
}

export interface Resource {
  /** Stable key: `${cmid}:${filepath}${filename}`. Used for incremental file sync. */
  key: string;
  cmid: number;
  courseId: number;
  section: string;
  /** Activity name as shown in the course page. */
  name: string;
  /** Moodle module type: resource, folder, url, page, ... */
  modname: string;
  /** Session-authenticated URL (pluginfile.php, not webservice/pluginfile.php). */
  url: string;
  filename?: string;
  mimetype?: string;
  filesize?: number;
  timemodified?: number;
}

/**
 * Files the student added on «Mis apuntes» (not from the campus): key `upload:<uuid>`, courseId 0,
 * modname "upload", section «Mis archivos», url "". They live only in the store, never in a snapshot.
 */
export const UPLOAD_SECTION = "Mis archivos";
export const isUpload = (r: Pick<Resource, "modname">) => r.modname === "upload";

export interface ForumPost {
  id: number;
  discussionId: number;
  courseId: number;
  forumName: string;
  subject: string;
  author: string;
  created: number;
  /** Plain text (HTML stripped). */
  message: string;
  url: string;
}

export interface Assignment {
  id: number;
  cmid: number;
  courseId: number;
  name: string;
  dueDate?: number;
  cutoffDate?: number;
  allowSubmissionsFrom?: number;
  intro: string;
  url: string;
}

export interface CalendarEvent {
  id: number;
  courseId?: number;
  name: string;
  /** Moodle eventtype / modulename, e.g. "due", "close", "course", "site". */
  type: string;
  module?: string;
  time: number;
  description: string;
  url?: string;
}

/** One row of the student's own grade report in a course (grade/report/user). Strings as shown. */
export interface GradeItem {
  courseId: number;
  /** Grade categories above the item, outermost first, without the course itself ("Teoría"). */
  category: string[];
  name: string;
  /** Moodle's label for the item kind ("Tarea", "Elemento manual", "Cálculo total"...). */
  kind?: string;
  /** A category or course total, not a graded item. */
  total: boolean;
  /** "7.50", "-" when not graded yet. */
  grade: string;
  range?: string;
  percentage?: string;
  feedback?: string;
  contribution?: string;
}

/** A teacher of a course (participants page, teacher roles only: never other students). */
export interface Teacher {
  courseId: number;
  name: string;
  role: string;
  /** Groups the teacher is in, e.g. practice groups they teach. */
  groups: string[];
}

export interface Snapshot {
  syncedAt: number;
  siteUrl: string;
  courses: Course[];
  resources: Resource[];
  posts: ForumPost[];
  assignments: Assignment[];
  events: CalendarEvent[];
  /** The student's own grades (absent when the student turned grades off, or in older snapshots). */
  grades?: GradeItem[];
  teachers?: Teacher[];
  /** The student's own groups per course id ("PA-Ing-02", "PL-I-1-C"). */
  myGroups?: Record<number, string[]>;
  /** Non-fatal problems during collection (a WS call disabled, a page that failed to parse...). */
  warnings: string[];
}

export interface BridgeStatus {
  ok: true;
  version: string;
  dataDir: string;
  lastSync?: number;
  /** Resource keys already stored, mapped to the timemodified they were stored with. */
  knownFiles: Record<string, number>;
}
