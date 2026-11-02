// The main process's own log, <userData>/logs/main.log (Linux: ~/.config/hr-harnessor/logs/main.log): each start
// (version, arguments, the Linux launcher's sandbox decision) and every uncaught error — and a start that fails
// says so in a dialog with the log's path instead of ending silently (a launcher click that "does nothing").
// No Electron here, so it is unit-tested (test/startup-log.test.js).
"use strict";

const fs = require("fs");
const path = require("path");

const MAX_BYTES = 512 * 1024; // then main.log → main.log.1

function createLog(file, { now = () => new Date(), fsImpl = fs } = {}) {
  function write(level, msg) {
    const line = `${now().toISOString()} [${level}] ${msg}\n`;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fsImpl.statSync(file).size > MAX_BYTES) fsImpl.renameSync(file, `${file}.1`);
      } catch {
        /* no log yet */
      }
      fsImpl.appendFileSync(file, line);
    } catch {
      /* a log that can't be written must not take the app down */
    }
    return line;
  }
  return { file, info: (m) => write("info", m), warn: (m) => write("warn", m), error: (m) => write("error", m) };
}

function errorText(err) {
  if (err && typeof err === "object" && err.stack) return String(err.stack);
  if (err && typeof err === "object" && err.message) return String(err.message);
  return String(err);
}

/** the error's first line, short enough for a dialog */
function errorHeadline(err) {
  const s = err && typeof err === "object" && err.message ? String(err.message) : String(err);
  const first = s.split("\n")[0].trim() || "unknown error";
  return first.length > 300 ? `${first.slice(0, 297)}…` : first;
}

/** what a start says about itself (one log line) */
function startLine({ version, argv = [], env = {}, platform }) {
  const parts = [`start ${version}`, `pid ${process.pid}`, platform, `argv ${JSON.stringify(argv.slice(1))}`];
  if (env.HRH_SANDBOX_STATE) parts.push(`sandbox ${env.HRH_SANDBOX_STATE}`);
  if (env.APPIMAGE) parts.push(`appimage ${env.APPIMAGE}`);
  if (env.XDG_SESSION_TYPE) parts.push(`session ${env.XDG_SESSION_TYPE}`);
  return parts.join(" · ");
}

/**
 * The failure handler. Before the start has finished, an error is logged, shown (once, after `ready` if need be)
 * and the app exits; afterwards it is only logged (and printed), the app keeps running.
 *   deps: { log, isReady, whenReady, showErrorBox, exit, text: (err, file) => [title, body], print }
 */
function createFailureHandler(deps) {
  let started = false;
  let shown = false;
  function fail(err, where) {
    deps.log.error(`${where}: ${errorText(err)}`);
    if (deps.print) deps.print(`[desktop] ${where}: ${errorText(err)}`);
    if (started || shown) return;
    shown = true;
    const show = () => {
      try {
        const [title, body] = deps.text(err, deps.log.file);
        deps.showErrorBox(title, body);
      } catch {
        /* no dialog then — the log has it */
      }
      deps.exit(1);
    };
    if (deps.isReady()) show();
    else deps.whenReady().then(show, show);
  }
  return {
    fail,
    started: () => {
      started = true;
    },
    get isStarted() {
      return started;
    },
  };
}

module.exports = { createLog, errorText, errorHeadline, startLine, createFailureHandler, MAX_BYTES };
