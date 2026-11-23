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

export interface Snapshot {
  syncedAt: number;
  siteUrl: string;
  courses: Course[];
  resources: Resource[];
  posts: ForumPost[];
  assignments: Assignment[];
  events: CalendarEvent[];
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
  /** Public MCP connector URL for web AIs, while `npm run remote` is running. Secret: grants read access. */
  remoteUrl?: string;
}
