import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Terminal,
  Plus,
  Search,
  Server,
  Star,
  ChevronRight,
  ChevronDown,
  Folder,
  Settings,
  X,
  PanelRight,
  SquareTerminal,
  Pencil,
  Trash2,
  ArrowDownUp,
  Zap,
  KeyRound,
  FileCode,
  Columns2,
} from "lucide-react";
import TerminalPane from "./TerminalPane";
import FilesPane, { type TransferStatus } from "./FilesPane";
import RemoteEditor from "./RemoteEditor";
import type {
  Connection,
  EditorDocument,
  ExternalEditEvent,
  RemoteTextFile,
  SessionTab,
  TestConnectionResult,
  WriteResult,
} from "./types";
import { desktop, errorText } from "./types";

interface ExtendedSessionTab extends SessionTab {
  initialSecret?: string;
}

const blank = (): Connection => ({
  id: crypto.randomUUID(),
  name: "",
  host: "",
  port: 22,
  username: "",
  auth: "password",
  privateKey: "",
  group: "Ungrouped",
  notes: "",
  favorite: false,
});

export default function App() {
  const [connections, setConnections] = useState<Connection[]>([]),
    [savedCredentials, setSavedCredentials] = useState<Set<string>>(
      () => new Set(),
    ),
    [tabs, setTabs] = useState<ExtendedSessionTab[]>([]),
    [active, setActive] = useState(""),
    [sessions, setSessions] = useState<Record<string, string | null>>({}),
    [query, setQuery] = useState(""),
    [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(
      () => {
        try {
          return JSON.parse(
            localStorage.getItem("sidebar.collapsedGroups") || "{}",
          );
        } catch {
          return {};
        }
      },
    ),
    [editing, setEditing] = useState<Connection | null>(null),
    [editingSecret, setEditingSecret] = useState(""),
    [clearSavedSecret, setClearSavedSecret] = useState(false),
    [testResult, setTestResult] = useState<TestConnectionResult | null>(null),
    [testingConn, setTestingConn] = useState(false),
    [modalError, setModalError] = useState(""),
    [quickOpen, setQuickOpen] = useState(false),
    [quickForm, setQuickForm] = useState({
      host: "",
      port: 22,
      username: "",
      password: "",
      saveConnection: false,
    }),
    [deleteCandidate, setDeleteCandidate] = useState<Connection | null>(null),
    [closeTabConfirm, setCloseTabConfirm] = useState<string | null>(null),
    [discardEditorConfirm, setDiscardEditorConfirm] = useState<{
      tabKey: string;
      doc: EditorDocument;
    } | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [files, setFiles] = useState(true),
    [settings, setSettings] = useState(false),
    [saving, setSaving] = useState(false),
    [selectedConnection, setSelectedConnection] = useState(""),
    [sidebarMenu, setSidebarMenu] = useState<{
      x: number;
      y: number;
      connection: Connection;
    } | null>(null),
    [tabMenu, setTabMenu] = useState<{
      x: number;
      y: number;
      tab: ExtendedSessionTab;
    } | null>(null);

  const [transferInfo, setTransferInfo] = useState<
      Record<string, TransferStatus>
    >({}),
    [showTransfers, setShowTransfers] = useState(false),
    [editorsByTab, setEditorsByTab] = useState<
      Record<string, EditorDocument[]>
    >({}),
    [activeViewByTab, setActiveViewByTab] = useState<Record<string, string>>(
      {},
    ),
    [splitByTab, setSplitByTab] = useState<Record<string, boolean>>({}),
    [refreshTokens, setRefreshTokens] = useState<Record<string, number>>({});

  async function reload() {
    if (!desktop) return;
    const [list, creds] = await Promise.all([
      invoke<Connection[]>("list_connections"),
      invoke<string[]>("list_saved_credentials").catch(() => []),
    ]);
    setConnections(list);
    setSavedCredentials(new Set(creds));
  }

  useEffect(() => {
    void reload().catch((e) => setError(errorText(e)));
  }, []);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | undefined;
    void listen<ExternalEditEvent>("remote-edit-event", (event) => {
      const payload = event.payload;
      const filename = payload.path.split("/").pop() || payload.path;
      if (payload.status === "synced") {
        setNotice(`Synced “${filename}” to server.`);
        setRefreshTokens((prev) => {
          const next = { ...prev };
          for (const [tabKey, sessId] of Object.entries(sessionsRef.current)) {
            if (sessId === payload.sessionId) {
              next[tabKey] = (next[tabKey] ?? 0) + 1;
            }
          }
          return next;
        });
      } else if (payload.message) {
        setError(`Auto-sync failed for “${filename}”: ${payload.message}`);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    localStorage.setItem(
      "sidebar.collapsedGroups",
      JSON.stringify(collapsedGroups),
    );
  }, [collapsedGroups]);

  useEffect(() => {
    if (!sidebarMenu && !tabMenu) return;
    const dismiss = () => {
      setSidebarMenu(null);
      setTabMenu(null);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [sidebarMenu, tabMenu]);

  useEffect(() => {
    function key(e: KeyboardEvent) {
      const inEditorOrTerm = Boolean(
        (e.target as HTMLElement | null)?.closest(".cm-editor, .terminal-host"),
      );
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setModalError("");
        setQuickOpen(true);
        return;
      }
      if (!inEditorOrTerm && e.ctrlKey && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        openEditorModal(blank());
        return;
      }
      if (!inEditorOrTerm && e.ctrlKey && e.key === "k") {
        e.preventDefault();
        document.getElementById("server-search")?.focus();
        return;
      }
      if (e.key === "Escape") {
        if (discardEditorConfirm) setDiscardEditorConfirm(null);
        else if (closeTabConfirm) setCloseTabConfirm(null);
        else if (deleteCandidate) setDeleteCandidate(null);
        else if (quickOpen) {
          setQuickOpen(false);
          setModalError("");
        } else if (editing) closeConnectionModal();
        else if (settings) setSettings(false);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [
    discardEditorConfirm,
    closeTabConfirm,
    deleteCandidate,
    quickOpen,
    editing,
    settings,
  ]);

  function openEditorModal(c: Connection) {
    setEditing({ ...c });
    setEditingSecret("");
    setClearSavedSecret(false);
    setTestResult(null);
    setModalError("");
  }

  function closeConnectionModal() {
    setEditing(null);
    setEditingSecret("");
    setClearSavedSecret(false);
    setTestResult(null);
    setModalError("");
  }

  function openConnection(
    connection: Connection,
    forceNewTab = false,
    initialSecret?: string,
  ) {
    if (!forceNewTab) {
      const existing = tabs.find((t) => t.connection.id === connection.id);
      if (existing) {
        setActive(existing.key);
        return;
      }
    }
    const key = crypto.randomUUID();
    setTabs((prev) => [...prev, { key, connection, initialSecret }]);
    setActiveViewByTab((prev) => ({ ...prev, [key]: "terminal" }));
    setActive(key);
  }

  function requestCloseTab(key: string) {
    const tInfo = transferInfo[key];
    const hasBusyTransfer =
      tInfo &&
      (tInfo.status === "planning" ||
        tInfo.status === "transferring" ||
        tInfo.status === "verifying" ||
        tInfo.queued > 0);
    const hasUnsavedEditors = (editorsByTab[key] ?? []).some(
      (d) => d.text !== d.savedText,
    );
    if (hasBusyTransfer || hasUnsavedEditors) {
      setCloseTabConfirm(key);
      return;
    }
    forceCloseTab(key);
  }

  function forceCloseTab(key: string) {
    setCloseTabConfirm(null);
    setTransferInfo((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    setEditorsByTab((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setActiveViewByTab((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setSplitByTab((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      if (active === key) setActive(next.at(-1)?.key ?? "");
      return next;
    });
    setSessions((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function saveConnection() {
    if (!editing) return;
    setSaving(true);
    setModalError("");
    try {
      await invoke("save_connection", { connection: editing });
      if (editingSecret) {
        await invoke("save_credential", {
          id: editing.id,
          secret: editingSecret,
        });
      } else if (clearSavedSecret) {
        await invoke("delete_credential", { id: editing.id });
      }
      setTabs((prev) =>
        prev.map((t) =>
          t.connection.id === editing.id ? { ...t, connection: editing } : t,
        ),
      );
      await reload();
      closeConnectionModal();
    } catch (e) {
      setModalError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  async function runTestConnection() {
    if (!editing) return;
    setTestingConn(true);
    setModalError("");
    setTestResult(null);
    try {
      const res = await invoke<TestConnectionResult>("test_connection", {
        connection: editing,
        secret: editingSecret,
      });
      setTestResult(res);
    } catch (e) {
      setModalError(errorText(e));
    } finally {
      setTestingConn(false);
    }
  }

  async function confirmDeleteConnection() {
    if (!deleteCandidate) return;
    const target = deleteCandidate;
    setDeleteCandidate(null);
    try {
      await invoke("delete_connection", { id: target.id });
      if (selectedConnection === target.id) setSelectedConnection("");
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function duplicateConnection(c: Connection) {
    const copy: Connection = {
      ...c,
      id: crypto.randomUUID(),
      name: `${c.name} Copy`,
    };
    try {
      await invoke("save_connection", { connection: copy });
      await reload();
      openEditorModal(copy);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function toggleFavorite(c: Connection) {
    try {
      await invoke("save_connection", {
        connection: { ...c, favorite: !c.favorite },
      });
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function submitQuickConnect() {
    setModalError("");
    const host = quickForm.host.trim();
    const username = quickForm.username.trim();
    if (!host || !username) {
      setModalError("Host and username are required.");
      return;
    }
    const conn: Connection = {
      id: crypto.randomUUID(),
      name: `${username}@${host}`,
      host,
      port: quickForm.port || 22,
      username,
      auth: "password",
      privateKey: "",
      group: "Quick Connect",
      notes: "",
      favorite: false,
    };
    if (quickForm.saveConnection && desktop) {
      try {
        await invoke("save_connection", { connection: conn });
        if (quickForm.password) {
          await invoke("save_credential", {
            id: conn.id,
            secret: quickForm.password,
          });
        }
        await reload();
      } catch (e) {
        setModalError(errorText(e));
        return;
      }
    }
    setQuickOpen(false);
    openConnection(conn, true, quickForm.password);
    setQuickForm({
      host: "",
      port: 22,
      username: "",
      password: "",
      saveConnection: false,
    });
  }

  async function openRemoteEditor(
    tabKey: string,
    remotePath: string,
    previewMode?: "head" | "tail",
  ) {
    const sessId = sessions[tabKey];
    if (!sessId) return;
    const existing = (editorsByTab[tabKey] ?? []).find(
      (d) => d.path === remotePath,
    );
    if (existing && !previewMode) {
      setActiveViewByTab((prev) => ({ ...prev, [tabKey]: existing.key }));
      return;
    }
    try {
      const file = await invoke<RemoteTextFile | string>("read_remote", {
        id: sessId,
        path: remotePath,
        previewMode: previewMode ?? null,
      });
      const data: RemoteTextFile =
        typeof file === "string"
          ? {
              path: remotePath,
              text: file,
              mtime: null,
              size: file.length,
              permissions: null,
              readOnly: false,
              readOnlyReason: null,
              truncated: false,
              previewMode: null,
              lossyUtf8: false,
              binary: false,
              lineEnding: "LF",
            }
          : file;

      if (data.binary) {
        setError(`“${remotePath.split("/").pop()}” contains binary data.`);
        return;
      }

      const docKey = existing?.key ?? crypto.randomUUID();
      const doc: EditorDocument = {
        key: docKey,
        path: data.path,
        name: data.path.split("/").pop() || data.path,
        text: data.text,
        savedText: data.text,
        mtime: data.mtime,
        size: data.size,
        permissions: data.permissions,
        readOnly: data.readOnly,
        readOnlyReason: data.readOnlyReason,
        truncated: data.truncated,
        previewMode:
          data.previewMode === "head" || data.previewMode === "tail"
            ? data.previewMode
            : null,
        lossyUtf8: data.lossyUtf8,
        lineEnding: data.lineEnding,
        conflict: null,
        saving: false,
        error: null,
      };
      setEditorsByTab((prev) => {
        const list = prev[tabKey] ?? [];
        const updated = existing
          ? list.map((d) => (d.key === existing.key ? doc : d))
          : [...list, doc];
        return { ...prev, [tabKey]: updated };
      });
      setActiveViewByTab((prev) => ({ ...prev, [tabKey]: docKey }));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function saveRemoteEditor(
    tabKey: string,
    doc: EditorDocument,
    force = false,
  ): Promise<boolean> {
    const sessId = sessions[tabKey];
    if (!sessId || doc.readOnly) return false;
    setEditorsByTab((prev) => ({
      ...prev,
      [tabKey]: (prev[tabKey] ?? []).map((d) =>
        d.key === doc.key
          ? { ...d, saving: true, error: null, conflict: null }
          : d,
      ),
    }));
    try {
      const result = await invoke<WriteResult | void>("write_remote", {
        id: sessId,
        path: doc.path,
        text: doc.text,
        expectedMtime: doc.mtime,
        force,
      });
      setEditorsByTab((prev) => ({
        ...prev,
        [tabKey]: (prev[tabKey] ?? []).map((d) =>
          d.key === doc.key
            ? {
                ...d,
                saving: false,
                savedText: doc.text,
                mtime: result ? result.mtime : d.mtime,
                size: result ? result.size : doc.text.length,
                conflict: null,
                error: null,
              }
            : d,
        ),
      }));
      setRefreshTokens((prev) => ({
        ...prev,
        [tabKey]: (prev[tabKey] ?? 0) + 1,
      }));
      setNotice(`Saved “${doc.name}” to server.`);
      return true;
    } catch (e) {
      const msg = errorText(e);
      const isConflict = msg.startsWith("CONFLICT:");
      setEditorsByTab((prev) => ({
        ...prev,
        [tabKey]: (prev[tabKey] ?? []).map((d) =>
          d.key === doc.key
            ? {
                ...d,
                saving: false,
                conflict: isConflict ? msg.replace("CONFLICT:", "") : null,
                error: isConflict ? null : msg,
              }
            : d,
        ),
      }));
      return false;
    }
  }

  function closeRemoteEditor(tabKey: string, doc: EditorDocument) {
    if (doc.text !== doc.savedText) {
      setDiscardEditorConfirm({ tabKey, doc });
      return;
    }
    forceCloseRemoteEditor(tabKey, doc.key);
  }

  function forceCloseRemoteEditor(tabKey: string, docKey: string) {
    setDiscardEditorConfirm(null);
    setEditorsByTab((prev) => {
      const remaining = (prev[tabKey] ?? []).filter((d) => d.key !== docKey);
      return { ...prev, [tabKey]: remaining };
    });
    setActiveViewByTab((prev) => {
      if (prev[tabKey] !== docKey) return prev;
      const remaining = (editorsByTab[tabKey] ?? []).filter(
        (d) => d.key !== docKey,
      );
      return {
        ...prev,
        [tabKey]: remaining.at(-1)?.key ?? "terminal",
      };
    });
  }

  async function openExternalEditor(tabKey: string, remotePath: string) {
    const sessId = sessions[tabKey];
    if (!sessId) return;
    try {
      await invoke("open_remote_external", { id: sessId, path: remotePath });
      setNotice(
        `Opened “${remotePath.split("/").pop()}” in default app. Saves will auto-sync to server.`,
      );
    } catch (e) {
      setError(errorText(e));
    }
  }

  const filtered = connections.filter((c) =>
    `${c.name} ${c.host} ${c.username} ${c.group}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const favorites = filtered
    .filter((c) => c.favorite)
    .sort((a, b) => a.name.localeCompare(b.name));
  const groups = [
    ...new Set(filtered.map((c) => c.group || "Ungrouped")),
  ].sort();
  const current = tabs.find((t) => t.key === active);

  function renderConnectionRow(c: Connection, keyPrefix = "") {
    const isChosen = (selectedConnection || current?.connection.id) === c.id;
    const isOpen = tabs.some((t) => t.connection.id === c.id);
    return (
      <div
        className={`connection-row ${isChosen ? "chosen" : ""}`}
        key={`${keyPrefix}${c.id}`}
        onContextMenu={(e) => {
          e.preventDefault();
          setSelectedConnection(c.id);
          setSidebarMenu({ x: e.clientX, y: e.clientY, connection: c });
        }}
      >
        <button
          className="connection-open"
          onClick={() => setSelectedConnection(c.id)}
          onDoubleClick={(e) => openConnection(c, e.shiftKey)}
          onKeyDown={(e) => {
            if (e.key === "Enter") openConnection(c, e.shiftKey);
          }}
        >
          <Server size={16} />
          <span className="connection-info">
            <strong>{c.name}</strong>
            <small>
              {c.username}@{c.host}
            </small>
          </span>
          {isOpen && <span className="status-dot online" title="Open in tab" />}
          {c.favorite && <Star size={11} className="fav-star" />}
        </button>
        <div className="row-actions">
          <button title="Edit connection" onClick={() => openEditorModal(c)}>
            <Pencil size={12} />
          </button>
          <button
            title="Delete connection"
            onClick={() => setDeleteCandidate(c)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <Terminal size={22} />
          </div>
          <strong>ShellDock</strong>
          <span className="platform-tag">WINDOWS</span>
        </div>
        <div className="sidebar-heading">
          <span>WORKSPACE</span>
          <button
            title="New connection (Ctrl+N)"
            onClick={() => openEditorModal(blank())}
          >
            <Plus size={17} />
          </button>
        </div>
        <div className="server-search">
          <Search size={15} />
          <input
            id="server-search"
            aria-label="Search servers"
            placeholder="Search Servers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>⌃ K</kbd>
        </div>
        <div className="server-count">
          <Server size={15} />
          <span>All servers</span>
          <span className="count">{connections.length}</span>
        </div>
        <nav className="connections" aria-label="Saved servers">
          {favorites.length > 0 && (
            <div>
              <button
                type="button"
                className="group-title"
                onClick={() =>
                  setCollapsedGroups((p) => ({
                    ...p,
                    __favorites: !p.__favorites,
                  }))
                }
              >
                {collapsedGroups.__favorites ? (
                  <ChevronRight size={12} />
                ) : (
                  <ChevronDown size={12} />
                )}
                <Star size={12} />
                <span>Favorites</span>
                <span className="spacer" />
                <span>{favorites.length}</span>
              </button>
              {!collapsedGroups.__favorites &&
                favorites.map((c) => renderConnectionRow(c, "fav-"))}
            </div>
          )}
          {groups.map((group) => {
            const items = filtered
              .filter((c) => (c.group || "Ungrouped") === group)
              .sort(
                (a, b) =>
                  Number(b.favorite) - Number(a.favorite) ||
                  a.name.localeCompare(b.name),
              );
            const collapsed = Boolean(collapsedGroups[group]);
            return (
              <div key={group}>
                <button
                  type="button"
                  className="group-title"
                  onClick={() =>
                    setCollapsedGroups((p) => ({ ...p, [group]: !p[group] }))
                  }
                >
                  {collapsed ? (
                    <ChevronRight size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                  <Folder size={13} />
                  <span>{group}</span>
                  <span className="spacer" />
                  <span>{items.length}</span>
                </button>
                {!collapsed && items.map((c) => renderConnectionRow(c))}
              </div>
            );
          })}
          {connections.length === 0 && (
            <div className="sidebar-empty">
              <p>No saved servers yet.</p>
              <button onClick={() => openEditorModal(blank())}>
                Add your first server <Plus size={13} />
              </button>
            </div>
          )}
        </nav>
        <div className="sidebar-actions">
          <button
            className="add-server"
            onClick={() => openEditorModal(blank())}
          >
            <Plus size={15} /> New connection <kbd>Ctrl N</kbd>
          </button>
          <button
            className="add-server quick-btn"
            onClick={() => {
              setModalError("");
              setQuickOpen(true);
            }}
          >
            <Zap size={14} /> Quick connect
          </button>
        </div>
        <div className="sidebar-footer">
          <button onClick={() => setSettings(true)}>
            <Settings size={16} /> Settings & about
          </button>
          <span className="small muted">v0.2.3 · Windows</span>
        </div>
      </aside>
      <main className="main">
        <header className="workspace-header">
          <div>
            <Terminal size={16} />
            <strong>{current?.connection.name ?? "ShellDock"}</strong>
          </div>
          <span className="spacer" />
          <button
            aria-label="Show all transfers"
            title="Transfers"
            onClick={() => setShowTransfers(!showTransfers)}
          >
            <ArrowDownUp size={16} />
            <span>Transfers</span>
            {Object.values(transferInfo).some(
              (t) =>
                t.status === "planning" ||
                t.status === "transferring" ||
                t.status === "verifying" ||
                t.queued > 0,
            ) && <span className="status-dot online" />}
          </button>
          <button
            title="Quick connect (Ctrl+Shift+N)"
            onClick={() => {
              setModalError("");
              setQuickOpen(true);
            }}
          >
            <Zap size={16} />
          </button>
          <button
            title="New connection (Ctrl+N)"
            onClick={() => openEditorModal(blank())}
          >
            <Plus size={17} />
          </button>
          <button title="Settings" onClick={() => setSettings(true)}>
            <Settings size={17} />
          </button>
          <button
            title="Toggle SFTP panel"
            disabled={!current}
            className={files ? "toggled" : ""}
            onClick={() => setFiles(!files)}
          >
            <PanelRight size={17} />
            <span>Files</span>
          </button>
        </header>
        {showTransfers && (
          <section
            className="transfers-popover"
            role="dialog"
            aria-label="Transfers"
          >
            <div className="file-manager-title">
              <ArrowDownUp size={15} />
              <strong>Transfers</strong>
              <span className="spacer" />
              <button
                title="Close transfers"
                onClick={() => setShowTransfers(false)}
              >
                <X size={15} />
              </button>
            </div>
            {tabs
              .filter(
                (t) =>
                  transferInfo[t.key]?.status !== "idle" && transferInfo[t.key],
              )
              .map((tab) => (
                <button
                  className="transfer-summary"
                  key={tab.key}
                  onClick={() => {
                    setActive(tab.key);
                    setFiles(true);
                    setShowTransfers(false);
                  }}
                >
                  <Server size={16} />
                  <span>
                    <strong>{tab.connection.name}</strong>
                    <small>
                      {transferInfo[tab.key].status === "completed" &&
                      transferInfo[tab.key].completed === 0 &&
                      transferInfo[tab.key].skipped > 0
                        ? "all skipped"
                        : transferInfo[tab.key].status}{" "}
                      · {transferInfo[tab.key].completed}/
                      {transferInfo[tab.key].total} files
                      {transferInfo[tab.key].skipped
                        ? ` · ${transferInfo[tab.key].skipped} skipped`
                        : ""}
                      {transferInfo[tab.key].queued
                        ? ` · ${transferInfo[tab.key].queued} queued`
                        : ""}
                    </small>
                  </span>
                </button>
              ))}
            {!tabs.some(
              (t) =>
                transferInfo[t.key] && transferInfo[t.key].status !== "idle",
            ) && <p>No transfers yet.</p>}
          </section>
        )}
        {notice && (
          <div className="notice-banner" role="status">
            <span>{notice}</span>
            <button title="Dismiss" onClick={() => setNotice("")}>
              <X size={13} />
            </button>
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            <button title="Dismiss" onClick={() => setError("")}>
              <X size={13} />
            </button>
          </div>
        )}
        {!desktop && (
          <div className="preview-banner">
            Browser preview · SSH, secure storage and file operations require
            the Windows desktop app.
          </div>
        )}
        {tabs.length > 0 ? (
          <>
            <div className="tab-bar">
              {tabs.map((t) => (
                <div
                  key={t.key}
                  className={`tab ${t.key === active ? "active" : ""}`}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      requestCloseTab(t.key);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTabMenu({ x: e.clientX, y: e.clientY, tab: t });
                  }}
                >
                  <button onClick={() => setActive(t.key)}>
                    <span
                      className={`status-dot ${sessions[t.key] ? "online" : ""}`}
                    />
                    {t.connection.name}
                  </button>
                  <button
                    title={`Close ${t.connection.name}`}
                    onClick={() => requestCloseTab(t.key)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <button
                title="Add connection"
                onClick={() => openEditorModal(blank())}
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="session-workspace">
              <div className="terminals">
                {tabs.map((t) => {
                  const isActiveTab = t.key === active;
                  const docs = editorsByTab[t.key] ?? [];
                  const activeSub = activeViewByTab[t.key] ?? "terminal";
                  const activeDoc =
                    docs.find((d) => d.key === activeSub) ?? null;
                  const split =
                    Boolean(splitByTab[t.key]) && Boolean(activeDoc);
                  const showTerminal =
                    !activeDoc || activeSub === "terminal" || split;
                  const showEditor = Boolean(activeDoc);

                  return (
                    <div
                      className="session-left-column"
                      style={{ display: isActiveTab ? "flex" : "none" }}
                      key={t.key}
                    >
                      {docs.length > 0 && (
                        <div
                          className="subtab-bar"
                          role="tablist"
                          aria-label="Session views"
                        >
                          <button
                            role="tab"
                            aria-selected={activeSub === "terminal"}
                            className={`subtab ${activeSub === "terminal" ? "active" : ""}`}
                            onClick={() =>
                              setActiveViewByTab((p) => ({
                                ...p,
                                [t.key]: "terminal",
                              }))
                            }
                          >
                            <Terminal size={12} />
                            <span>Terminal</span>
                          </button>
                          {docs.map((doc) => {
                            const dirty = doc.text !== doc.savedText;
                            return (
                              <div
                                key={doc.key}
                                className={`subtab ${activeSub === doc.key ? "active" : ""}`}
                              >
                                <button
                                  role="tab"
                                  aria-selected={activeSub === doc.key}
                                  title={doc.path}
                                  onClick={() =>
                                    setActiveViewByTab((p) => ({
                                      ...p,
                                      [t.key]: doc.key,
                                    }))
                                  }
                                >
                                  <FileCode size={12} />
                                  <span>
                                    {doc.name}
                                    {dirty ? " •" : ""}
                                  </span>
                                </button>
                                <button
                                  title={`Close ${doc.name}`}
                                  onClick={() => closeRemoteEditor(t.key, doc)}
                                >
                                  <X size={11} />
                                </button>
                              </div>
                            );
                          })}
                          <span className="spacer" />
                          {activeDoc && (
                            <button
                              className={`subtab-split ${split ? "toggled" : ""}`}
                              title="Toggle split view (Terminal + Editor)"
                              onClick={() =>
                                setSplitByTab((p) => ({
                                  ...p,
                                  [t.key]: !p[t.key],
                                }))
                              }
                            >
                              <Columns2 size={12} />
                              <span>Split</span>
                            </button>
                          )}
                        </div>
                      )}
                      <div
                        className={`session-left-body ${split ? "split" : ""}`}
                      >
                        <div
                          className="terminal-wrapper"
                          style={{ display: showTerminal ? "flex" : "none" }}
                        >
                          <TerminalPane
                            connection={t.connection}
                            active={isActiveTab && showTerminal}
                            hasSavedCredential={savedCredentials.has(
                              t.connection.id,
                            )}
                            initialSecret={t.initialSecret}
                            onCredentialSaved={(id, saved) => {
                              setSavedCredentials((prev) => {
                                const next = new Set(prev);
                                if (saved) next.add(id);
                                else next.delete(id);
                                return next;
                              });
                            }}
                            onSession={(id) =>
                              setSessions((prev) =>
                                prev[t.key] === id
                                  ? prev
                                  : { ...prev, [t.key]: id },
                              )
                            }
                          />
                        </div>
                        {showEditor && activeDoc && (
                          <div className="editor-wrapper">
                            <RemoteEditor
                              doc={activeDoc}
                              splitWithTerminal={split}
                              onToggleSplit={() =>
                                setSplitByTab((p) => ({
                                  ...p,
                                  [t.key]: !p[t.key],
                                }))
                              }
                              onChange={(text) =>
                                setEditorsByTab((prev) => ({
                                  ...prev,
                                  [t.key]: (prev[t.key] ?? []).map((d) =>
                                    d.key === activeDoc.key
                                      ? { ...d, text }
                                      : d,
                                  ),
                                }))
                              }
                              onSave={(force) =>
                                void saveRemoteEditor(t.key, activeDoc, force)
                              }
                              onReload={(mode) =>
                                void openRemoteEditor(
                                  t.key,
                                  activeDoc.path,
                                  mode,
                                )
                              }
                              onOpenExternal={() =>
                                void openExternalEditor(t.key, activeDoc.path)
                              }
                              onClose={() =>
                                closeRemoteEditor(t.key, activeDoc)
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {tabs.map((tab) => (
                <FilesPane
                  key={tab.key}
                  id={sessions[tab.key] ?? null}
                  active={files && active === tab.key}
                  refreshToken={refreshTokens[tab.key] ?? 0}
                  onTransfer={(status) =>
                    setTransferInfo((prev) => ({ ...prev, [tab.key]: status }))
                  }
                  onOpenEditor={(remotePath) =>
                    void openRemoteEditor(tab.key, remotePath)
                  }
                  onOpenExternal={(remotePath) =>
                    void openExternalEditor(tab.key, remotePath)
                  }
                />
              ))}
            </div>
          </>
        ) : (
          <div className="welcome">
            <div className="welcome-content">
              <SquareTerminal size={46} strokeWidth={1.3} />
              <h1>Your Remote Workspace</h1>
              <p>
                Choose a server in the sidebar, then double-click to connect
                automatically. Double-click remote config files to edit them in
                place.
              </p>
              <div className="welcome-actions">
                <button
                  className="primary"
                  onClick={() => openEditorModal(blank())}
                >
                  New Connection
                </button>
                <button
                  onClick={() => {
                    setModalError("");
                    setQuickOpen(true);
                  }}
                >
                  <Zap size={14} /> Quick Connect
                </button>
              </div>
            </div>
          </div>
        )}
        <footer className="status-bar">
          <span
            className={`status-dot ${Object.values(sessions).some(Boolean) ? "online" : ""}`}
          />
          <span>
            {Object.values(sessions).filter(Boolean).length} active sessions
          </span>
          <span className="spacer" />
          <span>SSH2 / SFTP</span>
          <span>UTF-8</span>
          <span>ShellDock for Windows</span>
        </footer>
      </main>

      {sidebarMenu && (
        <div
          className="context-menu"
          style={{ left: sidebarMenu.x, top: sidebarMenu.y }}
          role="menu"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => {
              openConnection(sidebarMenu.connection, false);
              setSidebarMenu(null);
            }}
          >
            Connect
          </button>
          <button
            role="menuitem"
            onClick={() => {
              openConnection(sidebarMenu.connection, true);
              setSidebarMenu(null);
            }}
          >
            Open in New Tab
          </button>
          <hr />
          <button
            role="menuitem"
            onClick={() => {
              openEditorModal(sidebarMenu.connection);
              setSidebarMenu(null);
            }}
          >
            Edit…
          </button>
          <button
            role="menuitem"
            onClick={() => {
              void duplicateConnection(sidebarMenu.connection);
              setSidebarMenu(null);
            }}
          >
            Duplicate
          </button>
          <button
            role="menuitem"
            onClick={() => {
              void toggleFavorite(sidebarMenu.connection);
              setSidebarMenu(null);
            }}
          >
            {sidebarMenu.connection.favorite
              ? "Remove from Favorites"
              : "Add to Favorites"}
          </button>
          <hr />
          <button
            role="menuitem"
            className="danger-item"
            onClick={() => {
              setDeleteCandidate(sidebarMenu.connection);
              setSidebarMenu(null);
            }}
          >
            Delete…
          </button>
        </div>
      )}

      {tabMenu && (
        <div
          className="context-menu"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          role="menu"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => {
              openConnection(tabMenu.tab.connection, true);
              setTabMenu(null);
            }}
          >
            Duplicate Tab
          </button>
          <button
            role="menuitem"
            onClick={() => {
              requestCloseTab(tabMenu.tab.key);
              setTabMenu(null);
            }}
          >
            Close Tab
          </button>
          <button
            role="menuitem"
            disabled={tabs.length <= 1}
            onClick={() => {
              const keep = tabMenu.tab.key;
              for (const t of tabs) {
                if (t.key !== keep) forceCloseTab(t.key);
              }
              setActive(keep);
              setTabMenu(null);
            }}
          >
            Close Other Tabs
          </button>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop">
          <form
            className="modal connection-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-title"
            onSubmit={(e) => {
              e.preventDefault();
              void saveConnection();
            }}
          >
            <div className="modal-title">
              <div className="round-icon">
                <Server size={22} />
              </div>
              <div>
                <h2 id="connection-title">
                  {connections.some((c) => c.id === editing.id)
                    ? "Edit connection"
                    : "New connection"}
                </h2>
                <p className="muted">Connection details and authentication.</p>
              </div>
              <button
                type="button"
                title="Close"
                onClick={closeConnectionModal}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              Display name
              <input
                required
                autoFocus
                placeholder="Production server"
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </label>
            <div className="form-row">
              <label>
                Host
                <input
                  required
                  placeholder="192.168.1.10 or example.com"
                  value={editing.host}
                  onChange={(e) =>
                    setEditing({ ...editing, host: e.target.value })
                  }
                />
              </label>
              <label className="port">
                Port
                <input
                  required
                  type="number"
                  min="1"
                  max="65535"
                  value={editing.port}
                  onChange={(e) =>
                    setEditing({ ...editing, port: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Username
                <input
                  required
                  placeholder="root"
                  value={editing.username}
                  onChange={(e) =>
                    setEditing({ ...editing, username: e.target.value })
                  }
                />
              </label>
              <label>
                Group
                <input
                  value={editing.group}
                  onChange={(e) =>
                    setEditing({ ...editing, group: e.target.value })
                  }
                  list="groups"
                />
                <datalist id="groups">
                  {[...new Set(connections.map((c) => c.group))].map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </datalist>
              </label>
            </div>
            <label>
              Authentication
              <select
                value={editing.auth}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    auth: e.target.value as Connection["auth"],
                  })
                }
              >
                <option value="password">Password</option>
                <option value="privateKey">Private key</option>
                <option value="agent">SSH agent</option>
              </select>
            </label>
            {editing.auth === "privateKey" && (
              <label>
                Private key
                <div className="form-row">
                  <input
                    required
                    value={editing.privateKey}
                    onChange={(e) =>
                      setEditing({ ...editing, privateKey: e.target.value })
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      void open({ multiple: false })
                        .then((path) => {
                          if (typeof path === "string")
                            setEditing({ ...editing, privateKey: path });
                        })
                        .catch((e) => setModalError(errorText(e)))
                    }
                  >
                    Browse…
                  </button>
                </div>
              </label>
            )}
            {editing.auth !== "agent" && (
              <label>
                <span className="cred-label-row">
                  <span>
                    {editing.auth === "password"
                      ? "Saved password"
                      : "Saved key passphrase"}{" "}
                    <span className="muted">(optional)</span>
                  </span>
                  {savedCredentials.has(editing.id) && !clearSavedSecret && (
                    <span className="cred-badge">
                      <KeyRound size={11} /> Saved in Windows Credential Manager
                    </span>
                  )}
                </span>
                <div className="form-row">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={editingSecret}
                    onChange={(e) => {
                      setEditingSecret(e.target.value);
                      if (e.target.value) setClearSavedSecret(false);
                    }}
                    placeholder={
                      savedCredentials.has(editing.id) && !clearSavedSecret
                        ? "Saved (enter new value to replace)"
                        : "Enter secret to save in Windows Credential Manager"
                    }
                  />
                  {savedCredentials.has(editing.id) && !clearSavedSecret && (
                    <button
                      type="button"
                      onClick={() => {
                        setClearSavedSecret(true);
                        setEditingSecret("");
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </label>
            )}
            <label>
              Notes
              <textarea
                rows={2}
                value={editing.notes}
                onChange={(e) =>
                  setEditing({ ...editing, notes: e.target.value })
                }
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={editing.favorite}
                onChange={(e) =>
                  setEditing({ ...editing, favorite: e.target.checked })
                }
              />{" "}
              Mark as favorite
            </label>
            <p className="muted small">
              Secrets are stored only in Windows Credential Manager and never
              written to the connection file.
            </p>
            {testResult && (
              <div
                className={`test-result ${testResult.authenticated ? "ok" : "warn"}`}
                role="status"
              >
                <strong>{testResult.message}</strong>
                <small>{testResult.fingerprint}</small>
              </div>
            )}
            {modalError && (
              <p role="alert" className="error">
                {modalError}
              </p>
            )}
            <div className="actions">
              <button
                type="button"
                disabled={testingConn || !desktop}
                onClick={() => void runTestConnection()}
              >
                {testingConn ? "Testing…" : "Test connection"}
              </button>
              <span className="spacer" />
              <button type="button" onClick={closeConnectionModal}>
                Cancel
              </button>
              <button className="primary" disabled={saving || !desktop}>
                {saving ? "Saving…" : "Save connection"}
              </button>
            </div>
          </form>
        </div>
      )}

      {quickOpen && (
        <div className="modal-backdrop">
          <form
            className="modal narrow"
            role="dialog"
            aria-modal="true"
            aria-label="Quick Connect"
            onSubmit={(e) => {
              e.preventDefault();
              void submitQuickConnect();
            }}
          >
            <div className="modal-title">
              <div className="round-icon">
                <Zap size={20} />
              </div>
              <div>
                <h2>Quick Connect</h2>
                <p className="muted">
                  Connect immediately without creating a profile.
                </p>
              </div>
              <button
                type="button"
                title="Close"
                onClick={() => {
                  setQuickOpen(false);
                  setModalError("");
                }}
              >
                <X size={18} />
              </button>
            </div>
            <div className="form-row">
              <label>
                Host
                <input
                  required
                  autoFocus
                  placeholder="192.168.1.10"
                  value={quickForm.host}
                  onChange={(e) =>
                    setQuickForm({ ...quickForm, host: e.target.value })
                  }
                />
              </label>
              <label className="port">
                Port
                <input
                  required
                  type="number"
                  min="1"
                  max="65535"
                  value={quickForm.port}
                  onChange={(e) =>
                    setQuickForm({
                      ...quickForm,
                      port: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <label>
              Username
              <input
                required
                placeholder="root"
                value={quickForm.username}
                onChange={(e) =>
                  setQuickForm({ ...quickForm, username: e.target.value })
                }
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={quickForm.password}
                onChange={(e) =>
                  setQuickForm({ ...quickForm, password: e.target.value })
                }
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={quickForm.saveConnection}
                onChange={(e) =>
                  setQuickForm({
                    ...quickForm,
                    saveConnection: e.target.checked,
                  })
                }
              />{" "}
              Save connection & credential
            </label>
            {modalError && (
              <p role="alert" className="error">
                {modalError}
              </p>
            )}
            <div className="actions">
              <button
                type="button"
                onClick={() => {
                  setQuickOpen(false);
                  setModalError("");
                }}
              >
                Cancel
              </button>
              <button className="primary">Connect</button>
            </div>
          </form>
        </div>
      )}

      {deleteCandidate && (
        <div className="modal-backdrop">
          <div
            className="modal narrow"
            role="dialog"
            aria-modal="true"
            aria-label="Delete connection"
          >
            <h2>Delete connection?</h2>
            <p>
              Permanently remove “{deleteCandidate.name}” and any saved
              credential in Windows Credential Manager?
            </p>
            <div className="actions">
              <button onClick={() => setDeleteCandidate(null)}>Cancel</button>
              <button
                className="danger"
                onClick={() => void confirmDeleteConnection()}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {closeTabConfirm && (
        <div className="modal-backdrop">
          <div
            className="modal narrow"
            role="dialog"
            aria-modal="true"
            aria-label="Close session tab"
          >
            <h2>Close active tab?</h2>
            <p>
              This session has an active file transfer or unsaved editor
              changes. Closing the tab will stop them.
            </p>
            <div className="actions">
              <button onClick={() => setCloseTabConfirm(null)}>Cancel</button>
              <button
                className="danger"
                onClick={() => forceCloseTab(closeTabConfirm)}
              >
                Close tab
              </button>
            </div>
          </div>
        </div>
      )}

      {discardEditorConfirm && (
        <div className="modal-backdrop">
          <div
            className="modal narrow"
            role="dialog"
            aria-modal="true"
            aria-label="Unsaved changes"
          >
            <h2>Unsaved changes</h2>
            <p>
              Save changes to “{discardEditorConfirm.doc.name}” on the server
              before closing?
            </p>
            <div className="actions">
              <button onClick={() => setDiscardEditorConfirm(null)}>
                Cancel
              </button>
              <button
                className="danger"
                onClick={() =>
                  forceCloseRemoteEditor(
                    discardEditorConfirm.tabKey,
                    discardEditorConfirm.doc.key,
                  )
                }
              >
                Discard
              </button>
              <button
                className="primary"
                onClick={() => {
                  const target = discardEditorConfirm;
                  setDiscardEditorConfirm(null);
                  void saveRemoteEditor(target.tabKey, target.doc).then(
                    (ok) => {
                      if (ok)
                        forceCloseRemoteEditor(target.tabKey, target.doc.key);
                    },
                  );
                }}
              >
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}

      {settings && (
        <div className="modal-backdrop">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="About ShellDock"
            className="modal narrow"
          >
            <h2>ShellDock for Windows</h2>
            <p>Version 0.2.3</p>
            <p className="muted">
              Tauri 2 · React · Rust · libssh2 · xterm.js · CodeMirror 6
            </p>
            <p>
              Host keys are pinned per host and port. Saved passwords and key
              passphrases use Windows Credential Manager. Deleting a saved
              connection removes its credential.
            </p>
            <p>
              Includes auto-connect on saved credentials, pooled SFTP, recursive
              remote deletion, two-way Local ↔ Remote & Explorer drag-and-drop,
              and a non-blocking remote code editor with auto-sync external edit
              support.
            </p>
            <div className="actions">
              <button onClick={() => setSettings(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
