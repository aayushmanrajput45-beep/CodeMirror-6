import {
  makeId, cleanPath, basename, dirname, folderPaths,
  blankProject, starter, restoreProject,
  searchFiles, replaceMatches, zipProject, unzipProject, download, mime
} from "./core.js";
import {
  loadWorkspace, saveProject, saveSettings, normalizeSettings,
  readDirectory, readFiles, subscribeStorageChanges, ProjectConflictError
} from "./storage.js";
import * as UI from "./ui.js";

const ids = `
  home work resume projectName themeButton commandKey
  filesTab searchTab filePanel searchPanel tree tabs
  searchQuery replaceText matchCase breadcrumb findKey
  editorHost editorEmpty entry liveButton runKey
  previewFrame previewEmpty previewMessage previewHint
  consoleButton consolePanel saveState cursorState languageState offlineState
  folderInput filesInput zipInput mobileCode mobilePreview dialog
`.trim().split(/\s+/);

const E = Object.fromEntries(ids.map(id => [id, UI.$(id)]));
const root = document.documentElement;

const pageFile = file =>
  file && !file.binary && /\.(html?|md|markdown)$/i.test(file.path);

let project = null;
let preferences = normalizeSettings();
let inWork = location.hash === "#work";
let generation = 0;
let version = 0;
let savedVersion = 0;
let dataVersion = 0;
let freshBlank = false;
let busy = false;
let operationSerial = 0;
let saveBlocked = null;
let activeSave = null;
let saveTimer = 0;
let previewTimer = 0;
let searchTimer = 0;
let editor = null;
let editorPromise = null;
let editorTicket = 0;
let preview = null;
let previewPromise = null;
let previewTicket = 0;
let previewHasDocument = false;
let languageName = () => "Text";
let bootPromise;
let lastRemoteToken = "";
let waitingWorker = null;
let installPrompt = null;
let offlineReady = null;
let reloadForUpdate = false;

const pickerRequests = new Map();
const popupCopies = new Set();
const commands = new Map();

const consoleView = UI.createConsole();

const treeView = UI.createTree({
  onOpen: path => safely(() => openFile(path)),
  onSelect: () => reflectActions(),
  onMenu: (node, action) => safely(() => fileMenu(node, action))
});

const tabView = UI.createTabs({
  onOpen: path => safely(() => openFile(path)),
  onClose: path => safely(() => closeTab(path))
});

const searchView = UI.createSearchResults({
  onOpen: match => safely(async () => {
    if (!match || !findFile(match.path)) return;
    await openFile(match.path, { focus: false });
    editor?.reveal(match.offset, match.length);
  })
});

function findFile(path) {
  return project?.files.find(file => file.path === path) || null;
}

function activeFile() {
  return findFile(project?.active);
}

function directories(value = project) {
  return value
    ? [...new Set(
      [...folderPaths(value)]
        .map(path => path.replace(/\/+$/, ""))
        .filter(Boolean)
    )]
    : [];
}

function pages() {
  return project?.files.filter(pageFile) || [];
}

function previewEntry() {
  return pageFile(findFile(project?.entry))
    ? project.entry
    : pages()[0]?.path || null;
}

function selectedNode() {
  return treeView.selected || (
    activeFile()
      ? { path: activeFile().path, kind: "file" }
      : null
  );
}

function updateSaveState() {
  if (!project) {
    E.saveState.textContent = "No project open";
  } else if (activeSave?.generation === generation) {
    E.saveState.textContent = "Saving…";
  } else if (saveBlocked) {
    E.saveState.textContent = "Not saved";
  } else {
    E.saveState.textContent = savedVersion >= version
      ? "Saved in this browser"
      : "Not saved";
  }
}

function updateConsoleButton() {
  E.consoleButton.textContent = consoleView.count
    ? "Console (" + consoleView.count + ")"
    : "Console";
}

function report(error) {
  if (error?.name === "AbortError") return;
  const message = error?.message || String(error);
  UI.notice(message);
  consoleView.write({
    level: "error",
    source: "Slate",
    text: message
  });
  updateConsoleButton();
}

async function safely(task) {
  try {
    if (bootPromise) await bootPromise;
    return await task();
  } catch (error) {
    report(error);
    return false;
  }
}

function reflectActions() {
  for (const element of document.querySelectorAll("[data-act]")) {
    const command = commands.get(element.dataset.act);
    if (command && "disabled" in element) {
      element.disabled = !command.when();
    }
  }
  E.entry.disabled = busy || !pages().length;
}

function reflectProject() {
  E.resume.hidden = !project;
  E.resume.textContent = project
    ? "Resume " + project.name
    : "Resume project";
  E.projectName.hidden = !inWork || !project;

  if (!project) {
    updateSaveState();
    reflectActions();
    return;
  }

  E.projectName.textContent = project.name;
  document.title = inWork ? project.name + " — Slate" : "Slate";

  treeView.render(project);
  tabView.render(project);
  editor?.retain(project.files);

  const file = activeFile();
  E.breadcrumb.textContent = file?.path || project.name;
  E.languageState.textContent = file
    ? file.binary
      ? "Not text"
      : languageName(file.path)
    : "";

  const choices = pages();
  E.entry.replaceChildren(
    ...choices.map(item => new Option(item.path, item.path))
  );
  E.entry.hidden = choices.length < 2;
  E.entry.value = previewEntry() || "";

  refreshSearch();
  updateSaveState();
  reflectActions();
}

function setMobile(mode) {
  document.body.dataset.mobile = mode;
  E.mobileCode.setAttribute("aria-pressed", String(mode === "code"));
  E.mobilePreview.setAttribute("aria-pressed", String(mode === "preview"));

  document.querySelector('[data-act="mobile-files"]')
    ?.setAttribute("aria-pressed", String(mode === "files"));
}

function setSidebar(panel) {
  E.filePanel.hidden = panel !== "files";
  E.searchPanel.hidden = panel !== "search";
  E.filesTab.setAttribute("aria-pressed", String(panel === "files"));
  E.searchTab.setAttribute("aria-pressed", String(panel === "search"));
}

function setConsole(open) {
  E.consolePanel.hidden = !open;
  E.consoleButton.setAttribute("aria-expanded", String(open));
  E.consoleButton.setAttribute("aria-pressed", String(open));
}

