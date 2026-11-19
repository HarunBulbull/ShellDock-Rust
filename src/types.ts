export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: "password" | "privateKey" | "agent";
  privateKey: string;
  group: string;
  notes: string;
  favorite: boolean;
}

export interface SessionTab {
  key: string;
  connection: Connection;
}

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  directory: boolean;
  symlink: boolean;
  modified: number;
  permissions?: number | null;
}

export interface LocalDirectory {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

export interface RemoteDirectory {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

export interface DriveInfo {
  path: string;
  label: string;
}

export interface LocalPlaces {
  home: string;
  desktop: string | null;
  downloads: string | null;
  documents: string | null;
  drives: DriveInfo[];
}

export interface RemoteTextFile {
  path: string;
  text: string;
  mtime: number | null;
  size: number;
  permissions: number | null;
  readOnly: boolean;
  readOnlyReason: string | null;
  truncated: boolean;
  previewMode: string | null;
  lossyUtf8: boolean;
  binary: boolean;
  lineEnding: string;
}

export interface WriteResult {
  mtime: number | null;
  size: number;
}

export interface BatchFailure {
  path: string;
  error: string;
}

export interface DeleteBatchResult {
  deleted: string[];
  failed: BatchFailure[];
}

export interface EditorDocument {
  key: string;
  path: string;
  name: string;
  text: string;
  savedText: string;
  mtime: number | null;
  size: number;
  permissions: number | null;
  readOnly: boolean;
  readOnlyReason: string | null;
  truncated: boolean;
  previewMode: "head" | "tail" | null;
  lossyUtf8: boolean;
  lineEnding: string;
  conflict: string | null;
  saving: boolean;
  error: string | null;
}

export interface TestConnectionResult {
  fingerprint: string;
  previous: string | null;
  trusted: boolean;
  authenticated: boolean;
  message: string;
}

export interface ExternalEditEvent {
  editId: string;
  sessionId: string;
  path: string;
  status: string;
  message: string | null;
}

export type TerminalEvent =
  | { kind: "output"; data: number[] }
  | { kind: "closed" }
  | { kind: "error"; data: string };

export const desktop = "__TAURI_INTERNALS__" in window;

export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

export const formatOctalPermissions = (perm?: number | null) =>
  typeof perm === "number" ? (perm & 0o7777).toString(8).padStart(3, "0") : "—";
