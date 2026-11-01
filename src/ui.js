import { esc, basename, dirname, folderPaths, mime } from "./core.js";

export const isMac = typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

export function $(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error("Missing interface element: " + id);
  return element;
}

export function shortcut(value = "") {
  return value.replace(/\bMod\b/g, isMac ? "⌘" : "Ctrl")
    .replace(/\bShift\b/g, isMac ? "⇧" : "Shift")
    .replace(/\bAlt\b/g, isMac ? "⌥" : "Alt")
    .replace(/-/g, isMac ? "" : "+");
}

export function notice(message) {
  $("noticeText").textContent = String(message);
  $("notice").hidden = false;
}

export function hideNotice() {
  $("notice").hidden = true;
}

function report(error) {
  console.error(error);
  notice(error?.message || String(error));
}

function invoke(callback, ...args) {
  try {
    Promise.resolve(callback?.(...args)).catch(report);
  } catch (error) {
    report(error);
  }
}

let dialogQueue = Promise.resolve();

function showDialog(title, markup, setup = () => {}) {
  const task = dialogQueue.then(() => new Promise((resolve, reject) => {
    const dialog = $("dialog");
    const content = $("dialogContent");
    const previousFocus = document.activeElement;
    let result = null;
    let settled = false;

    function cleanup(error) {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("close", closed);
      dialog.removeEventListener("cancel", cancelled);
      $("dialogClose").removeEventListener("click", cancel);
      content.removeEventListener("click", cancelClick);
      content.replaceChildren();
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
      if (error) reject(error);
      else resolve(result);
    }

    function closed() {
      cleanup();
    }

    function finish(value) {
      if (!dialog.open) return;
      result = value;
      dialog.close();
    }

    function cancel() {
      finish(null);
    }

    function cancelled(event) {
      event.preventDefault();
      cancel();
    }

    function cancelClick(event) {
      if (event.target.closest("[data-dialog-cancel]")) cancel();
    }

    try {
      $("dialogTitle").textContent = title;
      content.innerHTML = markup;
      dialog.addEventListener("close", closed);
      dialog.addEventListener("cancel", cancelled);
      $("dialogClose").addEventListener("click", cancel);
      content.addEventListener("click", cancelClick);
      const afterOpen = setup(content, finish);
      dialog.showModal();
      afterOpen?.();
    } catch (error) {
      if (dialog.open) dialog.close();
      cleanup(error);
    }
  }));

  dialogQueue = task.catch(() => {});
  return task;
}

