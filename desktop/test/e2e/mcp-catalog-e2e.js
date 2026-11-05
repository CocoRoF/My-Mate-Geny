"use strict";
// Actual Local desktop, real public Time package and protocol calls. No paid
// model, media generation, provider installation or real account credentials.
const { App, until, sleep } = require("./screen-capture-e2e");
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  assert = require("assert/strict");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "../../..");
const out =
  process.env.MCP_CATALOG_OUTPUT ||
  fs.mkdtempSync(path.join(os.tmpdir(), "geny-catalog-"));
fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(out, "home-"));
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(path.join(home, ".config/hr-harnessor"), { recursive: true });
fs.writeFileSync(
  path.join(home, ".claude/.credentials.json"),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "fixture-only",
      refreshToken: "fixture-only",
      expiresAt: Date.now() + 86400000,
      scopes: ["user:inference"],
    },
  }),
);
fs.writeFileSync(
  path.join(home, ".config/hr-harnessor/settings.json"),
  JSON.stringify({ language: "ko" }),
);
fs.writeFileSync(path.join(home, "fake-claude-turns.jsonl"), "");
process.env.CLAUDE_BINARY = path.join(__dirname, "fake-claude.py");
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CODEX_HOME = path.join(home, ".codex");
process.env.PLAN_USAGE_FETCH = "false";
process.env.CLI_UPDATE_CHECK = "false";
process.env.MONITOR_ENABLED = "false";
for (const key of [
  "HIGGSFIELD_CREDENTIALS_PATH",
  "HIGGSFIELD_CONFIG_PATH",
  "HIGGSFIELD_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
])
  delete process.env[key];
if (process.env.LOCAL_TEST_PACKAGED_APP)
  delete process.env.HRH_LOCAL_RUNTIME_ROOT;
else
  process.env.HRH_LOCAL_RUNTIME_ROOT = path.join(ROOT, "desktop/local-runtime");