function showHome(cancel = true) {
  if (cancel && busy) operationSerial++;

  for (const request of [...pickerRequests.values()]) {
    request.cancel();
  }

  inWork = false;
  editorTicket++;
  previewTicket++;
  clearTimeout(previewTimer);

  editor?.close();
  preview?.clear();
  previewHasDocument = false;

  E.home.hidden = false;
  E.work.hidden = true;
  E.projectName.hidden = true;
  E.resume.hidden = !project;

  if (project) E.resume.textContent = "Resume " + project.name;

  document.title = "Slate";
  history.replaceState(null, "", "#home");
  reflectActions();
}

function showWorkspace({ focus = true } = {}) {
  if (!project) return showHome(false);

  inWork = true;
  E.home.hidden = true;
  E.work.hidden = false;

  history.replaceState(null, "", "#work");
  reflectProject();

  void openActive(focus).catch(report);
  schedulePreview(0, true);
}

async function ensureEditor() {
  if (editor) return editor;

  editorPromise ||= import("./editor.js").then(module => {
    languageName = module.languageName;

    editor = module.createEditor({
      parent: E.editorHost,
      settings: preferences,

      onChange(change) {
        const file = project?.files.find(item => item.id === change.id);

        if (!file || file.binary || file.text === change.text) return;

        file.text = change.text;
        touch({
          content: true,
          preview: true,
          search: true
        });
      },

      onCursor(position) {
        E.cursorState.textContent = position
          ? `Ln ${position.line}, Col ${position.column}` +
            (position.selected ? ` · ${position.selected} selected` : "")
          : "";

        if (position) {
          E.languageState.textContent = position.language;
        }
      },

      onError: report
    });

    return editor;
  }).catch(error => {
    editorPromise = null;
    throw error;
  });

  return editorPromise;
}

async function openActive(focus = false) {
  const request = ++editorTicket;
  const currentGeneration = generation;
  const file = activeFile();
  const previousFocus = document.activeElement;

  if (!file || file.binary) {
    editor?.close();
    UI.showEditorEmpty(file, Boolean(project?.files.length));
    E.cursorState.textContent = "";
    return;
  }

  if (!editor) {
    E.editorEmpty.hidden = false;
    E.editorEmpty.innerHTML = `
      <p>Opening the editor.</p>
      <button type="button" data-act="home">Home</button>
    `;
  }

  try {
    const instance = await ensureEditor();

    if (
      request !== editorTicket ||
      currentGeneration !== generation ||
      !inWork
    ) return;

    instance.retain(project.files);
    instance.open(file, project.history[file.id]);

    UI.showEditorEmpty(file, true);
    E.languageState.textContent = languageName(file.path);

    if (
      focus &&
      !E.dialog.open &&
      (
        document.activeElement === previousFocus ||
        document.activeElement === document.body ||
        E.editorHost.contains(document.activeElement)
      )
    ) {
      instance.focus();
    }
  } catch (error) {
    if (
      request === editorTicket &&
      currentGeneration === generation
    ) {
      E.editorEmpty.hidden = false;
      E.editorEmpty.innerHTML = `
        <p>The editor could not load; reconnect and reload Slate.</p>
        <button type="button" data-act="home">Home</button>
      `;
    }

    throw error;
  }
}

function emptyPreview(
  message = "Choose an HTML or Markdown file for preview."
) {
  E.previewEmpty.innerHTML = `
    <p>${message}</p>
    <button type="button" data-act="${previewEntry() ? "run" : "new-html"}">
      ${previewEntry() ? "Run preview" : "New HTML file"}
    </button>
  `;

  E.previewEmpty.hidden = false;
  E.previewFrame.hidden = true;
}

function previewStatus(status) {
  root.dataset.previewState = status.state;
  E.previewMessage.textContent = status.message || "";
  E.previewMessage.hidden = !status.message;

  if (status.state === "idle") {
    previewHasDocument = false;
    E.previewHint.textContent = "Preview not running";
    emptyPreview();
  } else if (status.state === "loading") {
    E.previewHint.textContent = status.stale
      ? "Updating the previous preview"
      : "Preparing preview";

    if (!previewHasDocument) {
      emptyPreview("Preparing the browser preview.");
    }
  } else if (status.state === "ready") {
    E.previewHint.textContent = status.warnings
      ? "Preview loaded · check Console"
      : preferences.live
        ? "Live preview"
        : "Run to update";

    E.previewMessage.hidden = true;
  } else if (status.state === "error") {
    E.previewHint.textContent = status.stale
      ? "Previous preview shown"
      : "Check Console";

    if (status.stale && status.message) {
      E.previewMessage.textContent +=
        " The previous preview is still shown.";
    }

    if (!previewHasDocument) {
      emptyPreview("The preview could not be prepared.");
    }
  } else if (status.state === "navigated") {
    E.previewHint.textContent =
      "Run to return to the project page";
  }
}

async function ensurePreview() {
  if (preview) return preview;

  previewPromise ||= import("./preview.js").then(({ createPreview }) => {
    preview = createPreview({
      frame: E.previewFrame,

      onConsole(message) {
        consoleView.write(message);
        updateConsoleButton();
      },

      onStatus: previewStatus,

      onNavigate(path) {
        if (!inWork || E.dialog.open) return;

        if (busy) {
          return UI.notice(
            "Finish the file operation before changing preview pages."
          );
        }

        void safely(() => setEntry(path));
      },

      onDownload(file) {
        download(
          file.binary ? file.data : file.text,
          basename(file.path),
          mime(file.path)
        );
        UI.notice("Download requested.");
      }
    });

    return preview;
  }).catch(error => {
    previewPromise = null;
    throw error;
  });

  return previewPromise;
}

function schedulePreview(delay = 300, force = false) {
  clearTimeout(previewTimer);

  if (
    !inWork ||
    !project ||
    (!force && !preferences.live)
  ) return;

  previewTimer = setTimeout(() => void runPreview(), delay);
}

async function runPreview() {
  clearTimeout(previewTimer);

  if (!project || !inWork) return false;

  const request = ++previewTicket;
  const currentGeneration = generation;
  const entry = previewEntry();

  if (!entry) {
    preview?.clear();
    emptyPreview();
    return false;
  }

  try {
    const instance = await ensurePreview();

    if (
      request !== previewTicket ||
      currentGeneration !== generation ||
      !inWork
    ) return false;

    consoleView.clear();
    updateConsoleButton();

    const accepted = await instance.run(project, {
      entry,
      external: preferences.external
    });

    if (
      request !== previewTicket ||
      currentGeneration !== generation ||
      !inWork
    ) return false;

    if (accepted) {
      previewHasDocument = true;
      E.previewFrame.hidden = false;
      E.previewEmpty.hidden = true;
    }

    return accepted;
  } catch (error) {
    if (
      request === previewTicket &&
      currentGeneration === generation
    ) {
      previewStatus({
        state: "error",
        message: error.message || String(error),
        stale: previewHasDocument
      });
      report(error);
    }

    return false;
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);

  if (!project || saveBlocked) return;

  saveTimer = setTimeout(() => void flushSave(), 450);
}

