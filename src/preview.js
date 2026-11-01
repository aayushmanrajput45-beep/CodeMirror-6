import { makeId, mime, basename, download } from "./core.js";
import {
  buildPreview,
  PREVIEW_CHANNEL,
  PREVIEW_ORIGIN
} from "./preview-build.js";

export { buildPreview };

const isPage = file =>
  file && !file.binary && /\.(html?|md|markdown)$/i.test(file.path);

function defaultDownload(file) {
  download(
    file.binary ? file.data : file.text,
    basename(file.path),
    mime(file.path)
  );
}

export function createPreview({
  frame,
  onConsole = () => {},
  onStatus = () => {},
  onNavigate = () => {},
  onDownload = defaultDownload
} = {}) {
  if (!frame || frame.localName !== "iframe" || !frame.contentWindow) {
    throw new Error("The preview needs an attached iframe element.");
  }

  const owner = frame.ownerDocument.defaultView;
  if (!owner) throw new Error("The preview frame has no browser window.");

  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.setAttribute("referrerpolicy", "no-referrer");

  let current = null;
  let serial = 0;
  let destroyed = false;

  function call(callback, ...args) {
    if (typeof callback !== "function") return;
    try {
      const result = callback(...args);
      if (result && typeof result.then === "function") {
        result.catch(error => console.error("Slate preview callback:", error));
      }
    } catch (error) {
      console.error("Slate preview callback:", error);
    }
  }

  function status(state, message = "", extra = {}) {
    call(onStatus, { state, message, ...extra });
  }

  function active(record) {
    return Boolean(
      !destroyed && record && current === record && !record.disposed
    );
  }

  function log(level, text, record = current, source = "") {
    call(onConsole, {
      level,
      text,
      source: source || record?.entry || "Slate",
      stale: Boolean(record?.stale)
    });
  }

  function stopTimer(record, name) {
    if (!record) return;
    clearTimeout(record[name]);
    record[name] = 0;
  }

  function dispose(record) {
    if (!record || record.disposed) return;
    record.disposed = true;
    stopTimer(record, "completionTimer");
    stopTimer(record, "probeTimer");
    if (record.port) {
      record.port.onmessage = null;
      record.port.onmessageerror = null;
      record.port.close();
    }
  }

  function send(record, type, values = {}, transfer = []) {
    if (!active(record) || !record.port || record.left) return false;
    record.port.postMessage({
      ...values,
      type,
      channel: PREVIEW_CHANNEL,
      token: record.token
    }, transfer);
    return true;
  }

  function failed(record, message, source = "") {
    if (!active(record)) return;
    record.error = message;
    stopTimer(record, "completionTimer");
    log("error", message, record, source);
    if (!record.stale) {
      status("error", message, { stale: false });
    }
  }

  function navigated(record) {
    if (!active(record) || record.left) return;
    record.left = true;
    stopTimer(record, "completionTimer");
    stopTimer(record, "probeTimer");
    if (!record.stale) {
      status(
        "navigated",
        "The preview left the project page. Run preview to return.",
        { stale: false }
      );
    }
  }

  function localURL(value, record) {
    if (typeof value !== "string") {
      throw new Error("The preview supplied an invalid file address.");
    }
    const base = PREVIEW_ORIGIN + "/" +
      record.entry.split("/").map(encodeURIComponent).join("/");
    const url = new URL(value, base);
    if (url.origin !== PREVIEW_ORIGIN) {
      throw new Error("The file bridge only reads files from this project.");
    }
    url.hash = "";
    return {
      url: url.href,
      path: decodeURIComponent(url.pathname.slice(1))
    };
  }

  function replyToFetch(record, message) {
    if (!Number.isSafeInteger(message.id) || message.id < 1) return;

    try {
      const method = typeof message.method === "string"
        ? message.method.toUpperCase() : "";

      if (method !== "GET" && method !== "HEAD") {
        throw new Error("Local preview files only support GET and HEAD.");
      }

      const target = localURL(message.url, record);
      const file = record.files.get(target.path);
      const content = file
        ? file.binary
          ? new Uint8Array(file.data)
          : new TextEncoder().encode(file.text)
        : new TextEncoder().encode("File not found: " + target.path);

      const body = method === "HEAD"
        ? new ArrayBuffer(0)
        : content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength
        );

      send(record, "fetch-result", {
        id: message.id,
        url: target.url,
        status: file ? 200 : 404,
        statusText: file ? "OK" : "Not Found",
        headers: {
          "Content-Type": file ? mime(file.path) : "text/plain; charset=utf-8",
          "Content-Length": String(content.byteLength)
        },
        body
      }, [body]);
    } catch (error) {
      send(record, "fetch-result", {
        id: message.id,
        error: error?.message || String(error)
      });
    }
  }

  function openLink(record, message) {
    try {
      const target = localURL(message.url, record);
      const file = record.files.get(target.path);

      if (!file) {
        log("warn", "Linked file not found: " + target.path, record);
        return;
      }

      if (message.download || !isPage(file)) {
        const activation = owner.navigator.userActivation;
        if (activation && !activation.isActive) {
          log("warn", "Click the file link again to download it.", record);
          return;
        }
        call(onDownload, file);
      } else {
        call(onNavigate, file.path, target.url);
      }
    } catch (error) {
      log("warn", error?.message || String(error), record);
    }
  }

  function receive(record, message) {
    if (!active(record) || record.left || !message ||
        message.channel !== PREVIEW_CHANNEL ||
        message.token !== record.token) return;

    if (message.type === "fetch") {
      replyToFetch(record, message);
    } else if (message.type === "console") {
      const levels = ["log", "info", "warn", "error", "debug", "clear"];
      const level = levels.includes(message.level) ? message.level : "log";
      if (level === "clear" && record.stale) return;
      if (level !== "clear" && typeof message.text !== "string") return;
      log(
        level,
        level === "clear" ? "" : message.text,
        record,
        typeof message.source === "string" ? message.source : record.entry
      );
    } else if (message.type === "error") {
      failed(
        record,
        typeof message.message === "string"
          ? message.message : "The preview reported an error.",
        typeof message.source === "string" ? message.source : record.entry
      );
    } else if (message.type === "ready") {
      record.ready = true;
      stopTimer(record, "completionTimer");

      if (typeof message.error === "string" && message.error) {
        record.error = message.error;
      }

      if (!record.stale) {
        status(
          record.error ? "error" : "ready",
          record.error || "",
          {
            stale: false,
            warnings: Number.isSafeInteger(message.warnings) &&
              message.warnings > 0 ? message.warnings : 0
          }
        );
      }
    } else if (message.type === "pong") {
      if (message.id === record.probeId) {
        stopTimer(record, "probeTimer");
        record.probeId = "";
      }
    } else if (message.type === "navigate") {
      openLink(record, message);
    } else if (message.type === "leaving") {
      navigated(record);
    }
  }

  function handshake(event) {
    const record = current;
    const message = event.data;

    if (!active(record) || event.source !== frame.contentWindow ||
        event.origin !== "null" || !message ||
        message.channel !== PREVIEW_CHANNEL) return;

    if (message.token !== record.token) {
      for (const port of event.ports || []) port.close();
      return;
    }

    if (message.type === "bootstrap-error" && !record.port) {
      failed(
        record,
        typeof message.message === "string"
          ? message.message : "The preview could not start."
      );
      return;
    }

    if (message.type !== "hello") return;

    if (record.port || record.left) {
      for (const port of event.ports || []) port.close();
      return;
    }

    const port = event.ports?.[0];
    if (!port) return;

    record.port = port;
    port.onmessage = received => receive(record, received.data);
    port.onmessageerror = () => {
      failed(record, "A preview message could not be read.");
    };
    port.start();

    for (const extra of [...event.ports].slice(1)) extra.close();
  }

  function loaded() {
    const record = current;
    if (!active(record) || record.left || !record.port) return;

    stopTimer(record, "probeTimer");
    record.probeId = makeId();

    try {
      send(record, "probe", { id: record.probeId });
      record.probeTimer = setTimeout(() => {
        record.probeTimer = 0;
        navigated(record);
      }, 1500);
    } catch {
      navigated(record);
    }
  }

  owner.addEventListener("message", handshake);
  frame.addEventListener("load", loaded);

  async function run(project, options = {}) {
    if (destroyed) return false;
    const request = ++serial;
    if (current) current.stale = true;

    status("loading", "", { stale: Boolean(current) });

    let compiled;
    try {
      compiled = await buildPreview(project, {
        ...options,
        token: makeId()
      });
    } catch (error) {
      if (destroyed || request !== serial) return false;
      const message = error?.message || String(error);
      log("error", message);
      status("error", message, { stale: Boolean(current) });
      return false;
    }

    if (destroyed || request !== serial) return false;

    const previous = current;
    const record = {
      token: compiled.token,
      entry: compiled.entry,
      files: compiled.files,
      port: null,
      ready: false,
      left: false,
      stale: false,
      disposed: false,
      error: "",
      probeId: "",
      probeTimer: 0,
      completionTimer: 0
    };

    current = record;

    try {
      frame.srcdoc = compiled.html;
    } catch (error) {
      current = previous;
      dispose(record);
      const message = error?.message || String(error);
      log("error", message);
      status("error", message, { stale: Boolean(previous) });
      return false;
    }

    dispose(previous);

    record.completionTimer = setTimeout(() => {
      record.completionTimer = 0;
      if (!active(record) || record.ready || record.left) return;
      const message = record.port
        ? "The page has not reported finishing. It may be waiting on a script or resource."
        : "The preview has not reported starting. Run again or check Console.";
      failed(record, message);
    }, 20000);

    status("loading", "", { stale: false });
    return active(record);
  }

  function clear() {
    serial++;
    dispose(current);
    current = null;
    try {
      frame.srcdoc = "";
    } catch (error) {
      console.error("Slate could not clear the preview:", error);
    }
    if (!destroyed) status("idle");
  }

  function destroy() {
    if (destroyed) return;
    clear();
    destroyed = true;
    owner.removeEventListener("message", handshake);
    frame.removeEventListener("load", loaded);
  }

  return { run, clear, destroy };
}
