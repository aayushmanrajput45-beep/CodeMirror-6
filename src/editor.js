import { basicSetup } from "codemirror";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  historyField, isolateHistory, undo, redo, selectAll,
  indentWithTab, indentMore, indentLess, toggleComment
} from "@codemirror/commands";
import {
  HighlightStyle, syntaxHighlighting, indentUnit,
  foldCode, unfoldCode, foldAll, unfoldAll
} from "@codemirror/language";
import { openSearchPanel, closeSearchPanel } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { DEFAULT_SETTINGS } from "./core.js";

const MODES = {
  html: "html", htm: "html", css: "css",
  js: "js", mjs: "js", cjs: "js", jsx: "jsx",
  ts: "ts", tsx: "tsx", json: "json",
  md: "md", markdown: "md", py: "py", pyw: "py"
};
const LABELS = {
  html: "HTML", css: "CSS", js: "JavaScript", jsx: "JavaScript JSX",
  ts: "TypeScript", tsx: "TypeScript JSX", json: "JSON",
  md: "Markdown", py: "Python"
};
const COMMANDS = {
  undo, redo, selectAll, indent: indentMore, outdent: indentLess,
  comment: toggleComment, find: openSearchPanel, closeFind: closeSearchPanel,
  fold: foldCode, unfold: unfoldCode, foldAll, unfoldAll
};
const languageCache = new Map();
const separatorFor = text => text.match(/\r\n|\r|\n/)?.[0] || "\n";

function modeForPath(path) {
  const suffix = String(path || "").match(/\.([^./]+)$/)?.[1]?.toLowerCase();
  return MODES[suffix] || "";
}

export function languageName(path) {
  return LABELS[modeForPath(path)] || "Plain text";
}

function loadLanguage(mode) {
  if (languageCache.has(mode)) return languageCache.get(mode);

  const pending = (async () => {
    if (mode === "html") return (await import("@codemirror/lang-html")).html();
    if (mode === "css") return (await import("@codemirror/lang-css")).css();
    if (["js", "jsx", "ts", "tsx"].includes(mode)) {
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: mode === "ts" || mode === "tsx",
        jsx: mode === "jsx" || mode === "tsx"
      });
    }
    if (mode === "json") return (await import("@codemirror/lang-json")).json();
    if (mode === "md") return (await import("@codemirror/lang-markdown")).markdown();
    if (mode === "py") return (await import("@codemirror/lang-python")).python();
    return [];
  })().catch(error => {
    languageCache.delete(mode);
    throw error;
  });

  languageCache.set(mode, pending);
  return pending;
}