function touch({
  content = false,
  preview: updatePreview = false,
  search = false
} = {}) {
  if (!project) return;

  version++;

  if (content) {
    dataVersion = version;
    freshBlank = false;
  }

  project.updatedAt = Date.now();

  updateSaveState();
  scheduleSave();

  if (updatePreview) schedulePreview();

  if (search) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshSearch, 150);
  }
}

function flushSave(force = false) {
  clearTimeout(saveTimer);

  if (!project || (!force && saveBlocked)) {
    return Promise.resolve(false);
  }

  const currentGeneration = generation;

  if (activeSave?.generation === currentGeneration) {
    return activeSave.promise.then(ok => {
      if (!ok || currentGeneration !== generation) return false;

      return force || version > savedVersion
        ? flushSave(force)
        : true;
    });
  }

  if (!force && savedVersion >= version) {
    return Promise.resolve(true);
  }

  const capturedVersion = version;
  let pending;

  try {
    if (editor) {
      project.history = editor.snapshot(
        project.history,
        project.files
      );
    }

    pending = saveProject(project);
  } catch (error) {
    pending = Promise.reject(error);
  }

  const task = pending.then(() => {
    if (currentGeneration === generation) {
      savedVersion = Math.max(savedVersion, capturedVersion);
      saveBlocked = null;
    }

    return true;
  }, error => {
    if (currentGeneration === generation) {
      saveBlocked = error;
      report(error);
    }

    return false;
  }).finally(() => {
    if (activeSave?.promise === task) {
      activeSave = null;
    }

    if (currentGeneration === generation) {
      updateSaveState();

      if (version > savedVersion && !saveBlocked) {
        scheduleSave();
      }
    }
  });

  activeSave = {
    generation: currentGeneration,
    promise: task
  };

  updateSaveState();
  return task;
}

function applyPreferences(next, { rerun = true } = {}) {
  const previousExternal = preferences.external;

  preferences = normalizeSettings(next);

  root.dataset.theme = preferences.theme;
  root.style.setProperty(
    "--editor-font-size",
    preferences.fontSize + "px"
  );

  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      "content",
      preferences.theme === "light"
        ? "#f5f6f2"
        : "#171a17"
    );

  E.themeButton.textContent = preferences.theme === "dark"
    ? "Light"
    : "Dark";

  E.themeButton.setAttribute(
    "aria-label",
    preferences.theme === "dark"
      ? "Use light theme"
      : "Use dark theme"
  );

  E.liveButton.setAttribute(
    "aria-pressed",
    String(preferences.live)
  );

  editor?.configure(preferences);

  if (previousExternal !== preferences.external) {
    previewTicket++;
    preview?.clear();
    previewHasDocument = false;

    for (const copy of popupCopies) {
      copy.controller.destroy();

      if (!copy.window.closed) {
        copy.runButton.disabled = true;
        copy.status.textContent =
          "Preview permissions changed. Open a new copy from Slate.";
      }
    }

    popupCopies.clear();

    if (rerun) schedulePreview(0, true);
  } else if (rerun && preferences.live) {
    schedulePreview(0);
  }

  if (!preferences.live) {
    clearTimeout(previewTimer);
  }

  reflectActions();
}

async function changePreferences(next) {
  const externalChanged =
    preferences.external !== next.external;

  applyPreferences(next);

  if (externalChanged && inWork) {
    void runPreview();
  }

  try {
    await saveSettings(preferences);
  } catch (error) {
    UI.notice(
      "Not all settings could be saved. " +
      (error.message || String(error))
    );
  }
}

async function mutate(task) {
  if (!project && task.needsProject) {
    throw new Error("Open a project first.");
  }

  if (busy) {
    throw new Error("Finish the current file operation first.");
  }

  const ticket = ++operationSerial;

  const check = () => {
    if (ticket !== operationSerial) {
      throw new DOMException("Cancelled", "AbortError");
    }
  };

  busy = true;
  reflectActions();

  try {
    return await task(check);
  } finally {
    busy = false;
    reflectActions();

    if (ticket !== operationSerial) {
      UI.notice(
        "File operation cancelled. Originals were not changed."
      );
    }
  }
}

function installProject(next, {
  saved = false,
  open = true,
  fresh = false,
  keepBlocked = false
} = {}) {
  const validated = next ? restoreProject(next) : null;

  clearTimeout(saveTimer);
  clearTimeout(previewTimer);
  clearTimeout(searchTimer);

  generation++;
  editorTicket++;
  previewTicket++;

  editor?.reset();
  preview?.clear();

  previewHasDocument = false;
  project = validated;
  version = project && !saved ? 1 : 0;
  dataVersion = version;
  savedVersion = 0;
  freshBlank = fresh;

  if (!keepBlocked) {
    saveBlocked = null;
  }

  E.searchQuery.value = "";
  E.replaceText.value = "";

  setSidebar("files");
  consoleView.clear();
  updateConsoleButton();

  if (project && open) {
    setMobile("code");
    showWorkspace({ focus: !saved });
  } else {
    showHome(false);
  }

  reflectProject();

  if (project && !saved) {
    scheduleSave();
  }
}

async function confirmReplacement() {
  if (!project || freshBlank) return true;

  return UI.confirmAction({
    title: "Replace the current project?",
    message:
      "Opening another project replaces this browser’s current copy. " +
      "Export a ZIP first if you need to keep " + project.name +
      ". Files on your computer are not changed.",
    confirm: "Open other project"
  });
}

function commitModel(value, { focus = true } = {}) {
  project = restoreProject(value);

  touch({
    content: true,
    preview: true,
    search: true
  });

  reflectProject();
  void openActive(focus).catch(report);
}

