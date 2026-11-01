import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const viteBin = join(projectRoot, "node_modules/vite/bin/vite.js");
const origin = "http://127.0.0.1:4173";
const editorSelector = ".cm-editor .cm-content[contenteditable=true]";
const browserErrors = [], consoleMessages = [], shellResponses = [];
let browser, page, temporaryDirectory, server, serverError, resolveServerExit;
let serverStopped = true, collectShell = true, serverOutput = "";
const serverExit = new Promise(resolve => { resolveServerExit = resolve; });

async function until(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await predicate(); if (result) return result; }
    catch (error) { lastError = error; }
    await delay(75);
  }
  throw new Error("Timed out: " + description + (lastError ? "\n" + lastError.message : ""));
}
async function check(name, task) {
  await task();
  console.log("PASS: " + name);
}
async function stopServer() {
  if (!server || serverStopped) return;
  server.kill("SIGTERM");
  await Promise.race([serverExit, delay(5000)]);
  if (!serverStopped) {
    server.kill("SIGKILL");
    await Promise.race([serverExit, delay(2000)]);
  }
  assert.ok(serverStopped, "The browser-check server did not stop.");
}
function observe(targetPage) {
  targetPage.on("pageerror", error => browserErrors.push(error.stack || error.message));
  targetPage.on("console", message => {
    if (["error", "warn"].includes(message.type())) {
      consoleMessages.push(message.type() + ": " + message.text());
    }
  });
  targetPage.on("dialog", dialog => {
    browserErrors.push("Unexpected browser dialog: " + dialog.message());
    void dialog.dismiss();
  });
}
async function chord(targetPage, ...keys) {
  const modifiers = keys.slice(0, -1);
  try {
    for (const key of modifiers) await targetPage.keyboard.down(key);
    await targetPage.keyboard.press(keys.at(-1));
  } finally {
    for (const key of modifiers.reverse()) await targetPage.keyboard.up(key);
  }
}
async function fill(targetPage, selector, value) {
  await targetPage.waitForSelector(selector, { visible: true });
  await targetPage.click(selector);
  await chord(targetPage, "Control", "a");
  await targetPage.keyboard.sendCharacter(value);
}
async function palette(targetPage, label) {
  await chord(targetPage, "Control", "k");
  await fill(targetPage, "#paletteQuery", label);
  await targetPage.keyboard.press("Enter");
  await targetPage.waitForFunction(() => !document.getElementById("paletteQuery"));
}
async function dialogButton(targetPage, label) {
  await targetPage.waitForFunction(expected =>
    [...document.querySelectorAll("#dialog[open] button")]
      .some(button => !button.disabled && button.textContent.trim() === expected), {}, label);
  for (const button of await targetPage.$$("#dialog[open] button")) {
    const matches = await button.evaluate((element, expected) =>
      !element.disabled && element.textContent.trim() === expected, label);
    if (matches) {
      await button.click();
      return;
    }
  }
  throw new Error("Dialog button not found: " + label);
}
async function prompt(targetPage, action, value, submit = "Create") {
  await palette(targetPage, action);
  await fill(targetPage, "#field", value);
  await dialogButton(targetPage, submit);
  await targetPage.waitForSelector("#field", { hidden: true });
}
const shellReady = targetPage => targetPage.waitForSelector("html[data-slate-ready=true]");
const editorText = targetPage => targetPage.$eval(editorSelector, element =>
  [...element.querySelectorAll(".cm-line")].map(line => line.textContent).join("\n"));
