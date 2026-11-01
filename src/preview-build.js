import { makeId, mime, esc } from "./core.js";
import { previewRuntime } from "./preview-runtime.js";

export const PREVIEW_ORIGIN = "https://slate.invalid";
export const PREVIEW_CHANNEL = "slate-preview";

const encodePath = path => path.split("/").map(encodeURIComponent).join("/");
const pageURL = path => PREVIEW_ORIGIN + "/" + encodePath(path);
const isPage = path => /\.(html?|md|markdown)$/i.test(path);
const isCode = path => /\.(mjs|cjs|js|jsx|ts|tsx)$/i.test(path);
const safeJSON = value => JSON.stringify(value).replace(/</g, "\\u003c")
  .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

let lexerPromise;

function getLexer() {
  lexerPromise ||= import("es-module-lexer/minimal").then(async lexer => {
    await lexer.init();
    return lexer;
  }).catch(error => {
    lexerPromise = null;
    throw error;
  });
  return lexerPromise;
}

function locate(value, base) {
  const url = new URL(value, base);
  return {
    url: url.href,
    path: url.origin === PREVIEW_ORIGIN
      ? decodeURIComponent(url.pathname.slice(1)) : null,
    hash: url.hash,
    query: url.searchParams
  };
}

function bytes64(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  }
  return btoa(chunks.join(""));
}

