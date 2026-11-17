import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Terminal,
  Plus,
  Search,
  Server,
  Star,
  ChevronRight,
  Folder,
  Settings,
  X,
  PanelRight,
  SquareTerminal,
  Pencil,
  Trash2,
  ArrowDownUp,
} from "lucide-react";
import TerminalPane from "./TerminalPane";
import FilesPane, { type TransferStatus } from "./FilesPane";
import type { Connection, SessionTab } from "./types";
import { desktop, errorText } from "./types";
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
    [tabs, setTabs] = useState<SessionTab[]>([]),
    [active, setActive] = useState(""),
    [sessions, setSessions] = useState<Record<string, string | null>>({}),
    [query, setQuery] = useState(""),
    [editing, setEditing] = useState<Connection | null>(null),
    [error, setError] = useState(""),
    [files, setFiles] = useState(true),
    [settings, setSettings] = useState(false),
    [saving, setSaving] = useState(false),
    [selectedConnection, setSelectedConnection] = useState("");
  const [transferInfo, setTransferInfo] = useState<
      Record<string, TransferStatus>
    >({}),
    [showTransfers, setShowTransfers] = useState(false);
  async function reload() {
    if (desktop) setConnections(await invoke<Connection[]>("list_connections"));
  }
  useEffect(() => {
    void reload().catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault();
        setEditing(blank());
      }
      if (e.ctrlKey && e.key === "k") {
        e.preventDefault();
        document.getElementById("server-search")?.focus();
      }
      if (e.key === "Escape") {
        setSettings(false);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  function connect(connection: Connection) {
    const key = crypto.randomUUID();
    setTabs((prev) => [...prev, { key, connection }]);
    setActive(key);
  }
  function close(key: string) {
    setTransferInfo((previous) => {
      const next = { ...previous };
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
  async function save() {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      await invoke("save_connection", { connection: editing });
      await reload();
      setEditing(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  async function remove(c: Connection) {
    if (!confirm(`Delete saved connection “${c.name}”?`)) return;
    try {
      await invoke("delete_connection", { id: c.id });
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  }
  const filtered = connections.filter((c) =>
    `${c.name} ${c.host} ${c.username} ${c.group}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const current = tabs.find((t) => t.key === active);
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
            onClick={() => setEditing(blank())}
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
          {[...new Set(filtered.map((c) => c.group))].sort().map((group) => (
            <div key={group}>
              <div className="group-title">
                <ChevronRight size={12} />
                <Folder size={13} />
                <span>{group || "Ungrouped"}</span>
                <span className="spacer" />
                <span>{filtered.filter((c) => c.group === group).length}</span>
              </div>
              {filtered
                .filter((c) => c.group === group)
                .sort(
                  (a, b) =>
                    Number(b.favorite) - Number(a.favorite) ||
                    a.name.localeCompare(b.name),
                )
                .map((c) => (
                  <div
                    className={`connection-row ${(selectedConnection || current?.connection.id) === c.id ? "chosen" : ""}`}
                    key={c.id}
                  >
                    <button
                      className="connection-open"
                      onClick={() => setSelectedConnection(c.id)}
                      onDoubleClick={() => connect(c)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") connect(c);
                      }}
                    >
                      <Server size={16} />
                      <span>
                        <strong>{c.name}</strong>
                        <small>
                          {c.username}@{c.host}
                        </small>
                      </span>
                      {c.favorite && <Star size={11} />}
                    </button>
                    <div className="row-actions">
                      <button
                        title="Edit connection"
                        onClick={() => setEditing({ ...c })}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        title="Delete connection"
                        onClick={() => void remove(c)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          ))}
          {connections.length === 0 && (
            <div className="sidebar-empty">
              <p>No saved servers yet.</p>
              <button onClick={() => setEditing(blank())}>
                Add your first server <Plus size={13} />
              </button>
            </div>
          )}
        </nav>
        <button className="add-server" onClick={() => setEditing(blank())}>
          <Plus size={15} /> New connection <kbd>Ctrl N</kbd>
        </button>
        <div className="sidebar-footer">
          <button onClick={() => setSettings(true)}>
            <Settings size={16} /> Settings & about
          </button>
          <span className="small muted">v0.2.1 · Preview</span>
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
            title="New connection (Ctrl+N)"
            onClick={() => setEditing(blank())}
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
        {error && !editing && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => setError("")}>
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
                >
                  <button onClick={() => setActive(t.key)}>
                    <span
                      className={`status-dot ${sessions[t.key] ? "online" : ""}`}
                    />
                    {t.connection.name}
                  </button>
                  <button
                    title={`Close ${t.connection.name}`}
                    onClick={() => close(t.key)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <button
                title="Add connection"
                onClick={() => setEditing(blank())}
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="session-workspace">
              <div className="terminals">
                {tabs.map((t) => (
                  <div
                    className="terminal-wrapper"
                    style={{ display: t.key === active ? "flex" : "none" }}
                    key={t.key}
                  >
                    <TerminalPane
                      connection={t.connection}
                      active={t.key === active}
                      onSession={(id) =>
                        setSessions((prev) =>
                          prev[t.key] === id ? prev : { ...prev, [t.key]: id },
                        )
                      }
                    />
                  </div>
                ))}
              </div>
              {tabs.map((tab) => (
                <FilesPane
                  key={tab.key}
                  id={sessions[tab.key] ?? null}
                  active={files && active === tab.key}
                  onTransfer={(status) =>
                    setTransferInfo((prev) => ({ ...prev, [tab.key]: status }))
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
                Choose a server in the sidebar, then double-click to open a
                session.
              </p>
              <button className="primary" onClick={() => setEditing(blank())}>
                New Connection
              </button>
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
      {editing && (
        <div className="modal-backdrop">
          <form
            className="modal connection-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-title"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
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
                onClick={() => {
                  setEditing(null);
                  setError("");
                }}
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
                        .catch((e) => setError(errorText(e)))
                    }
                  >
                    Browse…
                  </button>
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
              Credentials are requested when connecting and never stored in the
              connection file.
            </p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="actions">
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="primary" disabled={saving || !desktop}>
                {saving ? "Saving…" : "Save connection"}
              </button>
            </div>
          </form>
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
            <p>Version 0.2.1 · Development preview</p>
            <p className="muted">Tauri 2 · React · Rust · libssh2 · xterm.js</p>
            <p>
              Host keys are pinned per host and port. Saved passwords and key
              passphrases use Windows Credential Manager. Deleting a saved
              connection removes its credential.
            </p>
            <p>
              Local and remote file browsers support multi-selection, file and
              folder transfers, Explorer drops, an in-session transfer queue and
              cancellation. Folder synchronization and persistent resume are
              still in development.
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