export function promptValue({
  title,
  label = "Name",
  value = "",
  hint = "",
  submit = "Create",
  validate = text => text.trim()
}) {
  return showDialog(title, `
    <form>
      <label class="field-label" for="field">${esc(label)}</label>
      <input id="field" value="${esc(value)}" autocomplete="off"
        spellcheck="false" aria-describedby="fieldError" autofocus>
      ${hint ? `<p class="muted">${esc(hint)}</p>` : ""}
      <p id="fieldError" role="alert" hidden></p>
      <div class="dialog-actions">
        <button type="button" data-dialog-cancel>Cancel</button>
        <button type="submit" class="primary">${esc(submit)}</button>
      </div>
    </form>`, (content, finish) => {
    const input = content.querySelector("#field");
    const error = content.querySelector("#fieldError");

    input.addEventListener("input", () => {
      error.hidden = true;
      input.removeAttribute("aria-invalid");
    });

    content.querySelector("form").addEventListener("submit", event => {
      event.preventDefault();
      try {
        finish(validate(input.value));
      } catch (problem) {
        error.textContent = problem.message || String(problem);
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
    });

    return () => {
      input.focus();
      input.select();
    };
  });
}

export function confirmAction({
  title,
  message,
  confirm = "Continue",
  danger = false
}) {
  return showDialog(title, `
    <form>
      <p>${esc(message)}</p>
      <div class="dialog-actions">
        <button type="button" data-dialog-cancel autofocus>Cancel</button>
        <button type="submit" class="${danger ? "danger" : "primary"}">${esc(confirm)}</button>
      </div>
    </form>`, (content, finish) => {
    content.querySelector("form").addEventListener("submit", event => {
      event.preventDefault();
      finish(true);
    });
  }).then(Boolean);
}

export function chooseAction({ title, description = "", items }) {
  return showDialog(title, `
    ${description ? `<p class="muted">${esc(description)}</p>` : ""}
    <div class="command-list">
      ${items.map((item, index) => `
        <button type="button" data-choice="${index}"
          ${item.disabled ? "disabled" : ""}
          ${index === 0 ? "autofocus" : ""}>
          <span>${esc(item.label)}
            ${item.description ? `<small class="muted" style="display:block">${esc(item.description)}</small>` : ""}
          </span>
          ${item.shortcut ? `<span class="muted">${esc(shortcut(item.shortcut))}</span>` : ""}
        </button>`).join("")}
    </div>`, (content, finish) => {
    content.addEventListener("click", event => {
      const button = event.target.closest("[data-choice]");
      if (!button || button.disabled) return;
      finish(items[Number(button.dataset.choice)].id);
    });
  });
}

export function chooseStarter() {
  return chooseAction({
    title: "Open a starter project",
    description: "These are example projects you can change.",
    items: [
      {
        id: "Personal site",
        label: "Personal site",
        description: "Example HTML and CSS files."
      },
      {
        id: "Landing page",
        label: "Landing page",
        description: "Example page with a small interaction."
      },
      {
        id: "Small app",
        label: "Small app",
        description: "Example task list; tasks reset when the preview runs."
      }
    ]
  });
}

export function showCommands(commands) {
  return showDialog("Commands", `
    <label class="sr-only" for="paletteQuery">Find a command</label>
    <input id="paletteQuery" placeholder="Find a command" autocomplete="off"
      spellcheck="false" role="combobox" aria-autocomplete="list"
      aria-expanded="true" aria-controls="commandResults" autofocus>
    <div id="commandResults" class="command-list" role="listbox"></div>`,
  (content, finish) => {
    const input = content.querySelector("#paletteQuery");
    const list = content.querySelector("#commandResults");
    let filtered = [];
    let selected = -1;
    const enabled = command => typeof command.enabled === "function"
      ? command.enabled() : command.enabled !== false;

    function draw(reset = false) {
      const query = input.value.trim().toLowerCase();
      filtered = commands.filter(command =>
        [command.label, command.id, command.keywords || ""]
          .join(" ").toLowerCase().includes(query)
      );

      if (reset || selected < 0 || !filtered[selected] ||
          !enabled(filtered[selected])) {
        selected = filtered.findIndex(enabled);
      }

      list.innerHTML = filtered.length ? filtered.map((command, index) => `
        <button type="button" id="palette-command-${index}" data-command="${index}"
          role="option" aria-selected="${index === selected}" tabindex="-1"
          class="${index === selected ? "selected" : ""}"
          ${enabled(command) ? "" : "disabled"}>
          <span>${esc(command.label)}</span>
          <span class="muted">${esc(shortcut(command.shortcut || ""))}</span>
        </button>`).join("") : `
          <p class="muted">No matching commands.</p>
          <button type="button" data-clear-query>Clear search</button>`;

      if (selected >= 0) {
        input.setAttribute("aria-activedescendant", "palette-command-" + selected);
        list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    input.addEventListener("input", () => draw(true));

    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (selected >= 0 && enabled(filtered[selected])) {
          finish(filtered[selected].id);
        }
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const choices = filtered.map((command, index) =>
          enabled(command) ? index : -1
        ).filter(index => index !== -1);
        if (!choices.length) return;
        const current = choices.indexOf(selected);
        const step = event.key === "ArrowDown" ? 1 : -1;
        selected = choices[
          (current + step + choices.length) % choices.length
        ];
        draw();
      }
    });

    list.addEventListener("click", event => {
      if (event.target.closest("[data-clear-query]")) {
        input.value = "";
        draw(true);
        input.focus();
        return;
      }
      const button = event.target.closest("[data-command]");
      if (!button || button.disabled) return;
      const command = filtered[Number(button.dataset.command)];
      if (enabled(command)) finish(command.id);
    });

    draw(true);
    return () => input.focus();
  });
}

