export const NL = "\n";

export const DEFAULT_SETTINGS = Object.freeze({
  theme: "dark",
  fontSize: 13,
  tabSize: 2,
  wrap: true,
  live: true,
  external: false
});

const PAGE_TYPES = new Set(["html", "htm", "md", "markdown"]);
const BINARY_TYPES = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico",
  "woff", "woff2", "ttf", "otf", "mp3", "wav", "ogg",
  "mp4", "webm", "pdf", "zip", "gz", "bin", "wasm"
]);

const MIME_TYPES = {
  html: "text/html", htm: "text/html", css: "text/css",
  js: "text/javascript", mjs: "text/javascript",
  ts: "text/javascript", jsx: "text/javascript", tsx: "text/javascript",
  json: "application/json", md: "text/markdown", txt: "text/plain",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", ico: "image/x-icon", woff: "font/woff",
  woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf",
  wasm: "application/wasm"
};

export function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export const basename = path => String(path).split("/").pop();
export const dirname = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
export const ext = path => {
  const name = basename(path);
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
};
export const mime = path => MIME_TYPES[ext(path)] || "application/octet-stream";
export const remote = value => /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//");
export const isPage = file => !file.binary && PAGE_TYPES.has(ext(file.path));

export function safeJSON(value) {
  return (JSON.stringify(value) ?? "null").replaceAll("<", "\\u003c");
}

export function cleanPath(value) {
  const raw = String(value ?? "").trim().replaceAll("\\", "/");
  if (!raw || raw.includes("\0")) throw new Error("Enter a valid file or folder name.");
  if (raw.startsWith("/") || /^[a-z]:/i.test(raw)) {
    throw new Error("Use a path inside this project, without a leading slash or drive name.");
  }
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("That path leaves this project.");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (!parts.length) throw new Error("Enter a file or folder name.");
  return parts.join("/");
}

export function resolveFile(files, spec, from) {
  const raw = String(spec).split("#")[0].split("?")[0];
  if (!raw) {
    const current = files.find(file => file.path === from);
    if (current) return current;
  }
  let decoded;
  try { decoded = decodeURIComponent(raw); }
  catch { throw new Error("Invalid file address: " + spec); }
  const joined = decoded.startsWith("/") ? decoded.slice(1) : dirname(from) + decoded;
  const path = joined ? cleanPath(joined) : "";
  const prefix = path ? path + "/" : "";
  const candidates = [
    ...(path ? [path] : []),
    ...["js", "ts", "jsx", "tsx", "json", "css"].map(type => path + "." + type),
    ...["js", "ts", "html", "htm"].map(type => prefix + "index." + type)
  ];
  for (const candidate of candidates) {
    const file = files.find(item => item.path === candidate);
    if (file) return file;
  }
  throw new Error("File not found: " + spec + " in " + from);
}

export function folderPaths(project) {
  const folders = new Set(project.dirs || []);
  const paths = [...project.files.map(file => file.path), ...folders];
  for (const path of paths) {
    let parent = dirname(path);
    while (parent) {
      const folder = parent.slice(0, -1);
      folders.add(folder);
      parent = dirname(folder);
    }
  }
  return folders;
}

export function base64(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
  }
  return btoa(chunks.join(""));
}

export function dataURL(file) {
  const bytes = file.binary
    ? new Uint8Array(file.data)
    : new TextEncoder().encode(file.text);
  return "data:" + mime(file.path) + ";base64," + base64(bytes);
}

export async function readFile(file, path = file.name) {
  const normalized = cleanPath(path);
  const data = new Uint8Array(await file.arrayBuffer());
  const record = { id: makeId(), path: normalized };
  if (BINARY_TYPES.has(ext(normalized)) || data.includes(0)) {
    return { ...record, binary: true, data };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    return { ...record, binary: false, text };
  } catch {
    return { ...record, binary: true, data };
  }
}