function unescapeCSS(value) {
  return value.replace(
    /\\([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|\\(?:\r\n|[\r\n\f])|\\([\s\S])/gi,
    (_, hex, character) => {
      if (!hex) return character || "";
      const point = parseInt(hex, 16);
      return !point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
        ? "\ufffd" : String.fromCodePoint(point);
    }
  );
}

const CSS_PARTS = /\/\*[\s\S]*?\*\/|@import\s*(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|url\(\s*(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?:\\[\s\S]|[^\\)"'\s])*)\s*\)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/gi;

export async function buildPreview(project, {
  entry = project.entry,
  external = false,
  token = makeId()
} = {}) {
  const files = new Map(project.files.map(file => [
    file.path,
    file.binary ? { ...file, data: new Uint8Array(file.data) } : { ...file }
  ]));
  const entryFile = files.get(entry);
  if (!entryFile || entryFile.binary || !isPage(entry)) {
    throw new Error("Choose an HTML or Markdown file for the preview.");
  }

  const assets = [], modules = new Map(), assetIndexes = new Map();
  const warnings = new Set(), aliases = Object.create(null);
  const assetPrefix = "slate-asset:" + token + ":";
  const bridge = "__slate_" + String(token).replace(/[^a-z0-9]/gi, "");
  let base = pageURL(entry);
  let packageInfo;

  function findFile(path, extensions = false) {
    const exact = files.get(path);
    if (exact || !extensions) return exact;
    const stem = path.replace(/\/+$/, "");
    for (const suffix of [
      ".js", ".ts", ".jsx", ".tsx", ".mjs", ".json",
      "/index.js", "/index.ts", "/index.jsx", "/index.tsx"
    ]) {
      if (files.has(stem + suffix)) return files.get(stem + suffix);
    }
    return null;
  }

  async function asset(file) {
    if (assetIndexes.has(file.path)) {
      const previous = assets[assetIndexes.get(file.path)];
      if (previous.loading) {
        warnings.add("A circular stylesheet import was skipped: " + file.path);
        return "data:text/css,";
      }
      return previous.tag;
    }
    const index = assets.length;
    const record = {
      path: file.path,
      tag: assetPrefix + index + ":",
      type: /\.wasm$/i.test(file.path) ? "application/wasm" : mime(file.path),
      loading: true
    };
    assetIndexes.set(file.path, index);
    assets.push(record);
    if (file.binary) record.bytes = bytes64(file.data);
    else record.text = /\.css$/i.test(file.path)
      ? await rewriteCSS(file.text, pageURL(file.path)) : file.text;
    delete record.loading;
    return record.tag;
  }

  async function resource(value, from) {
    if (!value || value.startsWith("#")) return value;
    const target = locate(value, from);
    if (target.path === null) {
      if (!external && /^https?:/i.test(target.url)) {
        warnings.add("An online resource was blocked: " + target.url);
        return /\.css(?:[?#]|$)/i.test(target.url) ? "data:text/css," : "data:,";
      }
      return target.url;
    }
    const file = findFile(target.path);
    if (!file) {
      warnings.add("A referenced file was not found: " + target.path);
      return "data:,";
    }
    return await asset(file) + target.hash;
  }

  async function rewriteCSS(text, from) {
    const edits = [];
    for (const match of text.matchAll(CSS_PARTS)) {
      const part = match[0];
      const importing = /^@import\b/i.test(part);
      if (!importing && !/^url\(/i.test(part)) continue;
      if (!importing && /[\w-]/.test(text[match.index - 1] || "")) continue;
      let value = importing
        ? part.replace(/^@import\s*/i, "")
        : part.slice(part.indexOf("(") + 1, -1).trim();
      if (/^["']/.test(value)) value = value.slice(1, -1);
      const rewritten = await resource(unescapeCSS(value), from);
      edits.push({
        from: match.index, to: match.index + part.length,
        text: (importing ? "@import " : "") + "url(" + JSON.stringify(rewritten) + ")"
      });
    }
    for (const edit of edits.reverse()) {
      text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
    }
    return text;
  }

  async function rewriteSrcset(value, from) {
    const result = [];
    let index = 0;
    while (index < value.length) {
      while (index < value.length && /[\s,]/.test(value[index])) index++;
      if (index >= value.length) break;
      const start = index;
      while (index < value.length && !/\s/.test(value[index])) index++;
      let url = value.slice(start, index);
      const separated = url.endsWith(",");
      url = url.replace(/,+$/, "");
      let descriptor = "";
      if (!separated) {
        const start = index;
        while (index < value.length && value[index] !== ",") index++;
        descriptor = value.slice(start, index).trim();
      }
      if (url) result.push(await resource(url, from) + (descriptor ? " " + descriptor : ""));
    }
    return result.join(", ");
  }

  function applyAlias(specifier) {
    if (Object.hasOwn(aliases, specifier)) return aliases[specifier];
    const prefix = Object.keys(aliases)
      .filter(key => key.endsWith("/") && specifier.startsWith(key))
      .sort((a, b) => b.length - a.length)[0];
    if (!prefix) return specifier;
    return typeof aliases[prefix] === "string"
      ? aliases[prefix] + specifier.slice(prefix.length) : null;
  }

  async function resolveImport(specifier, from, attributes) {
    const mapped = applyAlias(specifier);
    if (typeof mapped !== "string") {
      throw new Error("This import is blocked by the page’s import map: " + specifier);
    }
    if (/^(node:|bun:|deno:)/i.test(mapped)) {
      throw new Error("Server-only imports cannot run in this preview: " + mapped);
    }
    const bare = !mapped.startsWith(".") && !mapped.startsWith("/") &&
      !/^[a-z][a-z\d+.-]*:/i.test(mapped);
    if (bare) {
      if (!external) throw new Error("Online code is disabled for this import: " + mapped);
      if (mapped.startsWith("@/") || mapped.startsWith("~/") || mapped.startsWith("#")) {
        throw new Error("This project alias needs an import map or relative path: " + mapped);
      }
      const name = mapped.match(/^(?:@[^/]+\/)?[^/]+/)?.[0];
      if (!name) throw new Error("The import name is invalid: " + mapped);
      if (packageInfo === undefined) {
        const manifest = files.get("package.json");
        packageInfo = manifest && !manifest.binary ? JSON.parse(manifest.text) : {};
      }
      const version = String(packageInfo?.dependencies?.[name] ||
        packageInfo?.devDependencies?.[name] || "");
      if (/^(workspace:|file:|link:|npm:|git|https?:)/i.test(version)) {
        throw new Error("This dependency needs installation before preview: " + name);
      }
      return "https://esm.sh/" + name +
        (version ? "@" + encodeURIComponent(version) : "") + mapped.slice(name.length);
    }
    const target = locate(mapped, from);
    if (target.path === null) {
      if (!/^(https?:|data:|blob:)/i.test(target.url)) {
        throw new Error("This import address is unsupported: " + mapped);
      }
      if (!external && /^https?:/i.test(target.url)) {
        throw new Error("External code is disabled: " + target.url);
      }
      return target.url;
    }
    const file = findFile(target.path, true);
    if (!file) throw new Error("Imported file not found: " + target.path);
    return moduleFor(file, {
      raw: target.query.has("raw"), url: target.query.has("url"),
      native: attributes && /\.(json|css)$/i.test(file.path)
    });
  }

  async function compile(source, from, path) {
    const transforms = [];
    if (/\.(ts|tsx)$/i.test(path)) transforms.push("typescript");
    if (/\.(jsx|tsx)$/i.test(path)) transforms.push("jsx");
    if (transforms.length) {
      const { transform } = await import("sucrase");
      source = transform(source, {
        filePath: path, transforms, jsxRuntime: "automatic",
        production: true, disableESTransforms: true
      }).code;
    }
    const { parse } = await getLexer();
    const [imports] = parse(source, path);
    const edits = [];
    for (const item of imports) {
      if (item.d === -2) {
        const before = source.slice(0, item.s).match(
          /new\s+URL\s*\(\s*(?:"([^"\\\r\n]*)"|'([^'\\\r\n]*)')\s*,\s*$/
        );
        const after = source.slice(item.e).match(/^\s*\.url\s*\)/);
        if (before && after) edits.push({
          from: item.s - before[0].length, to: item.e + after[0].length,
          text: "new URL(" + JSON.stringify(await resource(before[1] ?? before[2], from)) + ")"
        });
        continue;
      }
      if ([4, 5, 6, 7].includes(item.t)) {
        throw new Error("Source and deferred imports are unsupported: " + path);
      }
      if (typeof item.n !== "string") {
        throw new Error("This preview needs a quoted, fixed import path in: " + path);
      }
      const replacement = JSON.stringify(await resolveImport(item.n, from, item.a >= 0));
      let start = item.s, end = item.e;
      if (!/^(['"`])[\s\S]*\1$/.test(source.slice(start, end))) {
        if (!/['"`]/.test(source[start - 1] || "") || source[start - 1] !== source[end]) {
          throw new Error("The import path could not be rewritten in: " + path);
        }
        start--;
        end++;
      }
      edits.push({ from: start, to: end, text: replacement });
    }
    for (const edit of edits.sort((a, b) => b.from - a.from)) {
      source = source.slice(0, edit.from) + edit.text + source.slice(edit.to);
    }
    return source;
  }

  async function moduleFor(file, options = {}) {
    const prefix = options.raw ? "slate-raw:" : options.url ? "slate-url:" :
      options.native ? "slate-native:" : "slate:";
    const key = prefix + "/" + encodePath(file.path);
    if (modules.has(key)) return key;
    const record = { key, path: file.path, type: "text/javascript", code: "" };
    modules.set(key, record);
    if (options.raw) {
      if (file.binary) throw new Error("Raw text imports need a text file: " + file.path);
      record.code = "export default " + JSON.stringify(file.text);
    } else if (options.url) {
      record.code = "export default " + JSON.stringify(await asset(file));
    } else if (/\.json$/i.test(file.path) && !file.binary) {
      const text = file.text.replace(/^\ufeff/, "");
      try { JSON.parse(text); }
      catch (error) { throw new Error(file.path + ": " + error.message); }
      if (options.native) {
        record.type = "application/json";
        record.code = text;
      } else record.code = "export default JSON.parse(" + JSON.stringify(text) + ")";
    } else if (/\.css$/i.test(file.path) && !file.binary) {
      const css = await rewriteCSS(file.text, pageURL(file.path));
      if (options.native) {
        record.type = "text/css";
        record.code = css;
      } else record.code = "const css=" + JSON.stringify(css) +
        ";const style=document.createElement('style');style.textContent=css;" +
        "document.head.append(style);export default css;";
    } else if (isCode(file.path) && !file.binary) {
      record.code = await compile(file.text, pageURL(file.path), file.path);
    } else record.code = "export default " + JSON.stringify(await asset(file));
    return key;
  }

  let html = entryFile.text;
  if (/\.(md|markdown)$/i.test(entry)) {
    const { marked } = await import("marked");
    html = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>" +
      await marked.parse(html, { async: false }) + "</body></html>";
  }
  const guard = makeId();
  const doc = new DOMParser().parseFromString(
    `<!doctype html><meta data-slate-parse="${guard}" http-equiv="Content-Security-Policy" content="default-src 'none'">` +
    html, "text/html"
  );
  doc.querySelector(`[data-slate-parse="${guard}"]`)?.remove();
  const originalBase = doc.querySelector("base[href]");
  if (originalBase) base = new URL(originalBase.getAttribute("href"), base).href;
  for (const element of doc.querySelectorAll("base")) element.remove();
  for (const element of doc.querySelectorAll("meta[http-equiv]")) {
    if (/^(refresh|content-security-policy)$/i.test(element.getAttribute("http-equiv"))) {
      warnings.add("The page’s own security and refresh meta tags are not evaluated here.");
      element.remove();
    }
  }
  for (const element of doc.querySelectorAll("script[type='importmap']")) {
    const value = JSON.parse(element.textContent);
    if (value.scopes && Object.keys(value.scopes).length) {
      throw new Error("Scoped import maps are not supported in this preview.");
    }
    for (const [name, target] of Object.entries(value.imports || {})) {
      aliases[name] = typeof target === "string" &&
        (target.startsWith(".") || target.startsWith("/"))
        ? new URL(target, base).href : target;
    }
    element.remove();
  }

  const scripts = [];
  for (const element of [...doc.querySelectorAll("script")]) {
    const type = (element.getAttribute("type") || "").trim().toLowerCase();
    if (type && type !== "module" && !/(javascript|ecmascript)$/.test(type)) continue;
    const descriptor = { attrs: [...element.attributes].map(attr => [attr.name, attr.value]) };
    const source = element.getAttribute("src");
    if (source !== null) {
      const target = locate(source, base);
      if (target.path === null) {
        if (!/^(https?:|data:|blob:)/i.test(target.url)) {
          throw new Error("Unsupported script address: " + target.url);
        }
        if (!external && /^https?:/i.test(target.url)) {
          throw new Error("External code is disabled: " + target.url);
        }
        descriptor.url = target.url;
      } else {
        const file = findFile(target.path, true);
        if (!file || file.binary) throw new Error("Script file not found: " + target.path);
        descriptor.key = await moduleFor(file);
      }
    } else {
      descriptor.key = "slate-inline:/" + token + "/" + scripts.length;
      modules.set(descriptor.key, {
        key: descriptor.key, path: entry, type: "text/javascript",
        code: await compile(element.textContent, base, entry + ".js")
      });
    }
    if (descriptor.key) {
      descriptor.attrs = descriptor.attrs.filter(([name]) => name.toLowerCase() !== "integrity");
      if (element.hasAttribute("integrity")) {
        warnings.add("Integrity checks are not applied to rewritten local scripts.");
      }
    }
    const loader = doc.createElement("script");
    loader.textContent = "window[" + JSON.stringify(bridge) + "].script(" + scripts.length + ")";
    scripts.push(descriptor);
    element.replaceWith(loader);
  }
  for (const element of [...doc.querySelectorAll("*")]) {
    const tag = element.localName.toLowerCase();
    if (tag === "script") continue;
    if (tag === "link" && /^(modulepreload|preload)$/i.test(element.getAttribute("rel"))) {
      element.remove();
      continue;
    }
    if (tag === "style") element.textContent = await rewriteCSS(element.textContent, base);
    if (element.hasAttribute("style")) {
      element.setAttribute("style", await rewriteCSS(element.getAttribute("style"), base));
    }
    for (const name of ["src", "poster", "background", "href", "xlink:href"]) {
      if (!element.hasAttribute(name) || (tag === "a" && name === "href")) continue;
      element.setAttribute(name, await resource(element.getAttribute(name), base));
      if (element.hasAttribute("integrity")) {
        element.removeAttribute("integrity");
        warnings.add("Integrity checks are not applied to rewritten preview resources.");
      }
    }
    if (element.hasAttribute("srcset")) {
      element.setAttribute("srcset", await rewriteSrcset(element.getAttribute("srcset"), base));
    }
  }

  const network = external ? "https: http:" : "";
  const policy = [
    "default-src 'none'", "script-src 'unsafe-inline' 'unsafe-eval' blob: data: " + network,
    "style-src 'unsafe-inline' blob: data: " + network, "img-src blob: data: " + network,
    "font-src blob: data: " + network, "media-src blob: data: " + network,
    "connect-src blob: data: " + (external ? "https: http: wss: ws:" : ""),
    "frame-src " + (external ? network : "'none'"), "worker-src blob:",
    "form-action " + (external ? network : "'none'"), "base-uri https: http:", "object-src 'none'"
  ].join("; ");
  const policyMeta = '<meta http-equiv="Content-Security-Policy" content="' + esc(policy) + '">';
  const payload = {
    channel: PREVIEW_CHANNEL, origin: PREVIEW_ORIGIN, token, bridge, base, entry, external,
    assetPrefix, assets, modules: [...modules.values()], scripts, warnings: [...warnings],
    head: policyMeta + doc.head.innerHTML, body: doc.body.outerHTML,
    attributes: [...doc.documentElement.attributes].map(attr => [attr.name, attr.value])
  };
  const fallback = "window.onerror=function(message){parent.postMessage({type:'bootstrap-error'," +
    "channel:" + safeJSON(PREVIEW_CHANNEL) + ",token:" + safeJSON(token) +
    ",message:String(message)},'*')}";
  const runtime = previewRuntime.toString().replace(/<\/script/gi, "<\\/script");
  return {
    token, entry, files,
    html: "<!doctype html><html><head><meta charset=\"utf-8\">" + policyMeta +
      "<script>" + fallback + "</script><script>(" + runtime + ")(" + safeJSON(payload) +
      ")</script></head><body></body></html>"
  };
}