export function showSettings(settings) {
  return showDialog("Settings", `
    <form>
      <div class="settings-grid">
        <label class="setting">Theme
          <select name="theme" autofocus>
            <option value="dark" ${settings.theme === "dark" ? "selected" : ""}>Dark</option>
            <option value="light" ${settings.theme === "light" ? "selected" : ""}>Light</option>
          </select>
        </label>
        <label class="setting">Code text size
          <select name="fontSize">
            ${[11, 12, 13, 14, 20, 28].map(size => `
              <option value="${size}" ${settings.fontSize === size ? "selected" : ""}>${size} px</option>
            `).join("")}
          </select>
        </label>
        <label class="setting">Indent size
          <select name="tabSize">
            ${[2, 4].map(size => `
              <option value="${size}" ${settings.tabSize === size ? "selected" : ""}>${size} spaces</option>
            `).join("")}
          </select>
        </label>
      </div>
      <label class="check">
        <input type="checkbox" name="wrap" ${settings.wrap ? "checked" : ""}>
        Wrap long lines
      </label>
      <label class="check">
        <input type="checkbox" name="live" ${settings.live ? "checked" : ""}>
        Update preview while typing
      </label>
      <label class="check">
        <input type="checkbox" name="external" ${settings.external ? "checked" : ""}>
        Allow online code and resources
      </label>
      <p class="settings-note">Online package imports use esm.sh. Only run code you trust.</p>
      <p class="settings-note">This isolated preview does not provide persistent app storage or a Node server. Page-generated downloads are blocked; Slate’s file downloads remain available.</p>
      <p class="settings-note">Folder imports only read your originals. Browser storage can be cleared or evicted; export a ZIP to keep a separate copy.</p>
      <div class="dialog-actions">
        <button type="button" data-dialog-cancel>Cancel</button>
        <button type="submit" class="primary">Apply</button>
      </div>
    </form>`, (content, finish) => {
    content.querySelector("form").addEventListener("submit", event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      finish({
        theme: values.get("theme"),
        fontSize: Number(values.get("fontSize")),
        tabSize: Number(values.get("tabSize")),
        wrap: values.has("wrap"),
        live: values.has("live"),
        external: values.has("external")
      });
    });
  });
}

