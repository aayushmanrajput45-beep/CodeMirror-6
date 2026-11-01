import {
  DEFAULT_SETTINGS,
  cleanPath,
  makeId,
  newProject,
  readFile,
  restoreProject
} from "./core.js";

const DATABASE_NAME = "slate-app";
const STORE_NAME = "data";
const CHANNEL_NAME = "slate-storage";
const SIGNAL_KEY = "slate.storage-change";

export const IGNORED_FOLDERS = Object.freeze(["node_modules", ".git"]);

let databasePromise = null;
let liveDatabase = null;
let writeQueue = Promise.resolve();
let knownProjectToken;
let sessionId;
let channel = null;
let storageListener = null;

const subscribers = new Set();
const session = () => sessionId ||= makeId();

export class ProjectConflictError extends Error {
  constructor() {
    super(
      "The browser copy changed since this tab loaded it. " +
      "Export this tab’s project as a ZIP before reloading."
    );
    this.name = "ProjectConflictError";
  }
}

function storageError(error, fallback = "Browser storage failed.") {
  if (error instanceof ProjectConflictError) return error;

  const messages = {
    QuotaExceededError:
      "Browser storage has no room for this save. Export a ZIP to keep your work.",
    SecurityError:
      "Browser storage is blocked. Changes can remain only in this tab.",
    InvalidStateError:
      "Browser storage was closed. Reload before saving again.",
    VersionError:
      "This browser has Slate data from a newer app version.",
    AbortError:
      "Browser storage interrupted the operation. Try saving again."
  };

  const detail = error?.message ? " " + error.message : "";
  const result = new Error(
    messages[error?.name] || fallback + detail,
    { cause: error }
  );
  result.name = error?.name || "StorageError";
  return result;
}

export function readThemePreference() {
  try {
    const theme = localStorage.getItem("slate.theme");
    if (theme === "light" || theme === "dark") return theme;
  } catch {}
  return DEFAULT_SETTINGS.theme;
}

export function normalizeSettings(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const settings = { ...DEFAULT_SETTINGS, theme: readThemePreference() };

  if (input.theme === "dark" || input.theme === "light") {
    settings.theme = input.theme;
  }
  if ([11, 12, 13, 14, 20, 28].includes(input.fontSize)) {
    settings.fontSize = input.fontSize;
  }
  if ([2, 4].includes(input.tabSize)) settings.tabSize = input.tabSize;

  for (const key of ["wrap", "live", "external"]) {
    if (typeof input[key] === "boolean") settings[key] = input[key];
  }

  return settings;
}

export function openDatabase() {
  if (databasePromise) return databasePromise;

  const pending = new Promise((resolve, reject) => {
    let settled = false;
    let request;

    const fail = error => {
      if (settled) return;
      settled = true;
      reject(storageError(error, "Browser storage could not be opened."));
    };

    try {
      if (!globalThis.indexedDB) {
        throw new Error("This browser does not provide project storage.");
      }

      request = indexedDB.open(DATABASE_NAME, 1);

      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction.abort();
          return;
        }
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };

      request.onblocked = () => fail(
        new Error("Another Slate tab is blocking storage. Close it and retry.")
      );

      request.onerror = () => fail(request.error);

      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }

        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.close();
          fail(new Error("The saved browser database has an unknown structure."));
          return;
        }

        settled = true;
        liveDatabase = database;

        const invalidate = () => {
          if (liveDatabase !== database) return;
          liveDatabase = null;
          databasePromise = null;
        };

        database.onversionchange = () => {
          database.close();
          invalidate();
        };
        database.onclose = invalidate;
        resolve(database);
      };
    } catch (error) {
      fail(error);
    }
  });

  databasePromise = pending;
  pending.catch(() => {
    if (databasePromise === pending) databasePromise = null;
  });

  return pending;
}

function transaction(database, mode, operation) {
  return new Promise((resolve, reject) => {
    let active;
    let result;
    let failure = null;

    const abort = error => {
      failure = error;
      try { active.abort(); }
      catch { reject(failure); }
    };

    try {
      active = database.transaction(STORE_NAME, mode);
      active.oncomplete = () => resolve(result);
      active.onabort = () => reject(
        failure || storageError(active.error)
      );
      active.onerror = event => {
        failure ||= storageError(event.target?.error || active.error);
      };

      operation(
        active.objectStore(STORE_NAME),
        value => { result = value; },
        abort
      );
    } catch (error) {
      const wrapped = storageError(error);
      if (active) abort(wrapped);
      else reject(wrapped);
    }
  });
}

function queueWrite(operation) {
  const pending = writeQueue.then(operation);
  writeQueue = pending.catch(() => {});
  return pending;
}

function decodeProjectRecord(record) {
  if (record == null) return { project: null, token: null };

  if (
    record.kind === "slate-project" &&
    record.format === 1 &&
    typeof record.token === "string" &&
    record.project
  ) {
    return { project: record.project, token: record.token };
  }

  if (Array.isArray(record.files)) {
    return {
      project: record,
      token: "legacy:" + (record.id || "") + ":" + (record.updatedAt || "")
    };
  }

  throw new Error(
    "The saved browser project is unreadable. It has not been replaced."
  );
}

export async function loadWorkspace() {
  await writeQueue;
  const database = await openDatabase();

  const records = await transaction(database, "readonly", (store, setResult) => {
    const result = {};
    const projectRequest = store.get("project");
    const settingsRequest = store.get("settings");

    projectRequest.onsuccess = () => {
      result.project = projectRequest.result;
    };
    settingsRequest.onsuccess = () => {
      result.settings = settingsRequest.result;
    };
    setResult(result);
  });

  const decoded = decodeProjectRecord(records.project);
  const project = decoded.project ? restoreProject(decoded.project) : null;
  knownProjectToken = decoded.token;

  return {
    project,
    settings: normalizeSettings(records.settings)
  };
}

