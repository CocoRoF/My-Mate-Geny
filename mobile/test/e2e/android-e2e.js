// End-to-end check of a debug APK on an emulator/device against the contract
// mock server, driven over the WebView's DevTools socket (debug builds only).
//
//   ANDROID_SERIAL=emulator-5584 node test/e2e/android-e2e.js android/app/build/outputs/apk/debug/app-debug.apk
//
// The mock listens on the host's 127.0.0.1; the emulator reaches it as 10.0.2.2.
// Wipes the app's data first. Needs Node ≥ 22 (global WebSocket).
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { createMock } = require("../../../desktop/test/mock-server");

const APK = path.resolve(process.argv[2] || "");
const PKG = "me.hrletsgo.harnessor";
const ADB = path.join(process.env.ANDROID_HOME || path.join(process.env.HOME, "Android", "Sdk"), "platform-tools", "adb");
const HOST_ALIAS = process.env.GENY_HOST_ALIAS || "10.0.2.2";
const FWD = 9500 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);
const adb = (...a) => execFileSync(ADB, a, { encoding: "utf8" });

async function until(what, fn, ms = 30000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

let ws = null;
let wsTarget = null;
let seq = 0;
const pending = new Map();

function forward() {
  const sockets = adb("shell", "cat", "/proc/net/unix").split("\n").map((l) => (/@(webview_devtools_remote_\d+)/.exec(l) || [])[1]).filter(Boolean);
  const pid = adb("shell", "pidof", PKG).trim();
  const sock = sockets.find((s) => s.endsWith(`_${pid}`));
  if (!sock) throw new Error("no WebView devtools socket yet");
  adb("forward", `tcp:${FWD}`, `localabstract:${sock}`);
}
async function targets() {
  const r = await fetch(`http://127.0.0.1:${FWD}/json/list`);
  return (await r.json()).filter((t) => t.type === "page");
}
let lastMatch = null;
async function attach(match) {
  lastMatch = match;
  const t = await until(`a page matching ${match}`, async () => {
    try {
      return (await targets()).find((x) => match.test(x.url));
    } catch {
      forward(); // the app restarted (new pid → new socket)
      return null;
    }
  });
  if (ws && wsTarget === t.id && ws.readyState === 1) return;
  if (ws) ws.close();
  wsTarget = t.id;
  ws = new WebSocket(t.webSocketDebuggerUrl);
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };
  ws.onclose = () => {
    if (ws && ws.readyState !== 1) wsTarget = null;
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
}
function send(method, params = {}) {
  if (!ws || ws.readyState !== 1) return Promise.reject(new Error("not attached"));
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 8000);
  });
}
async function evaluate(expr) {
  let r;
  try {
    r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  } catch (e) {
    // the activity was recreated under us (its WebView is destroyed): follow
    if (!lastMatch || (ws && ws.readyState === 1 && (await pageUrl()))) throw e;
    if (ws) ws.close();
    ws = null;
    wsTarget = null;
    await attach(lastMatch);
    r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  }
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function pageUrl() {
  try {
    return (await targets()).find((t) => t.id === wsTarget)?.url || "";
  } catch {
    return "";
  }
}

const fill = (server, username, password) => `(() => {
  const set = (id, v) => { document.getElementById(id).value = v; };
  set("server", ${JSON.stringify(server)}); set("username", ${JSON.stringify(username)}); set("password", ${JSON.stringify(password)});
  document.getElementById("go").click();
  return true;
})()`;
const statusText = `document.getElementById("status").textContent`;

function launch(extra = []) {
  adb("shell", "am", "start", "-W", ...extra, "-n", `${PKG}/.MainActivity`);
}
function stopApp() {
  // background first so the WebView flushes its cookies, then kill
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  execFileSync("sleep", ["2"]);
  adb("shell", "am", "force-stop", PKG);
  if (ws) ws.close();
  ws = null;
  wsTarget = null;
}

async function main() {
  if (!process.argv[2] || !fs.existsSync(APK)) throw new Error("usage: node test/e2e/android-e2e.js <app-debug.apk>");
  const mock = createMock({ maxFails: 20 });
  await mock.listen();
  const port = mock.port;
  const server = `http://${HOST_ALIAS}:${port}`;
  const consoleRe = new RegExp(`^${server.replace(/\./g, "\\.")}/$`);
  try {
    step("install, clear data, launch");
    adb("install", "-r", APK);
    adb("shell", "pm", "clear", PKG);
    launch();
    await attach(/^https:\/\/localhost\//);

    step("first start: the local connect page, with the native bridge");
    await until("the page", () => evaluate(`!!window.GenyMobile && !!window.GenyConnect && document.readyState === "complete"`));
    assert.equal(await evaluate(`!!(window.Capacitor && Capacitor.isNativePlatform())`), true);
    assert.equal(await evaluate(`document.getElementById("server").value`), "");
    assert.ok(await evaluate(`document.querySelector(".head img").naturalWidth > 0`), "the logo loads");

    step("unreachable → \"Can't reach the server\"");
    await evaluate(fill(`${HOST_ALIAS}:1`, "admin", "secret"));
    await until("the unreachable error", async () => /Can't reach the server/.test(await evaluate(statusText)));

    step("wrong password → \"Wrong username or password\" (address normalized in the field)");
    await evaluate(fill(` ${HOST_ALIAS}:${port}/ `, "admin", "nope"));
    await until("the credentials error", async () => /Wrong username or password/.test(await evaluate(statusText)));
    assert.equal(await evaluate(`document.getElementById("server").value`), server);

    step("connect (http:// LAN server via native HTTP) → exchange → console with the bridge");
    mock.log.length = 0;
    await evaluate(fill(`${HOST_ALIAS}:${port}`, "admin", "secret"));
    await attach(consoleRe);
    await until("the console page", () => evaluate(`!!document.getElementById("console")`));
    assert.ok(mock.log.some((e) => e.path === "/auth/exchange"), "loaded /auth/exchange");
    assert.ok(mock.log.some((e) => e.path === "/" && e.authed), "console request carried the cookie");
    assert.equal(await evaluate(`!!(window.Capacitor && Capacitor.isNativePlatform())`), true, "native bridge on the server origin");
    const st = await evaluate(`Capacitor.nativePromise("GenyServer", "getState")`);
    assert.equal(st.server, server);
    assert.equal(st.username, "admin");
    await evaluate(`Capacitor.nativePromise("App", "getInfo").then((i) => i.version)`).then((v) => assert.equal(v, "0.4.0-dev"));

    step("next launch goes straight to the saved server");
    stopApp();
    mock.log.length = 0;
    launch();
    await attach(consoleRe);
    await until("the console page", () => evaluate(`!!document.getElementById("console")`));
    assert.ok(mock.log.some((e) => e.path === "/" && e.authed));

    step("expired session → the server's own /login page");
    mock.expireSessions();
    await evaluate(`location.reload(), true`).catch(() => {});
    await until("the login page", async () => (await pageUrl()) === `${server}/login`);

    step("switchServer() from the server's page → connect page, prefilled");
    await evaluate(`Capacitor.nativePromise("GenyServer", "switchServer"), true`).catch(() => {});
    await attach(/^https:\/\/localhost\//);
    await until("prefill", async () => (await evaluate(`document.getElementById("server").value`)) === server);
    assert.equal(await evaluate(`document.getElementById("username").value`), "admin");
    assert.equal(await evaluate(`document.getElementById("password").value`), "");

    step("sign in again, then signOut() clears the cookie");
    await evaluate(`document.getElementById("password").value = "secret"; document.getElementById("go").click(), true`);
    await attach(consoleRe);
    await until("the console page", () => evaluate(`!!document.getElementById("console")`));
    await evaluate(`Capacitor.nativePromise("GenyServer", "signOut"), true`).catch(() => {});
    await attach(/^https:\/\/localhost\//);
    await until("prefill", async () => (await evaluate(`document.getElementById("server").value`)) === server);
    const left = (await send("Network.getCookies", { urls: [`${server}/`] })).cookies;
    assert.equal(left.filter((c) => c.name === "hrh_session").length, 0, "no session cookie left");

    step("server down → offline page; Retry brings the console back once it's up");
    await evaluate(fill(server, "admin", "secret"));
    await attach(consoleRe);
    await until("the console page", () => evaluate(`!!document.getElementById("console")`));
    stopApp();
    await mock.close();
    launch();
    await attach(/^https:\/\/localhost\/offline\.html/);
    await until("offline page", () => evaluate(`!!document.getElementById("retry")`));
    await mock.listen(port);
    await evaluate(`document.getElementById("retry").click(), true`).catch(() => {});
    await attach(consoleRe);
    await until("the console page", () => evaluate(`!!document.getElementById("console")`));

    step("offline page → Switch server → connect page");
    stopApp();
    await mock.close();
    launch();
    await attach(/^https:\/\/localhost\/offline\.html/);
    await until("offline page", () => evaluate(`!!document.getElementById("switch")`));
    await evaluate(`document.getElementById("switch").click(), true`).catch(() => {});
    await attach(/^https:\/\/localhost\/(index\.html)?$/);
    await until("connect page", () => evaluate(`!!document.getElementById("go")`));
    await mock.listen(port);

    step("launcher shortcut \"Switch server\" → connect page");
    await evaluate(fill(server, "admin", "secret"));
    await attach(consoleRe);
    await until("the console page", () => evaluate(`!!document.getElementById("console")`));
    launch(["-a", `${PKG}.SWITCH_SERVER`]);
    await attach(/^https:\/\/localhost\/(index\.html)?$/);
    await until("connect page", () => evaluate(`!!document.getElementById("go")`));

    step("remember off → next cold start forgets the server");
    await evaluate(`document.getElementById("remember").checked = false, true`);
    await evaluate(fill(server, "admin", "secret"));
    await attach(consoleRe);
    await until("the console page", () => evaluate(`!!document.getElementById("console")`));
    stopApp();
    launch();
    await attach(/^https:\/\/localhost\/(index\.html)?$/);
    await until("connect page", () => evaluate(`!!document.getElementById("go")`));
    assert.equal(await evaluate(`document.getElementById("username").value`), "");

    step("pre-0.4 install (ran before, not signed in) → old address prefilled, not used");
    stopApp();
    adb("shell", "pm", "clear", PKG);
    adb("shell", "run-as", PKG, "sh", "-c",
      `'mkdir -p shared_prefs && echo "<?xml version=\\"1.0\\" encoding=\\"utf-8\\" standalone=\\"yes\\" ?><map><string name=\\"lastBinaryVersionCode\\">3</string></map>" > shared_prefs/CapWebViewSettings.xml'`);
    launch();
    await attach(/^https:\/\/localhost\/(index\.html)?$/);
    await until("legacy prefill", async () => (await evaluate(`document.getElementById("server").value`)) === "https://agent.hrletsgo.me");

    console.log("\nANDROID E2E OK");
  } finally {
    if (ws) ws.close();
    try {
      adb("forward", "--remove", `tcp:${FWD}`);
    } catch {}
    await mock.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`\nANDROID E2E FAILED: ${e.stack || e}`);
  targets().then((t) => console.error(`pages: ${JSON.stringify(t.map((x) => x.url))}`), () => {});
  process.exitCode = 1;
});