export function createTree({
  host = $("tree"),
  onOpen = () => {},
  onSelect = () => {},
  onMenu = () => {}
} = {}) {
  let project = null;
  let projectId = null;
  let lastActive = null;
  let selectedPath = null;
  let nodes = new Map();
  const expanded = new Set();

  host.setAttribute("role", "tree");

  const rows = () => [...host.querySelectorAll("[role=treeitem]")];
  const rowFor = path => rows().find(row => row.dataset.treePath === path);

  function select(path, focus = false, notify = true) {
    const node = nodes.get(path);
    if (!node) return false;
    const changed = selectedPath !== path;
    selectedPath = path;

    for (const row of rows()) {
      const current = row.dataset.treePath === path;
      row.tabIndex = current ? 0 : -1;
      row.classList.toggle("active", current);
      row.setAttribute("aria-selected", String(current));
    }

    if (focus) {
      const row = rowFor(path);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    if (notify && changed) invoke(onSelect, { ...node });
    return true;
  }

  function render(value, options = {}) {
    const focused = host.contains(document.activeElement);
    const focusedPath = document.activeElement
      ?.closest("[data-tree-path]")?.dataset.treePath;

    project = value;
    if (!project) {
      nodes.clear();
      selectedPath = null;
      host.replaceChildren();
      return;
    }

    if (project.id !== projectId) {
      projectId = project.id;
      lastActive = null;
      selectedPath = null;
      expanded.clear();
    }

    nodes = new Map();
    for (const path of folderPaths(project)) {
      const normalized = path.replace(/\/+$/, "");
      if (normalized) nodes.set(normalized, {
        path: normalized,
        name: basename(normalized),
        kind: "folder"
      });
    }
    for (const file of project.files) {
      nodes.set(file.path, {
        path: file.path,
        name: basename(file.path),
        kind: "file"
      });
    }

    const requested = typeof options.select === "string"
      ? options.select : options.select?.path;
    const preferred = requested !== undefined
      ? requested
      : project.active !== lastActive
        ? project.active
        : selectedPath;

    selectedPath = nodes.has(preferred)
      ? preferred
      : nodes.has(project.active)
        ? project.active
        : null;
    lastActive = project.active;

    let parent = selectedPath ? dirname(selectedPath).replace(/\/$/, "") : "";
    while (parent) {
      expanded.add(parent);
      parent = dirname(parent).replace(/\/$/, "");
    }

    const children = new Map();
    for (const node of nodes.values()) {
      const parentPath = dirname(node.path).replace(/\/$/, "");
      if (!children.has(parentPath)) children.set(parentPath, []);
      children.get(parentPath).push(node);
    }

    for (const siblings of children.values()) {
      siblings.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { numeric: true });
      });
    }

    const fragment = document.createDocumentFragment();

    function append(parentPath, level) {
      const siblings = children.get(parentPath) || [];
      siblings.forEach((node, index) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tree-row";
        row.dataset.treePath = node.path;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-label", node.path);
        row.setAttribute("aria-level", String(level));
        row.setAttribute("aria-posinset", String(index + 1));
        row.setAttribute("aria-setsize", String(siblings.length));
        row.style.paddingLeft = 8 + (level - 1) * 12 + "px";

        if (node.kind === "folder") {
          row.setAttribute("aria-expanded", String(expanded.has(node.path)));
          row.innerHTML = `
            <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"
              style="transform:rotate(${expanded.has(node.path) ? 90 : 0}deg)">
              <path d="m4 2 4 4-4 4"></path>
            </svg>`;
        } else {
          const spacer = document.createElement("span");
          spacer.setAttribute("aria-hidden", "true");
          spacer.style.cssText = "width:12px;flex-shrink:0";
          row.append(spacer);
        }

        const name = document.createElement("span");
        name.textContent = node.name;
        row.append(name);
        fragment.append(row);

        if (node.kind === "folder" && expanded.has(node.path)) {
          append(node.path, level + 1);
        }
      });
    }

    append("", 1);

    if (!nodes.size) {
      const text = document.createElement("p");
      text.className = "muted";
      text.textContent = "Create a file to start editing.";
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.act = "new-file";
      button.textContent = "New file";
      fragment.append(text, button);
    }

    host.replaceChildren(fragment);
    selectedPath ||= rows()[0]?.dataset.treePath || null;
    if (selectedPath) select(selectedPath, false, false);

    if (focused) {
      const target = nodes.has(focusedPath) && rowFor(focusedPath)
        ? focusedPath : selectedPath;
      if (target) select(target, true, false);
    }
  }

  function toggle(node) {
    if (expanded.has(node.path)) expanded.delete(node.path);
    else expanded.add(node.path);
    render(project, { select: node.path });
  }

  function clicked(event) {
    const row = event.target.closest("[data-tree-path]");
    const node = row && nodes.get(row.dataset.treePath);
    if (!node) return;
    select(node.path);
    if (node.kind === "folder") toggle(node);
    else invoke(onOpen, node.path);
  }

  function focused(event) {
    const row = event.target.closest("[data-tree-path]");
    if (row) select(row.dataset.treePath);
  }

  function context(event) {
    const row = event.target.closest("[data-tree-path]");
    const node = row && nodes.get(row.dataset.treePath);
    if (!node) return;
    event.preventDefault();
    select(node.path, true);
    invoke(onMenu, { ...node }, null);
  }

  function keydown(event) {
    const row = event.target.closest("[data-tree-path]");
    const node = row && nodes.get(row.dataset.treePath);
    if (!node || event.altKey || event.ctrlKey || event.metaKey) return;

    const visible = rows();
    const index = visible.indexOf(row);
    let next = null;

    if (event.key === "ArrowDown") next = visible[Math.min(index + 1, visible.length - 1)];
    else if (event.key === "ArrowUp") next = visible[Math.max(index - 1, 0)];
    else if (event.key === "Home") next = visible[0];
    else if (event.key === "End") next = visible.at(-1);
    else if (event.key === "ArrowRight") {
      if (node.kind === "folder") {
        if (!expanded.has(node.path)) toggle(node);
        else if (
          visible[index + 1] &&
          Number(visible[index + 1].getAttribute("aria-level")) >
          Number(row.getAttribute("aria-level"))
        ) next = visible[index + 1];
      }
    } else if (event.key === "ArrowLeft") {
      if (node.kind === "folder" && expanded.has(node.path)) toggle(node);
      else next = rowFor(dirname(node.path).replace(/\/$/, ""));
    } else if (event.key === "Enter" || event.key === " ") {
      if (node.kind === "folder") toggle(node);
      else invoke(onOpen, node.path);
    } else if (event.key === "F2") {
      invoke(onMenu, { ...node }, "rename");
    } else if (event.key === "Delete") {
      invoke(onMenu, { ...node }, "delete");
    } else if (event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")) {
      invoke(onMenu, { ...node }, null);
    } else return;

    event.preventDefault();
    if (next) select(next.dataset.treePath, true);
  }

  host.addEventListener("click", clicked);
  host.addEventListener("focusin", focused);
  host.addEventListener("contextmenu", context);
  host.addEventListener("keydown", keydown);

  return {
    render,
    focus(path = selectedPath || project?.active) {
      if (!nodes.has(path)) return false;
      render(project, { select: path });
      return select(path, true);
    },
    get selected() {
      const node = nodes.get(selectedPath);
      return node ? { ...node } : null;
    },
    destroy() {
      host.removeEventListener("click", clicked);
      host.removeEventListener("focusin", focused);
      host.removeEventListener("contextmenu", context);
      host.removeEventListener("keydown", keydown);
      host.replaceChildren();
      nodes.clear();
      expanded.clear();
    }
  };
}