export function newProject(name, files = [], dirs = []) {
  const paths = new Set(), ids = new Set();
  const records = files.map(source => {
    const path = cleanPath(source.path);
    if (paths.has(path)) throw new Error("Duplicate file: " + path);
    paths.add(path);
    const id = typeof source.id === "string" && source.id ? source.id : makeId();
    if (ids.has(id)) throw new Error("Two files have the same internal ID.");
    ids.add(id);
    if (source.binary === true) {
      if (!(source.data instanceof Uint8Array) && !(source.data instanceof ArrayBuffer)) {
        throw new Error("Missing binary data: " + path);
      }
      return { id, path, binary: true, data: new Uint8Array(source.data) };
    }
    if (typeof source.text !== "string") throw new Error("Missing file text: " + path);
    return { id, path, binary: false, text: source.text };
  });
  const folders = folderPaths({ files: records, dirs: dirs.map(cleanPath) });
  for (const folder of folders) {
    if (paths.has(folder)) throw new Error("A file is also being used as a folder: " + folder);
  }
  const pages = records.filter(isPage);
  const entry = pages.find(file => file.path === "index.html")
    || pages.find(file => file.path === "index.htm") || pages[0];
  const first = entry || records.find(file => !file.binary) || records[0];
  const now = Date.now();
  return {
    version: 1, id: makeId(), name: String(name ?? "").trim() || "Untitled",
    files: records, dirs: [...folders], active: first?.path || null,
    tabs: first ? [first.path] : [], entry: entry?.path || null,
    history: {}, createdAt: now, updatedAt: now
  };
}

export function restoreProject(value) {
  if (!value || !Array.isArray(value.files)) throw new Error("The saved project is invalid.");
  const project = newProject(value.name, value.files, Array.isArray(value.dirs) ? value.dirs : []);
  const paths = new Set(project.files.map(file => file.path));
  if (typeof value.id === "string" && value.id) project.id = value.id;
  if (Number.isFinite(value.createdAt)) project.createdAt = value.createdAt;
  if (Number.isFinite(value.updatedAt)) project.updatedAt = value.updatedAt;
  if (Array.isArray(value.tabs)) {
    project.tabs = [...new Set(value.tabs.filter(path => paths.has(path)))];
  }
  if (value.active === null) project.active = null;
  else if (paths.has(value.active)) project.active = value.active;
  else project.active = project.tabs[0] || null;
  if (project.active && !project.tabs.includes(project.active)) project.tabs.push(project.active);
  if (value.entry === null) project.entry = null;
  else if (project.files.some(file => file.path === value.entry && isPage(file))) {
    project.entry = value.entry;
  }
  if (value.history && typeof value.history === "object") {
    project.history = Object.fromEntries(project.files
      .filter(file => Object.hasOwn(value.history, file.id))
      .map(file => [file.id, value.history[file.id]]));
  }
  return project;
}

export const blankProject = () => newProject("Untitled", [{ path: "index.html", text: "" }]);

function literalPattern(query, matchCase) {
  const escaped = String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, matchCase ? "gu" : "giu");
}

export function searchFiles(files, query, matchCase = false) {
  if (!query) return [];
  const pattern = literalPattern(query, matchCase), results = [];
  for (const file of files) {
    if (file.binary) continue;
    let line = 1, lineStart = 0, nextBreak = file.text.indexOf(NL);
    for (const match of file.text.matchAll(pattern)) {
      while (nextBreak !== -1 && nextBreak < match.index) {
        line++;
        lineStart = nextBreak + 1;
        nextBreak = file.text.indexOf(NL, lineStart);
      }
      results.push({
        path: file.path, offset: match.index, length: match[0].length, line,
        text: file.text.slice(lineStart, nextBreak === -1 ? file.text.length : nextBreak)
      });
    }
  }
  return results;
}

export function replaceMatches(text, query, replacement, matchCase = false) {
  if (!query) return text;
  return text.replace(literalPattern(query, matchCase), () => String(replacement ?? ""));
}

export async function zipProject(project) {
  const { zip, strToU8 } = await import("fflate");
  const safe = restoreProject(project), contents = Object.create(null);
  for (const dir of safe.dirs) contents[dir + "/"] = new Uint8Array();
  for (const file of safe.files) {
    contents[file.path] = file.binary ? new Uint8Array(file.data) : strToU8(file.text);
  }
  return new Promise((resolve, reject) => {
    zip(contents, { level: 6 }, (error, data) => error ? reject(error) : resolve(data));
  });
}

