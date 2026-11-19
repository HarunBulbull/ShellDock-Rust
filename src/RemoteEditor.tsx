import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentUnit,
} from "@codemirror/language";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { yaml } from "@codemirror/lang-yaml";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { xml } from "@codemirror/lang-xml";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { sql } from "@codemirror/lang-sql";
import { markdown } from "@codemirror/lang-markdown";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import {
  Columns2,
  ExternalLink,
  RefreshCw,
  Save,
  Search,
  X,
} from "lucide-react";
import type { EditorDocument } from "./types";
import { formatOctalPermissions } from "./types";

function languageForPath(path: string): { label: string; ext: Extension } {
  const filename = path.split("/").pop()?.toLowerCase() ?? "";
  if (filename === "dockerfile" || filename.startsWith("dockerfile."))
    return { label: "Dockerfile", ext: StreamLanguage.define(dockerFile) };
  if (filename === ".env" || filename.startsWith(".env."))
    return { label: "Env", ext: StreamLanguage.define(properties) };
  if (
    filename === ".bashrc" ||
    filename === ".zshrc" ||
    filename === ".profile"
  )
    return { label: "Shell", ext: StreamLanguage.define(shell) };

  const ext = filename.includes(".") ? (filename.split(".").pop() ?? "") : "";
  switch (ext) {
    case "yml":
    case "yaml":
      return { label: "YAML", ext: yaml() };
    case "json":
    case "jsonc":
      return { label: "JSON", ext: json() };
    case "js":
    case "mjs":
    case "cjs":
      return { label: "JavaScript", ext: javascript() };
    case "jsx":
      return { label: "JSX", ext: javascript({ jsx: true }) };
    case "ts":
    case "mts":
      return { label: "TypeScript", ext: javascript({ typescript: true }) };
    case "tsx":
      return {
        label: "TSX",
        ext: javascript({ typescript: true, jsx: true }),
      };
    case "py":
      return { label: "Python", ext: python() };
    case "xml":
    case "svg":
    case "plist":
      return { label: "XML", ext: xml() };
    case "html":
    case "htm":
      return { label: "HTML", ext: html() };
    case "css":
    case "scss":
      return { label: "CSS", ext: css() };
    case "sql":
      return { label: "SQL", ext: sql() };
    case "md":
    case "markdown":
      return { label: "Markdown", ext: markdown() };
    case "sh":
    case "bash":
    case "zsh":
      return { label: "Shell", ext: StreamLanguage.define(shell) };
    case "toml":
      return { label: "TOML", ext: StreamLanguage.define(toml) };
    case "ini":
    case "env":
    case "properties":
    case "cnf":
    case "service":
      return { label: "Config", ext: StreamLanguage.define(properties) };
    case "conf":
      return { label: "Nginx / Conf", ext: StreamLanguage.define(nginx) };
    case "diff":
    case "patch":
      return { label: "Diff", ext: StreamLanguage.define(diff) };
    default:
      return { label: "Plain Text", ext: [] };
  }
}

const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