export function createTabs({
  host = $("tabs"),
  onOpen = () => {},
  onClose = () => {}
} = {}) {
  let project = null;
  host.setAttribute("role", "tablist");

  function render(value) {
    const hadFocus = host.contains(document.activeElement);
    project = value;
    const fragment = document.createDocumentFragment();

    for (const path of project?.tabs || []) {
      const file = project.files.find(item => item.path === path);
      if (!file) continue;
      const active = path === project.active;
      const wrapper = document.createElement("div");
      wrapper.className = "tab" + (active ? " active" : "");
      wrapper.dataset.tabPath = path;

      const open = document.createElement("button");
      open.type = "button";
      open.id = "slate-tab-" + file.id.replace(/[^a-z0-9_-]/gi, "");
      open.dataset.tabOpen = path;
      open.setAttribute("role", "tab");
      open.setAttribute("aria-label", path);
      open.setAttribute("aria-selected", String(active));
      open.setAttribute("aria-controls", file.binary ? "editorEmpty" : "editorHost");
      open.tabIndex = active ? 0 : -1;
      open.textContent = basename(path);

      const close = document.createElement("button");
      close.type = "button";
      close.className = "close-tab";
      close.dataset.tabClose = path;
      close.tabIndex = -1;
      close.setAttribute("aria-label", "Close " + path);
      close.innerHTML = `
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="m3 3 6 6m0-6-6 6"></path>
        </svg>`;

      wrapper.append(open, close);
      fragment.append(wrapper);
    }

    host.replaceChildren(fragment);
    const active = host.querySelector('[role="tab"][aria-selected="true"]');
    const first = host.querySelector('[role="tab"]');
    if (!active && first) first.tabIndex = 0;
    if (hadFocus) (active || first)?.focus({ preventScroll: true });

    const file = project?.files.find(item => item.path === project.active);
    if (file) {
      const panel = $(file.binary ? "editorEmpty" : "editorHost");
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby",
        "slate-tab-" + file.id.replace(/[^a-z0-9_-]/gi, ""));
    }
  }

  function clicked(event) {
    const close = event.target.closest("[data-tab-close]");
    if (close) {
      event.preventDefault();
      invoke(onClose, close.dataset.tabClose);
      return;
    }
    const open = event.target.closest("[data-tab-open]");
    if (open) invoke(onOpen, open.dataset.tabOpen);
  }

  function auxiliary(event) {
    if (event.button !== 1) return;
    const wrapper = event.target.closest("[data-tab-path]");
    if (!wrapper) return;
    event.preventDefault();
    invoke(onClose, wrapper.dataset.tabPath);
  }

  function keydown(event) {
    const button = event.target.closest("[data-tab-open]");
    if (!button || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = [...host.querySelectorAll("[data-tab-open]")];
    const index = buttons.indexOf(button);
    let next;

    if (event.key === "ArrowRight") next = buttons[(index + 1) % buttons.length];
    else if (event.key === "ArrowLeft") next = buttons[(index - 1 + buttons.length) % buttons.length];
    else if (event.key === "Home") next = buttons[0];
    else if (event.key === "End") next = buttons.at(-1);
    else if (event.key === "Delete") {
      event.preventDefault();
      invoke(onClose, button.dataset.tabOpen);
      return;
    } else return;

    event.preventDefault();
    next?.focus({ preventScroll: true });
    if (next) invoke(onOpen, next.dataset.tabOpen);
  }

  host.addEventListener("click", clicked);
  host.addEventListener("auxclick", auxiliary);
  host.addEventListener("keydown", keydown);

  return {
    render,
    destroy() {
      host.removeEventListener("click", clicked);
      host.removeEventListener("auxclick", auxiliary);
      host.removeEventListener("keydown", keydown);
      host.replaceChildren();
    }
  };
}

