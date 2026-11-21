import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckSquare,
  Columns2,
  Copy,
  Download,
  ExternalLink,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Laptop,
  Pencil,
  RefreshCw,
  Search,
  Server,
  Shield,
  Trash2,
  Upload,
  X,
  Eye,
} from "lucide-react";
import type {
  DeleteBatchResult,
  FileEntry,
  LocalDirectory,
  LocalPlaces,
  RemoteDirectory,
} from "./types";
import { desktop, errorText, formatOctalPermissions } from "./types";

interface Progress {
  completedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
  skippedFiles: number;
  current: string;
  status: string;
  bytesPerSec?: number;
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
  skipped: number;
}

type SortKey = "name" | "size" | "modified";
interface SortState {
  key: SortKey;
  asc: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  isLocal: boolean;
  file: FileEntry | null;
}

const joinRemote = (base: string, name: string) =>
  `${base.replace(/\/$/, "")}/${name}`;

const parentRemote = (current: string) => {
  if (!current || current === "/" || current === ".") return "/";
  return current.replace(/\/[^/]+\/?$/, "") || "/";
};

const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1073741824
        ? `${(n / 1048576).toFixed(1)} MB`
        : `${(n / 1073741824).toFixed(2)} GB`;

const empty: Progress = {
  completedBytes: 0,
  totalBytes: 0,
  completedFiles: 0,
  totalFiles: 0,
  skippedFiles: 0,
  current: "",
  status: "idle",
  bytesPerSec: 0,
};

const dragTypeLocal = "application/x-shelldock-local-paths";
const dragTypeRemote = "application/x-shelldock-remote-paths";

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "pdf",
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "iso",
  "mp3",
  "mp4",
  "mkv",
  "avi",
  "mov",
  "wav",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "db",
  "sqlite",
]);

function isLikelyBinary(name: string): boolean {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? (lower.split(".").pop() ?? "") : "";
  return BINARY_EXTENSIONS.has(ext);
}

function sortEntries(entries: FileEntry[], sort: SortState): FileEntry[] {
  const factor = sort.asc ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    if (sort.key === "size") {
      return (a.size - b.size) * factor || a.name.localeCompare(b.name);
    }
    if (sort.key === "modified") {
      return (a.modified - b.modified) * factor || a.name.localeCompare(b.name);
    }
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) * factor;
  });
}