async function openFile(path, options = {}) {
  const file = findFile(path);

  if (!file) {
    throw new Error("File not found: " + path);
  }

  const fromTab =
    document.activeElement?.getAttribute("role") === "tab";
  const focus = options.focus ?? !fromTab;

  let changed = project.active !== path;
  project.active = path;

  if (!project.tabs.includes(path)) {
    project.tabs.push(path);
    changed = true;
  }

  if (pageFile(file) && project.entry !== path) {
    project.entry = path;
    changed = true;
    schedulePreview(0, true);
  }

  if (changed) touch();

  if (!inWork) {
    showWorkspace({ focus: false });
  }

  reflectProject();
  setMobile("code");

  if (fromTab && !focus) {
    [...E.tabs.querySelectorAll("[data-tab-open]")]
      .find(button => button.dataset.tabOpen === path)
      ?.focus({ preventScroll: true });
  }

  await openActive(focus);
}

function closeTab(path = project?.active) {
  if (!project || !path || !project.tabs.includes(path)) return;

  const index = project.tabs.indexOf(path);

  project.tabs = project.tabs.filter(item => item !== path);

  if (project.active === path) {
    project.active =
      project.tabs[Math.min(index, project.tabs.length - 1)] ||
      null;
  }

  touch();
  reflectProject();
  void openActive(false).catch(report);
}

function setEntry(path) {
  if (!pageFile(findFile(path))) {
    throw new Error("Choose an HTML or Markdown page.");
  }

  project.entry = path;
  touch();
  reflectProject();
  schedulePreview(0, true);
}

function refreshSearch() {
  clearTimeout(searchTimer);

  const query = E.searchQuery.value;
  const results = project && query
    ? searchFiles(project.files, query, E.matchCase.checked)
    : [];

  searchView.render(results, query);
  reflectActions();
}

function focusSearch() {
  if (!inWork) {
    showWorkspace({ focus: false });
  }

  setSidebar("search");
  setMobile("files");
  refreshSearch();

  E.searchQuery.focus();
  E.searchQuery.select();
}

function folderPrefix() {
  const node = selectedNode();

  return node?.kind === "folder"
    ? node.path + "/"
    : node
      ? dirname(node.path)
      : "";
}

function uniquePath(prefix, name) {
  const used = new Set([
    ...directories(),
    ...project.files.map(file => file.path)
  ]);

  let candidate = prefix + name;
  let number = 2;

  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const suffix = dot > 0 ? name.slice(dot) : "";

  while (used.has(candidate)) {
    candidate = prefix + stem + "-" + number++ + suffix;
  }

  return candidate;
}

function unusedPath(value, ignore = null) {
  const path = cleanPath(value);

  if (path === ignore) return path;

  if (
    project.files.some(file =>
      file.path === path && file.path !== ignore
    ) ||
    directories().includes(path)
  ) {
    throw new Error("A file or folder already uses that path.");
  }

  let parent = dirname(path).replace(/\/$/, "");

  while (parent) {
    if (
      project.files.some(file =>
        file.path === parent && file.path !== ignore
      )
    ) {
      throw new Error(
        "A file is already using a parent folder’s name: " +
        parent
      );
    }

    parent = dirname(parent).replace(/\/$/, "");
  }

  return path;
}

async function newFile(html = false) {
  return mutate(async check => {
    if (!project) {
      throw new Error("Open a project first.");
    }

    const path = await UI.promptValue({
      title: "New file",
      label: "File path",
      value: uniquePath(
        folderPrefix(),
        html || !pages().length
          ? "untitled.html"
          : "untitled.js"
      ),
      hint:
        "Use folder/name.ext to create a file inside a folder.",
      validate: value => unusedPath(value)
    });

    check();
    if (path === null) return;

    const file = {
      id: makeId(),
      path,
      binary: false,
      text: ""
    };

    const files = [...project.files, file];

    const candidate = {
      ...project,
      files,
      tabs: [...project.tabs, path],
      active: path,
      entry: pageFile(file) ? path : project.entry
    };

    commitModel(candidate);
    setMobile("code");
  });
}

async function newFolder() {
  return mutate(async check => {
    if (!project) {
      throw new Error("Open a project first.");
    }

    const path = await UI.promptValue({
      title: "New folder",
      label: "Folder path",
      value: uniquePath(folderPrefix(), "new-folder"),
      validate: value => unusedPath(value)
    });

    check();
    if (path === null) return;

    commitModel({
      ...project,
      dirs: [...directories(), path]
    }, {
      focus: false
    });

    treeView.focus(path);
  });
}

async function renameNode(node = selectedNode()) {
  if (!node) return;

  return mutate(async check => {
    const path = await UI.promptValue({
      title: node.kind === "folder"
        ? "Rename folder"
        : "Rename file",
      label: "New path",
      value: node.path,
      submit: "Rename",
      hint:
        "Links and imports inside code are not changed automatically.",

      validate(value) {
        const result = unusedPath(value, node.path);

        if (
          node.kind === "folder" &&
          result.startsWith(node.path + "/")
        ) {
          throw new Error(
            "A folder cannot be moved inside itself."
          );
        }

        return result;
      }
    });

    check();

    if (path === null || path === node.path) return;

    const mapPath = value =>
      value === node.path
        ? path
        : node.kind === "folder" &&
          value?.startsWith(node.path + "/")
          ? path + value.slice(node.path.length)
          : value;

    commitModel({
      ...project,
      files: project.files.map(file => ({
        ...file,
        path: mapPath(file.path)
      })),
      dirs: directories().map(mapPath),
      tabs: project.tabs.map(mapPath),
      active: mapPath(project.active),
      entry: mapPath(project.entry)
    });
  });
}

async function deleteNode(node = selectedNode()) {
  if (!node) return;

  return mutate(async check => {
    const confirmed = await UI.confirmAction({
      title: node.kind === "folder"
        ? "Delete folder?"
        : "Delete file?",
      message:
        "Remove " + node.path +
        " from this browser project? " +
        "This does not delete originals on your computer.",
      confirm: "Delete",
      danger: true
    });

    check();
    if (!confirmed) return;

    const removed = file =>
      file.path === node.path ||
      (
        node.kind === "folder" &&
        file.path.startsWith(node.path + "/")
      );

    const deleted = project.files.filter(removed);
    const paths = new Set(deleted.map(file => file.path));
    const files = project.files.filter(file => !removed(file));
    const tabs = project.tabs.filter(path => !paths.has(path));
    const history = { ...project.history };

    for (const file of deleted) {
      delete history[file.id];
    }

    commitModel({
      ...project,
      files,
      tabs,
      history,
      dirs: directories().filter(path =>
        node.kind !== "folder" ||
        (
          path !== node.path &&
          !path.startsWith(node.path + "/")
        )
      ),
      active: paths.has(project.active)
        ? tabs.at(-1) || null
        : project.active,
      entry: paths.has(project.entry)
        ? files.find(pageFile)?.path || null
        : project.entry
    });
  });
}

