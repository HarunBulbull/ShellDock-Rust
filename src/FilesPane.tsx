import { useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowUp,
  RefreshCw,
  FolderPlus,
  Upload,
  Download,
  Folder,
  File,
  Pencil,
  Trash2,
  Home,
  X,
} from "lucide-react";
import type { FileEntry } from "./types";
import { errorText } from "./types";
const join = (base: string, name: string) =>
  `${base.replace(/\/$/, "")}/${name}`;
const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
export default function FilesPane({ id }: { id: string | null }) {
  const [path, setPath] = useState("."),
    [input, setInput] = useState("."),
    [entries, setEntries] = useState<FileEntry[]>([]),
    [selected, setSelected] = useState<FileEntry | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("");
  const [edit, setEdit] = useState<{ path: string; text: string } | null>(null),
    [operation, setOperation] = useState<{
      type: "mkdir" | "rename" | "delete";
      value: string;
    } | null>(null),
    [transfer, setTransfer] = useState<{
      name: string;
      completed: number;
      total: number;
      status: string;
    } | null>(null);
  async function load(next = path) {
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      const files = await invoke<FileEntry[]>("list_remote", {
        id,
        path: next,
      });
      setEntries(files);
      setPath(next);
      setInput(next);
      setSelected(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let disposed = false;
    setEntries([]);
    setSelected(null);
    setError("");
    if (id) {
      void invoke<string>("remote_home", { id })
        .then((home) => {
          if (!disposed) void load(home);
        })
        .catch((e) => {
          if (!disposed) setError(errorText(e));
        });
    }
    return () => {
      disposed = true;
    };
  }, [id]);
  async function send(upload: boolean) {
    if (!id) return;
    setError("");
    try {
      const local = upload
        ? await open({ multiple: false, directory: false })
        : await save({ defaultPath: selected?.name });
      if (!local || Array.isArray(local)) return;
      const name = upload ? local.split(/[\\/]/).pop()! : selected!.name;
      const remote = upload ? join(path, name) : selected!.path;
      const progress = new Channel<{ completed: number; total: number }>();
      progress.onmessage = (p) =>
        setTransfer({ name, ...p, status: "Transferring" });
      setTransfer({ name, completed: 0, total: 0, status: "Transferring" });
      await invoke("transfer", {
        id,
        local,
        remote,
        upload,
        replace: false,
        progress,
      });
      setTransfer((prev) => (prev ? { ...prev, status: "Completed" } : null));
      await load();
    } catch (e) {
      setError(errorText(e));
      setTransfer((prev) =>
        prev
          ? { ...prev, status: "Failed · partial destination may remain" }
          : null,
      );
    }
  }
  async function action() {
    if (!operation || !id) return;
    setBusy(true);
    try {
      await invoke("remote_action", {
        id,
        action: operation.type,
        path:
          operation.type === "mkdir"
            ? join(path, operation.value)
            : selected!.path,
        destination:
          operation.type === "rename" ? join(path, operation.value) : null,
      });
      setOperation(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function editFile() {
    if (!selected || !id) return;
    setBusy(true);
    try {
      const text = await invoke<string>("read_remote", {
        id,
        path: selected.path,
      });
      setEdit({ path: selected.path, text });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="files-pane">
      <div className="pane-toolbar">
        <Folder size={15} />
        <strong>Remote files</strong>
        <span className="spacer" />
        <button
          title="Refresh files"
          disabled={!id || busy}
          onClick={() => void load()}
        >
          <RefreshCw size={15} className={busy ? "spin" : ""} />
        </button>
      </div>
      {!id ? (
        <div className="empty-files">
          <Folder size={34} />
          <h3>Your server's files, here.</h3>
          <p>Connect an SSH session to browse and transfer files over SFTP.</p>
        </div>
      ) : (
        <>
          <form
            className="path-bar"
            onSubmit={(e) => {
              e.preventDefault();
              void load(input);
            }}
          >
            <button
              type="button"
              title="Home"
              onClick={() =>
                void invoke<string>("remote_home", { id })
                  .then((p) => load(p))
                  .catch((e) => setError(errorText(e)))
              }
            >
              <Home size={15} />
            </button>
            <button
              type="button"
              title="Parent folder"
              onClick={() =>
                void load(
                  path === "/" ? "/" : path.replace(/\/[^/]+\/?$/, "") || "/",
                )
              }
            >
              <ArrowUp size={15} />
            </button>
            <input
              aria-label="Remote path"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </form>
          <div className="file-actions">
            <button
              disabled={busy}
              title="New folder"
              onClick={() => setOperation({ type: "mkdir", value: "" })}
            >
              <FolderPlus size={15} />
            </button>
            <button
              disabled={transfer?.status === "Transferring"}
              title="Upload file (existing files are preserved)"
              onClick={() => void send(true)}
            >
              <Upload size={15} />
            </button>
            <button
              title="Download file"
              disabled={
                !selected ||
                selected.directory ||
                transfer?.status === "Transferring"
              }
              onClick={() => void send(false)}
            >
              <Download size={15} />
            </button>
            <span className="spacer" />
            <input
              aria-label="Filter current folder"
              placeholder="Filter files…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <div className="file-list" role="list" aria-label="Remote directory">
            <div className="file-heading">
              <span>Name</span>
              <span>Size</span>
            </div>
            {entries
              .filter((e) =>
                e.name.toLowerCase().includes(filter.toLowerCase()),
              )
              .map((file) => (
                <button
                  role="listitem"
                  className={`file-row ${selected?.path === file.path ? "selected" : ""}`}
                  key={file.path}
                  onClick={() => setSelected(file)}
                  onDoubleClick={() => {
                    if (file.directory) void load(file.path);
                  }}
                >
                  {file.directory ? (
                    <Folder size={16} className="folder-icon" />
                  ) : (
                    <File size={16} />
                  )}
                  <span className="file-name">
                    {file.name}
                    {file.symlink ? " ↗" : ""}
                  </span>
                  <span className="muted small">
                    {file.directory ? "—" : size(file.size)}
                  </span>
                </button>
              ))}
            {entries.length === 0 && !busy && (
              <p className="muted center">This folder is empty.</p>
            )}
          </div>
          <div className="selection-tools">
            <span className="muted small">
              {selected?.name ?? `${entries.length} items`}
            </span>
            <span className="spacer" />
            <button
              title="Edit text file"
              disabled={!selected || selected.directory || busy}
              onClick={() => void editFile()}
            >
              <Pencil size={14} />
            </button>
            <button
              disabled={!selected || busy}
              onClick={() =>
                setOperation({ type: "rename", value: selected!.name })
              }
            >
              Rename
            </button>
            <button
              title="Delete selected item"
              disabled={!selected || busy}
              onClick={() =>
                setOperation({ type: "delete", value: selected!.name })
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
          {transfer && (
            <div className="transfer">
              <div>
                <strong>{transfer.name}</strong>
                <span>{transfer.status}</span>
              </div>
              <progress max={transfer.total || 1} value={transfer.completed} />
              <span className="small muted">
                {size(transfer.completed)} / {size(transfer.total)}
              </span>
            </div>
          )}
        </>
      )}
      {operation && (
        <div className="modal-backdrop">
          <form
            role="dialog"
            aria-modal="true"
            aria-label="File operation"
            className="modal narrow"
            onSubmit={(e) => {
              e.preventDefault();
              void action();
            }}
          >
            <h2>
              {operation.type === "mkdir"
                ? "New folder"
                : operation.type === "rename"
                  ? "Rename item"
                  : "Delete item?"}
            </h2>
            {operation.type === "delete" ? (
              <p>
                Delete “{operation.value}” permanently? Folders must be empty.
                This action cannot be undone.
              </p>
            ) : (
              <label>
                Name
                <input
                  autoFocus
                  required
                  pattern="[^/\\\\]+"
                  value={operation.value}
                  onChange={(e) =>
                    setOperation({ ...operation, value: e.target.value })
                  }
                />
              </label>
            )}
            <div className="actions">
              <button type="button" onClick={() => setOperation(null)}>
                Cancel
              </button>
              <button
                disabled={
                  busy || operation.value === "." || operation.value === ".."
                }
                className={operation.type === "delete" ? "danger" : "primary"}
              >
                Confirm
              </button>
            </div>
          </form>
        </div>
      )}
      {edit && (
        <div className="modal-backdrop">
          <div
            className="modal editor"
            role="dialog"
            aria-modal="true"
            aria-label="Remote text editor"
          >
            <div className="pane-toolbar">
              <strong>{edit.path}</strong>
              <span className="spacer" />
              <button
                onClick={() => {
                  if (
                    window.confirm("Close editor and discard unsaved changes?")
                  )
                    setEdit(null);
                }}
              >
                <X size={17} />
              </button>
            </div>
            <p className="muted small">
              Saving replaces the remote file's contents. Concurrent remote
              changes are not detected.
            </p>
            <textarea
              aria-label="File contents"
              spellCheck={false}
              value={edit.text}
              onChange={(e) => setEdit({ ...edit, text: e.target.value })}
            />
            <div className="actions">
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  if (
                    !window.confirm("Replace the remote file with this text?")
                  )
                    return;
                  setBusy(true);
                  void invoke("write_remote", { id, ...edit })
                    .then(() => setEdit(null))
                    .catch((e) => setError(errorText(e)))
                    .finally(() => setBusy(false));
                }}
              >
                Save to server
              </button>
            </div>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
