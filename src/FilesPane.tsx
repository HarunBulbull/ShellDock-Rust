import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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
  FolderOpen,
  Search,
  Eye,
  Columns2,
  Laptop,
  Server,
} from "lucide-react";
import type { FileEntry } from "./types";
import { desktop, errorText } from "./types";

interface LocalDirectory {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}
interface Progress {
  completedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
  skippedFiles: number;
  current: string;
  status: string;
}
interface Pending {
  sources: string[];
  destination: string;
  upload: boolean;
}
export interface TransferStatus {
  status: string;
  completed: number;
  total: number;
  queued: number;
}
const join = (base: string, name: string) =>
  `${base.replace(/\/$/, "")}/${name}`;
const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const empty: Progress = {
  completedBytes: 0,
  totalBytes: 0,
  completedFiles: 0,
  totalFiles: 0,
  skippedFiles: 0,
  current: "",
  status: "idle",
};
const dragType = "application/x-shelldock-local-paths";

export default function FilesPane({
  id,
  active = true,
  onTransfer,
}: {
  id: string | null;
  active?: boolean;
  onTransfer?: (status: TransferStatus) => void;
}) {
  const [mode, setMode] = useState<"remote" | "local" | "both">(() => {
    const saved = localStorage.getItem("files.mode");
    return saved === "local" || saved === "remote" ? saved : "both";
  });
  const [width, setWidth] = useState(
    () => Number(localStorage.getItem("files.width")) || 680,
  );
  const [singleWidth, setSingleWidth] = useState(
    () => Number(localStorage.getItem("files.singleWidth")) || 340,
  );
  const [queuedCount, setQueuedCount] = useState(0);
  const queued = useRef<{ batch: Pending; policy: "skip" | "replace" }[]>([]),
    localRequest = useRef(0),
    remoteRequest = useRef(0);
  const [local, setLocal] = useState<LocalDirectory | null>(null),
    [remote, setRemote] = useState<FileEntry[]>([]),
    [path, setPath] = useState("."),
    [localInput, setLocalInput] = useState(""),
    [remoteInput, setRemoteInput] = useState(".");
  const [localSelected, setLocalSelected] = useState<string[]>([]),
    [remoteSelected, setRemoteSelected] = useState<string[]>([]),
    [localFilter, setLocalFilter] = useState(""),
    [remoteFilter, setRemoteFilter] = useState(""),
    [hidden, setHidden] = useState(false);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [pending, setPending] = useState<Pending | null>(null),
    [policy, setPolicy] = useState<"skip" | "replace">("skip"),
    [progress, setProgress] = useState<Progress>(empty),
    [over, setOver] = useState(false),
    [transfersVisible, setTransfersVisible] = useState(true);
  const [operation, setOperation] = useState<{
      type: "mkdir" | "rename" | "delete";
      path: string;
      value: string;
    } | null>(null),
    [edit, setEdit] = useState<{ path: string; text: string } | null>(null);
  const remoteElement = useRef<HTMLDivElement>(null),
    job = useRef<string | null>(null),
    anchor = useRef<Record<string, string>>({}),
    mounted = useRef(true);
  const busy =
    progress.status === "planning" || progress.status === "transferring";
  const snapshot = useRef({ id, active, busy, path });
  snapshot.current = { id, active, busy, path };
  const transferCallback = useRef(onTransfer);
  transferCallback.current = onTransfer;
  useEffect(() => {
    transferCallback.current?.({
      status: progress.status,
      completed: progress.completedFiles,
      total: progress.totalFiles,
      queued: queuedCount,
    });
  }, [
    progress.status,
    progress.completedFiles,
    progress.totalFiles,
    queuedCount,
  ]);
  async function loadLocal(next?: string) {
    const serial = ++localRequest.current;
    try {
      const value = await invoke<LocalDirectory>("list_local", {
        path: next ?? null,
      });
      if (!mounted.current || serial !== localRequest.current) return;
      setLocal(value);
      setLocalInput(value.path);
      setLocalSelected([]);
      localStorage.setItem("files.localPath", value.path);
    } catch (e) {
      if (mounted.current && serial === localRequest.current)
        setError(errorText(e));
    }
  }
  async function loadRemote(next = path) {
    if (!id) return;
    const serial = ++remoteRequest.current;
    setLoading(true);
    try {
      const entries = await invoke<FileEntry[]>("list_remote", {
        id,
        path: next,
      });
      if (!mounted.current || serial !== remoteRequest.current) return;
      setRemote(entries);
      setPath(next);
      setRemoteInput(next);
      setRemoteSelected([]);
    } catch (e) {
      if (mounted.current && serial === remoteRequest.current)
        setError(errorText(e));
    } finally {
      if (mounted.current && serial === remoteRequest.current)
        setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (desktop)
      void loadLocal(localStorage.getItem("files.localPath") || undefined);
    return () => {
      mounted.current = false;
      if (job.current) void invoke("cancel_transfer", { jobId: job.current });
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    remoteRequest.current++;
    queued.current = [];
    setQueuedCount(0);
    setProgress(empty);
    job.current = null;
    setRemote([]);
    setRemoteSelected([]);
    setError("");
    if (id)
      void invoke<string>("remote_home", { id })
        .then((home) => {
          if (!disposed) void loadRemote(home);
        })
        .catch((e) => {
          if (!disposed) setError(errorText(e));
        });
    return () => {
      disposed = true;
      if (job.current) void invoke("cancel_transfer", { jobId: job.current });
    };
  }, [id]);
  useEffect(() => {
    localStorage.setItem("files.mode", mode);
  }, [mode]);
  // Explorer paths come from Tauri's native events; browser File objects omit them.
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const attach = async () => {
      for (const eventName of [
        "tauri://drag-enter",
        "tauri://drag-over",
        "tauri://drag-drop",
        "tauri://drag-leave",
      ]) {
        const unlisten = await listen<{
          paths?: string[];
          position?: { x: number; y: number };
        }>(eventName, (event) => {
          const current = snapshot.current;
          if (!current.active || !current.id || !remoteElement.current) {
            setOver(false);
            return;
          }
          if (eventName === "tauri://drag-leave") {
            setOver(false);
            return;
          }
          const pos = event.payload.position;
          if (!pos) return;
          const x = pos.x / window.devicePixelRatio,
            y = pos.y / window.devicePixelRatio,
            rect = remoteElement.current.getBoundingClientRect();
          const hit = document.elementFromPoint(x, y);
          const inside =
            rect.width > 0 &&
            x >= rect.left &&
            x <= rect.right &&
            y >= rect.top &&
            y <= rect.bottom &&
            hit?.closest(".remote-browser") === remoteElement.current;
          setOver(inside && eventName !== "tauri://drag-drop");
          if (
            eventName === "tauri://drag-drop" &&
            inside &&
            event.payload.paths?.length
          ) {
            const target = hit?.closest<HTMLElement>("[data-remote-directory]")
              ?.dataset.remoteDirectory;
            setPolicy("skip");
            setPending({
              sources: [...new Set(event.payload.paths)],
              destination: target || current.path,
              upload: true,
            });
          }
        });
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      }
    };
    void attach().catch((e) => {
      if (!disposed) setError(errorText(e));
    });
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);
  function select(
    event: MouseEvent,
    file: string,
    entries: FileEntry[],
    isLocal: boolean,
  ) {
    const selected = isLocal ? localSelected : remoteSelected,
      update = isLocal ? setLocalSelected : setRemoteSelected,
      key = isLocal ? "local" : "remote";
    if (event.shiftKey && anchor.current[key]) {
      const a = entries.findIndex((e) => e.path === anchor.current[key]),
        b = entries.findIndex((e) => e.path === file);
      if (a >= 0 && b >= 0) {
        update(
          entries.slice(Math.min(a, b), Math.max(a, b) + 1).map((e) => e.path),
        );
        return;
      }
    }
    anchor.current[key] = file;
    update(
      event.ctrlKey || event.metaKey
        ? selected.includes(file)
          ? selected.filter((p) => p !== file)
          : [...selected, file]
        : [file],
    );
  }
  function queue(sources: string[], upload: boolean, destination?: string) {
    if (!id || !sources.length) return;
    setError("");
    setPolicy("skip");
    setPending({
      sources,
      destination: destination ?? (upload ? path : (local?.path ?? "")),
      upload,
    });
  }
  async function chooseUpload(directory = false) {
    try {
      const chosen = await open({ multiple: true, directory });
      if (chosen) queue(typeof chosen === "string" ? [chosen] : chosen, true);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function download() {
    try {
      if (!id || !remoteSelected.length) return;
      let destination = local?.path;
      if (mode !== "both" || !destination) {
        const chosen = await open({
          directory: true,
          multiple: false,
          title: "Download to local folder",
        });
        if (typeof chosen !== "string") return;
        destination = chosen;
      }
      queue(remoteSelected, false, destination);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function startBatch() {
    if (!pending || !id) return;
    setPending(null);
    if (job.current) {
      queued.current.push({ batch: pending, policy });
      setQueuedCount(queued.current.length);
      return;
    }
    await executeBatch(pending, policy);
  }
  async function executeBatch(
    batch: Pending,
    selectedPolicy: "skip" | "replace",
  ) {
    const sessionId = snapshot.current.id;
    if (!sessionId) return;
    const request = {
      ...batch,
      policy: selectedPolicy,
      jobId: crypto.randomUUID(),
    };
    job.current = request.jobId;
    let failed = false;
    setTransfersVisible(true);
    setProgress({ ...empty, status: "planning" });
    const channel = new Channel<Progress>();
    channel.onmessage = (value) => {
      if (mounted.current && snapshot.current.id === sessionId)
        setProgress(value);
    };
    try {
      const result = await invoke<Progress>("transfer_batch", {
        id: sessionId,
        request,
        progress: channel,
      });
      if (mounted.current && snapshot.current.id === sessionId)
        setProgress(result);
    } catch (e) {
      failed = !errorText(e).includes("cancelled");
      if (mounted.current && snapshot.current.id === sessionId) {
        setError(errorText(e));
        setProgress((p) => ({
          ...p,
          status: errorText(e).includes("cancelled") ? "cancelled" : "failed",
        }));
      }
    } finally {
      if (job.current !== request.jobId) return;
      job.current = null;
      if (mounted.current && snapshot.current.id === sessionId) {
        void loadRemote();
        if (local) void loadLocal(local.path);
        if (failed) queued.current = [];
        const next = queued.current.shift();
        setQueuedCount(queued.current.length);
        if (next) void executeBatch(next.batch, next.policy);
      }
    }
  }
  async function chooseLocal() {
    try {
      const chosen = await open({
        directory: true,
        multiple: false,
        title: "Choose a local folder",
      });
      if (typeof chosen === "string") void loadLocal(chosen);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function action() {
    if (!operation || !id) return;
    try {
      await invoke("remote_action", {
        id,
        action: operation.type,
        path:
          operation.type === "mkdir"
            ? join(path, operation.value)
            : operation.path,
        destination:
          operation.type === "rename" ? join(path, operation.value) : null,
      });
      setOperation(null);
      void loadRemote();
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function editFile() {
    const selected = remote.find((e) => e.path === remoteSelected[0]);
    if (!selected || selected.directory) return;
    try {
      setEdit({
        path: selected.path,
        text: await invoke<string>("read_remote", { id, path: selected.path }),
      });
    } catch (e) {
      setError(errorText(e));
    }
  }
  const visibleLocal = (local?.entries ?? []).filter(
    (e) =>
      (hidden || !e.name.startsWith(".")) &&
      e.name.toLowerCase().includes(localFilter.toLowerCase()),
  );
  const visibleRemote = remote.filter(
    (e) =>
      (hidden || !e.name.startsWith(".")) &&
      e.name.toLowerCase().includes(remoteFilter.toLowerCase()),
  );
  const selectedRemote = remote.find((e) => e.path === remoteSelected[0]);
  function rows(entries: FileEntry[], isLocal: boolean) {
    const selected = isLocal ? localSelected : remoteSelected;
    return entries.map((file) => (
      <div
        key={file.path}
        role="option"
        aria-selected={selected.includes(file.path)}
        tabIndex={0}
        className={`browser-row ${selected.includes(file.path) ? "selected" : ""}`}
        data-remote-directory={
          !isLocal && file.directory ? file.path : undefined
        }
        draggable={isLocal && !file.symlink}
        onDragStart={(e) => {
          if (!isLocal) return;
          e.dataTransfer.setData(
            dragType,
            JSON.stringify(
              selected.includes(file.path) ? selected : [file.path],
            ),
          );
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={(e) => select(e, file.path, entries, isLocal)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && file.directory)
            void (isLocal ? loadLocal(file.path) : loadRemote(file.path));
          if (e.ctrlKey && e.key === "a") {
            e.preventDefault();
            (isLocal ? setLocalSelected : setRemoteSelected)(
              entries.map((f) => f.path),
            );
          }
        }}
        onDoubleClick={() => {
          if (file.directory)
            void (isLocal ? loadLocal(file.path) : loadRemote(file.path));
        }}
      >
        {file.directory ? (
          <Folder size={15} className="folder-icon" />
        ) : (
          <File size={15} />
        )}
        <span className="browser-name">
          {file.name}
          {file.symlink ? " ↗" : ""}
        </span>
        <span className="browser-size">
          {file.directory ? "—" : bytes(file.size)}
        </span>
        <span className="browser-date">
          {file.modified
            ? new Date(file.modified * 1000).toLocaleDateString()
            : ""}
        </span>
      </div>
    ));
  }
  function pathBar(isLocal: boolean) {
    return (
      <form
        className="browser-path"
        onSubmit={(e) => {
          e.preventDefault();
          void (isLocal ? loadLocal(localInput) : loadRemote(remoteInput));
        }}
      >
        <button
          type="button"
          title={isLocal ? "Local home" : "Remote home"}
          disabled={!isLocal && !id}
          onClick={() => {
            if (isLocal) void loadLocal();
            else
              void invoke<string>("remote_home", { id })
                .then((p) => loadRemote(p))
                .catch((e) => setError(errorText(e)));
          }}
        >
          <Home size={14} />
        </button>
        <button
          type="button"
          title={isLocal ? "Local parent folder" : "Remote parent folder"}
          disabled={isLocal ? !local?.parent : !id || path === "/"}
          onClick={() =>
            void (isLocal
              ? loadLocal(local!.parent!)
              : loadRemote(path.replace(/\/[^/]+\/?$/, "") || "/"))
          }
        >
          <ArrowUp size={14} />
        </button>
        <input
          aria-label={isLocal ? "Local path" : "Remote path"}
          disabled={!isLocal && !id}
          value={isLocal ? localInput : remoteInput}
          onChange={(e) =>
            (isLocal ? setLocalInput : setRemoteInput)(e.target.value)
          }
        />
      </form>
    );
  }
  return (
    <aside
      className={`file-manager mode-${mode}`}
      style={{
        display: active ? "flex" : "none",
        width: mode === "both" ? width : singleWidth,
      }}
      aria-label="File manager"
    >
      <div
        className="panel-resizer"
        role="separator"
        aria-label="Resize file manager"
        aria-orientation="vertical"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            const next = Math.max(
              mode === "both" ? 480 : 280,
              Math.min(
                mode === "both" ? window.innerWidth - 660 : 560,
                (mode === "both" ? width : singleWidth) +
                  (e.key === "ArrowLeft" ? 20 : -20),
              ),
            );
            (mode === "both" ? setWidth : setSingleWidth)(next);
            localStorage.setItem(
              mode === "both" ? "files.width" : "files.singleWidth",
              String(next),
            );
          }
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const start = e.clientX,
            initial =
              e.currentTarget.parentElement!.getBoundingClientRect().width;
          const move = (event: PointerEvent) => {
            const next = Math.max(
              mode === "both" ? 480 : 280,
              Math.min(
                mode === "both" ? window.innerWidth - 660 : 560,
                initial + start - event.clientX,
              ),
            );
            (mode === "both" ? setWidth : setSingleWidth)(next);
            localStorage.setItem(
              mode === "both" ? "files.width" : "files.singleWidth",
              String(next),
            );
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      />
      <div className="file-manager-title">
        <Folder size={16} />
        <strong>Files</strong>
        <span className="spacer" />
        <div className="segmented" aria-label="File browser view">
          {(["remote", "local", "both"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {value === "remote" ? (
                <Server size={12} />
              ) : value === "local" ? (
                <Laptop size={12} />
              ) : (
                <Columns2 size={12} />
              )}{" "}
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <div role="alert" className="file-error">
          {error}
          <button title="Dismiss error" onClick={() => setError("")}>
            <X size={13} />
          </button>
        </div>
      )}
      <div className="file-browsers">
        {mode !== "remote" && (
          <section className="browser local-browser" aria-label="Local files">
            <div className="browser-toolbar">
              <Laptop size={14} />
              <strong>Local</strong>
              <span className="spacer" />
              <button
                title="Choose local folder"
                onClick={() => void chooseLocal()}
              >
                <FolderOpen size={15} />
              </button>
              <button
                title="Upload selection"
                disabled={!id || !localSelected.length}
                onClick={() => queue(localSelected, true)}
              >
                <Upload size={15} />
              </button>
              <button
                title="Refresh local files"
                onClick={() => void loadLocal(local?.path)}
              >
                <RefreshCw size={14} />
              </button>
            </div>
            {pathBar(true)}
            <div className="browser-filter">
              <Search size={13} />
              <input
                aria-label="Filter local files"
                placeholder="Filter this folder"
                value={localFilter}
                onChange={(e) => setLocalFilter(e.target.value)}
              />
            </div>
            <div className="browser-columns">
              <span>Name</span>
              <span>Size</span>
              <span>Modified</span>
            </div>
            <div
              className="browser-list"
              role="listbox"
              aria-label="Local directory"
              aria-multiselectable="true"
            >
              {rows(visibleLocal, true)}
              {!local && (
                <button
                  className="choose-folder"
                  onClick={() => void chooseLocal()}
                >
                  <FolderOpen size={28} />
                  Choose a local folder
                </button>
              )}
              {local && visibleLocal.length === 0 && (
                <p className="browser-empty">No matching items</p>
              )}
            </div>
            <div className="browser-footer">
              {localSelected.length
                ? `${localSelected.length} selected`
                : `${visibleLocal.length} items`}
              <span className="spacer" />
              <span>Ctrl / Shift to select</span>
            </div>
          </section>
        )}
        {mode !== "local" && (
          <section
            className={`browser remote-browser ${over ? "drop-target" : ""}`}
            ref={remoteElement}
            aria-label="Remote files"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(dragType) && id) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setOver(true);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const value = e.dataTransfer.getData(dragType);
              if (value) {
                const target = (e.target as HTMLElement).closest<HTMLElement>(
                  "[data-remote-directory]",
                )?.dataset.remoteDirectory;
                queue(JSON.parse(value), true, target || path);
              }
            }}
          >
            <div className="browser-toolbar">
              <span className={`status-dot ${id ? "online" : ""}`} />
              <strong>{mode === "both" ? "Remote" : "SFTP"}</strong>
              <span className="spacer" />
              <button
                title="New remote folder"
                disabled={!id || busy}
                onClick={() =>
                  setOperation({ type: "mkdir", path: "", value: "New folder" })
                }
              >
                <FolderPlus size={15} />
              </button>
              <button
                title="Upload files"
                disabled={!id}
                onClick={() => void chooseUpload()}
              >
                <Upload size={15} />
              </button>
              <button
                title="Upload folders"
                disabled={!id}
                onClick={() => void chooseUpload(true)}
              >
                <FolderOpen size={15} />
              </button>
              <button
                title="Download selection"
                disabled={!id || !remoteSelected.length}
                onClick={() => void download()}
              >
                <Download size={15} />
              </button>
              <button
                title="Refresh files"
                disabled={!id || loading}
                onClick={() => void loadRemote()}
              >
                <RefreshCw size={14} className={loading ? "spin" : ""} />
              </button>
            </div>
            {pathBar(false)}
            <div className="browser-filter">
              <Search size={13} />
              <input
                aria-label="Filter remote files"
                placeholder="Filter this folder"
                value={remoteFilter}
                onChange={(e) => setRemoteFilter(e.target.value)}
              />
            </div>
            <div className="browser-columns">
              <span>Name</span>
              <span>Size</span>
              <span>Modified</span>
            </div>
            <div
              className="browser-list"
              role="listbox"
              aria-label="Remote directory"
              aria-multiselectable="true"
            >
              {id ? (
                rows(visibleRemote, false)
              ) : (
                <div className="browser-disconnected">
                  <Server size={28} />
                  <strong>SFTP not connected</strong>
                  <p>Connect this server to browse remote files.</p>
                </div>
              )}
              {id && visibleRemote.length === 0 && !loading && (
                <p className="browser-empty">This folder is empty</p>
              )}
            </div>
            {over && (
              <div className="drop-hint">
                <Upload size={24} />
                <strong>Upload to this folder</strong>
                <span>Drop files or folders from Explorer</span>
              </div>
            )}
            <div className="browser-footer">
              <span>
                {remoteSelected.length
                  ? `${remoteSelected.length} selected`
                  : `${visibleRemote.length} items`}
              </span>
              <span className="spacer" />
              <button
                title="Edit text file"
                disabled={
                  !selectedRemote ||
                  selectedRemote.directory ||
                  remoteSelected.length !== 1 ||
                  busy
                }
                onClick={() => void editFile()}
              >
                <Pencil size={13} />
              </button>
              <button
                title="Rename remote item"
                disabled={
                  !selectedRemote || remoteSelected.length !== 1 || busy
                }
                onClick={() =>
                  setOperation({
                    type: "rename",
                    path: selectedRemote!.path,
                    value: selectedRemote!.name,
                  })
                }
              >
                Rename
              </button>
              <button
                title="Delete remote item"
                disabled={
                  !selectedRemote || remoteSelected.length !== 1 || busy
                }
                onClick={() =>
                  setOperation({
                    type: "delete",
                    path: selectedRemote!.path,
                    value: selectedRemote!.name,
                  })
                }
              >
                <Trash2 size={13} />
              </button>
            </div>
          </section>
        )}
      </div>
      <div className="file-manager-footer">
        <button
          aria-pressed={hidden}
          title="Show hidden files"
          onClick={() => setHidden(!hidden)}
        >
          <Eye size={13} /> Hidden files
        </button>
        <span className="spacer" />
        <button onClick={() => setTransfersVisible(!transfersVisible)}>
          <Upload size={12} /> Transfers{busy ? " •" : ""}
          {queuedCount ? ` · ${queuedCount} queued` : ""}
        </button>
        {queuedCount > 0 && (
          <button
            title="Clear queued transfers"
            onClick={() => {
              queued.current = [];
              setQueuedCount(0);
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>
      {transfersVisible && progress.status !== "idle" && (
        <div className="batch-progress" role="status">
          <div>
            <strong>
              {progress.status === "completed"
                ? "Transfer complete"
                : progress.status === "cancelled"
                  ? "Transfer cancelled"
                  : progress.status === "failed"
                    ? "Transfer failed"
                    : progress.status === "planning"
                      ? "Preparing transfer…"
                      : "Transferring…"}
            </strong>
            <span className="spacer" />
            {busy && (
              <button
                title="Cancel transfer"
                onClick={() => {
                  if (job.current)
                    void invoke("cancel_transfer", {
                      jobId: job.current,
                    }).catch((e) => setError(errorText(e)));
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <progress
            max={Math.max(1, progress.totalFiles)}
            value={
              progress.status === "completed"
                ? Math.max(1, progress.totalFiles)
                : progress.completedFiles + progress.skippedFiles
            }
          />
          <div>
            <span>
              {progress.completedFiles} / {progress.totalFiles} files ·{" "}
              {progress.skippedFiles} skipped
            </span>
            <span className="spacer" />
            {bytes(progress.completedBytes)} / {bytes(progress.totalBytes)}
          </div>
          <p title={progress.current}>{progress.current}</p>
        </div>
      )}
      {pending && (
        <div className="modal-backdrop">
          <form
            className="modal narrow"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm transfer"
            onSubmit={(e) => {
              e.preventDefault();
              void startBatch();
            }}
          >
            <h2>
              {pending.upload ? "Upload" : "Download"} {pending.sources.length}{" "}
              item{pending.sources.length === 1 ? "" : "s"}
            </h2>
            <p>
              Folders are merged. Symbolic links are skipped.
              {busy
                ? " This batch will be queued after the current transfer."
                : ""}
            </p>
            <label>
              Destination
              <input readOnly value={pending.destination} />
            </label>
            <label>
              When a file already exists
              <select
                aria-label="Conflict policy"
                value={policy}
                onChange={(e) => setPolicy(e.target.value as typeof policy)}
              >
                <option value="skip">Skip existing files</option>
                <option value="replace">Replace existing files</option>
              </select>
            </label>
            <ul className="transfer-sources">
              {pending.sources.map((source) => (
                <li key={source}>{source}</li>
              ))}
            </ul>
            <div className="actions">
              <button type="button" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button className="primary">
                Start {pending.upload ? "upload" : "download"}
              </button>
            </div>
          </form>
        </div>
      )}
      {operation && (
        <div className="modal-backdrop">
          <form
            className="modal narrow"
            role="dialog"
            aria-modal="true"
            aria-label="File operation"
            onSubmit={(e) => {
              e.preventDefault();
              void action();
            }}
          >
            <h2>
              {operation.type === "delete"
                ? "Delete remote item?"
                : operation.type === "mkdir"
                  ? "New folder"
                  : "Rename item"}
            </h2>
            {operation.type === "delete" ? (
              <p>
                Permanently delete “{operation.value}”? Folders must be empty.
              </p>
            ) : (
              <label>
                Name
                <input
                  required
                  autoFocus
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
                className={operation.type === "delete" ? "danger" : "primary"}
                disabled={
                  !operation.value.trim() ||
                  operation.value === "." ||
                  operation.value === ".." ||
                  /[\\/]/.test(operation.value)
                }
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
                title="Close editor"
                onClick={() => {
                  if (confirm("Discard unsaved changes?")) setEdit(null);
                }}
              >
                <X size={16} />
              </button>
            </div>
            <p className="muted small">
              Saving replaces the remote file. Concurrent remote changes are not
              detected.
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
                onClick={() => {
                  if (confirm("Replace the remote file with this text?"))
                    void invoke("write_remote", { id, ...edit })
                      .then(() => setEdit(null))
                      .catch((e) => setError(errorText(e)));
                }}
              >
                Save to server
              </button>
            </div>
            {error && <p className="error">{error}</p>}
          </div>
        </div>
      )}
    </aside>
  );
}
