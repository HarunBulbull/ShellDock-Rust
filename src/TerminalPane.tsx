import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Search, RotateCw, ShieldCheck, Unplug } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { Connection, TerminalEvent } from "./types";
import { errorText } from "./types";

interface Props {
  connection: Connection;
  active: boolean;
  onSession: (id: string | null) => void;
}
export default function TerminalPane({ connection, active, onSession }: Props) {
  const container = useRef<HTMLDivElement>(null),
    term = useRef<Terminal | null>(null),
    session = useRef<string | null>(null),
    search = useRef<SearchAddon | null>(null),
    fit = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState("Disconnected"),
    [secret, setSecret] = useState(""),
    [remember, setRemember] = useState(false),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [showSearch, setShowSearch] = useState(false);
  const [challenge, setChallenge] = useState<{
      fingerprint: string;
      previous: string | null;
    } | null>(null),
    [failure, setFailure] = useState("");
  const alive = useRef(true),
    callback = useRef(onSession);
  callback.current = onSession;
  const generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    let dispose = () => {};
    const frame = requestAnimationFrame(() => {
      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: "Cascadia Code, Consolas, monospace",
        fontSize: 14,
        lineHeight: 1.25,
        scrollback: 10000,
        theme: {
          background: "#101317",
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
        if (e.type === "keydown" && e.ctrlKey && e.key === "f") {
          setShowSearch(true);
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
  async function start(trusted = false) {
    const attempt = ++generation.current;
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
        if (event.kind === "output")
          term.current?.write(new Uint8Array(event.data));
        if (event.kind === "error") setFailure(event.data);
        if (event.kind === "closed") {
          ended = true;
          session.current = null;
          setStatus("Disconnected");
          callback.current(null);
          term.current?.writeln("\r\n\x1b[90m[Session closed]\x1b[0m");
        }
      };
      term.current?.clear();
      const id = await invoke<string>("connect", {
        connection,
        secret,
        remember,
        output,
        cols: term.current?.cols ?? 100,
        rows: term.current?.rows ?? 30,
      });
      if (!alive.current || ended || attempt !== generation.current) {
        await invoke("disconnect", { id });
        return;
      }
      session.current = id;
      callback.current(id);
      setSecret("");
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
    generation.current++;
    if (session.current) await invoke("disconnect", { id: session.current });
    session.current = null;
    callback.current(null);
    setStatus("Disconnected");
    setBusy(false);
  }
  return (
    <section className="terminal-pane">
      <div className="pane-toolbar">
        <span
          className={`status-dot ${status === "Connected" ? "online" : ""}`}
        />
        <span>{status}</span>
        <span className="spacer" />
        <button
          title="Search terminal (Ctrl+F)"
          onClick={() => setShowSearch(!showSearch)}
        >
          <Search size={15} />
        </button>
        <button title="Reconnect" disabled={busy} onClick={() => void start()}>
          <RotateCw size={15} />
        </button>
        <button title="Disconnect" onClick={() => void stop()}>
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
      <div className="terminal-host" ref={container} />
      {status !== "Connected" && (
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
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="Leave empty to use a saved credential"
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
        <div className="error" role="alert">
          {failure}
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
