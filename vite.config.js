import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const workerRuntime = String.raw`
"use strict";

const CACHE_PREFIX = "slate-static-v1-";
const CACHE_NAME = CACHE_PREFIX + BUILD_ID;
const FILES = Object.keys(FILE_HASHES);
const KNOWN_FILES = new Set(FILES);

function absolute(path) {
  return new URL(path, self.location.origin).href;
}

function isAsset(path) {
  return path.startsWith("/assets/");
}

function checkType(path, response) {
  if (!response.ok || response.type === "opaque") {
    throw new Error("Could not cache " + path);
  }

  const type = (response.headers.get("content-type") || "").toLowerCase();
  let valid = true;

  if (path === "/" || /\.html?$/i.test(path)) {
    valid = type.includes("text/html");
  } else if (/\.m?js$/i.test(path)) {
    valid = type.includes("javascript") || type.includes("ecmascript");
  } else if (/\.css$/i.test(path)) {
    valid = type.includes("text/css");
  } else if (/\.(json|webmanifest)$/i.test(path)) {
    valid = type.includes("json");
  } else if (/\.svg$/i.test(path)) {
    valid = type.includes("image/svg+xml");
  } else if (/\.wasm$/i.test(path)) {
    valid = type.includes("application/wasm");
  }

  if (!valid) throw new Error("Unexpected file type for " + path);
}

async function verify(path, response) {
  checkType(path, response);
  const expected = FILE_HASHES[path];
  if (!expected) return;

  const bytes = await response.clone().arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  if (actual !== expected) {
    throw new Error("The downloaded file did not match this build: " + path);
  }
}

async function olderAsset(path) {
  if (!isAsset(path)) return null;
  const names = (await caches.keys()).reverse();

  for (const name of names) {
    if (!name.startsWith(CACHE_PREFIX) || name === CACHE_NAME) continue;
    const cache = await caches.open(name);
    const response = await cache.match(absolute(path));
    if (response) return response;
  }

  return null;
}

async function storeFile(cache, path) {
  let response = await olderAsset(path);

  if (response) {
    try {
      await verify(path, response);
    } catch {
      response = null;
    }
  }

  if (!response) {
    response = await fetch(new Request(absolute(path), {
      cache: "reload",
      credentials: "same-origin"
    }));
    await verify(path, response);
  }

  await cache.put(absolute(path), response);
}

async function storeGroup(cache, paths) {
  const results = await Promise.allSettled(
    paths.map(path => storeFile(cache, path))
  );
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
}

async function installFiles() {
  const existed = await caches.has(CACHE_NAME);
  const cache = await caches.open(CACHE_NAME);

  try {
    await storeGroup(cache, SHELL_FILES);
    const shell = new Set(SHELL_FILES);
    await storeGroup(cache, FILES.filter(path => !shell.has(path)));
  } catch (error) {
    if (!existed) await caches.delete(CACHE_NAME);
    throw error;
  }
}

self.addEventListener("install", event => {
  event.waitUntil(installFiles());
});

self.addEventListener("activate", event => {
  // Older assets remain available to tabs running an earlier build.
  event.waitUntil(self.clients.claim());
});

async function cacheComplete() {
  if (!await caches.has(CACHE_NAME)) return false;
  const cache = await caches.open(CACHE_NAME);

  for (const path of FILES) {
    const response = await cache.match(absolute(path));
    if (!response) return false;
    await verify(path, response);
  }

  return true;
}

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (event.data?.type !== "CACHE_STATUS" || !event.ports[0]) return;
  const port = event.ports[0];

  event.waitUntil((async () => {
    try {
      port.postMessage({
        type: "CACHE_STATUS",
        ready: await cacheComplete()
      });
    } catch (error) {
      port.postMessage({
        type: "CACHE_STATUS",
        ready: false,
        error: error.message || String(error)
      });
    }
  })());
});

function offlinePage() {
  const html = [
    '<!doctype html><html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Slate</title>',
    '<style>',
    ':root{color-scheme:dark;background:#171a17;color:#e5e8e0}',
    'body{margin:24px;font:13px/1.5 system-ui,sans-serif}',
    'a{display:inline-block;color:inherit;border:1px solid #667060;',
    'padding:8px 12px;text-decoration:none;border-radius:2px}',
    'a:focus-visible{outline:2px solid #bfd6a0;outline-offset:4px}',
    '@media(prefers-color-scheme:light){',
    ':root{color-scheme:light;background:#f5f6f2;color:#252a23}}',
    '</style></head><body><main>',
    '<p>Slate is not cached; reconnect and try again.</p>',
    '<a href="/#work">Try again</a>',
    '</main></body></html>'
  ].join("");

  return new Response(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function serve(request, path, navigation) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(absolute(path));
  if (cached) return cached;

  const previous = await olderAsset(path);
  if (previous) return previous;

  try {
    const response = await fetch(request);

    // A navigation may receive a newer published build.
    // Do not mix that document into this build's offline copy.
    if (!navigation && KNOWN_FILES.has(path) && response.ok) {
      await verify(path, response);

      try {
        await cache.put(absolute(path), response.clone());
      } catch {
        // A full cache must not prevent an online file from loading.
      }
    }

    return response;
  } catch {
    return navigation ? offlinePage() : Response.error();
  }
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  const navigation = request.mode === "navigate" &&
    (path === "/" || path === "/index.html");

  if (!navigation && !KNOWN_FILES.has(path) && !isAsset(path)) return;

  event.respondWith(serve(request, path, navigation));
});
`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function offlineFilesPlugin() {
  let publicDirectory = "";

  return {
    name: "slate-offline-files",
    apply: "build",
    enforce: "post",

    configResolved(config) {
      publicDirectory = config.publicDir;
    },

    generateBundle: {
      order: "post",

      async handler(_options, bundle) {
        const contents = new Map();

        for (const name of Object.keys(bundle).sort()) {
          if (name.endsWith(".map") || name === "sw.js") continue;

          const output = bundle[name];

          contents.set(
            "/" + name.replace(/\\/g, "/"),
            output.type === "chunk" ? output.code : output.source
          );
        }

        if (!contents.has("/index.html")) {
          this.error("Slate needs index.html at the repository root.");
          return;
        }

        for (const name of ["manifest.webmanifest", "icon.svg"]) {
          contents.set(
            "/" + name,
            await readFile(join(publicDirectory, name))
          );
        }

        contents.set("/", contents.get("/index.html"));

        const hashes = Object.fromEntries(
          [...contents.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([path, content]) => [path, sha256(content)])
        );

        const shell = new Set([
          "/",
          "/index.html",
          "/manifest.webmanifest",
          "/icon.svg"
        ]);

        const visited = new Set();

        function visit(name) {
          if (visited.has(name)) return;

          visited.add(name);

          const output = bundle[name];
          if (!output) return;

          if (contents.has("/" + name)) {
            shell.add("/" + name);
          }

          if (output.type === "chunk") {
            for (const dependency of output.imports) {
              visit(dependency);
            }
          }
        }

        for (const [name, output] of Object.entries(bundle)) {
          if (output.type === "chunk" && output.isEntry) {
            visit(name);
          }

          if (name.endsWith(".css")) {
            shell.add("/" + name);
          }
        }

        const shellFiles = [...shell]
          .filter(path => path in hashes)
          .sort();

        const buildId = sha256(
          workerRuntime +
          JSON.stringify(hashes) +
          JSON.stringify(shellFiles)
        ).slice(0, 24);

        const source = [
          "const BUILD_ID = " + JSON.stringify(buildId) + ";",
          "const FILE_HASHES = " + JSON.stringify(hashes) + ";",
          "const SHELL_FILES = " + JSON.stringify(shellFiles) + ";",
          workerRuntime
        ].join("\n");

        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source
        });
      }
    }
  };
}

export default defineConfig({
  base: "/",
  publicDir: "public",

  plugins: [offlineFilesPlugin()],

  resolve: {
    dedupe: [
      "codemirror",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/search",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr"
    ]
  },

  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: [".e2b.app"],
    cors: false
  },

  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    allowedHosts: [".e2b.app"],
    cors: false
  },

  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: true
  }
});
