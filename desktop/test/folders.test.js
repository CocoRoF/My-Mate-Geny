// src/folders.js: scanning a picked folder, reads confined to it, grants per page.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scan, inside, createFolders, registerIpc } = require("../src/folders");

function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hrh-folders-")));
  const w = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  };
  w("README.md", "# hi");
  w("src/a.js", "a");
  w("src/deep/b.js", "bb");
  w("node_modules/x/index.js", "junk");
  w(".git/HEAD", "ref");
  w("pkg/__pycache__/m.pyc", "c");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hrh-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(outside, path.join(root, "link-out"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "src", "secret-link.txt"));
  return { root, outside };
}

test("scan: files with sizes, skips VCS / dependency folders, never follows symlinks", async () => {
  const { root } = tree();
  const r = await scan(root);
  assert.deepEqual(r.files.map((f) => f.rel).sort(), ["README.md", "src/a.js", "src/deep/b.js"]);
  assert.equal(r.bytes, 4 + 1 + 2);
  assert.equal(r.skipped, 3);
  assert.deepEqual(r.skippedNames, [".git", "__pycache__", "node_modules"]);
  assert.equal(r.links, 2);
  assert.equal(r.truncated, false);
});

test("scan: stops at the limits", async () => {
  const { root } = tree();
  assert.equal((await scan(root, { maxFiles: 2 })).truncated, true);
  const r = await scan(root, { maxBytes: 5 });
  assert.equal(r.truncated, true);
  assert.ok(r.bytes <= 5);
});

test("inside: no absolute paths, no .., no symlink escapes", () => {
  const { root } = tree();
  assert.equal(inside(root, "src/a.js"), path.join(root, "src", "a.js"));
  assert.equal(inside(root, "src\\deep\\b.js"), path.join(root, "src", "deep", "b.js"));
  for (const bad of ["../x", "src/../../x", "/etc/passwd", "C:\\x", "", "link-out/secret.txt", "src/secret-link.txt", "a\0b"])
    assert.equal(inside(root, bad), null, bad);
});

test("grants: only the page that picked the folder reads it; release drops the probe", async () => {
  const { root, outside } = tree();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hrh-probe-"));
  const f = createFolders({ tmpdir: tmp });
  const g = f.grant(7, root);
  assert.equal(g.path, root);
  assert.equal(g.name, path.basename(root));
  assert.match(path.basename(g.probe.path), /^geny-probe-[0-9a-f]{24}$/);
  assert.equal(fs.readFileSync(g.probe.path, "utf8"), g.probe.nonce);

  assert.equal((await f.read(7, root, "src/a.js")).toString(), "a");
  assert.equal(await f.read(8, root, "src/a.js"), null, "another page");
  assert.equal(await f.read(7, outside, "secret.txt"), null, "a folder nobody picked");
  assert.equal(await f.read(7, root, "../" + path.basename(outside) + "/secret.txt"), null);
  assert.equal(await f.read(7, root, "README.md", 2), null, "over the size cap");
  assert.equal(await f.scan(8, root), null);
  assert.equal((await f.scan(7, root)).files.length, 3);

  assert.equal(f.release(8, root), false);
  assert.equal(f.release(7, root), true);
  assert.equal(fs.existsSync(g.probe.path), false);
  assert.equal(await f.read(7, root, "src/a.js"), null, "released");
});

test("grants expire", async () => {
  const { root } = tree();
  let t = 0;
  const f = createFolders({ tmpdir: fs.mkdtempSync(path.join(os.tmpdir(), "hrh-probe-")), now: () => t });
  f.grant(1, root);
  t = 16 * 60 * 1000;
  assert.equal(await f.read(1, root, "src/a.js"), null);
});

test("ipc: the dialog's pick is granted; foreign pages get nothing", async () => {
  const { root } = tree();
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => (handlers[ch] = fn) };
  let shown = 0;
  const dialog = { showOpenDialog: async () => (shown++, { canceled: false, filePaths: [root] }) };
  const BrowserWindow = { fromWebContents: () => ({}) };
  registerIpc({ ipcMain, dialog, BrowserWindow, allowed: (e) => e.ours });
  const ours = { ours: true, sender: { id: 3 } };
  const theirs = { ours: false, sender: { id: 3 } };
  assert.equal(await handlers["folders:pick"](theirs), null);
  assert.equal(shown, 0, "no dialog for a foreign page");
  const g = await handlers["folders:pick"](ours);
  assert.equal(g.path, root);
  assert.equal((await handlers["folders:scan"](ours, root, {})).files.length, 3);
  assert.equal(await handlers["folders:scan"](theirs, root, {}), null);
  assert.equal((await handlers["folders:read"](ours, root, "src/deep/b.js", 0)).toString(), "bb");
  assert.equal(await handlers["folders:release"](ours, root), true);
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.equal(await handlers["folders:pick"](ours), null);
});