export function createSearchResults({ onOpen = () => {} } = {}) {
  const host = $("searchResults");
  const summary = $("searchSummary");
  let matches = [];

  function render(value, query = "") {
    matches = Array.isArray(value) ? value : [];
    const fragment = document.createDocumentFragment();

    if (!query || !matches.length) {
      summary.textContent = "";
      const text = document.createElement("p");
      text.className = "muted";
      text.textContent = query
        ? "No matching text in this project."
        : "Search text across your project.";
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.act = query ? "clear-search" : "search";
      button.textContent = query ? "Clear search" : "Search";
      fragment.append(text, button);
    } else {
      const files = new Set(matches.map(match => match.path)).size;
      summary.textContent = matches.length + " matches in " + files +
        (files === 1 ? " file" : " files");

      matches.forEach((match, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.searchMatch = String(index);
        const path = document.createElement("span");
        path.className = "result-path";
        path.textContent = match.path + ":" + match.line;
        const text = document.createElement("span");
        text.className = "result-text";
        text.textContent = match.text;
        button.append(path, text);
        fragment.append(button);
      });
    }

    host.replaceChildren(fragment);
  }

  function clicked(event) {
    const button = event.target.closest("[data-search-match]");
    const match = button && matches[Number(button.dataset.searchMatch)];
    if (match) invoke(onOpen, { ...match });
  }

  host.addEventListener("click", clicked);

  return {
    render,
    destroy() {
      host.removeEventListener("click", clicked);
      host.replaceChildren();
      summary.textContent = "";
      matches = [];
    }
  };
}

export function showEditorEmpty(file, hasFiles = false) {
  const host = $("editorHost");
  const empty = $("editorEmpty");
  const editable = Boolean(file && !file.binary);

  host.hidden = !editable;
  empty.hidden = editable;
  if (editable) return;

  if (file?.binary) {
    empty.innerHTML = `
      <p>This file cannot be edited as text (${esc(mime(file.path))}).</p>
      <button type="button" data-act="download-file">Download file</button>`;
  } else {
    empty.innerHTML = hasFiles
      ? `<p>Choose a file to edit.</p>
         <button type="button" data-act="files">Show files</button>`
      : `<p>Create a file to start editing.</p>
         <button type="button" data-act="new-file">New file</button>`;
  }
}

export function createConsole({ host = $("consoleOutput") } = {}) {
  const owner = host.ownerDocument;
  const view = owner.defaultView;
  const messages = [];
  let pending = [];
  let frame = 0;
  let follow = true;

  host.setAttribute("role", "log");
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-relevant", "additions text");

  function scroll() {
    if (follow && host.getClientRects().length) {
      host.scrollTop = host.scrollHeight;
    }
  }

  function flush() {
    frame = 0;
    if (!pending.length) return;
    const fragment = owner.createDocumentFragment();

    for (const message of pending) {
      const line = owner.createElement("p");
      if (message.level === "error") line.className = "error";
      line.textContent =
        (message.stale ? "Previous preview · " : "") +
        (message.source ? message.source + ": " : "") +
        message.text;
      fragment.append(line);
    }

    pending = [];
    host.append(fragment);
    scroll();
  }

  function clear() {
    if (frame) view.cancelAnimationFrame(frame);
    frame = 0;
    pending = [];
    messages.length = 0;
    follow = true;
    host.innerHTML = `
      <p class="muted">No console messages.</p>
      <button type="button" data-act="run">Run preview</button>`;
  }

  function write(message = {}) {
    if (message.level === "clear") {
      clear();
      return;
    }

    if (!messages.length) host.replaceChildren();

    const entry = {
      level: String(message.level || "log"),
      source: message.source ? String(message.source) : "",
      stale: Boolean(message.stale),
      text: String(message.text ?? "")
    };

    messages.push(entry);
    pending.push(entry);
    if (!frame) frame = view.requestAnimationFrame(flush);
  }

  function scrolled() {
    follow = host.scrollHeight - host.clientHeight - host.scrollTop < 24;
  }

  host.addEventListener("scroll", scrolled, { passive: true });
  const observer = typeof view.ResizeObserver === "function"
    ? new view.ResizeObserver(scroll) : null;
  observer?.observe(host);
  clear();

  return {
    write,
    clear,
    text() {
      return messages.map(message =>
        (message.stale ? "Previous preview · " : "") +
        (message.source ? message.source + ": " : "") +
        message.text
      ).join("\n");
    },
    get count() {
      return messages.length;
    },
    destroy() {
      if (frame) view.cancelAnimationFrame(frame);
      observer?.disconnect();
      host.removeEventListener("scroll", scrolled);
      pending = [];
      messages.length = 0;
      host.replaceChildren();
    }
  };
}