const textAt = (target, selector) => target.$eval(selector, element => element.textContent);
async function setEditor(targetPage, text) {
  await fill(targetPage, editorSelector, text);
  await until(async () => await editorText(targetPage) === text, "editor text update");
}
async function readRecord(targetPage, key) {
  return targetPage.evaluate(key => new Promise((resolve, reject) => {
    const request = indexedDB.open("slate-app", 1);
    request.onupgradeneeded = () => {
      request.transaction.abort();
      reject(new Error("Slate's database does not exist."));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction("data", "readonly");
      const read = transaction.objectStore("data").get(key);
      let value;
      read.onsuccess = () => { value = read.result; };
      transaction.oncomplete = () => { db.close(); resolve(value); };
      transaction.onabort = transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error("Database read failed."));
      };
    };
  }), key);
}
async function storedProject(targetPage) {
  const record = await readRecord(targetPage, "project");
  return record?.project || record;
}
async function saved(targetPage, path, text) {
  await until(async () => (await storedProject(targetPage))?.files
    .some(file => file.path === path && file.text === text), "committed browser copy of " + path);
  await targetPage.waitForFunction(() =>
    document.getElementById("saveState").textContent === "Saved in this browser");
  return storedProject(targetPage);
}
async function previewReady(targetPage, selector, text) {
  return until(async () => {
    if (await targetPage.$eval("html", element => element.dataset.previewState) !== "ready") return false;
    const frame = await (await targetPage.$("#previewFrame")).contentFrame();
    return frame && await textAt(frame, selector) === text ? frame : false;
  }, "preview content: " + text);
}
async function treeRow(targetPage, name) {
  await targetPage.waitForFunction(name =>
    [...document.querySelectorAll("#tree .tree-row")].some(row =>
      row.getClientRects().length && row.textContent.trim().endsWith(name)), {}, name);
  for (const row of await targetPage.$$("#tree .tree-row")) {
    if (await row.evaluate((element, name) =>
      element.getClientRects().length && element.textContent.trim().endsWith(name), name)) return row;
  }
  throw new Error("Tree row not found: " + name);
}