export default function RemoteEditor({
  doc,
  splitWithTerminal,
  onToggleSplit,
  onChange,
  onSave,
  onReload,
  onOpenExternal,
  onClose,
}: {
  doc: EditorDocument;
  splitWithTerminal: boolean;
  onToggleSplit: () => void;
  onChange: (text: string) => void;
  onSave: (force?: boolean) => void;
  onReload: (previewMode?: "head" | "tail") => void;
  onOpenExternal: () => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const dirty = doc.text !== doc.savedText;
  const lang = languageForPath(doc.path);

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: doc.text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        foldGutter(),
        drawSelection(),
        bracketMatching(),
        highlightSelectionMatches(),
        indentUnit.of("  "),
        search({ top: true }),
        oneDark,
        lang.ext,
        readOnlyCompartment.current.of(EditorState.readOnly.of(doc.readOnly)),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              callbacks.current.onSave(false);
              return true;
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            callbacks.current.onChange(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            setCursor({ line: line.number, col: head - line.from + 1 });
          }
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "13px",
            backgroundColor: "#1a1b1e",
          },
          ".cm-scroller": {
            fontFamily: "Cascadia Code, Consolas, monospace",
            lineHeight: "1.55",
          },
          ".cm-gutters": {
            backgroundColor: "#1f2024",
            borderRight: "1px solid #323338",
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [doc.key, doc.path]);

  // Sync external reloads (Reload button or server re-fetch) into CodeMirror cleanly.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== doc.text) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: doc.text },
      });
    }
  }, [doc.text]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        EditorState.readOnly.of(doc.readOnly),
      ),
    });
  }, [doc.readOnly]);

  return (
    <section
      className="remote-editor"
      aria-label={`Remote editor for ${doc.name}`}
    >
      <div className="pane-toolbar editor-toolbar">
        <strong title={doc.path} className="editor-path">
          {doc.path}
          {dirty ? " •" : ""}
        </strong>
        <span className="editor-badge">{lang.label}</span>
        <span className="editor-badge">{doc.lineEnding}</span>
        <span className="editor-badge">{formatBytes(doc.size)}</span>
        <span className="editor-badge" title="Octal permissions">
          {formatOctalPermissions(doc.permissions)}
        </span>
        <span className="spacer" />
        <button
          title="Find & Replace (Ctrl+F)"
          onClick={() => {
            if (viewRef.current) {
              openSearchPanel(viewRef.current);
              viewRef.current.focus();
            }
          }}
        >
          <Search size={14} />
        </button>
        <button
          title={
            splitWithTerminal ? "Show full editor" : "Split view with terminal"
          }
          className={splitWithTerminal ? "toggled" : ""}
          onClick={onToggleSplit}
        >
          <Columns2 size={14} />
          <span>Split</span>
        </button>
        <button
          title="Open in default Windows app (Auto-Sync on save)"
          onClick={onOpenExternal}
        >
          <ExternalLink size={14} />
          <span>External</span>
        </button>
        <button
          title="Reload from server"
          disabled={doc.saving}
          onClick={() => onReload(doc.previewMode ?? undefined)}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="primary editor-save"
          title="Save to server (Ctrl+S)"
          disabled={!dirty || doc.readOnly || doc.saving}
          onClick={() => onSave(false)}
        >
          <Save size={13} />
          <span>{doc.saving ? "Saving…" : "Save"}</span>
        </button>
        <button title="Close file" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      {doc.readOnlyReason && (
        <div className="editor-notice">
          <span>{doc.readOnlyReason}</span>
          {doc.truncated && (
            <div className="editor-notice-actions">
              <button
                disabled={doc.previewMode === "head"}
                onClick={() => onReload("head")}
              >
                Load Head (512 KB)
              </button>
              <button
                disabled={doc.previewMode === "tail"}
                onClick={() => onReload("tail")}
              >
                Load Tail (512 KB)
              </button>
            </div>
          )}
        </div>
      )}

      {doc.conflict && (
        <div className="editor-conflict" role="alert">
          <span>{doc.conflict}</span>
          <div className="editor-notice-actions">
            <button onClick={() => onReload()}>Reload server copy</button>
            <button className="danger" onClick={() => onSave(true)}>
              Overwrite anyway
            </button>
          </div>
        </div>
      )}

      {doc.error && (
        <div className="error" role="alert">
          {doc.error}
        </div>
      )}

      <div className="editor-host" ref={hostRef} />

      <div className="editor-statusbar">
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span>Spaces: 2</span>
        <span className="spacer" />
        <span>
          {doc.readOnly
            ? "Read-only"
            : doc.saving
              ? "Saving to server…"
              : dirty
                ? "Unsaved changes (Ctrl+S to save)"
                : "Synced with server"}
        </span>
      </div>
    </section>
  );
}
