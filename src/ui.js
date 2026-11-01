import { esc, basename, folderPaths, mime } from "./core.js";

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
  try { Promise.resolve(callback(...args)).catch(report); }
  catch (error) { report(error); }
}

let dialogQueue = Promise.resolve();

function showDialog(title, markup, setup = () => {}) {
  const task = dialogQueue.then(() => new Promise((resolve, reject) => {
    const dialog = $("dialog"), content = $("dialogContent");
    const previousFocus = document.activeElement;
    let result = null, settled = false;

    function cleanup(error) {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("close", closed);
      dialog.removeEventListener("cancel", cancelled);
      $("dialogClose").removeEventListener("click", cancel);
      content.removeEventListener("click", cancelClick);
      content.replaceChildren();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      if (error) reject(error);
      else resolve(result);
    }
    function closed() { cleanup(); }
    function finish(value) {
      if (!dialog.open) return;
      result = value;
      dialog.close();
    }
    function cancel() { finish(null); }
    function cancelled(event) { event.preventDefault(); cancel(); }
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
  title, label = "Name", value = "", hint = "",
  submit = "Create", validate = text => text.trim()
}) {
  return showDialog(title, `
    <form id="valueForm">
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
      try { finish(validate(input.value)); }
      catch (problem) {
        error.textContent = problem.message || String(problem);
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
    });
    return () => { input.focus(); input.select(); };
  });
}

export function confirmAction({
  title, message, confirm = "Continue", danger = false
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
            ${item.description ? `<small class="muted">${esc(item.description)}</small>` : ""}
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
      { id: "Personal site", label: "Personal site", description: "Example HTML and CSS files." },
      { id: "Landing page", label: "Landing page", description: "Example page with a small interaction." },
      { id: "Small app", label: "Small app", description: "Example task list; tasks reset when the preview runs." }
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
    let filtered = [], selected = -1;
    const enabled = command => typeof command.enabled === "function"
      ? command.enabled() : command.enabled !== false;

    function draw(reset = false) {
      const query = input.value.trim().toLowerCase();
      filtered = commands.filter(command =>
        [command.label, command.id, command.keywords || ""]
          .join(" ").toLowerCase().includes(query)
      );
      if (reset || selected < 0 || !filtered[selected] || !enabled(filtered[selected])) {
        selected = filtered.findIndex(enabled);
      }
      list.innerHTML = filtered.length ? filtered.map((command, index) => `
        <button type="button" id="palette-command-${index}" data-command="${index}"
          role="option" aria-selected="${index === selected}" tabindex="-1"
          class="${index === selected ? "selected" : ""}"
          ${enabled(command) ? "" : "disabled"}>
          <span>${esc(command.label)}</span>
          <span class="muted">${esc(shortcut(command.shortcut || ""))}</span>
        </button>`).join("") :
        `<p class="muted">No matching commands.</p>
         <button type="button" data-clear-query>Clear search</button>`;
      if (selected >= 0) {
        input.setAttribute("aria-activedescendant", "palette-command-" + selected);
        list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
      } else input.removeAttribute("aria-activedescendant");
    }

    input.addEventListener("input", () => draw(true));
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (selected >= 0 && enabled(filtered[selected])) finish(filtered[selected].id);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const choices = filtered.map((command, index) => enabled(command) ? index : -1)
          .filter(index => index !== -1);
        if (!choices.length) return;
        const current = choices.indexOf(selected);
        const step = event.key === "ArrowDown" ? 1 : -1;
        selected = choices[(current + step + choices.length) % choices.length];
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
      if (button && !button.disabled) {
        const command = filtered[Number(button.dataset.command)];
        if (enabled(command)) finish(command.id);
      }
    });
    draw(true);
    return () => input.focus();
  });
}

export function showSettings(settings) {
  return showDialog("Settings", `
    <form id="settingsForm">
      <div class="settings-grid">
        <label class="setting">Theme
          <select name="theme" autofocus>
            <option value="dark" ${settings.theme === "dark" ? "selected" : ""}>Dark</option>
            <option value="light" ${settings.theme === "light" ? "selected" : ""}>Light</option>
          </select>
        </label>
        <label class="setting">Code text size
          <select name="fontSize">
            ${[11, 12, 13, 14, 20, 28].map(size =>
              `<option value="${size}" ${settings.fontSize === size ? "selected" : ""}>${size} px</option>`
            ).join("")}
          </select>
        </label>
        <label class="setting">Indent size
          <select name="tabSize">
            ${[2, 4].map(size =>
              `<option value="${size}" ${settings.tabSize === size ? "selected" : ""}>${size} spaces</option>`
            ).join("")}
          </select>
        </label>
      </div>
      <label class="check"><input type="checkbox" name="wrap" ${settings.wrap ? "checked" : ""}>Wrap long lines</label>
      <label class="check"><input type="checkbox" name="live" ${settings.live ? "checked" : ""}>Update preview while typing</label>
      <label class="check"><input type="checkbox" name="external" ${settings.external ? "checked" : ""}>Allow online code and resources</label>
      <p class="settings-note">Online package imports use esm.sh. Only run code you trust.</p>
      <p class="settings-note">The preview cannot run application servers or use persistent app storage. App-generated downloads are not enabled.</p>
      <p class="settings-note">Folder imports only read your originals. Browser storage can be cleared or evicted; export a ZIP to keep a separate copy.</p>
      <div class="dialog-actions">
        <button type="button" data-dialog-cancel>Cancel</button>
        <button type="submit" class="primary">Apply</button>
      </div>
    </form>`, (content, finish) => {
    const form = content.querySelector("form");
    form.addEventListener("submit", event => {
      event.preventDefault();
      const values = new FormData(form);
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
