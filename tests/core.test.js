import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import {
  DEFAULT_SETTINGS,
  makeId,
  esc,
  basename,
  dirname,
  mime,
  cleanPath,
  folderPaths,
  readFile as readProjectFile,
  blankProject,
  restoreProject,
  starter,
  searchFiles,
  replaceMatches,
  zipProject,
  unzipProject
} from "../src/core.js";

const encoder = new TextEncoder();

function textFile(path, text = "") {
  return {
    id: makeId(),
    path,
    binary: false,
    text
  };
}

function binaryFile(path, bytes) {
  return {
    id: makeId(),
    path,
    binary: true,
    data: new Uint8Array(bytes)
  };
}

function projectWith(files, dirs = []) {
  const base = blankProject();
  const active = files[0]?.path || null;
  const entry = files.find(file =>
    !file.binary && /\.(html?|md|markdown)$/i.test(file.path)
  )?.path || null;

  return restoreProject({
    ...base,
    name: "Unit test fixture",
    files,
    dirs,
    active,
    tabs: active ? [active] : [],
    entry,
    history: {}
  });
}

function directoryList(project) {
  return [...new Set(
    [...folderPaths(project)]
      .map(path => path.replace(/\/+$/, ""))
      .filter(Boolean)
  )].sort();
}

function fileContents(project) {
  return project.files.map(file => ({
    path: file.path,
    binary: file.binary,
    content: file.binary ? Array.from(file.data) : file.text
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function archiveFile(bytes, name = "fixture.zip") {
  return new File([bytes], name, {
    type: "application/zip"
  });
}

test("defaults use the dark theme and disable external resources", () => {
  assert.equal(DEFAULT_SETTINGS.theme, "dark");
  assert.equal(DEFAULT_SETTINGS.external, false);
  assert.equal(DEFAULT_SETTINGS.live, true);
  assert.equal(DEFAULT_SETTINGS.wrap, true);
  assert.equal(DEFAULT_SETTINGS.fontSize, 13);
  assert.equal(DEFAULT_SETTINGS.tabSize, 2);
});

test("generated identifiers are nonempty and distinct", () => {
  const ids = Array.from({ length: 32 }, () => makeId());

  for (const id of ids) {
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
  }

  assert.equal(new Set(ids).size, ids.length);
});

test("HTML escaping preserves ordinary text and escapes markup", () => {
  assert.equal(esc("Slate files"), "Slate files");

  const escaped = esc(`<script title="'">&</script>`);

  assert.ok(!escaped.includes("<"));
  assert.ok(!escaped.includes(">"));
  assert.ok(!escaped.includes('"'));
  assert.ok(!escaped.includes("'"));
  assert.ok(escaped.includes("&amp;"));
});

test("file name helpers retain project-relative folder paths", () => {
  assert.equal(basename("src/components/button.js"), "button.js");
  assert.equal(dirname("src/components/button.js"), "src/components/");
  assert.equal(basename("index.html"), "index.html");
  assert.equal(dirname("index.html"), "");
});

test("canonical paths preserve spaces and Unicode names", () => {
  assert.equal(cleanPath("src/app.js"), "src/app.js");
  assert.equal(
    cleanPath("assets/profile photo.svg"),
    "assets/profile photo.svg"
  );
  assert.equal(cleanPath("notes/café.md"), "notes/café.md");
});

test("common web files receive appropriate content types", () => {
  assert.match(mime("index.html"), /^text\/html(?:;|$)/i);
  assert.match(mime("styles.css"), /^text\/css(?:;|$)/i);
  assert.match(mime("app.js"), /javascript/i);
  assert.match(mime("data.json"), /json/i);
  assert.match(mime("icon.svg"), /^image\/svg\+xml(?:;|$)/i);
  assert.match(mime("photo.png"), /^image\/png(?:;|$)/i);
});

test("a blank project contains one empty HTML file", () => {
  const project = blankProject();

  assert.equal(project.version, 1);
  assert.equal(project.files.length, 1);
  assert.equal(project.files[0].path, "index.html");
  assert.equal(project.files[0].binary, false);
  assert.equal(project.files[0].text, "");
  assert.equal(project.active, "index.html");
  assert.equal(project.entry, "index.html");
  assert.deepEqual(project.tabs, ["index.html"]);
});

test("separate blank projects do not share identifiers or file objects", () => {
  const first = blankProject();
  const second = blankProject();

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.files[0].id, second.files[0].id);

  first.files[0].text = "Changed fixture";

  assert.equal(second.files[0].text, "");
});

test("restoring a project keeps its project and file identifiers", () => {
  const original = blankProject();
  const restored = restoreProject(original);

  assert.equal(restored.id, original.id);
  assert.equal(restored.files[0].id, original.files[0].id);
  assert.equal(restored.files[0].text, original.files[0].text);
});

test("a renamed file can retain its identifier", () => {
  const original = blankProject();
  const file = original.files[0];

  const renamed = restoreProject({
    ...original,
    files: [{
      ...file,
      path: "pages/home.html"
    }],
    active: "pages/home.html",
    tabs: ["pages/home.html"],
    entry: "pages/home.html"
  });

  assert.equal(renamed.files[0].id, file.id);
  assert.equal(renamed.files[0].path, "pages/home.html");
  assert.ok(directoryList(renamed).includes("pages"));
});

test("restoring closed tabs does not reopen a file", () => {
  const original = blankProject();

  const restored = restoreProject({
    ...original,
    active: null,
    tabs: []
  });

  assert.equal(restored.active, null);
  assert.deepEqual(restored.tabs, []);
  assert.equal(restored.files.length, original.files.length);
});

test("folders include file parents and explicitly empty folders", () => {
  const project = projectWith([
    textFile("index.html", "<p>Fixture</p>"),
    textFile("src/components/button.js", "export const button = true;")
  ], ["assets/empty"]);

  assert.deepEqual(directoryList(project), [
    "assets",
    "assets/empty",
    "src",
    "src/components"
  ]);
});

test("duplicate file paths are rejected", () => {
  assert.throws(() => projectWith([
    textFile("index.html", "First"),
    textFile("index.html", "Second")
  ]));
});

test("a file cannot also occupy a folder path", () => {
  assert.throws(() => projectWith([
    textFile("src", "This is a file."),
    textFile("src/app.js", "export const value = 1;")
  ]));
});

test("an explicit folder cannot have the same path as a file", () => {
  assert.throws(() => projectWith([
    textFile("index.html", "<p>Fixture</p>")
  ], ["index.html"]));
});

for (const kind of ["Personal site", "Landing page", "Small app"]) {
  test(`${kind} starter provides editable HTML, CSS, and JavaScript`, () => {
    const project = starter(kind);

    assert.ok(project.files.some(file =>
      !file.binary && /\.html?$/i.test(file.path)
    ));
    assert.ok(project.files.some(file =>
      !file.binary && /\.css$/i.test(file.path)
    ));
    assert.ok(project.files.some(file =>
      !file.binary && /\.js$/i.test(file.path)
    ));

    const paths = project.files.map(file => file.path);
    assert.equal(new Set(paths).size, paths.length);

    for (const file of project.files) {
      if (!file.binary) assert.equal(typeof file.text, "string");
    }
  });
}

test("reading text preserves its byte-order mark and line endings", async () => {
  const text = "\uFEFFFirst line\r\nSecond line\r\n";
  const blob = new Blob([text], { type: "text/plain" });
  const file = await readProjectFile(blob, "notes.txt");

  assert.equal(file.path, "notes.txt");
  assert.equal(file.binary, false);
  assert.equal(file.text, text);
});

test("invalid UTF-8 is kept as binary data", async () => {
  const bytes = new Uint8Array([255, 254, 128, 65]);
  const blob = new Blob([bytes], { type: "text/plain" });
  const file = await readProjectFile(blob, "invalid.txt");

  assert.equal(file.binary, true);
  assert.deepEqual(Array.from(file.data), Array.from(bytes));
});

test("a NUL byte prevents a file from being treated as editable text", async () => {
  const bytes = new Uint8Array([65, 0, 66]);
  const file = await readProjectFile(new Blob([bytes]), "nul.txt");

  assert.equal(file.binary, true);
  assert.deepEqual(Array.from(file.data), Array.from(bytes));
});

test("project search respects case matching and excludes binary files", () => {
  const files = [
    textFile("index.html", "Slate slate\nSLATE\n"),
    textFile("app.js", 'const name = "Slate";\n'),
    binaryFile("asset.bin", encoder.encode("Slate"))
  ];

  const insensitive = searchFiles(files, "Slate", false);
  const sensitive = searchFiles(files, "Slate", true);

  assert.equal(insensitive.length, 4);
  assert.equal(sensitive.length, 2);
  assert.ok(insensitive.every(match => match.path !== "asset.bin"));
});

test("search treats punctuation as literal text rather than a pattern", () => {
  const text = "a.b[0]\naxb0\na.b[0]";
  const matches = searchFiles([
    textFile("notes.txt", text)
  ], "a.b[0]", true);

  assert.deepEqual(
    matches.map(match => match.offset).sort((left, right) => left - right),
    [0, text.lastIndexOf("a.b[0]")]
  );
});

test("search offsets refer to the original Unicode and CRLF source", () => {
  const text = "İ🙂 first line\r\nSecond café line\r\n";
  const matches = searchFiles([
    textFile("notes.txt", text)
  ], "café", false);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].offset, text.indexOf("café"));
  assert.equal(matches[0].length, "café".length);
  assert.equal(matches[0].line, 2);

  assert.equal(
    text.slice(
      matches[0].offset,
      matches[0].offset + matches[0].length
    ),
    "café"
  );
});

test("replacement respects the case-matching option", () => {
  assert.equal(
    replaceMatches("Slate slate SLATE", "Slate", "Editor", true),
    "Editor slate SLATE"
  );

  assert.equal(
    replaceMatches("Slate slate SLATE", "Slate", "Editor", false),
    "Editor Editor Editor"
  );
});

test("replacement text does not interpret dollar-sign substitutions", () => {
  const source = "a.b[0] and a.b[0]";
  const replacement = "$& + $1 + $$";

  assert.equal(
    replaceMatches(source, "a.b[0]", replacement, true),
    source.split("a.b[0]").join(replacement)
  );
});

test("ZIP round-trip preserves text, binary bytes, and empty folders", {
  timeout: 15000
}, async () => {
  const project = projectWith([
    textFile("index.html", "\uFEFF<p>café</p>\r\n"),
    textFile("src/app.js", 'console.log("Fixture");\n'),
    textFile("assets/profile notes.txt", "Unicode: 🙂\n"),
    binaryFile("assets/raw.bin", [0, 1, 2, 127, 128, 254, 255])
  ], ["docs/empty"]);

  const expectedFiles = fileContents(project);
  const expectedFolders = directoryList(project);
  const bytes = await zipProject(project);
  const imported = await unzipProject(archiveFile(bytes));

  assert.deepEqual(fileContents(imported), expectedFiles);
  assert.deepEqual(directoryList(imported), expectedFolders);
  assert.deepEqual(fileContents(project), expectedFiles);
});

test("an empty project can be exported and imported", {
  timeout: 15000
}, async () => {
  const project = projectWith([]);
  const bytes = await zipProject(project);
  const imported = await unzipProject(archiveFile(bytes, "empty.zip"));

  assert.deepEqual(imported.files, []);
  assert.equal(imported.active, null);
  assert.deepEqual(imported.tabs, []);
});

for (const path of ["../outside.txt", "folder/../../outside.txt"]) {
  test(`ZIP import rejects an escaping archive path: ${path}`, {
    timeout: 15000
  }, async () => {
    const bytes = zipSync({
      [path]: encoder.encode("Unsafe archive fixture")
    });

    await assert.rejects(async () => {
      await unzipProject(archiveFile(bytes, "unsafe.zip"));
    });
  });
}

test("non-ZIP data is not accepted as a project archive", {
  timeout: 15000
}, async () => {
  const bytes = encoder.encode("This is not a ZIP archive.");

  await assert.rejects(async () => {
    await unzipProject(archiveFile(bytes, "broken.zip"));
  });
});