async function renameProject() {
  return mutate(async check => {
    const name = await UI.promptValue({
      title: "Rename project",
      value: project.name,
      submit: "Rename",

      validate(value) {
        if (!value.trim()) {
          throw new Error("Enter a project name.");
        }

        return value.trim();
      }
    });

    check();

    if (name === null || name === project.name) return;

    project.name = name;
    touch({ content: true });
    reflectProject();
  });
}

async function replaceAll() {
  return mutate(async check => {
    const query = E.searchQuery.value;
    if (!query) return;

    const matches = searchFiles(
      project.files,
      query,
      E.matchCase.checked
    );

    if (!matches.length) {
      return UI.notice("No matches to replace.");
    }

    const count = new Set(
      matches.map(match => match.path)
    ).size;

    const confirmed = await UI.confirmAction({
      title: "Replace project text?",
      message:
        `Replace ${matches.length} matches in ${count} files? ` +
        "Undo is separate for each file.",
      confirm: "Replace all"
    });

    check();
    if (!confirmed) return;

    const instance = await ensureEditor();
    check();

    let changed = 0;

    for (const file of project.files) {
      if (file.binary) continue;

      const text = replaceMatches(
        file.text,
        query,
        E.replaceText.value,
        E.matchCase.checked
      );

      if (
        text !== file.text &&
        instance.replace(file, text, project.history[file.id])
      ) {
        changed++;
      }
    }

    refreshSearch();

    UI.notice(
      changed
        ? `Updated ${changed} files. Undo is available in each file.`
        : "No file contents changed."
    );
  });
}

async function fileMenu(
  node = selectedNode(),
  action = null
) {
  if (action === "rename") return renameNode(node);
  if (action === "delete") return deleteNode(node);

  const items = [];

  if (node) {
    items.push({
      id: "rename",
      label: "Rename"
    });

    if (node.kind === "file") {
      items.push({
        id: "download",
        label: "Download file"
      });
    }

    items.push({
      id: "delete",
      label: "Delete"
    });
  }

  items.push(
    {
      id: "add-files",
      label: "Add files from computer"
    },
    {
      id: "open-zip",
      label: "Open project ZIP"
    },
    {
      id: "export",
      label: "Export project ZIP"
    }
  );

  const choice = await UI.chooseAction({
    title: node?.path || "Project files",
    items
  });

  if (choice === "rename") return renameNode(node);
  if (choice === "delete") return deleteNode(node);
  if (choice === "download") return downloadFile(node.path);
  if (choice) return dispatch(choice);
}

function downloadFile(path = project?.active) {
  const file = findFile(path);

  if (!file) {
    throw new Error("Select a file to download.");
  }

  download(
    file.binary ? file.data : file.text,
    basename(file.path),
    mime(file.path)
  );

  UI.notice("Download requested.");
}

function pickFiles(id) {
  pickerRequests.get(id)?.cancel();
  const input = E[id];

  return new Promise(resolve => {
    function finish(value) {
      input.removeEventListener("change", changed);
      input.removeEventListener("cancel", cancelled);

      if (pickerRequests.get(id)?.finish === finish) {
        pickerRequests.delete(id);
      }

      resolve(value);
    }

    function changed() {
      finish([...input.files]);
    }

    function cancelled() {
      finish(null);
    }

    pickerRequests.set(id, {
      finish,
      cancel: cancelled
    });

    input.value = "";
    input.addEventListener("change", changed, { once: true });
    input.addEventListener("cancel", cancelled, { once: true });

    try {
      input.click();
    } catch (error) {
      cancelled();
      report(error);
    }
  });
}

function importMessage(receipt) {
  const count = receipt.project.files.length;
  const messages = [`Opened ${count} files in this tab.`];

  if (receipt.excluded.length) {
    messages.push(
      `Skipped ${receipt.excluded.length} folders named node_modules or .git.`
    );
  }

  if (receipt.source === "directory-picker") {
    messages.push("This picker cannot copy empty folders.");
  }

  messages.push("Originals were not changed.");
  UI.notice(messages.join(" "));
}

async function openFolder(forcePicker = false) {
  let handle = null;
  let selected = null;

  if (
    !forcePicker &&
    typeof window.showDirectoryPicker === "function" &&
    isSecureContext
  ) {
    handle = await window.showDirectoryPicker({
      mode: "read"
    });
  } else {
    selected = await pickFiles("folderInput");

    if (selected === null) return;

    if (!selected.length) {
      return UI.notice(
        "The picker returned no files; " +
        "this picker cannot copy empty folders."
      );
    }
  }

  return mutate(async check => {
    UI.notice(
      "Reading the selected folder. Originals are not changed."
    );

    const receipt = handle
      ? await readDirectory(handle, {
        onProgress: check
      })
      : await readFiles(selected, {
        directory: true,
        onProgress: check
      });

    check();

    if (!await confirmReplacement()) return;
    check();

    installProject(receipt.project);
    importMessage(receipt);
  });
}

async function openZip() {
  const selected = await pickFiles("zipInput");
  if (!selected?.length) return;

  return mutate(async check => {
    UI.notice("Reading the selected ZIP.");

    const next = await unzipProject(selected[0]);
    check();

    if (!await confirmReplacement()) return;
    check();

    installProject(next);
    UI.notice(
      "ZIP opened in this tab. The original ZIP was not changed."
    );
  });
}

