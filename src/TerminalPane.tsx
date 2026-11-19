import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  Search,
  RotateCw,
  ShieldCheck,
  Unplug,
  Eraser,
  Minus,
  Plus,
  X,
  KeyRound,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { Connection, TerminalEvent } from "./types";
import { errorText } from "./types";

interface Props {
  connection: Connection;
  active: boolean;
  hasSavedCredential: boolean;
  autoConnect?: boolean;
  initialSecret?: string;
  onCredentialSaved?: (id: string, saved: boolean) => void;
  onSession: (id: string | null) => void;
}

export default function TerminalPane({
  connection,
  active,
  hasSavedCredential,
  autoConnect = true,
  initialSecret = "",
  onCredentialSaved,
  onSession,
}: Props) {
  const container = useRef<HTMLDivElement>(null),
    term = useRef<Terminal | null>(null),
    session = useRef<string | null>(null),
    search = useRef<SearchAddon | null>(null),
    fit = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState("Disconnected"),
    [secret, setSecret] = useState(initialSecret),
    [remember, setRemember] = useState(true),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [showSearch, setShowSearch] = useState(false),
    [hasHistory, setHasHistory] = useState(false),
    [showPromptCard, setShowPromptCard] = useState(false),
    [fontSize, setFontSize] = useState(
      () => Number(localStorage.getItem("terminal.fontSize")) || 14,
    ),
    [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [challenge, setChallenge] = useState<{
      fingerprint: string;
      previous: string | null;
    } | null>(null),
    [failure, setFailure] = useState("");
  const alive = useRef(true),
    callback = useRef(onSession),
    credCallback = useRef(onCredentialSaved),
    generation = useRef(0),
    attemptedAuto = useRef(false),
    manualStop = useRef(false),
    secretRef = useRef(secret);
  callback.current = onSession;
  credCallback.current = onCredentialSaved;
  secretRef.current = secret;

  function updateFontSize(next: number) {
    const clamped = Math.max(10, Math.min(24, next));
    setFontSize(clamped);
    localStorage.setItem("terminal.fontSize", String(clamped));
    if (term.current) {
      term.current.options.fontSize = clamped;
      fit.current?.fit();
    }
  }

  function copySelection() {
    const text = term.current?.getSelection();
    if (!text) return;
    void navigator.clipboard?.writeText(text).catch(() => {});
    term.current?.clearSelection();
  }

  function pasteFromClipboard() {
    void navigator.clipboard
      ?.readText()
      .then((text) => {
        if (text) term.current?.paste(text);
      })
      .catch(() => {});
  }

  useEffect(() => {
    alive.current = true;
    let dispose = () => {};
    const frame = requestAnimationFrame(() => {
      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: "Cascadia Code, Consolas, monospace",
        fontSize,
        lineHeight: 1.25,
        scrollback: 10000,
        theme: {
          background: "#1c1c1e",
          foreground: "#d3d8df",
          cursor: "#71b7ff",
          selectionBackground: "#31567a",
        },
      });
      const fitAddon = new FitAddon(),
        searchAddon = new SearchAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(searchAddon);
      terminal.open(container.current!);
      fitAddon.fit();
      term.current = terminal;
      fit.current = fitAddon;
      search.current = searchAddon;
      const data = terminal.onData((value) => {
        if (session.current)
          void invoke("terminal_write", {
            id: session.current,
            data: value,
          }).catch((e) => setFailure(errorText(e)));
      });
      const resize = terminal.onResize(({ cols, rows }) => {
        if (session.current)
          void invoke("terminal_resize", {
            id: session.current,
            cols,
            rows,
          }).catch(() => {});
      });
      const observer = new ResizeObserver(() => {
        if (container.current?.clientWidth) fitAddon.fit();
      });
      observer.observe(container.current!);
      terminal.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "f") {
          setShowSearch(true);
          return false;
        }
        if (e.ctrlKey && e.key.toLowerCase() === "c") {
          if (terminal.hasSelection() || e.shiftKey) {
            copySelection();
            return false;
          }
          return true;
        }
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v") {
          pasteFromClipboard();
          return false;
        }
        if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
          updateFontSize((terminal.options.fontSize ?? 14) + 1);
          return false;
        }
        if (e.ctrlKey && e.key === "-") {
          updateFontSize((terminal.options.fontSize ?? 14) - 1);
          return false;
        }
        if (e.ctrlKey && e.key === "0") {
          updateFontSize(14);
          return false;
        }
        return true;
      });
      dispose = () => {
        observer.disconnect();
        data.dispose();
        resize.dispose();
        terminal.dispose();
        term.current = null;
        fit.current = null;
        search.current = null;
      };

      const canAutoStart =
        autoConnect &&
        !manualStop.current &&
        !attemptedAuto.current &&
        (connection.auth === "agent" ||
          connection.auth === "privateKey" ||
          hasSavedCredential ||
          Boolean(initialSecret));
      if (canAutoStart) {
        attemptedAuto.current = true;
        void start(false, initialSecret);
      }
    });
    return () => {
      alive.current = false;
      generation.current++;
      cancelAnimationFrame(frame);
      dispose();
      if (session.current) void invoke("disconnect", { id: session.current });
      session.current = null;
      callback.current(null);
    };
  }, []);

  useEffect(() => {
    if (active) {
      fit.current?.fit();
      term.current?.focus();
    }
  }, [active]);

  useEffect(() => {
    if (!menu) return;
    const closeMenu = () => setMenu(null);
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeMenu);
    };
  }, [menu]);

  useEffect(() => {
    if (!challenge) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setChallenge(null);
        setStatus("Disconnected");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [challenge]);

  async function start(trusted = false, secretOverride?: string) {
    const attempt = ++generation.current;
    manualStop.current = false;
    setBusy(true);
    setFailure("");
    setStatus("Checking host key…");
    try {
      if (session.current) {
        await invoke("disconnect", { id: session.current });
        session.current = null;
        callback.current(null);
      }
      if (!trusted) {
        const probe = await invoke<{
          fingerprint: string;
          previous: string | null;
        }>("probe_host", { connection });
        if (!alive.current || attempt !== generation.current) return;
        if (probe.fingerprint !== probe.previous) {
          if (alive.current) setChallenge(probe);
          setStatus("Host verification required");
          return;
        }
      }
      setStatus("Connecting…");
      const output = new Channel<TerminalEvent>();
      let ended = false;
      output.onmessage = (event) => {
        if (!alive.current || attempt !== generation.current) return;
        if (event.kind === "output") {
          setHasHistory(true);
          term.current?.write(new Uint8Array(event.data));
        }
        if (event.kind === "error") setFailure(event.data);
        if (event.kind === "closed") {
          ended = true;
          session.current = null;
          setStatus("Disconnected");
          callback.current(null);
          term.current?.writeln("\r\n\x1b[90m[Session closed]\x1b[0m");
        }
      };
      if (hasHistory) {
        term.current?.writeln("\r\n\x1b[90m─── Reconnecting ───\x1b[0m");
      }
      const usedSecret = secretOverride ?? secretRef.current;
      const id = await invoke<string>("connect", {
        connection,
        secret: usedSecret,
        remember,
        output,
        cols: term.current?.cols ?? 100,
        rows: term.current?.rows ?? 30,
      });
      if (!alive.current || ended || attempt !== generation.current) {
        await invoke("disconnect", { id });
        return;
      }
      if (remember && usedSecret) {
        credCallback.current?.(connection.id, true);
      }
      session.current = id;
      callback.current(id);
      setSecret("");
      setShowPromptCard(false);
      setStatus("Connected");
      term.current?.focus();
    } catch (e) {
      if (alive.current && attempt === generation.current) {
        setFailure(errorText(e));
        setStatus("Connection failed");
      }
    } finally {
      if (alive.current && attempt === generation.current) setBusy(false);
    }
  }

  async function accept() {
    try {
      await invoke("trust_host", {
        connection,
        fingerprint: challenge!.fingerprint,
      });
      setChallenge(null);
      await start(true);
    } catch (e) {
      setFailure(errorText(e));
    }
  }

  async function stop() {
    manualStop.current = true;
    generation.current++;
    if (session.current) await invoke("disconnect", { id: session.current });
    session.current = null;
    callback.current(null);
    setStatus("Disconnected");
    setBusy(false);
  }

  const showFullCard =
    status !== "Connected" && (!hasHistory || showPromptCard);
  const showReconnectBanner =
    status !== "Connected" && hasHistory && !showPromptCard;

  return (
    <section className="terminal-pane">
      <div className="pane-toolbar">
        <span
          className={`status-dot ${status === "Connected" ? "online" : ""}`}
        />
        <span>{status}</span>
        {hasSavedCredential && connection.auth !== "agent" && (
          <span
            className="cred-badge"
            title="Credential saved in Windows Credential Manager"
          >
            <KeyRound size={11} /> Saved credential
          </span>
        )}
        <span className="spacer" />
        <button
          title="Decrease font size (Ctrl+-)"
          onClick={() => updateFontSize(fontSize - 1)}
        >
          <Minus size={13} />
        </button>
        <span className="small muted">{fontSize}px</span>
        <button
          title="Increase font size (Ctrl++)"
          onClick={() => updateFontSize(fontSize + 1)}
        >
          <Plus size={13} />
        </button>
        <button
          title="Clear terminal buffer"
          onClick={() => {
            term.current?.clear();
            setHasHistory(false);
          }}
        >
          <Eraser size={14} />
        </button>
        <button
          title="Search terminal (Ctrl+F)"
          onClick={() => setShowSearch(!showSearch)}
        >
          <Search size={15} />
        </button>
        <button title="Reconnect" disabled={busy} onClick={() => void start()}>
          <RotateCw size={15} />
        </button>
        <button
          title="Disconnect"
          disabled={status === "Disconnected" && !busy}
          onClick={() => void stop()}
        >
          <Unplug size={15} />
        </button>
      </div>
      {showSearch && (
        <div className="search-bar">
          <input
            aria-label="Search terminal"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              search.current?.findNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") search.current?.findNext(query);
              if (e.key === "Escape") setShowSearch(false);
            }}
            placeholder="Find in terminal…"
          />
          <button onClick={() => search.current?.findPrevious(query)}>
            Previous
          </button>
          <button onClick={() => search.current?.findNext(query)}>Next</button>
          <button onClick={() => setShowSearch(false)}>Close</button>
        </div>
      )}
      {showReconnectBanner && (
        <div className="reconnect-banner" role="region" aria-label="Reconnect">
          <span>
            <strong>{status}</strong>
            {failure ? ` · ${failure}` : " · Terminal history preserved below"}
          </span>
          <span className="spacer" />
          <button onClick={() => setShowPromptCard(true)}>Credentials…</button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? status : "Reconnect"}
          </button>
        </div>
      )}
      <div
        className="terminal-host"
        ref={container}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {showFullCard && (
        <div className="connect-overlay">
          <form
            className="connect-card"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <div className="round-icon">
              <ShieldCheck size={25} />
            </div>
            <h2>{connection.name}</h2>
            <p className="muted">
              {connection.username}@{connection.host}:{connection.port}
            </p>
            {connection.auth !== "agent" && (
              <>
                <label>
                  {connection.auth === "password"
                    ? "Password"
                    : "Private key passphrase"}
                  <input
                    type="password"
                    autoFocus={!hasSavedCredential && !busy}
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={
                      hasSavedCredential
                        ? "Saved credential will be used (or enter new)"
                        : connection.auth === "privateKey"
                          ? "Leave empty if key has no passphrase"
                          : "Enter password"
                    }
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />{" "}
                  Save in Windows Credential Manager
                </label>
              </>
            )}
            <button className="primary" disabled={busy || !!challenge}>
              {busy ? status : "Connect to server"}
            </button>
            {hasHistory && (
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowPromptCard(false)}
              >
                Back to terminal output
              </button>
            )}
            <p className="muted small">
              The server key is checked before credentials are sent.
            </p>
            {failure && (
              <p role="alert" className="error">
                {failure}
              </p>
            )}
          </form>
        </div>
      )}
      {status === "Connected" && failure && (
        <div className="error terminal-error" role="alert">
          <span>{failure}</span>
          <button title="Dismiss error" onClick={() => setFailure("")}>
            <X size={13} />
          </button>
        </div>
      )}
      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            disabled={!term.current?.hasSelection()}
            onClick={() => {
              copySelection();
              setMenu(null);
            }}
          >
            Copy
          </button>
          <button
            role="menuitem"
            onClick={() => {
              pasteFromClipboard();
              setMenu(null);
            }}
          >
            Paste
          </button>
          <button
            role="menuitem"
            onClick={() => {
              term.current?.selectAll();
              setMenu(null);
            }}
          >
            Select All
          </button>
          <hr />
          <button
            role="menuitem"
            onClick={() => {
              setShowSearch(true);
              setMenu(null);
            }}
          >
            Find in Terminal
          </button>
          <button
            role="menuitem"
            onClick={() => {
              term.current?.clear();
              setHasHistory(false);
              setMenu(null);
            }}
          >
            Clear Buffer
          </button>
          <hr />
          <button
            role="menuitem"
            onClick={() => {
              updateFontSize(fontSize + 1);
              setMenu(null);
            }}
          >
            Zoom In
          </button>
          <button
            role="menuitem"
            onClick={() => {
              updateFontSize(fontSize - 1);
              setMenu(null);
            }}
          >
            Zoom Out
          </button>
          <button
            role="menuitem"
            onClick={() => {
              updateFontSize(14);
              setMenu(null);
            }}
          >
            Reset Zoom (14px)
          </button>
        </div>
      )}
      {challenge && (
        <div className="modal-backdrop">
          <div
            className="modal narrow"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trust-title"
          >
            <ShieldCheck size={28} />
            <h2 id="trust-title">
              {challenge.previous
                ? "Server identity has changed"
                : "Verify server identity"}
            </h2>
            <p>
              {challenge.previous
                ? "The stored host key differs. This may indicate a reinstalled server or an intercepted connection."
                : "Compare this fingerprint with one obtained from the server administrator through a trusted channel."}
            </p>
            <p className="muted">
              {connection.host}:{connection.port}
            </p>
            <code className="fingerprint">{challenge.fingerprint}</code>
            {challenge.previous && (
              <>
                <p>Previously trusted</p>
                <code className="fingerprint">{challenge.previous}</code>
              </>
            )}
            <div className="actions">
              <button
                onClick={() => {
                  setChallenge(null);
                  setStatus("Disconnected");
                }}
              >
                Cancel
              </button>
              <button
                className={challenge.previous ? "danger" : "primary"}
                onClick={() => void accept()}
              >
                Trust this key and connect
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