function appearance(settings) {
  const dark = settings.theme !== "light";
  const background = dark ? "#171a17" : "#f5f6f2";
  const ink = dark ? "#dce2d7" : "#252c22";
  const muted = dark ? "#9aa493" : "#5f6b59";
  const line = dark ? "#343c30" : "#d5dbce";
  const active = dark ? "#20261e" : "#eaf0e4";
  const selection = "var(--selection, " + (dark ? "#33452f" : "#dbe7d5") + ")";
  const accent = "var(--accent, " + (dark ? "#a6c28e" : "#3d692e") + ")";
  const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

  return [
    EditorView.theme({
      "&": {
        height: "100%", backgroundColor: background, color: ink,
        fontFamily: "inherit", fontSize: "var(--editor-font-size, 13px)"
      },
      "&.cm-focused": { outline: "1px solid " + accent, outlineOffset: "-1px" },
      ".cm-scroller": { fontFamily: mono, lineHeight: "1.5", overflow: "auto" },
      ".cm-content": { padding: "8px 0", caretColor: accent },
      ".cm-line": { padding: "0 12px" },
      ".cm-gutters": { backgroundColor: background, color: muted, borderRight: "1px solid " + line },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
      ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: active },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: accent },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: selection },
      ".cm-content ::selection": { backgroundColor: selection },
      ".cm-searchMatch": { backgroundColor: selection },
      ".cm-searchMatch-selected": { outline: "1px solid " + accent },
      "&.cm-focused .cm-matchingBracket": { backgroundColor: selection, color: accent },
      ".cm-panels": { backgroundColor: background, color: ink, fontSize: "12px" },
      ".cm-panels-top": { borderBottom: "1px solid " + line },
      ".cm-search": { padding: "8px 28px 8px 8px", display: "flex", flexWrap: "wrap", gap: "4px 8px" },
      ".cm-search br": { display: "none" },
      ".cm-textfield": { background: background, color: ink, border: "1px solid " + line, borderRadius: "2px", maxWidth: "100%" },
      ".cm-textfield:focus": { outline: "1px solid " + accent },
      ".cm-button, .cm-button:active": { background: active, backgroundImage: "none", color: ink, border: "1px solid " + line, borderRadius: "2px", boxShadow: "none" },
      ".cm-tooltip": { backgroundColor: background, color: ink, border: "1px solid " + line, borderRadius: "2px", boxShadow: "0 8px 24px #0003" },
      ".cm-tooltip-autocomplete > ul": { fontFamily: mono },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: selection, color: ink },
      ".cm-foldPlaceholder": { backgroundColor: active, color: muted, border: "1px solid " + line, borderRadius: "2px" }
    }, { dark }),
    syntaxHighlighting(HighlightStyle.define([
      { tag: tags.comment, color: muted },
      { tag: [tags.keyword, tags.tagName, tags.attributeName], color: accent },
      { tag: [tags.string, tags.number, tags.bool, tags.null], color: ink },
      { tag: [tags.heading, tags.strong], fontWeight: "600" },
      { tag: tags.emphasis, fontStyle: "italic" },
      { tag: tags.link, textDecoration: "underline" },
      { tag: tags.invalid, textDecoration: "underline wavy", textDecorationColor: dark ? "#e09a91" : "#a52d24" }
    ]))
  ];
}