export async function saveProject(project) {
  const snapshot = restoreProject(project);
  snapshot.history = structuredClone(snapshot.history);
  snapshot.updatedAt = Date.now();

  return queueWrite(async () => {
    const database = await openDatabase();

    const token = await transaction(database, "readwrite", (store, setResult, abort) => {
      const request = store.get("project");

      request.onsuccess = () => {
        try {
          const current = decodeProjectRecord(request.result);
          const firstEmptySave =
            knownProjectToken === undefined && current.token === null;

          if (!firstEmptySave && current.token !== knownProjectToken) {
            throw new ProjectConflictError();
          }

          const nextToken = makeId();
          store.put({
            kind: "slate-project",
            format: 1,
            token: nextToken,
            writer: session(),
            project: snapshot
          }, "project");
          setResult(nextToken);
        } catch (error) {
          abort(error);
        }
      };
    });

    knownProjectToken = token;
    publishChange("project", token);
    return { token, updatedAt: snapshot.updatedAt };
  });
}

export function saveSettings(value) {
  const settings = normalizeSettings(value);

  try { localStorage.setItem("slate.theme", settings.theme); }
  catch {}

  return queueWrite(async () => {
    const database = await openDatabase();
    await transaction(database, "readwrite", (store, setResult) => {
      store.put(settings, "settings");
      setResult(settings);
    });
    publishChange("settings", makeId());
    return settings;
  });
}

function publishChange(key, token) {
  const message = {
    source: CHANNEL_NAME,
    writer: session(),
    key,
    token,
    savedAt: Date.now()
  };

  try { channel?.postMessage(message); }
  catch {}
  try { localStorage.setItem(SIGNAL_KEY, JSON.stringify(message)); }
  catch {}
}

function receiveChange(message) {
  if (
    !message ||
    message.source !== CHANNEL_NAME ||
    message.writer === session() ||
    !["project", "settings"].includes(message.key) ||
    typeof message.token !== "string"
  ) return;

  const change = Object.freeze({
    key: message.key,
    token: message.token,
    savedAt: message.savedAt
  });

  for (const listener of subscribers) listener(change);
}

export function subscribeStorageChanges(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("A storage-change listener must be a function.");
  }

  subscribers.add(listener);

  if (!storageListener) {
    storageListener = event => {
      if (event.key !== SIGNAL_KEY || !event.newValue) return;
      try { receiveChange(JSON.parse(event.newValue)); }
      catch {}
    };
    globalThis.addEventListener?.("storage", storageListener);

    if (typeof BroadcastChannel === "function") {
      try {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = event => receiveChange(event.data);
      } catch {}
    }
  }

  return () => {
    subscribers.delete(listener);
    if (subscribers.size) return;
    globalThis.removeEventListener?.("storage", storageListener);
    storageListener = null;
    channel?.close();
    channel = null;
  };
}

function importPath(value) {
  if (value !== value.trim()) {
    throw new Error("This importer cannot preserve surrounding spaces in: " + value);
  }
  if (value.includes("\\")) {
    throw new Error("Backslashes in file names are not supported: " + value);
  }
  if (value.split("/").includes("..")) {
    throw new Error("The selected file has an unsafe path: " + value);
  }
  return cleanPath(value);
}

export async function readDirectory(handle, { onProgress = () => {} } = {}) {
  if (!handle || handle.kind !== "directory") {
    throw new Error("Choose a folder to import.");
  }

  const files = [], dirs = [], excluded = [];

  async function walk(directory, prefix = "") {
    for await (const entry of directory.values()) {
      const path = importPath(prefix + entry.name);

      if (entry.kind === "directory") {
        if (IGNORED_FOLDERS.includes(entry.name)) {
          excluded.push(path);
          continue;
        }
        dirs.push(path);
        onProgress({ path, filesRead: files.length });
        await walk(entry, path + "/");
      } else if (entry.kind === "file") {
        onProgress({ path, filesRead: files.length });
        files.push(await readFile(await entry.getFile(), path));
      }
    }
  }

  await walk(handle);

  return {
    project: newProject(handle.name, files, dirs),
    excluded,
    source: "directory",
    emptyFoldersPreserved: true
  };
}

export async function readFiles(
  fileList,
  { name, directory = false, onProgress = () => {} } = {}
) {
  const selected = Array.from(fileList || []);
  const files = [], excluded = new Set();
  const fromFolder = directory || selected.some(file => file.webkitRelativePath);
  const firstRoot = selected[0]?.webkitRelativePath?.split("/")[0];

  for (const file of selected) {
    const relative = file.webkitRelativePath || "";
    if (relative.split("/").includes("..")) {
      throw new Error("The selected file has an unsafe path: " + relative);
    }

    const parts = relative ? relative.split("/").slice(1) : [];
    const raw = parts.length ? parts.join("/") : file.name;
    if (typeof raw !== "string" || !raw) {
      throw new Error("A selected file has no name.");
    }

    const path = importPath(raw);
    const parents = path.split("/").slice(0, -1);
    const ignored = parents.findIndex(part => IGNORED_FOLDERS.includes(part));

    if (ignored !== -1) {
      excluded.add(parents.slice(0, ignored + 1).join("/"));
      continue;
    }

    onProgress({ path, filesRead: files.length });
    files.push(await readFile(file, path));
  }

  return {
    project: newProject(name || firstRoot || "Imported project", files),
    excluded: [...excluded],
    source: fromFolder ? "directory-picker" : "files",
    emptyFoldersPreserved: false
  };
}