try {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "slate-browser-"));
  const downloadDirectory = join(temporaryDirectory, "downloads");
  await mkdir(downloadDirectory);
  for (const name of ["index.html", "sw.js", "manifest.webmanifest", "icon.svg"]) {
    assert.ok((await readFile(join(projectRoot, "dist", name))).length, name + " is missing.");
  }
  serverStopped = false;
  server = spawn(process.execPath, [
    viteBin, "preview", "--host", "0.0.0.0", "--port", "4173", "--strictPort"
  ], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  const capture = chunk => { serverOutput = (serverOutput + chunk.toString()).slice(-16000); };
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);
  server.once("error", error => {
    serverError = error; serverStopped = true; resolveServerExit();
  });
  server.once("exit", () => { serverStopped = true; resolveServerExit(); });
  await until(async () => {
    if (serverError) throw serverError;
    if (serverStopped) throw new Error("The preview server exited.\n" + serverOutput);
    return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok;
  }, "preview server startup");
  const unsafeFlags = new Set([
    "--single-process", "--disable-web-security", "--disable-site-isolation-trials"
  ]);
  const args = chromium.args.filter(arg => !unsafeFlags.has(arg)).map(arg => {
    if (!arg.startsWith("--disable-features=")) return arg;
    const features = arg.slice("--disable-features=".length).split(",")
      .filter(name => !["IsolateOrigins", "site-per-process", "SitePerProcess"].includes(name));
    return features.length ? "--disable-features=" + features.join(",") : "";
  }).filter(Boolean);
  browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(), args, headless: "shell",
    defaultViewport: { width: 1280, height: 800 }, timeout: 60000
  });
  const context = await browser.createBrowserContext();
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  observe(page);
  page.on("response", response => {
    const request = response.request();
    if (!collectShell || !response.url().startsWith(origin)) return;
    if (request.frame() !== page.mainFrame()) return;
    if (["document", "script", "stylesheet"].includes(request.resourceType())) {
      shellResponses.push(response.content());
    }
  });
  const browserSession = await browser.target().createCDPSession();
  await browserSession.send("Browser.setDownloadBehavior", {
    behavior: "allow", downloadPath: downloadDirectory, browserContextId: context.id
  });

  await check("fresh opening offers the three requested starting choices", async () => {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await shellReady(page);
    assert.equal(await page.$eval("#home", element => element.hidden), false);
    assert.equal(await page.$eval("#resume", element => element.hidden), true);
    for (const action of ["blank", "starters", "open-folder"]) {
      await page.waitForSelector(`#home [data-act="${action}"]`, { visible: true });
    }
    collectShell = false;
    const bytes = (await Promise.all(shellResponses))
      .reduce((total, body) => total + gzipSync(body).length, 0);
    assert.ok(bytes > 0 && bytes < 250 * 1024, "Cold shell exceeds 250 KiB gzip.");
    console.log("Measured cold-shell gzip bytes: " + bytes);
  });
  const original = '<h1 id="out">Hello from Slate</h1>';
  await check("real editor input and Ctrl+Enter produce a browser preview", async () => {
    await page.click('[data-act="blank"]');
    await page.waitForSelector(editorSelector, { visible: true });
    await page.click('[data-act="live"]');
    await page.waitForFunction(() =>
      document.getElementById("liveButton").getAttribute("aria-pressed") === "false");
    await setEditor(page, original); await chord(page, "Control", "Enter");
    const frame = await previewReady(page, "#out", "Hello from Slate");
    assert.equal(await frame.evaluate(() => {
      try { void parent.document; return false; } catch { return true; }
    }), true, "Preview must not have access to the editor document.");
    await saved(page, "index.html", original);
  });
  await check("saved text and undo history survive a reload", async () => {
    const changed = '<h1 id="out">Changed fixture</h1>';
    await setEditor(page, changed); await saved(page, "index.html", changed);
    await page.reload({ waitUntil: "domcontentloaded" }); await shellReady(page);
    await page.waitForSelector(editorSelector, { visible: true });
    assert.equal(await editorText(page), changed);
    await palette(page, "Undo file edit");
    await until(async () => await editorText(page) === original, "restored undo history");
    await saved(page, "index.html", original);
  });
  await check("file rename preserves identity", async () => {
    const id = (await storedProject(page)).files.find(file => file.path === "index.html").id;
    await prompt(page, "Rename selected file or folder", "home.html", "Rename");
    assert.equal((await saved(page, "home.html", original))
      .files.find(file => file.path === "home.html").id, id);
  });
  await check("folders, tabs, project replacement, and file find operate through the UI", async () => {
    await prompt(page, "New folder", "notes");
    await prompt(page, "New file", "notes/note.txt");
    await setEditor(page, "alpha fixture"); await saved(page, "notes/note.txt", "alpha fixture");
    await page.focus('#tabs [role="tab"][aria-selected="true"]');
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() =>
      document.activeElement?.matches('[role="tab"][aria-selected="true"]') &&
      document.activeElement.textContent.includes("home.html"));
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() =>
      document.activeElement?.matches('[role="tab"][aria-selected="true"]') &&
      document.activeElement.textContent.includes("note.txt"));
    await palette(page, "Search project");
    await fill(page, "#searchQuery", "alpha"); await fill(page, "#replaceText", "beta");
    await page.click('[data-act="replace-all"]'); await dialogButton(page, "Replace all");
    await saved(page, "notes/note.txt", "beta fixture");
    assert.match(await textAt(page, "#noticeText"), /Updated\s+1\s+file/);
    await palette(page, "Undo file edit"); await saved(page, "notes/note.txt", "alpha fixture");
    await page.click(editorSelector); await chord(page, "Control", "f");
    await page.waitForSelector(".cm-search input", { visible: true });
    await palette(page, "Close file find");
    await page.waitForSelector(".cm-search", { hidden: true });
    await palette(page, "Show files");
    const folder = await treeRow(page, "notes");
    if (await folder.evaluate(element => element.getAttribute("aria-expanded") === "false")) await folder.click();
    await (await treeRow(page, "note.txt")).click();
    await palette(page, "Delete selected file or folder"); await dialogButton(page, "Delete");
    await until(async () => !(await storedProject(page)).files
      .some(file => file.path === "notes/note.txt"), "file deletion committed");
  });
  await check("theme changes persist", async () => {
    await page.click("#themeButton");
    await until(async () => {
      const record = await readRecord(page, "settings");
      return (record?.settings || record)?.theme === "light";
    }, "light theme committed");
    await page.reload({ waitUntil: "domcontentloaded" }); await shellReady(page);
    assert.equal(await page.$eval("html", element => element.dataset.theme), "light");
  });
  await check("preview copy opens without an opener reference", async () => {
    const existing = new Set(browser.targets());
    const created = browser.waitForTarget(target => target.type() === "page" && !existing.has(target));
    await page.click('[data-act="new-page"]');
    const copy = await (await created).page();
    observe(copy);
    assert.equal(await copy.evaluate(() => window.opener === null), true);
    await until(async () => {
      const handle = await copy.$("iframe"), frame = handle && await handle.contentFrame();
      return frame && await textAt(frame, "#out") === "Hello from Slate";
    }, "preview copy content");
    await copy.close();
  });
  await check("export requests a real, readable ZIP download", async () => {
    await palette(page, "Export project ZIP");
    const name = await until(async () => (await readdir(downloadDirectory))
      .find(name => name.endsWith(".zip")), "ZIP download completion");
    const files = unzipSync(await readFile(join(downloadDirectory, name)));
    const path = Object.keys(files).find(path => path === "home.html" || path.endsWith("/home.html"));
    assert.ok(path, "Downloaded ZIP must contain the edited HTML.");
    assert.equal(strFromU8(files[path]), original);
  });

  const html = '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1 id="out"></h1><img id="asset" alt="Fixture"><script type="module" src="app.ts"></script></body></html>';
  const expected = "ZIP fixture ab: local text", fixturePath = join(temporaryDirectory, "input.zip");
  await writeFile(fixturePath, zipSync({
    "index.html": strToU8(html),
    "styles.css": strToU8("h1 { color: rgb(12, 34, 56); }"),
    "config.json": strToU8('{"label":"ZIP fixture"}'),
    "message.txt": strToU8("local text"),
    "a.js": strToU8('import { b } from "./b.js"; export function a() { return "a" + b(); }'),
    "b.js": strToU8('import { a } from "./a.js"; export function b() { return "b"; } export function again() { return a(); }'),
    "app.ts": strToU8('import config from "./config.json"; import { a } from "./a.js"; const label: string = config.label; document.querySelector("#asset").src = new URL("./asset.svg", import.meta.url).href; const response = await fetch("./message.txt"); document.querySelector("#out").textContent = label + " " + a() + ": " + await response.text(); console.log("preview-fixture-ready");'),
    "asset.svg": strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="black"/></svg>'),
    "README.md": strToU8("# Fixture heading\n\nLocal Markdown preview.")
  }));
  await check("ZIP import runs local TypeScript, JSON, CSS, assets, cycles, and file fetches", async () => {
    const chooser = page.waitForFileChooser();
    await palette(page, "Open project ZIP");
    await (await chooser).accept([fixturePath]); await dialogButton(page, "Open other project");
    await saved(page, "index.html", html); await chord(page, "Control", "Enter");
    const frame = await previewReady(page, "#out", expected);
    assert.equal(await frame.$eval("#out", element => getComputedStyle(element).color), "rgb(12, 34, 56)");
    await until(() => frame.$eval("#asset", element => element.naturalWidth === 8), "local image load");
    assert.ok((await textAt(page, "#consoleOutput")).includes("preview-fixture-ready"));
    assert.deepEqual(await frame.evaluate(async () => {
      const head = await fetch("./message.txt", { method: "HEAD" });
      const missing = await fetch("./missing-fixture.txt");
      let denied = false;
      try { await fetch("./message.txt", { method: "POST", body: "fixture" }); } catch { denied = true; }
      return [head.status, await head.text(), missing.status, denied];
    }), [200, "", 404, true]);
    await page.select("#entry", "README.md"); await previewReady(page, "h1", "Fixture heading");
    await page.select("#entry", "index.html"); await previewReady(page, "#out", expected);
  });
  await check("a compile failure preserves the previous preview", async () => {
    await setEditor(page, '<script type="module">import "./missing-fixture.js";</script>');
    await chord(page, "Control", "Enter");
    await page.waitForFunction(() => document.documentElement.dataset.previewState === "error");
    const frame = await (await page.$("#previewFrame")).contentFrame();
    assert.equal(await textAt(frame, "#out"), expected);
    await setEditor(page, html); await saved(page, "index.html", html);
    await chord(page, "Control", "Enter"); await previewReady(page, "#out", expected);
  });
  let latest = html + "<!-- second-tab fixture -->";
  await check("another tab cannot be silently overwritten", async () => {
    const other = await context.newPage();
    observe(other);
    await other.goto(origin + "/#work", { waitUntil: "domcontentloaded" }); await shellReady(other);
    await setEditor(other, latest); await saved(other, "index.html", latest);
    await setEditor(page, "<h1>Unsaved first-tab fixture</h1>");
    await palette(page, "Save in this browser");
    await page.waitForFunction(() => document.getElementById("saveState").textContent === "Not saved");
    assert.equal((await storedProject(page)).files.find(file => file.path === "index.html").text, latest);
    await palette(page, "Reload saved browser copy"); await dialogButton(page, "Reload browser copy");
    await until(async () => await editorText(page) === latest, "browser-copy reload");
    await other.close();
    await chord(page, "Control", "Enter"); await previewReady(page, "#out", expected);
  });
  await check("narrow layouts switch panes without horizontal page overflow", async () => {
    await page.setViewport({ width: 390, height: 844 });
    await page.click('[data-act="mobile-files"]');
    assert.ok(await page.$eval("#tree", element => element.getBoundingClientRect().width > 0));
    await page.click("#mobilePreview");
    assert.ok(await page.$eval("#previewFrame", element => element.getBoundingClientRect().width > 0));
    await page.click("#mobileCode");
    assert.ok(await page.$eval("#editorHost", element => element.getBoundingClientRect().width > 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewport({ width: 1280, height: 800 });
  });
  await check("cached editing and preview work with the server stopped", async () => {
    await until(() => page.evaluate(() => document.documentElement.dataset.offlineReady === "true" &&
      Boolean(navigator.serviceWorker.controller)), "verified offline app files", 60000);
    await page.setCacheEnabled(false); await page.setOfflineMode(true); await stopServer();
    await page.reload({ waitUntil: "domcontentloaded" }); await shellReady(page);
    await until(async () => await editorText(page) === latest, "offline saved text");
    latest = latest.replace("</body>", '<p id="offline-proof">Offline change</p></body>');
    await setEditor(page, latest); await saved(page, "index.html", latest);
    await chord(page, "Control", "Enter"); await previewReady(page, "#offline-proof", "Offline change");
  });
  assert.deepEqual(browserErrors, [], "Unexpected browser JavaScript errors.");
  console.log("All listed browser checks completed.");
} catch (error) {
  const details = [error?.stack || String(error)];
  if (page && !page.isClosed()) {
    try { details.push("Slate notice: " + await textAt(page, "#noticeText")); } catch {}
  }
  details.push(...browserErrors, ...consoleMessages);
  if (serverOutput) details.push(serverOutput);
  const message = details.join("\n");
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    const annotation = message.slice(0, 12000).replaceAll("%", "%25")
      .replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    console.log("::error title=Browser checks failed::" + annotation);
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(error => console.error(error.message));
  await stopServer().catch(error => { console.error(error.message); process.exitCode = 1; });
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