export function createEditor({
  parent,
  settings = DEFAULT_SETTINGS,
  onChange = () => {},
  onCursor = () => {},
  onError = error => console.error(error)
} = {}) {
  if (!parent) throw new Error("The editor needs a container.");

  let preferences = { ...DEFAULT_SETTINGS, ...settings };
  let activeId = null, disposed = false, muted = false;
  const records = new Map();
  const syntax = new Compartment(), theme = new Compartment();
  const indentation = new Compartment(), wrapping = new Compartment();
  const identity = new Compartment();

  function attributes(path) {
    return EditorView.contentAttributes.of({
      "aria-label": path ? "Code editor: " + path : "Code editor",
      "aria-description": "Press Escape, then Tab to leave.",
      spellcheck: "false", autocorrect: "off", autocapitalize: "off"
    });
  }

  function indentationSettings() {
    return [
      EditorState.tabSize.of(preferences.tabSize),
      indentUnit.of(" ".repeat(preferences.tabSize))
    ];
  }

  function extensions(path) {
    return [
      keymap.of([indentWithTab]), basicSetup,
      syntax.of([]), theme.of(appearance(preferences)),
      indentation.of(indentationSettings()),
      wrapping.of(preferences.wrap ? EditorView.lineWrapping : []),
      identity.of(attributes(path)),
      EditorView.updateListener.of(handleUpdate),
      EditorView.exceptionSink.of(onError)
    ];
  }

  parent.style.setProperty("--editor-font-size", preferences.fontSize + "px");
  const view = new EditorView({
    parent, state: EditorState.create({ extensions: extensions("") })
  });
  view.dom.hidden = true;

  function emitChange(record) {
    onChange({ id: record.id, path: record.path, text: record.sourceText });
  }

  function emitCursor() {
    if (!activeId) return onCursor(null);
    const state = view.state, range = state.selection.main;
    const currentLine = state.doc.lineAt(range.head);
    onCursor({
      line: currentLine.number,
      column: range.head - currentLine.from + 1,
      selected: state.selection.ranges.reduce((sum, item) => sum + item.to - item.from, 0),
      cursors: state.selection.ranges.length,
      language: languageName(records.get(activeId).path)
    });
  }

  function handleUpdate(update) {
    const record = records.get(activeId);
    if (!record) return;
    record.state = update.state;
    if (update.docChanged) {
      record.sourceText = update.state.doc.sliceString(
        0, update.state.doc.length, record.separator
      );
      if (!muted) emitChange(record);
    }
    if (update.docChanged || update.selectionSet) emitCursor();
  }

  function remember() {
    const record = records.get(activeId);
    if (!record) return;
    record.state = view.state;
    record.scroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
    record.scrollEffect = view.scrollSnapshot();
  }

  function applyEffects(record, effects) {
    if (activeId === record.id) view.dispatch({ effects });
    else record.state = record.state.update({ effects }).state;
  }

  function recordFor(file, saved) {
    let record = records.get(file.id);
    if (record) {
      if (record.path !== file.path) {
        record.path = file.path;
        applyEffects(record, identity.reconfigure(attributes(file.path)));
      }
      return record;
    }

    const config = { extensions: extensions(file.path) };
    let state;
    if (saved != null) {
      try {
        if (saved.doc !== file.text) throw new Error("The saved text does not match.");
        state = EditorState.fromJSON(saved, config, { history: historyField });
      } catch (error) {
        onError(new Error(
          "Undo history for " + file.path + " could not be restored. File contents were kept.",
          { cause: error }
        ));
      }
    }
    state ||= EditorState.create({ ...config, doc: file.text });
    record = {
      id: file.id, path: file.path, state, sourceText: file.text,
      separator: separatorFor(file.text), mode: null, request: 0,
      scroll: {
        top: Number.isFinite(saved?.scroll?.top) ? Math.max(0, saved.scroll.top) : 0,
        left: Number.isFinite(saved?.scroll?.left) ? Math.max(0, saved.scroll.left) : 0
      }
    };
    records.set(file.id, record);
    return record;
  }

  function applyText(record, text, notify = true) {
    if (record.sourceText === text) return false;
    const before = record.state.doc.toString();
    const after = text.replace(/\r\n?/g, "\n");
    record.separator = separatorFor(text);
    record.sourceText = text;

    if (before === after) {
      if (notify) emitChange(record);
      return true;
    }

    let from = 0, oldEnd = before.length, newEnd = after.length;
    while (from < oldEnd && from < newEnd && before[from] === after[from]) from++;
    while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }

    const change = record.state.update({
      changes: { from, to: oldEnd, insert: after.slice(from, newEnd) },
      annotations: [Transaction.userEvent.of("input.replace"), isolateHistory.of("full")]
    });
    record.scrollEffect = record.scrollEffect?.map(change.changes);
    if (activeId === record.id) {
      const previous = muted;
      muted = !notify;
      try { view.dispatch(change); }
      finally { muted = previous; }
    } else {
      record.state = change.state;
      record.sourceText = change.state.doc.sliceString(0, change.state.doc.length, record.separator);
      if (notify) emitChange(record);
    }
    if (!notify) record.sourceText = text;
    return true;
  }

  async function ensureSyntax(record) {
    const mode = modeForPath(record.path);
    if (record.mode === mode && record.syntaxStatus !== "failed") return;
    record.mode = mode;
    record.syntaxStatus = "loading";
    const request = ++record.request;
    applyEffects(record, syntax.reconfigure([]));
    try {
      const support = await loadLanguage(mode);
      if (disposed || records.get(record.id) !== record || record.request !== request) return;
      record.syntaxStatus = "ready";
      applyEffects(record, syntax.reconfigure(support));
    } catch (error) {
      if (disposed || records.get(record.id) !== record || record.request !== request) return;
      record.syntaxStatus = "failed";
      if (activeId === record.id) onError(new Error(
        "Syntax support for " + languageName(record.path) +
        " could not load. Text editing remains available.",
        { cause: error }
      ));
    }
  }

  function select(from, to = from) {
    if (!activeId) return false;
    const limit = view.state.doc.length;
    const anchor = Math.max(0, Math.min(limit, from));
    const head = Math.max(0, Math.min(limit, to));
    view.dispatch({
      selection: { anchor, head },
      effects: EditorView.scrollIntoView(head, { y: "center" })
    });
    view.focus();
    return true;
  }

  const api = {
    open(file, saved) {
      if (!file || file.binary) { api.close(); return false; }
      remember();
      const record = recordFor(file, saved);
      applyText(record, file.text, false);
      const switching = activeId !== record.id;
      activeId = record.id;
      view.dom.hidden = false;
      if (switching || view.state !== record.state) {
        view.setState(record.state);
        if (record.scrollEffect) view.dispatch({ effects: record.scrollEffect });
        else view.requestMeasure({
          read: () => record.scroll,
          write: scroll => {
            if (activeId !== record.id) return;
            view.scrollDOM.scrollTop = scroll.top;
            view.scrollDOM.scrollLeft = scroll.left;
          }
        });
      }
      void ensureSyntax(record);
      emitCursor();
      return true;
    },
    close() {
      remember();
      view.contentDOM.blur();
      activeId = null;
      view.dom.hidden = true;
      onCursor(null);
    },
    replace(file, text, saved) {
      if (!file || file.binary) return false;
      return applyText(recordFor(file, saved), String(text));
    },
    configure(next) {
      preferences = { ...preferences, ...next };
      parent.style.setProperty("--editor-font-size", preferences.fontSize + "px");
      const effects = [
        theme.reconfigure(appearance(preferences)),
        indentation.reconfigure(indentationSettings()),
        wrapping.reconfigure(preferences.wrap ? EditorView.lineWrapping : [])
      ];
      for (const record of records.values()) applyEffects(record, effects);
      view.requestMeasure();
    },
    snapshot(previous = {}, files = null) {
      remember();
      const result = Object.assign(Object.create(null), previous);
      const allowed = files ? new Set(files.filter(file => !file.binary).map(file => file.id)) : null;
      if (allowed) for (const id of Object.keys(result)) if (!allowed.has(id)) delete result[id];
      for (const record of records.values()) {
        if (allowed && !allowed.has(record.id)) continue;
        result[record.id] = {
          ...record.state.toJSON({ history: historyField }),
          doc: record.sourceText, scroll: { ...record.scroll }
        };
      }
      return result;
    },
    retain(files) {
      const allowed = new Set(files.filter(file => !file.binary).map(file => file.id));
      if (activeId && !allowed.has(activeId)) api.close();
      for (const id of records.keys()) if (!allowed.has(id)) records.delete(id);
    },
    reset() {
      api.close();
      records.clear();
      view.setState(EditorState.create({ extensions: extensions("") }));
    },
    run(name) {
      const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
      if (!activeId || !command) return false;
      const handled = command(view);
      if (name !== "find") view.focus();
      return handled;
    },
    reveal(offset = 0, length = 0) {
      const source = records.get(activeId)?.sourceText;
      if (source == null) return false;
      const position = (value, end = false) => {
        let index = Math.max(0, Math.min(source.length, Math.trunc(Number(value)) || 0));
        if (source[index - 1] === "\r" && source[index] === "\n") index += end ? 1 : -1;
        return source.slice(0, index).replace(/\r\n?/g, "\n").length;
      };
      return select(position(offset), position(Number(offset) + Number(length), true));
    },
    goTo(line, column = 1) {
      if (!activeId) return false;
      const number = Math.max(1, Math.min(view.state.doc.lines, Math.trunc(Number(line)) || 1));
      const target = view.state.doc.line(number);
      return select(target.from + Math.max(0, Math.min(target.length, Math.trunc(Number(column) - 1) || 0)));
    },
    focus() { if (activeId) view.focus(); },
    getText(id = activeId) { return records.get(id)?.sourceText ?? null; },
    retrySyntax() { if (activeId) void ensureSyntax(records.get(activeId)); },
    destroy() {
      disposed = true;
      records.clear();
      activeId = null;
      view.destroy();
      onCursor(null);
    }
  };
  return api;
}
