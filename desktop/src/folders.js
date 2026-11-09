// "Local folder" for a chat (the console's Folder button, frontend lib/localFolder.ts): a folder on THIS computer.
//
// The server usually runs elsewhere, so a folder picked here can only be linked when the server shares this machine's
// filesystem; otherwise its files are uploaded as a copy. This module gives the page what it needs, and no more:
//
//   pick()          the native folder dialog. The picked folder is granted to that page (scan / read work only inside
//                   folders the user picked), and a probe file with a random nonce is written to the temp dir: a
//                   server that can read that same file sees this filesystem (POST /api/folder-uploads/probe).
//   scan(root, o)   the folder's files (relative paths + sizes), skipping .git / node_modules / caches, never following
//                   symlinks, stopping at the given limits.
//   read(root, rel) one file's bytes, only inside a granted folder.
//   release(root)   drop the grant and the probe file (also on quit, and 15 minutes after the pick).
"use strict";
const fsp = require("fs/promises");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Same list as the server (backend/app/services/folder_upload.py SKIP_NAMES).
const SKIP = new Set([
  ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", ".next", ".nuxt", ".turbo", ".parcel-cache", ".gradle", ".cache", ".DS_Store", "Thumbs.db", "desktop.ini",
]);
const HARD_MAX_FILES = 50000;
const HARD_MAX_BYTES = 4 * 1024 ** 3;
const HARD_MAX_READ = 512 * 1024 ** 2;
const GRANT_TTL_MS = 15 * 60 * 1000;

const clamp = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : dflt);

/** Walk `root`: files as "a/b.txt" (forward slashes) with sizes; skipped names counted; symlinks never followed. */
async function scan(root, opts = {}) {
  const maxFiles = clamp(opts.maxFiles, 1, HARD_MAX_FILES, 10000);
  const maxBytes = clamp(opts.maxBytes, 1, HARD_MAX_BYTES, 500 * 1024 ** 2);
  const files = [];
  const skippedNames = new Map();
  let bytes = 0;
  let skipped = 0;
  let links = 0;
  let truncated = false;
  const stack = [""];
  while (stack.length && !truncated) {
    const rel = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue; // unreadable folder: left out
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.has(e.name)) {
        skipped += 1;
        skippedNames.set(e.name, (skippedNames.get(e.name) || 0) + 1);
        continue;
      }
      if (e.isSymbolicLink()) {
        links += 1;
        continue;
      }
      if (e.isDirectory()) stack.push(r);
      else if (e.isFile()) {
        let size = 0;
        try {
          size = (await fsp.stat(path.join(root, r))).size;
        } catch {
          continue;
        }
        if (files.length + 1 > maxFiles || bytes + size > maxBytes) {
          truncated = true;
          break;
        }
        files.push({ rel: r, size });
        bytes += size;
      }
    }
  }
  return { root, files, bytes, skipped, skippedNames: [...skippedNames.keys()].sort(), links, truncated };
}

/** `rel` inside `root` (real paths, so no symlink or ".." escapes), else null. */
function inside(root, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split(/[\\/]+/).filter((s) => s && s !== ".");
  if (!parts.length || parts.includes("..")) return null;
  let real;
  try {
    real = fs.realpathSync(path.join(root, ...parts));
  } catch {
    return null;
  }
  return real.startsWith(root.endsWith(path.sep) ? root : root + path.sep) ? real : null;
}

function createFolders({ tmpdir = os.tmpdir(), now = () => Date.now() } = {}) {
  const grants = new Map(); // root -> { owner, probe, at }
  const ok = (owner, root) => {
    const g = grants.get(String(root));
    if (!g || g.owner !== owner) return false;
    if (now() - g.at > GRANT_TTL_MS) {
      release(owner, root);
      return false;
    }
    return true;
  };
  function grant(owner, picked) {
    const root = fs.realpathSync(picked);
    const nonce = crypto.randomBytes(24).toString("hex");
    const probe = path.join(tmpdir, `geny-probe-${crypto.randomBytes(12).toString("hex")}`);
    try {
      fs.writeFileSync(probe, nonce, { mode: 0o644 });
    } catch {
      /* no probe: the folder is uploaded as a copy */
    }
    const old = grants.get(root);
    if (old) rm(old.probe);
    grants.set(root, { owner, probe, at: now() });
    return { path: root, name: path.basename(root) || root, probe: { path: probe, nonce } };
  }
  const rm = (f) => {
    try {
      fs.unlinkSync(f);
    } catch {}
  };
  function release(owner, root) {
    const g = grants.get(String(root));
    if (!g || (owner !== null && g.owner !== owner)) return false;
    rm(g.probe);
    grants.delete(String(root));
    return true;
  }
  return {
    grant,
    release,
    releaseAll: () => [...grants.keys()].forEach((r) => release(null, r)),
    scan: (owner, root, opts) => (ok(owner, root) ? scan(String(root), opts) : null),
    read: async (owner, root, rel, maxBytes) => {
      if (!ok(owner, root)) return null;
      const f = inside(String(root), rel);
      if (!f) return null;
      const st = await fsp.stat(f);
      if (!st.isFile() || st.size > clamp(maxBytes, 1, HARD_MAX_READ, HARD_MAX_READ)) return null;
      grants.get(String(root)).at = now(); // still in use
      return fsp.readFile(f);
    },
  };
}

/** IPC for the console page (main.js). `allowed(e)`: the sender is our app page. */
function registerIpc({ ipcMain, dialog, BrowserWindow, app, allowed, pickTitle }) {
  const folders = createFolders();
  const owner = (e) => e.sender.id;
  ipcMain.handle("folders:pick", async (e) => {
    if (!allowed(e)) return null;
    const w = BrowserWindow.fromWebContents(e.sender);
    // (pickTitle: the dialog title in the app's language — main.js / i18n.js)
    const title = (typeof pickTitle === "function" && pickTitle()) || "Choose a folder";
    // createDirectory: macOS shows "New Folder" only when asked (Windows' and Linux's dialogs always have it)
    const r = await dialog.showOpenDialog(w, { title, properties: ["openDirectory", "createDirectory", "dontAddToRecent"] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return folders.grant(owner(e), r.filePaths[0]);
  });
  ipcMain.handle("folders:scan", (e, root, opts) => (allowed(e) ? folders.scan(owner(e), root, opts || {}) : null));
  ipcMain.handle("folders:read", (e, root, rel, max) => (allowed(e) ? folders.read(owner(e), root, rel, max) : null));
  ipcMain.handle("folders:release", (e, root) => (allowed(e) ? folders.release(owner(e), root) : false));
  if (app) app.on("will-quit", () => folders.releaseAll());
  return folders;
}

module.exports = { SKIP, scan, inside, createFolders, registerIpc };