async function addFiles() {
  const targetGeneration = generation;
  const prefix = folderPrefix();
  const selected = await pickFiles("filesInput");

  if (!selected?.length) return;

  if (targetGeneration !== generation) {
    return UI.notice(
      "The project changed; the selected files were not added."
    );
  }

  return mutate(async check => {
    const receipt = await readFiles(selected, {
      onProgress: check
    });

    check();

    const incoming = receipt.project.files.map(file => ({
      ...file,
      path: prefix + file.path
    }));

    const existing = new Map(
      project.files.map(file => [file.path, file])
    );

    const replacements = incoming.filter(file =>
      existing.has(file.path)
    );

    const history = { ...project.history };

    const merged = new Map(
      project.files.map(file => [file.path, file])
    );

    for (const file of incoming) {
      const previous = existing.get(file.path);

      merged.set(
        file.path,
        previous ? { ...file, id: previous.id } : file
      );

      if (previous && (previous.binary || file.binary)) {
        delete history[previous.id];
      }
    }

    const candidate = restoreProject({
      ...project,
      files: [...merged.values()],
      history
    });

    if (replacements.length) {
      const confirmed = await UI.confirmAction({
        title: "Replace existing files?",
        message:
          `Replace ${replacements.length} existing files ` +
          "in this browser project? " +
          "Replaced images and other non-text files " +
          "cannot be undone in the text editor.",
        confirm: "Replace files"
      });

      check();
      if (!confirmed) return;
    }

    const textReplacements = replacements.filter(file =>
      !file.binary && !existing.get(file.path).binary
    );

    if (textReplacements.length) {
      const instance = await ensureEditor();
      check();

      for (const incomingFile of textReplacements) {
        const previous = existing.get(incomingFile.path);

        instance.replace(
          previous,
          incomingFile.text,
          project.history[previous.id]
        );

        candidate.files.find(file =>
          file.id === previous.id
        ).text = instance.getText(previous.id);
      }
    }

    check();

    commitModel(candidate, { focus: false });

    UI.notice(
      `Added or replaced ${incoming.length} files in this tab. ` +
      "Originals were not changed."
    );
  });
}

async function exportProject() {
  const snapshot = {
    ...project,
    files: project.files.map(file => ({ ...file })),
    dirs: [...project.dirs]
  };

  const bytes = await zipProject(snapshot);
  const name =
    snapshot.name.replace(/[\/\\]/g, "-") || "project";

  download(bytes, name + ".zip", "application/zip");

  UI.notice(
    "ZIP download requested. " +
    "Keep the downloaded file as your separate copy."
  );
}

async function createBlank() {
  return mutate(async check => {
    if (!await confirmReplacement()) return;
    check();

    installProject(blankProject(), {
      fresh: true
    });
  });
}

async function openStarter() {
  return mutate(async check => {
    const kind = await UI.chooseStarter();
    check();

    if (!kind || !await confirmReplacement()) return;
    check();

    installProject(starter(kind));
  });
}

async function reloadBrowserCopy() {
  return mutate(async check => {
    if (project) {
      const confirmed = await UI.confirmAction({
        title: "Reload the browser copy?",
        message:
          "This discards this tab’s current project " +
          "and reads the browser copy. " +
          "Export a ZIP first if you need to keep " +
          "this tab’s version.",
        confirm: "Reload browser copy"
      });

      check();
      if (!confirmed) return;
    }

    const loaded = await loadWorkspace();
    check();

    applyPreferences(loaded.settings, {
      rerun: false
    });

    installProject(loaded.project, {
      saved: true,
      open: inWork
    });
  });
}

async function openPreviewCopy() {
  const entry = previewEntry();

  if (!entry) {
    throw new Error(
      "Create an HTML or Markdown page first."
    );
  }

  const copy = UI.openPreviewWindow({
    name: project.name,
    theme: preferences.theme
  });

  const snapshot = {
    ...project,
    files: project.files.map(file => ({ ...file })),
    dirs: [...project.dirs]
  };

  const external = preferences.external;
  const { createPreview } = await import("./preview.js");

  if (copy.window.closed) return;

  const controller = createPreview({
    frame: copy.frame,
    onDownload: copy.download,

    onStatus(status) {
      if (copy.window.closed) return;

      copy.status.textContent = status.message || (
        status.state === "ready"
          ? "Preview copy loaded."
          : status.state
      );
    },

    onNavigate(path) {
      if (
        pageFile(
          snapshot.files.find(file => file.path === path)
        )
      ) {
        snapshot.entry = path;

        void controller.run(snapshot, {
          entry: path,
          external
        });
      }
    }
  });

  const item = {
    ...copy,
    controller
  };

  popupCopies.add(item);
  copy.runButton.disabled = false;

  copy.runButton.addEventListener("click", () => {
    void controller.run(snapshot, {
      entry: snapshot.entry || entry,
      external
    });
  });

  copy.window.addEventListener("pagehide", () => {
    controller.destroy();
    popupCopies.delete(item);
  }, { once: true });

  await controller.run(snapshot, {
    entry,
    external
  });
}

async function editorCommand(name) {
  const file = activeFile();

  if (!file || file.binary) return;

  setMobile("code");
  await openActive(false);
  editor?.run(name);
}

async function goToLine() {
  const value = await UI.promptValue({
    title: "Go to line",
    label: "Line number",
    value: "1",
    submit: "Go",

    validate(text) {
      const number = Number(text);

      if (!Number.isInteger(number) || number < 1) {
        throw new Error(
          "Enter a whole line number starting at 1."
        );
      }

      return number;
    }
  });

  if (value !== null) {
    await openActive(false);
    editor?.goTo(value);
  }
}

async function showPalette() {
  const list = [...commands.values()].map(command => ({
    ...command,
    label: typeof command.label === "function"
      ? command.label()
      : command.label,
    enabled: command.when
  }));

  const selected = await UI.showCommands(list);

  if (selected) {
    return dispatch(selected);
  }
}

function command(
  id,
  label,
  run,
  when = () => true,
  key = "",
  native = false
) {
  commands.set(id, {
    id,
    label,
    run,
    when,
    shortcut: key,
    native
  });
}

const hasProject = () => Boolean(project);
const mutable = () => Boolean(project) && !busy;
const hasText = () => Boolean(
  activeFile() && !activeFile().binary
);
const idle = () => !busy;

command(
  "home",
  "Home",
  () => showHome()
);

command(
  "blank",
  "Start with a blank page",
  createBlank,
  idle
);

command(
  "starters",
  "Open a starter project",
  openStarter,
  idle
);

command(
  "open-folder",
  "Open a folder from computer",
  () => openFolder(),
  idle
);

command(
  "folder-picker",
  "Open folder using the file picker",
  () => openFolder(true),
  idle
);

command(
  "resume",
  "Resume current project",
  () => showWorkspace(),
  hasProject
);

command(
  "commands",
  "Open commands",
  showPalette,
  () => true,
  "Mod-K"
);

command(
  "rename-project",
  "Rename project",
  renameProject,
  mutable
);

