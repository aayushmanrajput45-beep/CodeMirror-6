export function previewRuntime(payload) {
  setTimeout(() => {
    const objectURLs = [];
    let post;

    try {
      const channel = new MessageChannel();
      const port = channel.port1;
      const pending = new Map();
      const assetURLs = new Map();
      const assetPaths = new Map();
      const moduleURLs = new Map();
      const sourcePaths = new Map();
      const loadedScripts = new Set();
      const NativeRequest = window.Request;
      const NativeResponse = window.Response;
      const nativeFetch = window.fetch.bind(window);
      let sequence = 0;
      let firstError = "";
      let warningCount = payload.warnings.length;

      post = (type, values = {}, transfer = []) => {
        port.postMessage({
          ...values,
          type,
          channel: payload.channel,
          token: payload.token
        }, transfer);
      };

      parent.postMessage({
        type: "hello",
        channel: payload.channel,
        token: payload.token
      }, "*", [channel.port2]);

      function quote(value) {
        return String(value).replaceAll("&", "&amp;")
          .replaceAll('"', "&quot;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      }

      function format(value) {
        if (typeof value === "string") return value;
        if (typeof value === "bigint") return value.toString() + "n";
        if (value instanceof Error) return value.stack || value.message;
        try {
          const seen = new WeakSet();
          return JSON.stringify(value, (_, item) => {
            if (typeof item === "bigint") return item.toString() + "n";
            if (item && typeof item === "object") {
              if (seen.has(item)) return "[Circular]";
              seen.add(item);
            }
            return item;
          }) ?? String(value);
        } catch {
          try {
            return String(value);
          } catch {
            return "[Unable to display this value]";
          }
        }
      }

      function failure(error, source = payload.entry) {
        const message = error?.message || String(error);
        firstError ||= message;
        post("error", { message, source });
      }

      function warn(message) {
        warningCount++;
        post("console", {
          level: "warn",
          source: payload.entry,
          text: message
        });
      }

      function replaceAssets(value) {
        let text = String(value ?? "");
        for (const [tag, url] of assetURLs) {
          text = text.split(tag).join(url);
        }
        return text;
      }

      function virtualURL(path) {
        return payload.origin + "/" +
          path.split("/").map(encodeURIComponent).join("/");
      }

      function makeURL(parts, type) {
        const url = URL.createObjectURL(new Blob(parts, { type }));
        objectURLs.push(url);
        return url;
      }

      for (const asset of [...payload.assets].reverse()) {
        const data = asset.bytes !== undefined
          ? Uint8Array.from(atob(asset.bytes), value => value.charCodeAt(0))
          : replaceAssets(asset.text);
        const url = makeURL([data], asset.type);
        assetURLs.set(asset.tag, url);
        assetPaths.set(url, asset.path);
        sourcePaths.set(url, asset.path);
      }

      for (const module of payload.modules) {
        let code = replaceAssets(module.code);
        if (module.type === "text/javascript") {
          code += "\n//# sourceURL=" + virtualURL(module.path);
        }
        const url = makeURL([code], module.type);
        moduleURLs.set(module.key, url);
        sourcePaths.set(url, module.path);
        sourcePaths.set(virtualURL(module.path), module.path);
      }

      const importMap = JSON.stringify({
        imports: Object.fromEntries(moduleURLs)
      }).replaceAll("<", "\\u003c");

      const attributes = payload.attributes.map(([name, value]) =>
        name + '="' + quote(value) + '"'
      ).join(" ");

      const html = "<!doctype html><html " + attributes + "><head>" +
        '<meta charset="utf-8">' +
        '<base href="' + quote(payload.base) + '">' +
        '<script type="importmap">' + importMap + "</scr" + "ipt>" +
        replaceAssets(payload.head) + "</head>" +
        replaceAssets(payload.body) + "</html>";

      document.open();

      Object.defineProperty(window, payload.bridge, {
        configurable: false,
        writable: false,
        value: Object.freeze({
          script(index) {
            if (loadedScripts.has(index)) return;
            const descriptor = payload.scripts[index];
            if (!descriptor) throw new Error("Unknown preview script.");
            loadedScripts.add(index);

            const url = descriptor.key
              ? moduleURLs.get(descriptor.key)
              : descriptor.url;
            if (!url) throw new Error("The preview script has no source.");

            const attrs = descriptor.attrs
              .filter(([name]) => name.toLowerCase() !== "src")
              .map(([name, value]) => name + '="' + quote(value) + '"')
              .join(" ");

            document.write(
              "<script " + attrs + ' src="' + quote(url) + '"></scr' + "ipt>"
            );
          }
        })
      });

      for (const level of ["log", "info", "warn", "error", "debug", "dir", "table"]) {
        const original = typeof console[level] === "function"
          ? console[level].bind(console) : null;

        console[level] = (...values) => {
          post("console", {
            level: level === "dir" || level === "table" ? "log" : level,
            source: payload.entry,
            text: values.map(format).join(" ")
          });
          original?.(...values);
        };
      }

      const originalClear = console.clear.bind(console);
      console.clear = () => {
        post("console", { level: "clear", text: "" });
        originalClear();
      };

      const originalAssert = console.assert.bind(console);
      console.assert = (condition, ...values) => {
        if (!condition) {
          post("console", {
            level: "error",
            source: payload.entry,
            text: "Assertion failed" +
              (values.length ? ": " + values.map(format).join(" ") : "")
          });
        }
        originalAssert(condition, ...values);
      };

      port.onmessage = event => {
        const message = event.data;
        if (!message || message.channel !== payload.channel ||
            message.token !== payload.token) return;

        if (message.type === "probe") {
          post("pong", { id: message.id });
          return;
        }

        if (message.type !== "fetch-result") return;
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        request.signal.removeEventListener("abort", request.abort);

        if (message.error) {
          request.reject(new TypeError(message.error));
          return;
        }

        try {
          const response = new NativeResponse(
            request.method === "HEAD" ? null : message.body,
            {
              status: message.status,
              statusText: message.statusText,
              headers: message.headers
            }
          );
          Object.defineProperty(response, "url", { value: message.url });
          request.resolve(response);
        } catch (error) {
          request.reject(error);
        }
      };
      port.start();

      window.fetch = async (input, init) => {
        const raw = input instanceof NativeRequest ? input.url : String(input);
        let url = new URL(raw, payload.base);
        const assetPath = assetPaths.get(url.href.split("#")[0]);
        if (assetPath) url = new URL(virtualURL(assetPath));

        if (url.origin !== payload.origin) {
          if (/^(blob:|data:)$/.test(url.protocol)) {
            return nativeFetch(input, init);
          }
          if (!payload.external || !/^https?:$/.test(url.protocol)) {
            throw new TypeError(
              "Online requests are disabled or this address is unsupported."
            );
          }
          return nativeFetch(input, init);
        }

        const request = input instanceof NativeRequest
          ? new NativeRequest(input, init)
          : new NativeRequest(url.href, init);

        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new TypeError("Local preview files only support GET and HEAD.");
        }
        if (request.signal.aborted) {
          throw request.signal.reason || new DOMException("Aborted", "AbortError");
        }

        url.hash = "";

        return new Promise((resolve, reject) => {
          const id = ++sequence;
          const abort = () => {
            pending.delete(id);
            reject(request.signal.reason ||
              new DOMException("Aborted", "AbortError"));
          };

          pending.set(id, {
            resolve, reject, abort,
            signal: request.signal,
            method: request.method
          });
          request.signal.addEventListener("abort", abort, { once: true });

          try {
            post("fetch", { id, url: url.href, method: request.method });
          } catch (error) {
            pending.delete(id);
            request.signal.removeEventListener("abort", abort);
            reject(error);
          }
        });
      };

      window.addEventListener("error", event => {
        if (event.target && event.target !== window) {
          const target = event.target;
          const address = target.src || target.href || target.localName;
          const path = sourcePaths.get(address) || address;
          if (target.localName === "script") {
            failure(new Error("Script could not load: " + path), path);
          } else {
            warn("Resource could not load: " + path);
          }
          return;
        }
        const source = sourcePaths.get(event.filename) || payload.entry;
        failure(event.error || new Error(event.message || "Page error"), source);
      }, true);

      window.addEventListener("unhandledrejection", event => {
        failure(event.reason || new Error("An unhandled promise was rejected."));
      });

      window.addEventListener("securitypolicyviolation", event => {
        warn("Preview policy blocked " +
          (event.blockedURI || event.violatedDirective) +
          ". Check Settings if this page needs online resources.");
      });

      document.addEventListener("click", event => {
        if (event.defaultPrevented || !event.isTrusted || event.button !== 0) return;
        const anchor = event.target.closest?.("a[href]");
        if (!anchor) return;

        let url;
        try {
          url = new URL(anchor.getAttribute("href"), payload.base);
        } catch {
          return;
        }

        if (url.origin === payload.origin) {
          event.preventDefault();
          const current = new URL(payload.base);
          if (url.pathname === current.pathname && url.search === current.search &&
              url.hash && !anchor.hasAttribute("download")) {
            try {
              location.hash = url.hash;
            } catch {
              let id = url.hash.slice(1);
              try { id = decodeURIComponent(id); } catch {}
              document.getElementById(id)?.scrollIntoView();
            }
            return;
          }
          post("navigate", {
            url: url.href,
            download: anchor.hasAttribute("download")
          });
        } else if (!payload.external) {
          event.preventDefault();
          warn("Online links are disabled in this preview.");
        } else if (
          anchor.target && !["_self", "_parent", "_top"].includes(anchor.target)
        ) {
          event.preventDefault();
          warn("Pop-up windows are disabled inside this preview.");
        }
      });

      document.addEventListener("submit", event => {
        if (event.defaultPrevented) return;
        const form = event.target;
        const url = new URL(form.getAttribute("action") || payload.base, payload.base);
        if (url.origin === payload.origin) {
          event.preventDefault();
          warn("This static preview has no server to receive form submissions.");
        } else if (!payload.external) {
          event.preventDefault();
          warn("Online form submissions are disabled in this preview.");
        }
      });

      window.addEventListener("load", () => {
        post("ready", { error: firstError, warnings: warningCount });
      }, { once: true });

      window.addEventListener("pagehide", () => {
        post("leaving");
        for (const request of pending.values()) {
          request.signal.removeEventListener("abort", request.abort);
          request.reject(new DOMException("The preview closed.", "AbortError"));
        }
        pending.clear();
        for (const url of objectURLs) URL.revokeObjectURL(url);
        port.close();
      }, { once: true });

      for (const warning of payload.warnings) {
        post("console", {
          level: "warn",
          source: payload.entry,
          text: warning
        });
      }

      document.write(html);
      document.close();
    } catch (error) {
      const message = error?.message || String(error);
      try {
        post?.("error", { message, source: payload.entry });
        parent.postMessage({
          type: "bootstrap-error",
          channel: payload.channel,
          token: payload.token,
          message
        }, "*");
      } catch {}
    }
  }, 0);
}