export default function FilesPane({
  id,
  active = true,
  refreshToken = 0,
  onTransfer,
  onOpenEditor,
  onOpenExternal,
}: {
  id: string | null;
  active?: boolean;
  refreshToken?: number;
  onTransfer?: (status: TransferStatus) => void;
  onOpenEditor?: (path: string) => void;
  onOpenExternal?: (path: string) => void;
}) {
  const [mode, setMode] = useState<"remote" | "local" | "both">(() => {
    const saved = localStorage.getItem("files.mode");
    return saved === "local" || saved === "remote" ? saved : "both";
  });
  const [width, setWidth] = useState(
    () => Number(localStorage.getItem("files.width")) || 560,
  );
  const [singleWidth, setSingleWidth] = useState(
    () => Number(localStorage.getItem("files.singleWidth")) || 340,
  );
  const [queuedCount, setQueuedCount] = useState(0);
  const queued = useRef<
      { batch: Pending; policy: "skip" | "replace"; verify: boolean }[]
    >([]),
    localRequest = useRef(0),
    remoteRequest = useRef(0);
  const [local, setLocal] = useState<LocalDirectory | null>(null),
    [places, setPlaces] = useState<LocalPlaces | null>(null),
    [remote, setRemote] = useState<FileEntry[]>([]),
    [path, setPath] = useState("."),
    [localInput, setLocalInput] = useState(""),
    [remoteInput, setRemoteInput] = useState(".");
  const [localBack, setLocalBack] = useState<string[]>([]),
    [localForward, setLocalForward] = useState<string[]>([]),
    [remoteBack, setRemoteBack] = useState<string[]>([]),
    [remoteForward, setRemoteForward] = useState<string[]>([]);
  const [localSelected, setLocalSelected] = useState<string[]>([]),
    [remoteSelected, setRemoteSelected] = useState<string[]>([]),
    [localFilter, setLocalFilter] = useState(""),
    [remoteFilter, setRemoteFilter] = useState(""),
    [localSort, setLocalSort] = useState<SortState>({ key: "name", asc: true }),
    [remoteSort, setRemoteSort] = useState<SortState>({
      key: "name",
      asc: true,
    }),
    [hidden, setHidden] = useState(
      () => localStorage.getItem("files.hidden") === "true",
    );
  const [verifyUploads, setVerifyUploads] = useState(
    () => localStorage.getItem("files.verifyUploads") !== "false",
  );
  const [confirmTransfers, setConfirmTransfers] = useState(
    () => localStorage.getItem("files.confirmTransfers") !== "false",
  );
  const [error, setError] = useState(""),
    [modalError, setModalError] = useState(""),
    [loading, setLoading] = useState(false),
    [pending, setPending] = useState<Pending | null>(null),
    [policy, setPolicy] = useState<"skip" | "replace">("replace"),
    [progress, setProgress] = useState<Progress>(empty),
    [dropZone, setDropZone] = useState<"local" | "remote" | null>(null),
    [dropFolder, setDropFolder] = useState<{
      side: "local" | "remote";
      path: string;
      name: string;
    } | null>(null),
    [transfersVisible, setTransfersVisible] = useState(true),
    [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [operation, setOperation] = useState<{
    type: "mkdir" | "mkfile" | "rename" | "delete" | "chmod";
    local?: boolean;
    paths?: string[];
    path: string;
    value: string;
  } | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    x: number;
    y: number;
    count: number;
    label: string;
    direction: "upload" | "download";
  } | null>(null);

  const localElement = useRef<HTMLDivElement>(null),
    remoteElement = useRef<HTMLDivElement>(null),
    job = useRef<string | null>(null),
    anchor = useRef<Record<string, string>>({}),
    mounted = useRef(true);

  const busy =
    progress.status === "planning" ||
    progress.status === "transferring" ||
    progress.status === "verifying";

  const snapshot = useRef({
    id,
    active,
    busy,
    path,
    localPath: "",
    blocked: false,
  });
  snapshot.current = {
    id,
    active,
    busy,
    path,
    localPath: local?.path ?? "",
    blocked: !!(pending || operation),
  };
  const dragHandlers = useRef({
    queueTransfer: (
      _sources: string[],
      _upload: boolean,
      _destination?: string,
    ) => {},
    copyExplorerToLocal: (_paths: string[], _targetDir: string) => {},
  });

  const transferCallback = useRef(onTransfer);
  transferCallback.current = onTransfer;
  useEffect(() => {
    transferCallback.current?.({
      status: progress.status,
      completed: progress.completedFiles,
      total: progress.totalFiles,
      queued: queuedCount,
      skipped: progress.skippedFiles,
    });
  }, [
    progress.status,
    progress.completedFiles,
    progress.totalFiles,
    progress.skippedFiles,
    queuedCount,
  ]);

  async function loadLocal(
    next?: string,
    historyMode: "push" | "back" | "forward" | "none" = "push",
  ) {
    const serial = ++localRequest.current;
    try {
      const prevPath = local?.path;
      const value = await invoke<LocalDirectory>("list_local", {
        path: next ?? null,
      });
      if (!mounted.current || serial !== localRequest.current) return;
      if (historyMode === "push" && prevPath && prevPath !== value.path) {
        setLocalBack((prev) => [...prev.slice(-30), prevPath]);
        setLocalForward([]);
      }
      setLocal(value);
      setLocalInput(value.path);
      setLocalSelected([]);
      localStorage.setItem("files.localPath", value.path);
    } catch (e) {
      if (mounted.current && serial === localRequest.current) {
        setLocalInput(local?.path ?? "");
        setError(errorText(e));
      }
    }
  }

  async function loadRemote(
    next = path,
    historyMode: "push" | "back" | "forward" | "none" = "push",
  ) {
    if (!id) return;
    const serial = ++remoteRequest.current;
    setLoading(true);
    try {
      const prevPath = path;
      const result = await invoke<RemoteDirectory | FileEntry[]>(
        "list_remote",
        {
          id,
          path: next,
        },
      );
      if (!mounted.current || serial !== remoteRequest.current) return;
      const resolvedPath = Array.isArray(result) ? next : result.path;
      const entries = Array.isArray(result) ? result : result.entries;
      if (
        historyMode === "push" &&
        prevPath &&
        prevPath !== "." &&
        prevPath !== resolvedPath
      ) {
        setRemoteBack((prev) => [...prev.slice(-30), prevPath]);
        setRemoteForward([]);
      }
      setRemote(entries);
      setPath(resolvedPath);
      setRemoteInput(resolvedPath);
      setRemoteSelected([]);
    } catch (e) {
      if (mounted.current && serial === remoteRequest.current) {
        setRemoteInput(path);
        setError(errorText(e));
      }
    } finally {
      if (mounted.current && serial === remoteRequest.current)
        setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    if (desktop) {
      void loadLocal(
        localStorage.getItem("files.localPath") || undefined,
        "none",
      );
      void invoke<LocalPlaces>("list_local_places")
        .then((p) => {
          if (mounted.current) setPlaces(p);
        })
        .catch(() => {});
    }
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
    setRemoteBack([]);
    setRemoteForward([]);
    setError("");
    if (id)
      void invoke<string>("remote_home", { id })
        .then((home) => {
          if (!disposed) void loadRemote(home, "none");
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
    if (id && refreshToken > 0) {
      void loadRemote(path, "none");
    }
  }, [refreshToken]);

  useEffect(() => {
    localStorage.setItem("files.mode", mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem("files.hidden", String(hidden));
  }, [hidden]);

  useEffect(() => {
    localStorage.setItem("files.verifyUploads", String(verifyUploads));
  }, [verifyUploads]);

  useEffect(() => {
    localStorage.setItem("files.confirmTransfers", String(confirmTransfers));
  }, [confirmTransfers]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!pending && !operation) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setPending(null);
        setOperation(null);
        setModalError("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, operation]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<string>("external-drag-error", (event) => {
      if (snapshot.current.active) setError(event.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Explorer native drops: Remote uploads or Local folder copies.
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const current = snapshot.current;
        if (!current.active || current.blocked) {
          setDropZone(null);
          setDropFolder(null);
          return;
        }
        const payload = event.payload;
        if (payload.type === "leave") {
          setDropZone(null);
          setDropFolder(null);
          return;
        }
        const x = payload.position.x / window.devicePixelRatio;
        const y = payload.position.y / window.devicePixelRatio;
        const hit = document.elementFromPoint(x, y);
        const insideRemote =
          Boolean(current.id) &&
          remoteElement.current &&
          hit?.closest(".remote-browser") === remoteElement.current;
        const insideLocal =
          Boolean(current.localPath) &&
          localElement.current &&
          hit?.closest(".local-browser") === localElement.current;

        const targetZone = insideRemote
          ? "remote"
          : insideLocal
            ? "local"
            : null;
        setDropZone(payload.type !== "drop" ? targetZone : null);

        if (payload.type !== "drop") {
          if (insideRemote) {
            const folderEl = hit?.closest<HTMLElement>(
              "[data-remote-directory]",
            );
            setDropFolder(
              folderEl?.dataset.remoteDirectory
                ? {
                    side: "remote",
                    path: folderEl.dataset.remoteDirectory,
                    name: folderEl.dataset.name || "",
                  }
                : null,
            );
          } else if (insideLocal) {
            const folderEl = hit?.closest<HTMLElement>(
              "[data-local-directory]",
            );
            setDropFolder(
              folderEl?.dataset.localDirectory
                ? {
                    side: "local",
                    path: folderEl.dataset.localDirectory,
                    name: folderEl.dataset.name || "",
                  }
                : null,
            );
          } else {
            setDropFolder(null);
          }
          return;
        }

        setDropZone(null);
        setDropFolder(null);
        if (!payload.paths.length) return;
        const uniquePaths = [...new Set(payload.paths)];

        if (insideRemote && current.id) {
          const target = hit?.closest<HTMLElement>("[data-remote-directory]")
            ?.dataset.remoteDirectory;
          dragHandlers.current.queueTransfer(
            uniquePaths,
            true,
            target || current.path,
          );
        } else if (insideLocal && current.localPath) {
          const target = hit?.closest<HTMLElement>("[data-local-directory]")
            ?.dataset.localDirectory;
          dragHandlers.current.copyExplorerToLocal(
            uniquePaths,
            target || current.localPath,
          );
        } else {
          setError(
            current.id
              ? "Drop files inside the Remote or Local file panel."
              : "Connect to a server before dropping files into Remote.",
          );
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => {
        if (!disposed)
          setError("Explorer drop handler could not start: " + errorText(e));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function copyExplorerToLocal(paths: string[], targetDir: string) {
    try {
      setError("");
      await invoke("local_action", {
        action: "copy",
        paths,
        name: targetDir,
      });
      await loadLocal(local?.path ?? targetDir, "none");
    } catch (e) {
      setError(errorText(e));
    }
  }
  dragHandlers.current = {
    queueTransfer,
    copyExplorerToLocal: (paths, targetDir) => {
      void copyExplorerToLocal(paths, targetDir);
    },
  };

  const visibleLocal = useMemo(() => {
    const filtered = (local?.entries ?? []).filter(
      (e) =>
        (hidden || !e.name.startsWith(".")) &&
        e.name.toLowerCase().includes(localFilter.toLowerCase()),
    );
    return sortEntries(filtered, localSort);
  }, [local, hidden, localFilter, localSort]);

  const visibleRemote = useMemo(() => {
    const filtered = remote.filter(
      (e) =>
        (hidden || !e.name.startsWith(".")) &&
        e.name.toLowerCase().includes(remoteFilter.toLowerCase()),
    );
    return sortEntries(filtered, remoteSort);
  }, [remote, hidden, remoteFilter, remoteSort]);

  // Prune hidden selections when filter or hidden toggle hides items.
  useEffect(() => {
    const allowed = new Set(visibleLocal.map((e) => e.path));
    setLocalSelected((prev) => {
      const next = prev.filter((p) => allowed.has(p));
      return next.length === prev.length ? prev : next;
    });
  }, [visibleLocal]);

  useEffect(() => {
    const allowed = new Set(visibleRemote.map((e) => e.path));
    setRemoteSelected((prev) => {
      const next = prev.filter((p) => allowed.has(p));
      return next.length === prev.length ? prev : next;
    });
  }, [visibleRemote]);

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

  function queueTransfer(
    sources: string[],
    upload: boolean,
    destination?: string,
  ) {
    if (!id || !sources.length) return;
    const dest = destination ?? (upload ? path : (local?.path ?? ""));
    if (!dest) return;
    setError("");
    const batch: Pending = { sources, destination: dest, upload };
    if (!confirmTransfers) {
      void enqueueOrRun(batch, policy, verifyUploads);
      return;
    }
    setPolicy("replace");
    setPending(batch);
  }

  async function enqueueOrRun(
    batch: Pending,
    selectedPolicy: "skip" | "replace",
    verify: boolean,
  ) {
    if (job.current) {
      queued.current.push({ batch, policy: selectedPolicy, verify });
      setQueuedCount(queued.current.length);
      return;
    }
    await executeBatch(batch, selectedPolicy, verify);
  }

  async function chooseUpload(directory = false) {
    try {
      const chosen = await open({ multiple: true, directory });
      if (chosen)
        queueTransfer(typeof chosen === "string" ? [chosen] : chosen, true);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function download(sources = remoteSelected) {
    try {
      if (!id || !sources.length) return;
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
      queueTransfer(sources, false, destination);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function startBatch() {
    if (!pending || !id) return;
    const nextBatch = pending;
    setPending(null);
    await enqueueOrRun(nextBatch, policy, verifyUploads);
  }

  async function executeBatch(
    batch: Pending,
    selectedPolicy: "skip" | "replace",
    verify: boolean,
  ) {
    const sessionId = snapshot.current.id;
    if (!sessionId) return;
    const request = {
      ...batch,
      policy: selectedPolicy,
      verify,
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
        void loadRemote(path, "none");
        if (local) void loadLocal(local.path, "none");
        if (failed) queued.current = [];
        const next = queued.current.shift();
        setQueuedCount(queued.current.length);
        if (next) void executeBatch(next.batch, next.policy, next.verify);
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
    if (!operation || (!operation.local && !id)) return;
    setModalError("");
    try {
      if (operation.local) {
        await invoke("local_action", {
          action: operation.type,
          paths:
            operation.type === "mkdir"
              ? [local!.path]
              : operation.paths || [operation.path],
          name:
            operation.type === "rename" || operation.type === "mkdir"
              ? operation.value.trim()
              : null,
        });
        setOperation(null);
        await loadLocal(local?.path, "none");
      } else if (operation.type === "delete") {
        const targets = operation.paths || [operation.path];
        if (targets.length > 1) {
          const result = await invoke<DeleteBatchResult>(
            "remote_delete_batch",
            {
              id,
              paths: targets,
            },
          );
          if (result.failed.length > 0) {
            const firstFew = result.failed
              .slice(0, 3)
              .map((f) => `${f.path}: ${f.error}`)
              .join("; ");
            setModalError(
              `Deleted ${result.deleted.length}, failed ${result.failed.length}: ${firstFew}`,
            );
            await loadRemote(path, "none");
            return;
          }
        } else {
          await invoke("remote_action", {
            id,
            action: "delete",
            path: targets[0],
            destination: null,
            mode: null,
          });
        }
        setOperation(null);
        await loadRemote(path, "none");
      } else {
        const trimmed = operation.value.trim();
        await invoke("remote_action", {
          id,
          action: operation.type,
          path:
            operation.type === "mkdir" || operation.type === "mkfile"
              ? joinRemote(path, trimmed)
              : operation.path,
          destination:
            operation.type === "rename" ? joinRemote(path, trimmed) : null,
          mode: operation.type === "chmod" ? Number.parseInt(trimmed, 8) : null,
        });
        setOperation(null);
        await loadRemote(path, "none");
      }
    } catch (e) {
      setModalError(errorText(e));
    }
  }

  function openRemoteItem(file: FileEntry) {
    if (file.directory) {
      void loadRemote(file.path);
      return;
    }
    if (isLikelyBinary(file.name)) {
      if (
        confirm(
          `“${file.name}” looks like a binary file (${bytes(file.size)}). Download it instead of opening in the editor?`,
        )
      ) {
        void download([file.path]);
        return;
      }
    }
    onOpenEditor?.(file.path);
  }

  function openLocalItem(file: FileEntry) {
    if (file.directory) {
      void loadLocal(file.path);
      return;
    }
    if (desktop) {
      void invoke("open_local_default", { path: file.path }).catch((e) =>
        setError(errorText(e)),
      );
    }
  }

  async function duplicateRemote(file: FileEntry) {
    if (!id || file.directory) return;
    const dot = file.name.lastIndexOf(".");
    const copyName =
      dot > 0
        ? `${file.name.slice(0, dot)} copy${file.name.slice(dot)}`
        : `${file.name} copy`;
    try {
      await invoke("remote_action", {
        id,
        action: "duplicate",
        path: file.path,
        destination: joinRemote(parentRemote(file.path), copyName),
        mode: null,
      });
      await loadRemote(path, "none");
    } catch (e) {
      setError(errorText(e));
    }
  }

  const selectedRemote = remote.find((e) => e.path === remoteSelected[0]);
  const typeahead = useRef({ side: "", text: "", time: 0 });
  const internalDrag = useRef<null | {
    source: "local" | "remote";
    x: number;
    y: number;
    paths: string[];
    moved: boolean;
    pointer: number;
    element: HTMLElement;
    externalStarted?: boolean;
  }>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);

  function requestOperation(
    type: "rename" | "delete" | "chmod",
    isLocal: boolean,
    explicitPaths?: string[],
  ) {
    const selected =
      explicitPaths ?? (isLocal ? localSelected : remoteSelected);
    const entries = isLocal ? local?.entries || [] : remote;
    if (
      !selected.length ||
      busy ||
      ((type === "rename" || type === "chmod") && selected.length !== 1)
    )
      return;
    const first = entries.find((f) => f.path === selected[0]);
    if (first) {
      setModalError("");
      setOperation({
        type,
        local: isLocal,
        paths: [...selected],
        path: first.path,
        value:
          type === "chmod"
            ? formatOctalPermissions(first.permissions).replace("—", "644")
            : selected.length === 1
              ? first.name
              : `${selected.length} items`,
      });
    }
  }

  function browserKey(
    e: KeyboardEvent,
    entries: FileEntry[],
    isLocal: boolean,
  ) {
    if (
      (e.target as HTMLElement).closest("input, textarea, select, button") ||
      pending ||
      operation
    )
      return;
    const selected = isLocal ? localSelected : remoteSelected;
    const update = isLocal ? setLocalSelected : setRemoteSelected;
    const index = Math.max(
      0,
      entries.findIndex((f) => f.path === selected[selected.length - 1]),
    );
    const focus = (file: FileEntry | undefined) => {
      if (!file) return;
      update([file.path]);
      anchor.current[isLocal ? "local" : "remote"] = file.path;
      const list = e.currentTarget;
      requestAnimationFrame(() => {
        const row = [
          ...list.querySelectorAll<HTMLElement>("[role=option]"),
        ].find((r) => r.dataset.path === file.path);
        row?.focus();
        row?.scrollIntoView({ block: "nearest" });
      });
    };
    if (e.key === "Delete") {
      e.preventDefault();
      requestOperation("delete", isLocal);
    } else if (e.key === "F2") {
      e.preventDefault();
      requestOperation("rename", isLocal);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      update(entries.map((f) => f.path));
    } else if (e.key === "Enter") {
      const file = entries[index];
      if (file) {
        e.preventDefault();
        if (isLocal) openLocalItem(file);
        else openRemoteItem(file);
      }
    } else if (e.key === "Backspace") {
      e.preventDefault();
      if (isLocal && local?.parent) void loadLocal(local.parent);
      else if (!isLocal && id && path !== "/")
        void loadRemote(parentRemote(path));
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      focus(
        entries[
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? entries.length - 1
              : Math.max(
                  0,
                  Math.min(
                    entries.length - 1,
                    index + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                )
        ],
      );
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const side = isLocal ? "local" : "remote",
        previous = typeahead.current;
      const key = e.key.toLocaleLowerCase();
      const repeated = previous.side === side && previous.text === key;
      const text =
        previous.side === side && Date.now() - previous.time < 900 && !repeated
          ? previous.text + key
          : key;
      typeahead.current = { side, text, time: Date.now() };
      const start = text.length === 1 ? index + 1 : index;
      const ordered = [...entries.slice(start), ...entries.slice(0, start)];
      focus(ordered.find((f) => f.name.toLocaleLowerCase().startsWith(text)));
    }
  }

  function resolveDropTarget(
    x: number,
    y: number,
    targetSide: "local" | "remote",
  ): { dir: string; folderName: string | null } | null {
    const hit = document.elementFromPoint(x, y);
    if (snapshot.current.blocked || !snapshot.current.id) return null;
    if (targetSide === "remote") {
      if (hit?.closest(".remote-browser") !== remoteElement.current)
        return null;
      const folderEl = hit?.closest<HTMLElement>("[data-remote-directory]");
      return {
        dir: folderEl?.dataset.remoteDirectory || snapshot.current.path,
        folderName: folderEl?.dataset.name || null,
      };
    }
    if (
      !snapshot.current.localPath ||
      hit?.closest(".local-browser") !== localElement.current
    )
      return null;
    const folderEl = hit?.closest<HTMLElement>("[data-local-directory]");
    return {
      dir: folderEl?.dataset.localDirectory || snapshot.current.localPath,
      folderName: folderEl?.dataset.name || null,
    };
  }

  function beginDrag(
    e: ReactPointerEvent<HTMLDivElement>,
    file: FileEntry,
    isLocal: boolean,
  ) {
    // Do not initiate drag on right-click, double-click, or disconnected session.
    if (e.button !== 0 || e.detail >= 2 || !id || file.symlink) return;
    const selected = isLocal ? localSelected : remoteSelected;
    internalDrag.current = {
      source: isLocal ? "local" : "remote",
      x: e.clientX,
      y: e.clientY,
      paths: selected.includes(file.path) ? [...selected] : [file.path],
      moved: false,
      pointer: e.pointerId,
      element: e.currentTarget,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function moveDrag(e: ReactPointerEvent<HTMLDivElement>) {
    const d = internalDrag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if ((e.buttons & 1) === 0) {
      endDrag(e);
      return;
    }
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    e.preventDefault();
    d.moved = true;
    setDragging(true);

    const firstLabel = d.paths[0].split(/[\\/]/).pop() || d.paths[0];
    setDragPreview({
      x: e.clientX,
      y: e.clientY,
      count: d.paths.length,
      label: d.paths.length === 1 ? firstLabel : `${d.paths.length} items`,
      direction: d.source === "local" ? "upload" : "download",
    });

    // If dragging remote items outside the window on desktop, switch to native Windows OLE drag.
    if (
      desktop &&
      d.source === "remote" &&
      !d.externalStarted &&
      (e.clientX <= 1 ||
        e.clientY <= 1 ||
        e.clientX >= window.innerWidth - 2 ||
        e.clientY >= window.innerHeight - 2)
    ) {
      d.externalStarted = true;
      const paths = [...d.paths];
      const roots = paths.map((p) => {
        const entry = remote.find((item) => item.path === p);
        return {
          path: p,
          directory: entry?.directory ?? true,
          size: entry?.size ?? 0,
        };
      });
      internalDrag.current = null;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (d.element.hasPointerCapture(d.pointer))
        d.element.releasePointerCapture(d.pointer);
      setDropZone(null);
      setDropFolder(null);
      setDragging(false);
      setDragPreview(null);
      if (id) {
        void invoke("start_external_drag", { id, paths, roots }).catch((err) =>
          setError(errorText(err)),
        );
      }
      return;
    }

    const targetSide = d.source === "local" ? "remote" : "local";
    const resolved = resolveDropTarget(e.clientX, e.clientY, targetSide);
    setDropZone(resolved ? targetSide : null);
    setDropFolder(
      resolved?.folderName
        ? { side: targetSide, path: resolved.dir, name: resolved.folderName }
        : null,
    );
  }

  function endDrag(e: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const d = internalDrag.current;
    if (!d) return;
    internalDrag.current = null;
    if (d.element.hasPointerCapture(d.pointer))
      d.element.releasePointerCapture(d.pointer);
    setDropZone(null);
    setDropFolder(null);
    setDragging(false);
    setDragPreview(null);
    if (d.moved) {
      suppressClick.current = true;
      const targetSide = d.source === "local" ? "remote" : "local";
      const resolved =
        !cancelled && resolveDropTarget(e.clientX, e.clientY, targetSide);
      if (resolved) {
        queueTransfer(d.paths, d.source === "local", resolved.dir);
      }
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    }
  }

  function toggleSort(isLocal: boolean, key: SortKey) {
    const updater = isLocal ? setLocalSort : setRemoteSort;
    updater((prev) =>
      prev.key === key ? { key, asc: !prev.asc } : { key, asc: true },
    );
  }

  function rows(entries: FileEntry[], isLocal: boolean) {
    const selected = isLocal ? localSelected : remoteSelected;
    return entries.map((file) => {
      const isDropFolder =
        dropFolder &&
        dropFolder.side === (isLocal ? "local" : "remote") &&
        dropFolder.path === file.path;
      return (
        <div
          key={file.path}
          data-path={file.path}
          data-name={file.name}
          role="option"
          aria-selected={selected.includes(file.path)}
          tabIndex={0}
          className={`browser-row ${selected.includes(file.path) ? "selected" : ""} ${isDropFolder ? "drop-folder-hover" : ""}`}
          data-remote-directory={
            !isLocal && file.directory ? file.path : undefined
          }
          data-local-directory={
            isLocal && file.directory ? file.path : undefined
          }
          draggable={!desktop && !file.symlink}
          onPointerDown={(e) => beginDrag(e, file, isLocal)}
          onPointerMove={moveDrag}
          onPointerUp={(e) => endDrag(e)}
          onPointerCancel={(e) => endDrag(e, true)}
          onDragStart={(e) => {
            const payload = JSON.stringify(
              selected.includes(file.path) ? selected : [file.path],
            );
            e.dataTransfer.setData(
              isLocal ? dragTypeLocal : dragTypeRemote,
              payload,
            );
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={(e) => {
            if (!suppressClick.current) select(e, file.path, entries, isLocal);
          }}
          onDoubleClick={() => {
            if (isLocal) openLocalItem(file);
            else openRemoteItem(file);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selected.includes(file.path)) {
              (isLocal ? setLocalSelected : setRemoteSelected)([file.path]);
              anchor.current[isLocal ? "local" : "remote"] = file.path;
            }
            setContextMenu({
              x: e.clientX,
              y: e.clientY,
              isLocal,
              file,
            });
          }}
        >
          {file.directory ? (
            <Folder size={15} className="folder-icon" />
          ) : (
            <File size={15} />
          )}
          <span className="browser-name" title={file.name}>
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
      );
    });
  }

  function columnHeaders(isLocal: boolean) {
    const sort = isLocal ? localSort : remoteSort;
    const mark = (k: SortKey) =>
      sort.key === k ? (sort.asc ? " ▲" : " ▼") : "";
    return (
      <div className="browser-columns">
        <button type="button" onClick={() => toggleSort(isLocal, "name")}>
          Name{mark("name")}
        </button>
        <button type="button" onClick={() => toggleSort(isLocal, "size")}>
          Size{mark("size")}
        </button>
        <button type="button" onClick={() => toggleSort(isLocal, "modified")}>
          Modified{mark("modified")}
        </button>
      </div>
    );
  }

  function goBack(isLocal: boolean) {
    if (isLocal) {
      const target = localBack.at(-1);
      if (!target || !local) return;
      setLocalBack((p) => p.slice(0, -1));
      setLocalForward((p) => [...p, local.path]);
      void loadLocal(target, "back");
    } else {
      const target = remoteBack.at(-1);
      if (!target) return;
      setRemoteBack((p) => p.slice(0, -1));
      setRemoteForward((p) => [...p, path]);
      void loadRemote(target, "back");
    }
  }

  function goForward(isLocal: boolean) {
    if (isLocal) {
      const target = localForward.at(-1);
      if (!target || !local) return;
      setLocalForward((p) => p.slice(0, -1));
      setLocalBack((p) => [...p, local.path]);
      void loadLocal(target, "forward");
    } else {
      const target = remoteForward.at(-1);
      if (!target) return;
      setRemoteForward((p) => p.slice(0, -1));
      setRemoteBack((p) => [...p, path]);
      void loadRemote(target, "forward");
    }
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
          title="Back"
          disabled={
            isLocal ? localBack.length === 0 : !id || remoteBack.length === 0
          }
          onClick={() => goBack(isLocal)}
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          title="Forward"
          disabled={
            isLocal
              ? localForward.length === 0
              : !id || remoteForward.length === 0
          }
          onClick={() => goForward(isLocal)}
        >
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          title={isLocal ? "Local home" : "Remote home"}
          disabled={!isLocal && !id}
          onClick={() => {
            if (isLocal) void loadLocal(places?.home);
            else
              void invoke<string>("remote_home", { id })
                .then((p) => loadRemote(p))
                .catch((e) => setError(errorText(e)));
          }}
        >
          <Home size={13} />
        </button>
        <button
          type="button"
          title={isLocal ? "Local parent folder" : "Remote parent folder"}
          disabled={isLocal ? !local?.parent : !id || path === "/"}
          onClick={() =>
            void (isLocal
              ? loadLocal(local!.parent!)
              : loadRemote(parentRemote(path)))
          }
        >
          <ArrowUp size={13} />
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

  const transferRatio =
    progress.totalBytes > 0
      ? progress.completedBytes / progress.totalBytes
      : progress.totalFiles > 0
        ? (progress.completedFiles + progress.skippedFiles) /
          progress.totalFiles
        : 0;

  return (
    <aside
      className={`file-manager mode-${mode} ${dragging ? "internal-dragging" : ""}`}
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
            const maxW = Math.max(
              mode === "both" ? 420 : 280,
              window.innerWidth - 520,
            );
            const next = Math.max(
              mode === "both" ? 420 : 280,
              Math.min(
                maxW,
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
            const maxW = Math.max(
              mode === "both" ? 420 : 280,
              window.innerWidth - 520,
            );
            const next = Math.max(
              mode === "both" ? 420 : 280,
              Math.min(maxW, initial + start - event.clientX),
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
          <section
            ref={localElement}
            className={`browser local-browser ${dropZone === "local" ? "drop-target" : ""}`}
            aria-label="Local files"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(dragTypeRemote) && id) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDropZone("local");
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDropZone(null);
                setDropFolder(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDropZone(null);
              setDropFolder(null);
              const value = e.dataTransfer.getData(dragTypeRemote);
              if (value && local) {
                const target = (e.target as HTMLElement).closest<HTMLElement>(
                  "[data-local-directory]",
                )?.dataset.localDirectory;
                queueTransfer(JSON.parse(value), false, target || local.path);
              }
            }}
          >
            <div className="browser-toolbar">
              <Laptop size={14} />
              <strong>Local</strong>
              {places && (
                <select
                  aria-label="Quick local places"
                  className="drive-select"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) void loadLocal(e.target.value);
                  }}
                >
                  <option value="">Places…</option>
                  {places.desktop && (
                    <option value={places.desktop}>Desktop</option>
                  )}
                  {places.downloads && (
                    <option value={places.downloads}>Downloads</option>
                  )}
                  {places.documents && (
                    <option value={places.documents}>Documents</option>
                  )}
                  <option value={places.home}>Home</option>
                  {places.drives.map((d) => (
                    <option key={d.path} value={d.path}>
                      {d.label} ({d.path})
                    </option>
                  ))}
                </select>
              )}
              <span className="spacer" />
              <button
                title="New local folder"
                disabled={!local || busy}
                onClick={() => {
                  setModalError("");
                  setOperation({
                    type: "mkdir",
                    local: true,
                    path: local?.path ?? "",
                    value: "New folder",
                  });
                }}
              >
                <FolderPlus size={15} />
              </button>
              <button
                title="Choose local folder"
                onClick={() => void chooseLocal()}
              >
                <FolderOpen size={15} />
              </button>
              <button
                title="Upload selection"
                disabled={!id || !localSelected.length}
                onClick={() => queueTransfer(localSelected, true)}
              >
                <Upload size={15} />
              </button>
              <button
                title="Refresh local files"
                onClick={() => void loadLocal(local?.path, "none")}
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
              {localFilter && (
                <button
                  type="button"
                  title="Clear filter"
                  onClick={() => setLocalFilter("")}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {columnHeaders(true)}
            <div
              className="browser-list"
              role="listbox"
              aria-label="Local directory"
              tabIndex={0}
              onKeyDown={(e) => browserKey(e, visibleLocal, true)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  isLocal: true,
                  file: null,
                });
              }}
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
            {dropZone === "local" && (
              <div className="drop-pill">
                <Download size={13} />
                <span>
                  {dropFolder?.side === "local"
                    ? `Drop into ${dropFolder.name}`
                    : "Drop to download / copy here"}
                </span>
              </div>
            )}
            <div className="browser-footer">
              <span>
                {localSelected.length
                  ? `${localSelected.length} selected`
                  : `${visibleLocal.length} items`}
              </span>
              <span className="spacer" />
              <button
                title="Select all local items"
                disabled={!visibleLocal.length}
                onClick={() =>
                  setLocalSelected(
                    localSelected.length === visibleLocal.length
                      ? []
                      : visibleLocal.map((f) => f.path),
                  )
                }
              >
                <CheckSquare size={12} />
              </button>
              <button
                title="Rename local item"
                disabled={localSelected.length !== 1 || busy}
                onClick={() => requestOperation("rename", true)}
              >
                Rename
              </button>
              <button
                title="Delete local items"
                disabled={!localSelected.length || busy}
                onClick={() => requestOperation("delete", true)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </section>
        )}
        {mode !== "local" && (
          <section
            className={`browser remote-browser ${dropZone === "remote" ? "drop-target" : ""}`}
            ref={remoteElement}
            aria-label="Remote files"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(dragTypeLocal) && id) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDropZone("remote");
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDropZone(null);
                setDropFolder(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDropZone(null);
              setDropFolder(null);
              const value = e.dataTransfer.getData(dragTypeLocal);
              if (value) {
                const target = (e.target as HTMLElement).closest<HTMLElement>(
                  "[data-remote-directory]",
                )?.dataset.remoteDirectory;
                queueTransfer(JSON.parse(value), true, target || path);
              }
            }}
          >
            <div className="browser-toolbar">
              <span className={`status-dot ${id ? "online" : ""}`} />
              <strong>{mode === "both" ? "Remote" : "SFTP"}</strong>
              <span className="spacer" />
              <button
                title="New remote file"
                disabled={!id || busy}
                onClick={() => {
                  setModalError("");
                  setOperation({
                    type: "mkfile",
                    path: "",
                    value: "new-file.yml",
                  });
                }}
              >
                <FilePlus size={15} />
              </button>
              <button
                title="New remote folder"
                disabled={!id || busy}
                onClick={() => {
                  setModalError("");
                  setOperation({
                    type: "mkdir",
                    path: "",
                    value: "New folder",
                  });
                }}
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
                onClick={() => void loadRemote(path, "none")}
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
              {remoteFilter && (
                <button
                  type="button"
                  title="Clear filter"
                  onClick={() => setRemoteFilter("")}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {columnHeaders(false)}
            <div
              className="browser-list"
              role="listbox"
              aria-label="Remote directory"
              tabIndex={0}
              onKeyDown={(e) => browserKey(e, visibleRemote, false)}
              onContextMenu={(e) => {
                if (!id) return;
                e.preventDefault();
                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  isLocal: false,
                  file: null,
                });
              }}
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
            {dropZone === "remote" && (
              <div className="drop-pill">
                <Upload size={13} />
                <span>
                  {dropFolder?.side === "remote"
                    ? `Drop to upload into ${dropFolder.name}`
                    : `Drop to upload into ${path}`}
                </span>
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
                title="Select all remote items"
                disabled={!id || !visibleRemote.length}
                onClick={() =>
                  setRemoteSelected(
                    remoteSelected.length === visibleRemote.length
                      ? []
                      : visibleRemote.map((f) => f.path),
                  )
                }
              >
                <CheckSquare size={12} />
              </button>
              <button
                title="View / Edit remote file"
                disabled={
                  !selectedRemote ||
                  selectedRemote.directory ||
                  remoteSelected.length !== 1 ||
                  busy
                }
                onClick={() => selectedRemote && openRemoteItem(selectedRemote)}
              >
                <Pencil size={13} />
              </button>
              <button
                title="Rename remote item"
                disabled={remoteSelected.length !== 1 || busy}
                onClick={() => requestOperation("rename", false)}
              >
                Rename
              </button>
              <button
                title="Delete remote item"
                disabled={!remoteSelected.length || busy}
                onClick={() => requestOperation("delete", false)}
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
          <Eye size={13} /> Hidden
        </button>
        <button
          aria-pressed={!confirmTransfers}
          title={
            confirmTransfers
              ? "Confirm before transferring (click for instant mode)"
              : "Instant transfer active (click to confirm first)"
          }
          onClick={() => setConfirmTransfers(!confirmTransfers)}
        >
          {confirmTransfers ? "Ask" : "Instant"}
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
                ? progress.completedFiles === 0 && progress.skippedFiles > 0
                  ? "No files transferred — all items skipped"
                  : progress.skippedFiles > 0
                    ? "Transfer finished with skipped files"
                    : verifyUploads
                      ? "Transfer complete — verified"
                      : "Transfer complete"
                : progress.status === "cancelled"
                  ? "Transfer cancelled"
                  : progress.status === "failed"
                    ? "Transfer failed"
                    : progress.status === "planning"
                      ? "Preparing transfer…"
                      : progress.status === "verifying"
                        ? "Verifying server contents…"
                        : "Transferring…"}
            </strong>
            <span className="spacer" />
            {busy ? (
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
            ) : (
              <button
                title="Dismiss transfer status"
                onClick={() => setProgress(empty)}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <progress max={1000} value={Math.round(transferRatio * 1000)} />
          <div>
            <span>
              {progress.completedFiles} / {progress.totalFiles} files ·{" "}
              {progress.skippedFiles} skipped
            </span>
            <span className="spacer" />
            {bytes(progress.completedBytes)} / {bytes(progress.totalBytes)}
            {busy && progress.bytesPerSec
              ? ` · ${bytes(progress.bytesPerSec)}/s`
              : ""}
          </div>
          <p title={progress.current}>{progress.current}</p>
        </div>
      )}
      {dragPreview && (
        <div
          className="drag-ghost"
          style={{ left: dragPreview.x + 14, top: dragPreview.y + 14 }}
        >
          {dragPreview.direction === "upload" ? (
            <Upload size={13} />
          ) : (
            <Download size={13} />
          )}
          <span>{dragPreview.label}</span>
        </div>
      )}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {contextMenu.isLocal ? (
            <>
              {contextMenu.file && (
                <>
                  <button
                    role="menuitem"
                    onClick={() => {
                      openLocalItem(contextMenu.file!);
                      setContextMenu(null);
                    }}
                  >
                    {contextMenu.file.directory
                      ? "Open Folder"
                      : "Open in Default App"}
                  </button>
                  <button
                    role="menuitem"
                    disabled={!id}
                    onClick={() => {
                      queueTransfer(
                        localSelected.length
                          ? localSelected
                          : [contextMenu.file!.path],
                        true,
                      );
                      setContextMenu(null);
                    }}
                  >
                    <Upload size={13} /> Upload to Server
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      void invoke("reveal_local", {
                        path: contextMenu.file!.path,
                      }).catch((e) => setError(errorText(e)));
                      setContextMenu(null);
                    }}
                  >
                    Reveal in Explorer
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      void navigator.clipboard?.writeText(
                        contextMenu.file!.path,
                      );
                      setContextMenu(null);
                    }}
                  >
                    <Copy size={13} /> Copy Path
                  </button>
                  <hr />
                  <button
                    role="menuitem"
                    disabled={localSelected.length !== 1 || busy}
                    onClick={() => {
                      requestOperation("rename", true, [
                        contextMenu.file!.path,
                      ]);
                      setContextMenu(null);
                    }}
                  >
                    Rename…
                  </button>
                  <button
                    role="menuitem"
                    className="danger-item"
                    disabled={busy}
                    onClick={() => {
                      requestOperation(
                        "delete",
                        true,
                        localSelected.length
                          ? localSelected
                          : [contextMenu.file!.path],
                      );
                      setContextMenu(null);
                    }}
                  >
                    <Trash2 size={13} /> Delete…
                  </button>
                </>
              )}
              {!contextMenu.file && (
                <>
                  <button
                    role="menuitem"
                    disabled={!local || busy}
                    onClick={() => {
                      setModalError("");
                      setOperation({
                        type: "mkdir",
                        local: true,
                        path: local?.path ?? "",
                        value: "New folder",
                      });
                      setContextMenu(null);
                    }}
                  >
                    <FolderPlus size={13} /> New Folder…
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setLocalSelected(visibleLocal.map((f) => f.path));
                      setContextMenu(null);
                    }}
                  >
                    Select All
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      void loadLocal(local?.path, "none");
                      setContextMenu(null);
                    }}
                  >
                    Refresh
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              {contextMenu.file && (
                <>
                  {contextMenu.file.directory ? (
                    <button
                      role="menuitem"
                      onClick={() => {
                        void loadRemote(contextMenu.file!.path);
                        setContextMenu(null);
                      }}
                    >
                      Open Folder
                    </button>
                  ) : (
                    <>
                      <button
                        role="menuitem"
                        onClick={() => {
                          onOpenEditor?.(contextMenu.file!.path);
                          setContextMenu(null);
                        }}
                      >
                        <Pencil size={13} /> View / Edit in ShellDock
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          onOpenExternal?.(contextMenu.file!.path);
                          setContextMenu(null);
                        }}
                      >
                        <ExternalLink size={13} /> Open in Default App
                        (Auto-Sync)
                      </button>
                    </>
                  )}
                  <button
                    role="menuitem"
                    onClick={() => {
                      const targets = remoteSelected.length
                        ? remoteSelected
                        : [contextMenu.file!.path];
                      void download(targets);
                      setContextMenu(null);
                    }}
                  >
                    <Download size={13} /> Download
                  </button>
                  {!contextMenu.file.directory && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        void duplicateRemote(contextMenu.file!);
                        setContextMenu(null);
                      }}
                    >
                      Duplicate
                    </button>
                  )}
                  <button
                    role="menuitem"
                    onClick={() => {
                      void navigator.clipboard?.writeText(
                        contextMenu.file!.path,
                      );
                      setContextMenu(null);
                    }}
                  >
                    <Copy size={13} /> Copy Path
                  </button>
                  <button
                    role="menuitem"
                    disabled={remoteSelected.length !== 1 || busy}
                    onClick={() => {
                      requestOperation("chmod", false, [
                        contextMenu.file!.path,
                      ]);
                      setContextMenu(null);
                    }}
                  >
                    <Shield size={13} /> Permissions…
                  </button>
                  <hr />
                  <button
                    role="menuitem"
                    disabled={remoteSelected.length !== 1 || busy}
                    onClick={() => {
                      requestOperation("rename", false, [
                        contextMenu.file!.path,
                      ]);
                      setContextMenu(null);
                    }}
                  >
                    Rename…
                  </button>
                  <button
                    role="menuitem"
                    className="danger-item"
                    disabled={busy}
                    onClick={() => {
                      requestOperation(
                        "delete",
                        false,
                        remoteSelected.length
                          ? remoteSelected
                          : [contextMenu.file!.path],
                      );
                      setContextMenu(null);
                    }}
                  >
                    <Trash2 size={13} /> Delete…
                  </button>
                </>
              )}
              {!contextMenu.file && (
                <>
                  <button
                    role="menuitem"
                    disabled={!id || busy}
                    onClick={() => {
                      setModalError("");
                      setOperation({
                        type: "mkfile",
                        path: "",
                        value: "new-file.yml",
                      });
                      setContextMenu(null);
                    }}
                  >
                    <FilePlus size={13} /> New File…
                  </button>
                  <button
                    role="menuitem"
                    disabled={!id || busy}
                    onClick={() => {
                      setModalError("");
                      setOperation({
                        type: "mkdir",
                        path: "",
                        value: "New folder",
                      });
                      setContextMenu(null);
                    }}
                  >
                    <FolderPlus size={13} /> New Folder…
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setRemoteSelected(visibleRemote.map((f) => f.path));
                      setContextMenu(null);
                    }}
                  >
                    Select All
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      void loadRemote(path, "none");
                      setContextMenu(null);
                    }}
                  >
                    Refresh
                  </button>
                </>
              )}
            </>
          )}
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
              <input
                value={pending.destination}
                onChange={(e) =>
                  setPending({ ...pending, destination: e.target.value })
                }
              />
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
            {pending.upload && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={verifyUploads}
                  onChange={(e) => setVerifyUploads(e.target.checked)}
                />{" "}
                Verify uploaded bytes after transfer (slower)
              </label>
            )}
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
                ? `Delete ${operation.local ? "local" : "remote"} ${operation.paths && operation.paths.length > 1 ? "items" : "item"}?`
                : operation.type === "mkdir"
                  ? "New folder"
                  : operation.type === "mkfile"
                    ? "New file"
                    : operation.type === "chmod"
                      ? "Permissions (chmod)"
                      : "Rename item"}
            </h2>
            {operation.type === "delete" ? (
              <p>
                Permanently delete “{operation.value}”? Folders and all nested
                contents will be removed.
              </p>
            ) : (
              <label>
                {operation.type === "chmod"
                  ? "Octal mode (e.g. 644, 755)"
                  : "Name"}
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
            {modalError && (
              <p className="error" role="alert">
                {modalError}
              </p>
            )}
            <div className="actions">
              <button
                type="button"
                onClick={() => {
                  setOperation(null);
                  setModalError("");
                }}
              >
                Cancel
              </button>
              <button
                className={operation.type === "delete" ? "danger" : "primary"}
                disabled={
                  operation.type !== "delete" &&
                  (operation.type === "chmod"
                    ? !/^[0-7]{3,4}$/.test(operation.value.trim())
                    : !operation.value.trim() ||
                      operation.value === "." ||
                      operation.value === ".." ||
                      /[\\/]/.test(operation.value))
                }
              >
                Confirm
              </button>
            </div>
          </form>
        </div>
      )}
    </aside>
  );
}