command(
  "theme",
  "Toggle dark or light theme",
  () => changePreferences({
    ...preferences,
    theme: preferences.theme === "dark" ? "light" : "dark"
  })
);

command(
  "settings",
  "Settings",
  async () => {
    const next = await UI.showSettings(preferences);

    if (next) {
      await changePreferences(next);
    }
  }
);

command(
  "files",
  "Show files",
  () => {
    if (!inWork) {
      showWorkspace({ focus: false });
    }

    setSidebar("files");
    setMobile("files");
    treeView.focus();
  },
  hasProject,
  "Mod-Shift-E"
);

command(
  "mobile-files",
  "Show files on this screen",
  () => dispatch("files"),
  hasProject
);

command(
  "search",
  "Search project",
  focusSearch,
  hasProject,
  "Mod-Shift-F"
);

command(
  "clear-search",
  "Clear project search",
  () => {
    E.searchQuery.value = "";
    refreshSearch();
    E.searchQuery.focus();
  },
  hasProject
);

command(
  "new-file",
  "New file",
  () => newFile(),
  mutable
);

command(
  "new-html",
  "New HTML file",
  () => newFile(true),
  mutable
);

command(
  "new-folder",
  "New folder",
  newFolder,
  mutable
);

command(
  "file-menu",
  "File actions",
  () => fileMenu(),
  mutable
);

command(
  "rename-item",
  "Rename selected file or folder",
  () => renameNode(),
  () => mutable() && Boolean(selectedNode())
);

command(
  "delete-item",
  "Delete selected file or folder",
  () => deleteNode(),
  () => mutable() && Boolean(selectedNode())
);

command(
  "download-file",
  "Download current file",
  () => downloadFile(),
  () => Boolean(activeFile())
);

command(
  "add-files",
  "Add files from computer",
  addFiles,
  mutable
);

command(
  "open-zip",
  "Open project ZIP",
  openZip,
  idle
);

command(
  "export",
  "Export project ZIP",
  exportProject,
  hasProject
);

command(
  "reload-browser-copy",
  "Reload saved browser copy",
  reloadBrowserCopy,
  idle
);

command(
  "save",
  "Save in this browser",
  () => flushSave(true),
  hasProject,
  "Mod-S"
);

command(
  "replace-all",
  "Replace all project matches",
  replaceAll,
  () => mutable() && Boolean(E.searchQuery.value)
);

command(
  "find",
  "Find and replace in current file",
  () => editorCommand("find"),
  hasText,
  "Mod-F"
);

command(
  "close-find",
  "Close file find",
  () => editorCommand("closeFind"),
  hasText
);

command(
  "go-to-line",
  "Go to line",
  goToLine,
  hasText
);

command(
  "close-tab",
  "Close current file tab",
  () => closeTab(),
  () => Boolean(project?.active)
);

command(
  "next-tab",
  "Next open file",
  () => {
    const index = project.tabs.indexOf(project.active);

    return openFile(
      project.tabs[(index + 1) % project.tabs.length]
    );
  },
  () => Boolean(project?.tabs.length)
);

command(
  "previous-tab",
  "Previous open file",
  () => {
    const index = project.tabs.indexOf(project.active);

    return openFile(
      project.tabs[
        (index - 1 + project.tabs.length) % project.tabs.length
      ]
    );
  },
  () => Boolean(project?.tabs.length)
);

command(
  "show-code",
  "Show editor on this screen",
  () => {
    if (!inWork) {
      showWorkspace({ focus: false });
    }

    setMobile("code");
    editor?.focus();
  },
  hasProject
);

command(
  "show-preview",
  "Show preview on this screen",
  () => {
    if (!inWork) {
      showWorkspace({ focus: false });
    }

    setMobile("preview");
  },
  hasProject
);

command(
  "live",
  "Toggle preview updates while typing",
  () => changePreferences({
    ...preferences,
    live: !preferences.live
  }),
  hasProject
);

command(
  "run",
  "Run preview",
  runPreview,
  () => Boolean(project && previewEntry()),
  "Mod-Enter"
);

command(
  "new-page",
  "Open preview copy in a new window",
  openPreviewCopy,
  () => Boolean(project && previewEntry())
);

command(
  "console",
  () => E.consolePanel.hidden
    ? "Show console"
    : "Hide console",
  () => {
    setConsole(E.consolePanel.hidden);
  },
  hasProject
);

command(
  "clear-console",
  "Clear preview console",
  () => {
    consoleView.clear();
    updateConsoleButton();
  }
);

command(
  "dismiss-notice",
  "Dismiss notice",
  UI.hideNotice
);

command(
  "install",
  "Install Slate",
  async () => {
    if (!installPrompt) {
      return UI.notice(
        "Use your browser’s Install or Add to Home Screen menu if available."
      );
    }

    const prompt = installPrompt;
    installPrompt = null;

    await prompt.prompt();
    await prompt.userChoice;
  }
);

command(
  "apply-update",
  "Apply available app update",
  async () => {
    if (!waitingWorker) return;

    if (project && !await flushSave(true)) {
      return UI.notice(
        "The browser copy could not be saved. " +
        "Export your project before reloading."
      );
    }

    const confirmed = await UI.confirmAction({
      title: "Apply app update?",
      message:
        "This reloads Slate. " +
        "Your browser-saved project will reopen.",
      confirm: "Reload Slate"
    });

    if (!confirmed) return;

    reloadForUpdate = true;

    waitingWorker.postMessage({
      type: "SKIP_WAITING"
    });
  },
  () => Boolean(waitingWorker)
);

for (const [id, label, name, key] of [
  ["undo", "Undo file edit", "undo", "Mod-Z"],
  [
    "redo",
    "Redo file edit",
    "redo",
    UI.isMac ? "Mod-Shift-Z" : "Mod-Y"
  ],
  ["select-all", "Select all in file", "selectAll", "Mod-A"],
  ["indent", "Indent selection", "indent", "Tab"],
  ["outdent", "Outdent selection", "outdent", "Shift-Tab"],
  ["comment", "Toggle code comment", "comment", "Mod-/"],
  ["fold", "Fold code", "fold", ""],
  ["unfold", "Unfold code", "unfold", ""],
  ["fold-all", "Fold all code", "foldAll", ""],
  ["unfold-all", "Unfold all code", "unfoldAll", ""]
]) {
  command(
    id,
    label,
    () => editorCommand(name),
    hasText,
    key,
    true
  );
}