export async function unzipProject(file) {
  const { Unzip, AsyncUnzipInflate } = await import("fflate");
  const bytes = new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const results = [], dirs = [], streams = [];
    let pending = 0, parsed = false, settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      for (const stream of streams) { try { stream.terminate?.(); } catch {} }
      reject(error);
    };
    const finish = () => {
      if (!parsed || pending || settled) return;
      try {
        const name = basename(file.name || "Imported project.zip").replace(/[.]zip$/i, "");
        const project = newProject(name, results.filter(Boolean), dirs);
        settled = true;
        resolve(project);
      } catch (error) { fail(error); }
    };
    const reader = new Unzip(entry => {
      if (settled) { entry.terminate?.(); return; }
      streams.push(entry);
      try {
        const raw = entry.name.replaceAll("\\", "/");
        if (raw.split("/").includes("..")) throw new Error("Unsafe ZIP path: " + entry.name);
        const path = cleanPath(raw), directory = raw.endsWith("/");
        const position = results.length, chunks = [];
        results.push(null);
        pending++;
        entry.ondata = (error, chunk, final) => {
          if (settled) return;
          if (error) { fail(error); return; }
          if (!directory) chunks.push(chunk);
          if (!final) return;
          (async () => {
            if (directory) dirs.push(path);
            else results[position] = await readFile(new Blob(chunks), path);
            pending--;
            finish();
          })().catch(fail);
        };
        entry.start();
      } catch (error) { fail(error); }
    });
    reader.register(AsyncUnzipInflate);
    try { reader.push(bytes, true); parsed = true; finish(); }
    catch (error) { fail(error); }
  });
}

export function download(data, name, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = String(name).replaceAll("/", "-").replaceAll("\\", "-");
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const STARTER_CSS = `body { font: 14px/1.5 system-ui, sans-serif; max-width: 680px; margin: 40px auto; padding: 0 24px; color: #253022; background: #fff; }
h1 { font-size: 28px; line-height: 1.2; }
h2 { font-size: 20px; }
button, input { font: inherit; color: inherit; border: 1px solid #788572; border-radius: 2px; background: white; padding: 8px 12px; }
button { cursor: pointer; }
section { margin-top: 32px; }
form, li, li label { display: flex; align-items: center; gap: 8px; }
form { flex-wrap: wrap; }
ul { padding: 0; list-style: none; }
li { margin: 12px 0; }
li label { flex: 1; }
input[type=checkbox] { width: 16px; height: 16px; }
input:checked + span { text-decoration: line-through; }
button:focus-visible, input:focus-visible { outline: 1px solid #316c3f; outline-offset: 2px; }`;

const TASK_SCRIPT = `const form = document.querySelector("#tasks");
const list = document.querySelector("#list");
const empty = document.querySelector("#empty");
form.onsubmit = event => {
  event.preventDefault();
  const input = document.querySelector("#task");
  const text = input.value.trim();
  if (!text) return;
  const row = document.createElement("li");
  const label = document.createElement("label");
  const check = document.createElement("input");
  check.type = "checkbox";
  const content = document.createElement("span");
  content.textContent = text;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove";
  remove.onclick = () => {
    row.remove();
    empty.hidden = list.children.length !== 0;
  };
  label.append(check, content);
  row.append(label, remove);
  list.append(row);
  empty.hidden = true;
  input.value = "";
  input.focus();
};`;

export function starter(kind) {
  const examples = {
    "Personal site": {
      html: "<p>Personal site example</p><h1>My website</h1><section><h2>About</h2><p>I can introduce myself here.</p></section><section><h2>My work</h2><p>A place to describe the things I make.</p></section>",
      script: ""
    },
    "Landing page": {
      html: '<p>Landing page example</p><h1>A landing page</h1><p>This example connects a page, a stylesheet, and a script.</p><button id="details">Show details</button><p id="more" hidden>The button changes this section without reloading the page.</p>',
      script: `const button = document.querySelector("#details");
const more = document.querySelector("#more");
button.onclick = () => {
  more.hidden = !more.hidden;
  button.textContent = more.hidden ? "Show details" : "Hide details";
};`
    },
    "Small app": {
      html: '<p>Small app example</p><h1>Task list</h1><form id="tasks"><label for="task">Task</label><input id="task" required autocomplete="off"><button>Add task</button></form><p id="empty">No tasks yet.</p><ul id="list"></ul><p>These example tasks reset when the preview reloads.</p>',
      script: TASK_SCRIPT
    }
  };
  const example = examples[kind];
  if (!example) throw new Error("Unknown starter project.");
  const html = [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>" + esc(kind) + " example</title>",
    '<link rel="stylesheet" href="styles.css">', "</head>", "<body>", example.html,
    example.script ? '<script src="app.js" defer></script>' : "", "</body>", "</html>"
  ].filter(Boolean).join(NL);
  const files = [{ path: "index.html", text: html }, { path: "styles.css", text: STARTER_CSS }];
  if (example.script) files.push({ path: "app.js", text: example.script });
  return newProject(kind, files);
}