const result = {};
let app = null;
async function shot(p, name) {
  await p.send("Page.bringToFront");
  await sleep(150);
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, name), Buffer.from(r.data, "base64"));
}
async function click(p, selector) {
  await p.send("Page.bringToFront");
  await until("enabled target " + selector, () =>
    p.eval(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&e.checkVisibility({checkVisibilityCSS:true})})()`,
    ),
  );
  const r = await p.eval(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await p.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...r,
    button: "left",
    clickCount: 1,
  });
  await p.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...r,
    button: "left",
    clickCount: 1,
  });
}
async function fill(p, selector, text) {
  await p.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await p.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await p.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await p.send("Input.insertText", { text });
}
async function api(p, route, body, method) {
  return p.eval(
    `fetch(${JSON.stringify(route)},{${body !== undefined ? `method:${JSON.stringify(method || "POST")},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}` : ""}}).then(async r=>{if(!r.ok)throw Error('API '+r.status);return r.json()})`,
  );
}
async function open(p, tab = "mcp") {
  await p.eval(`location.href='/?view=settings&tab=${tab}'`);
  await until("settings mounted", () =>
    p.eval(`!!document.querySelector('[data-testid=settings-panel-${tab}]')`),
  );
}
async function quit() {
  if (!app) return;
  try {
    await app.main(
      'const a=require("electron").app;setTimeout(()=>a.quit(),100);return true;',
    );
    await Promise.race([app.exited, sleep(6500)]);
  } catch {}
  await app.stop();
  app = null;
}
(async () => {
  let p;
  try {
    app = new App(home, 9911, 10411);
    app.start();
    result.appVersion = await app.main(
      'return require("electron").app.getVersion();',
    );
    if (process.env.MCP_EXPECTED_VERSION)
      assert.equal(result.appVersion, process.env.MCP_EXPECTED_VERSION);
    p = await app.page(/connect\.html/);
    await until("local selection", () =>
      p.eval('!!document.getElementById("modeLocal")'),
    );
    await p.eval(
      'document.getElementById("modeLocal").click();document.getElementById("go").click()',
    );
    p = await app.page(/^http:\/\/127\.0\.0\.1:\d+\/(?!\?surface)/, 65000);
    await until("setup assistant", () =>
      p.eval('!!document.querySelector("[data-testid=setup-assistant]")'),
    );
    await p.eval(
      'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("나중에 설정할게요"))?.click()',
    );
    await open(p);
    await until("three tabs", () =>
      p.eval('document.querySelectorAll("[data-testid^=mcp-tab-]").length===3'),
    );
    assert.equal(
      await p.eval(
        'document.querySelector("[data-testid=mcp-tab-manage]").getAttribute("aria-selected")',
      ),
      "true",
    );
    result.manageIsDefault = true;
    await shot(p, "01-manage-default.png");
    // Keyboard tab selection is a real key event, not a synthetic click.
    await p.eval(
      'document.querySelector("[data-testid=mcp-tab-manage]").focus()',
    );
    await p.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowRight",
      code: "ArrowRight",
      windowsVirtualKeyCode: 39,
    });
    await until("catalog from keyboard", () =>
      p.eval('!!document.querySelector("[data-testid=mcp-discovery]")'),
    );
    await until("curated recipes", () =>
      p.eval(
        'document.querySelectorAll("[data-testid^=mcp-recipe-]").length===9',
      ),
    );
    let recipes = await api(p, "/api/mcp/recipes");
    assert(
      recipes.items.every(
        (r) => r.kind === "remote" || !r.installation.installed,
      ),
    );
    assert.equal((await api(p, "/api/mcp")).items.length, 0);
    result.browsingDoesNotDownload = true;
    result.keyboardTabs = true;
    await shot(p, "02-catalog.png");
    await click(p, "[data-testid=mcp-recipe-atlassian] button");
    await until("Atlassian method", () =>
      p.eval('!!document.querySelector("[data-testid=mcp-setup-wizard]")'),
    );
    assert(
      (
        await p.eval(
          'document.querySelector("[data-testid=mcp-setup-wizard]").innerText',
        )
      ).includes("mcp-atlassian"),
    );
    await shot(p, "03-atlassian-method.png");
    await click(p, '[data-testid=mcp-setup-wizard] button[aria-label="닫기"]');
    await click(p, "[data-testid=mcp-recipe-time] button");
    await click(p, "[data-testid=mcp-download-next]");
    await until(
      "real Time package installed",
      () => p.eval('!!document.querySelector("[data-testid=mcp-run-test]")'),
      180000,
    );
    result.realPythonPackageDownload = true;
    assert.equal((await api(p, "/api/mcp")).items.length, 0);
    await shot(p, "04-configure-test.png");
    await click(p, "[data-testid=mcp-run-test]");
    await until(
      "test passed",
      () =>
        p.eval('!!document.querySelector("[data-testid=mcp-register-tested]")'),
      45000,
    );
    assert.equal((await api(p, "/api/mcp")).items.length, 0);
    result.testDoesNotRegister = true;
    await shot(p, "05-test-passed.png");
    await click(p, "[data-testid=mcp-register-tested]");
    await until("managed entry", () =>
      p.eval('!!document.querySelector("[data-testid^=mcp-entry-]")'),
    );
    let entry = (await api(p, "/api/mcp")).items[0],
      mid = entry.id;
    assert.equal(entry.state, "connected");
    assert.equal(entry.catalog_id, "time");
    assert(entry.tool_count > 0);
    result.registersTestedConnection = true;
    await shot(p, "06-managed-time.png");
    const origin = await p.eval("location.origin");
    const secondId = await app.main(
      `const electron=require('electron'),path=require('path');const w=new electron.BrowserWindow({width:1200,height:880,webPreferences:{preload:path.join(electron.app.getAppPath(),'src/preload.js'),additionalArguments:['--hrh-surface=console','--hrh-version='+electron.app.getVersion()]}});await w.loadURL(${JSON.stringify(origin + "/?view=settings&tab=mcp&catalogSecond=1")});return w.webContents.id;`,
    );
    const second = await app.page(/catalogSecond=1/);
    await until("second managed entry", () =>
      second.eval(`!!document.querySelector('[data-testid=mcp-entry-${mid}]')`),
    );
    await click(p, `[data-testid=mcp-toggle-${mid}]`);
    await until("other window sees disconnect", () =>
      second.eval(
        `document.querySelector('[data-testid=mcp-toggle-${mid}]')?.getAttribute('aria-pressed')==='false'`,
      ),
    );
    await shot(second, "07-other-window-off.png");
    await click(p, `[data-testid=mcp-toggle-${mid}]`);
    await until("reconnected in other window", () =>
      second.eval(
        `document.querySelector('[data-testid=mcp-entry-${mid}]')?.innerText.includes('연결됨')`,
      ),
    );
    result.multiWindow = true;
    await app.main(
      `const w=require('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.id===${secondId});w.destroy();return true;`,
    );
    await click(p, "[data-testid=mcp-tab-direct]");
    await until("manual editor", () =>
      p.eval('!!document.querySelector("[data-testid=mcp-editor]")'),
    );
    await fill(p, "[data-testid=mcp-name]", "Missing executable");
    await fill(
      p,
      "[data-testid=mcp-command]",
      "geny-deliberately-missing-executable",
    );
    await click(p, "[data-testid=mcp-save]");
    await until("actionable missing command error", () =>
      p.eval(
        'document.querySelector("[data-testid=mcp-editor]")?.innerText.includes("실행 파일을 찾을 수 없어요")',
      ),
    );
    assert.equal((await api(p, "/api/mcp")).items.length, 1);
    result.invalidManualConfigNotRegistered = true;
    await shot(p, "08-missing-command.png");
    await click(p, "[data-testid=mcp-tab-manage]");
    const session = await api(p, "/api/sessions", {
      provider: "claude",
      workspace_path: home,
      title: "카탈로그 MCP 호출 검증",
    });
    assert.deepEqual(session.mcp, {});
    await p.eval(`location.href='/?view=chat&session=${session.id}'`);
    await until("session panel toolbar", () =>
      p.eval('!!document.querySelector("[data-topbar-item=panel]")'),
    );
    if (
      await p.eval(
        'document.querySelector("[data-topbar-item=panel]").getAttribute("aria-pressed")!=="true"',
      )
    )
      await click(p, "[data-topbar-item=panel]");
    await until("specific MCP toggle loaded", () =>
      p.eval(
        `!!document.querySelector('[data-testid=session-mcp-toggle-${mid}]')`,
      ),
    );
    await click(p, `[data-testid=session-mcp-toggle-${mid}]`);
    await until(
      "session selection persisted",
      async () =>
        (await api(p, "/api/sessions")).find((s) => s.id === session.id)?.mcp?.[
          mid
        ] === true,
    );
    await fill(
      p,
      "textarea",
      'tool:get_current_time {"timezone":"Asia/Seoul"}',
    );
    await p.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await p.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await until(
      "real downloaded tool returned",
      () => p.eval('document.body.innerText.includes("Tool get_current_time")'),
      45000,
    );
    result.downloadedToolThroughSessionGateway = true;
    await shot(p, "09-session-tool-call.png");
    const processes = () =>
      JSON.parse(
        execFileSync(
          "/home/hrjang/.cache/hrh-provider-mcp-venv/bin/python",
          [
            "-c",
            'import psutil,json,sys,os; print(json.dumps([p.pid for p in psutil.process_iter(["cmdline"]) if p.pid != os.getpid() and "python-runner-v1.py" in " ".join(p.info["cmdline"] or []) and sys.argv[1] in " ".join(p.info["cmdline"] or [])]))',
            home,
          ],
          { encoding: "utf8" },
        ),
      );
    assert(processes().length > 0);
    await quit();
    await until("managed processes released", () => processes().length === 0);
    result.quitReleasesManagedProcess = true;
    app = new App(home, 9912, 10412);
    app.start();
    p = await app.page(/^http:\/\/127\.0\.0\.1:\d+\/(?!\?surface)/, 65000);
    await open(p);
    await until(
      "restored connection",
      async () => {
        const items = (await api(p, "/api/mcp")).items;
        return items.some((i) => i.id === mid && i.state === "connected");
      },
      45000,
    );
    assert(
      (await api(p, "/api/mcp/recipes")).items.find((r) => r.id === "time")
        .installation.installed,
    );
    result.downloadAndConnectionSurviveRestart = true;
    result.noPaidProviderCalls = true;
    await shot(p, "10-restored.png");
    fs.writeFileSync(
      path.join(out, "results.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (e) {
    if (p) await shot(p, "failure.png").catch(() => {});
    throw e;
  } finally {
    await quit();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