async function dispatch(id) {
  if (id === "home") return showHome();

  if (bootPromise) await bootPromise;

  const item = commands.get(id);

  if (!item) {
    throw new Error("Action is not registered: " + id);
  }

  if (!item.when()) {
    return UI.notice(
      busy
        ? "Finish the current file operation first."
        : "Open the required project or file first."
    );
  }

  return item.run();
}

document.addEventListener("click", event => {
  const target = event.target.closest("[data-act]");

  if (!target || target.disabled) return;

  event.preventDefault();

  void safely(() => dispatch(target.dataset.act));
});

document.addEventListener("keydown", event => {
  if (
    event.isComposing ||
    event.getModifierState("AltGraph")
  ) return;

  const mod = UI.isMac ? event.metaKey : event.ctrlKey;
  const otherMod = UI.isMac ? event.ctrlKey : event.metaKey;

  if (otherMod) return;

  const value = [
    mod ? "Mod" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    event.key
  ].filter(Boolean).join("-").toLowerCase();

  const item = [...commands.values()].find(entry =>
    !entry.native &&
    entry.shortcut &&
    entry.shortcut.toLowerCase() === value
  );

  if (!item) return;

  if (E.dialog.open) {
    if (item.id === "commands") {
      event.preventDefault();

      if (E.dialog.querySelector("#paletteQuery")) {
        E.dialog.close();
      }
    }

    return;
  }

  if (
    !project &&
    ["find", "save"].includes(item.id)
  ) return;

  event.preventDefault();
  event.stopPropagation();

  void safely(() => dispatch(item.id));
}, true);

E.searchQuery.addEventListener("input", refreshSearch);
E.matchCase.addEventListener("change", refreshSearch);
E.replaceText.addEventListener("input", reflectActions);

E.entry.addEventListener("change", () => {
  void safely(() => {
    if (!busy) setEntry(E.entry.value);
  });
});

window.addEventListener("beforeunload", event => {
  if (
    !project ||
    (
      dataVersion <= savedVersion &&
      saveBlocked?.name !== "ProjectConflictError"
    )
  ) return;

  event.preventDefault();
  event.returnValue = "";
});

document.addEventListener("visibilitychange", () => {
  if (
    document.hidden &&
    project &&
    version > savedVersion
  ) {
    void flushSave();
  }
});

window.addEventListener("online", () => {
  updateOfflineState();
  editor?.retrySyntax();
});

window.addEventListener("offline", updateOfflineState);

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  UI.notice("The browser reports Slate installed.");
});

subscribeStorageChanges(change => {
  if (
    change.key !== "project" ||
    change.token === lastRemoteToken
  ) return;

  lastRemoteToken = change.token;
  saveBlocked = new ProjectConflictError();

  clearTimeout(saveTimer);
  updateSaveState();

  UI.notice(
    "Another tab changed the browser copy. " +
    "Export this tab’s project before reloading it."
  );
});

function updateOfflineState() {
  root.dataset.offlineReady = String(
    offlineReady === true
  );

  E.offlineState.textContent = offlineReady === true
    ? navigator.onLine
      ? "Offline ready"
      : "Offline · cached"
    : navigator.onLine
      ? "Online"
      : "Offline · cache unverified";
}

function checkOfflineCache(worker) {
  if (!worker) return;

  const channel = new MessageChannel();

  const timer = setTimeout(() => {
    channel.port1.close();
  }, 5000);

  channel.port1.onmessage = event => {
    if (event.data?.type !== "CACHE_STATUS") return;

    clearTimeout(timer);
    offlineReady = event.data.ready === true;
    updateOfflineState();
    channel.port1.close();
  };

  worker.postMessage(
    { type: "CACHE_STATUS" },
    [channel.port2]
  );
}

function setupOffline() {
  updateOfflineState();

  if (
    !import.meta.env.PROD ||
    !isSecureContext ||
    !("serviceWorker" in navigator)
  ) return;

  async function register() {
    try {
      const registration =
        await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none"
        });

      function inspect() {
        waitingWorker = registration.waiting;

        if (waitingWorker && !saveBlocked) {
          UI.notice(
            "An app update is ready. " +
            "Use Apply available app update in Commands."
          );
        }

        if (registration.active) {
          checkOfflineCache(registration.active);
        }
      }

      inspect();

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;

        installing?.addEventListener("statechange", () => {
          if (
            installing.state === "installed" ||
            installing.state === "activated"
          ) {
            inspect();
          }

          if (
            installing.state === "redundant" &&
            !registration.active
          ) {
            offlineReady = false;
            updateOfflineState();
          }
        });
      });

      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          if (reloadForUpdate) {
            location.reload();
          } else {
            checkOfflineCache(
              navigator.serviceWorker.controller
            );
          }
        }
      );

      void navigator.serviceWorker.ready.then(ready => {
        checkOfflineCache(ready.active);
      });
    } catch (error) {
      offlineReady = false;
      updateOfflineState();

      if (!saveBlocked) {
        UI.notice(
          "The offline copy could not be prepared. " +
          error.message
        );
      }
    }
  }

  if (document.readyState === "complete") {
    void register();
  } else {
    window.addEventListener(
      "load",
      () => void register(),
      { once: true }
    );
  }
}

async function initialize() {
  E.commandKey.textContent = UI.shortcut("Mod-K");
  E.findKey.textContent = UI.shortcut("Mod-F");
  E.runKey.textContent = UI.shortcut("Mod-Enter");

  setSidebar("files");
  setConsole(false);
  setMobile("code");

  applyPreferences(preferences, {
    rerun: false
  });

  if (inWork) {
    E.home.hidden = true;
    E.work.hidden = false;
    E.saveState.textContent = "Opening browser copy…";

    E.editorEmpty.innerHTML = `
      <p>Reading the saved browser copy.</p>
      <button type="button" data-act="home">Home</button>
    `;
  }

  try {
    const loaded = await loadWorkspace();
    const open = inWork;

    applyPreferences(loaded.settings, {
      rerun: false
    });

    installProject(loaded.project, {
      saved: true,
      open,
      keepBlocked: true
    });
  } catch (error) {
    saveBlocked = error;
    showHome(false);

    UI.notice(
      "The browser copy could not be opened. " +
      "You can still create a project and export it. " +
      (error.message || String(error))
    );
  } finally {
    updateSaveState();
    reflectActions();
    root.dataset.slateReady = "true";
  }
}

setupOffline();
bootPromise = initialize();