export function openPreviewWindow({
  name = "Preview",
  theme = "dark"
} = {}) {
  const popup = window.open("about:blank", "_blank");
  if (!popup) {
    throw new Error("The preview window was blocked. Allow popups for Slate and try again.");
  }

  try {
    popup.opener = null;
    if (popup.opener !== null) {
      throw new Error("The preview copy could not be isolated.");
    }

    const light = theme === "light";
    const colors = light
      ? {
        bg: "#f5f6f2", panel: "#ffffff", ink: "#253022",
        muted: "#64705d", line: "#d4ddcc", accent: "#316c3f"
      }
      : {
        bg: "#171a17", panel: "#1c201c", ink: "#e1e7df",
        muted: "#9ca797", line: "#323c31", accent: "#9bc8a5"
      };

    const doc = popup.document;
    doc.open();
    doc.write(`<!doctype html>
      <html lang="en"><head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <meta name="referrer" content="no-referrer">
        <title>${esc(name)} — Preview copy</title>
        <style>
          *{box-sizing:border-box}
          html,body{height:100%;margin:0}
          body{display:flex;flex-direction:column;background:${colors.bg};
            color:${colors.ink};font:13px/1.4 system-ui,sans-serif;
            color-scheme:${light ? "light" : "dark"}}
          header{display:flex;align-items:center;gap:12px;min-height:44px;
            padding:8px 12px;border-bottom:1px solid ${colors.line};
            background:${colors.panel}}
          header span{flex:1;min-width:0;overflow:hidden;
            text-overflow:ellipsis;white-space:nowrap}
          button{padding:4px 8px;border:1px solid ${colors.line};
            border-radius:2px;background:transparent;color:inherit;
            font:inherit;cursor:pointer}
          button:disabled{opacity:.5;cursor:default}
          button:focus-visible{outline:1px solid ${colors.accent};outline-offset:2px}
          iframe{display:block;flex:1;width:100%;min-height:0;border:0;background:white}
          footer{padding:8px 12px;border-top:1px solid ${colors.line};
            color:${colors.muted};font-size:12px}
          footer p{margin:0}
          #copyStatus{margin-bottom:4px}
        </style>
      </head><body>
        <header>
          <span>${esc(name)} · Preview copy</span>
          <button id="copyRun" type="button" disabled>Reload copy</button>
        </header>
        <iframe id="copyFrame" title="Preview copy"
          sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe>
        <footer>
          <p id="copyStatus" role="status">Waiting for preview.</p>
          <p>This is a snapshot; changes in Slate do not update this copy.</p>
        </footer>
      </body></html>`);
    doc.close();

    function download(file) {
      if (popup.closed) return;
      const data = file.binary ? file.data : file.text;
      const blob = new popup.Blob([data], { type: mime(file.path) });
      const url = popup.URL.createObjectURL(blob);
      const link = doc.createElement("a");
      link.href = url;
      link.download = basename(file.path);
      doc.body.append(link);
      link.click();
      link.remove();
      popup.setTimeout(() => popup.URL.revokeObjectURL(url), 60000);
    }

    return {
      window: popup,
      frame: doc.getElementById("copyFrame"),
      status: doc.getElementById("copyStatus"),
      runButton: doc.getElementById("copyRun"),
      download
    };
  } catch (error) {
    popup.close();
    throw error;
  }
}
