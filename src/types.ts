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
}
export type TerminalEvent =
  | { kind: "output"; data: number[] }
  | { kind: "closed" }
  | { kind: "error"; data: string };
export const desktop = "__TAURI_INTERNALS__" in window;
export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
