"use strict";
// Real native Local runtime + real MCP stdio server. Google model listings are
// served by an HTTP fixture; the coding CLI is a fixture. No paid provider calls.
const { App, until, sleep } = require("./screen-capture-e2e");
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  assert = require("assert/strict"),
  http = require("http");
const { execFileSync, spawn } = require("child_process");
const ROOT = path.resolve(__dirname, "../../.."),
  out =
    process.env.MCP_TEST_OUTPUT ||
    fs.mkdtempSync(path.join(os.tmpdir(), "geny-mcp-ui-"));
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
process.env.CODEX_HOME = path.join(home, ".codex");
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
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
const result = {},
  mockRequests = [];
let app = null;
const google = http.createServer((req, res) => {
  mockRequests.push({ method: req.method, path: req.url });
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "GET") {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Paid calls forbidden in this test" }));
    return;
  }
  res.end(
    JSON.stringify({
      models: [
        {
          name: "models/gemini-fixture-tts",
          displayName: "Fixture speech",
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/gemini-fixture-flash",
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/gemini-fixture-image",
          supportedGenerationMethods: ["generateContent"],
        },
      ],
    }),
  );
});
async function shot(p, name) {
  await sleep(300);
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, name), Buffer.from(r.data, "base64"));
}
async function fill(p, selector, text, index = 0) {
  await p.eval(
    `document.querySelectorAll(${JSON.stringify(selector)})[${index}].focus()`,
  );
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
    `(async()=>{const r=await fetch(${JSON.stringify(route)},${JSON.stringify(body === undefined ? {} : { method: method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })});if(!r.ok)throw Error(${JSON.stringify(route)}+" HTTP "+r.status+": "+await r.text());return r.json()})()`,
  );
}
async function open(p, tab) {
  await p.eval(`location.href='/?view=settings&tab=${tab}'`);
  await until("settings " + tab, () =>
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
async function click(p, selector) {
  await p.send("Page.bringToFront");
  await until("enabled click target", () =>
    p.eval(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e && !e.disabled && e.checkVisibility({checkVisibilityCSS:true})})()`,
    ),
  );
  const rect = await p.eval(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`,
  );
  assert(rect.w > 0 && rect.h > 0, "click target visible");
  await p.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await p.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
}
async function panel(p) {
  await until("panel toolbar", () =>
    p.eval('!!document.querySelector("[data-topbar-item=panel]")'),
  );
  if (
    await p.eval(
      'document.querySelector("[data-topbar-item=panel]").getAttribute("aria-pressed")!=="true"',
    )
  )
    await click(p, "[data-topbar-item=panel]");
  await until("visible session MCP controls", () =>
    p.eval(
      'document.querySelector("[data-testid=session-mcp]")?.checkVisibility({checkVisibilityCSS:true})',
    ),
  );
}

async function serverFlow() {
  const { chromium } = require("playwright-core");
  const serverHome = fs.mkdtempSync(path.join(out, "server-home-"));
  fs.mkdirSync(path.join(serverHome, ".claude"), { recursive: true });
  fs.copyFileSync(
    path.join(home, ".claude/.credentials.json"),
    path.join(serverHome, ".claude/.credentials.json"),
  );
  fs.writeFileSync(path.join(serverHome, "fake-claude-turns.jsonl"), "");
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const base = "http://127.0.0.1:" + port,
    python =
      process.env.MCP_FIXTURE_PYTHON ||
      "/home/hrjang/.cache/hrh-provider-mcp-venv/bin/python";
  const env = {
    ...process.env,
    HOME: serverHome,
    XDG_CONFIG_HOME: path.join(serverHome, ".config"),
    CLAUDE_CONFIG_DIR: path.join(serverHome, ".claude"),
    CODEX_HOME: path.join(serverHome, ".codex"),
    EXECUTION_MODE: "server",
    PORT: String(port),
    DB_PATH: path.join(serverHome, "db.sqlite"),
    UPLOADS_ROOT: path.join(serverHome, "uploads"),
    MATES_ROOT: path.join(serverHome, "mates"),
    HIGGSFIELD_ROOT: path.join(serverHome, "higgsfield"),
    AVATAR_ROOT: path.join(serverHome, "avatars"),
    STATIC_DIR: path.join(ROOT, "frontend/dist-mcp"),
    AUTH_USERNAME: "fixture",
    AUTH_PASSWORD: "fixture-mcp-password",
    COOKIE_SECURE: "false",
    SESSION_SECRET: "fixture-session-key",
    VAULT_KEY: require("crypto")
      .randomBytes(32)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_"),
  };
  const backend = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: path.join(ROOT, "backend"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let output = "";
  backend.stdout.on("data", (b) => (output += b));
  backend.stderr.on("data", (b) => (output += b));
  let browser;
  try {
    await until(
      "server backend ready",
      async () => {
        try {
          return (await fetch(base + "/health")).ok;
        } catch {
          return false;
        }
      },
      45000,
    );
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME ||
        "/home/hrjang/.cache/ms-playwright/chromium-1148/chrome-linux/chrome",
      headless: false,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({
      viewport: { width: 1360, height: 980 },
      locale: "ko-KR",
    });
    await context.addInitScript(() => localStorage.setItem("hrh_lang", "ko"));
    assert.equal(
      (
        await context.request.post(base + "/api/auth/login", {
          data: { username: "fixture", password: "fixture-mcp-password" },
        })
      ).status(),
      200,
    );
    const page = await context.newPage();
    await page.goto(base + "/");
    await page.waitForSelector("[data-testid=setup-assistant]");
    await page.getByRole("button", { name: "나중에 설정할게요" }).click();
    await page.goto(base + "/?view=settings&tab=mcp");
    await page.waitForSelector("[data-testid=mcp-settings]");
    assert(
      (await page.locator("body").innerText()).includes(
        "접속한 서버에서 MCP를 실행해요",
      ),
    );
    const saved = await context.request.post(base + "/api/mcp", {
      data: {
        name: "서버 MCP",
        command: python,
        args: [path.join(ROOT, "backend/tests/fixtures/mcp_server.py")],
        env: {
          FIXTURE_KEY: "server-fixture-secret",
          FIXTURE_PID: path.join(serverHome, "child.pid"),
        },
      },
    });
    assert.equal(saved.status(), 200);
    const item = await saved.json();
    assert.equal(item.state, "connected");
    await page.waitForSelector("[data-testid=mcp-entry-" + item.id + "]");
    const second = await context.newPage();
    await second.goto(base + "/?view=settings&tab=mcp");
    await second.waitForSelector("[data-testid=mcp-entry-" + item.id + "]");
    assert.equal(
      (
        await context.request.patch(base + "/api/mcp/" + item.id, {
          data: { name: "이름 바꾼 서버 MCP" },
        })
      ).status(),
      200,
    );
    await until("server window one update", async () =>
      (
        await page
          .locator("[data-testid=mcp-entry-" + item.id + "]")
          .innerText()
      ).includes("이름 바꾼 서버 MCP"),
    );
    await until("server window two update", async () =>
      (
        await second
          .locator("[data-testid=mcp-entry-" + item.id + "]")
          .innerText()
      ).includes("이름 바꾼 서버 MCP"),
    );
    result.serverMultiWindow = true;
    const pid = fs
      .readFileSync(path.join(serverHome, "child.pid"), "utf8")
      .trim();
    assert.equal(
      Number(
        execFileSync(
          python,
          [
            "-c",
            "import psutil,sys;print(psutil.Process(int(sys.argv[1])).ppid())",
            pid,
          ],
          { encoding: "utf8" },
        ).trim(),
      ),
      backend.pid,
    );
    result.serverOwnsMcpProcess = true;
    await page.bringToFront();
    await page.screenshot({
      path: path.join(out, "08-server-mcp-catalog.png"),
      animations: "disabled",
    });
    const created = await context.request.post(base + "/api/sessions", {
      data: {
        provider: "claude",
        workspace_path: serverHome,
        title: "서버 MCP 검증",
      },
    });
    const session = await created.json();
    await page.goto(base + "/?view=chat&session=" + session.id);
    const panelButton = page.locator("[data-topbar-item=panel]");
    await panelButton.waitFor({ state: "visible" });
    if ((await panelButton.getAttribute("aria-pressed")) !== "true")
      await panelButton.click();
    await page.getByTestId("session-mcp").waitFor({ state: "visible" });
    await page.getByTestId("session-mcp-toggle-" + item.id).click();
    await until("server MCP selected", async () => {
      const c = await (
        await context.request.get(base + "/api/sessions")
      ).json();
      return c.find((s) => s.id === session.id)?.mcp?.[item.id];
    });
    await page
      .locator("textarea")
      .first()
      .fill('tool:echo {"text":"server UI call"}');
    await page.locator("textarea").first().press("Enter");
    await until(
      "server proxy tool result",
      async () =>
        (await page.locator("body").innerText()).includes(
          "echo: server UI call",
        ),
      45000,
    );
    result.serverSessionBridgeCall = true;
    await page.bringToFront();
    await page.screenshot({
      path: path.join(out, "09-server-session-mcp.png"),
      animations: "disabled",
    });
    const logs = await (
      await context.request.get(base + "/api/admin/logs?source=mcp")
    ).json();
    assert(!JSON.stringify(logs).includes("server-fixture-secret"));
    assert(!JSON.stringify(logs).includes("server UI call"));
  } catch (e) {
    fs.writeFileSync(path.join(out, "server.log"), output);
    if (browser) {
      try {
        const p = browser
          .contexts()[0]
          .pages()
          .find((p) => p.url().includes("view=chat"));
        if (p) {
          fs.writeFileSync(
            path.join(out, "server-ui-failure.json"),
            JSON.stringify(
              {
                url: p.url(),
                body: (await p.locator("body").innerText()).slice(0, 20000),
              },
              null,
              2,
            ),
          );
          await p.bringToFront();
          await p.screenshot({
            path: path.join(out, "server-failure.png"),
            timeout: 5000,
            animations: "disabled",
          });
        }
      } catch {}
    }
    throw e;
  } finally {
    if (browser) await browser.close();
    backend.kill("SIGTERM");
    await Promise.race([
      new Promise((r) =>
        backend.exitCode !== null ? r() : backend.once("exit", r),
      ),
      sleep(8000),
    ]);
    if (backend.exitCode === null) {
      try {
        process.kill(-backend.pid, "SIGKILL");
      } catch {}
    }
  }
}

(async () => {
  try {
    await new Promise((r) => google.listen(0, "127.0.0.1", r));
    process.env.MATE_GOOGLE_BASE = `http://127.0.0.1:${google.address().port}`;
    if (process.env.MCP_SERVER_ONLY) {
      await serverFlow();
      fs.writeFileSync(
        path.join(out, "server-results.json"),
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify(result));
      return;
    }
    app = new App(home, 9901, 10401);
    app.start();
    let p = await app.page(/connect\.html/);
    await until("local mode", () =>
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
    await open(p, "providers");
    await until("language providers", () =>
      p.eval(
        'document.body.innerText.includes("Claude Code") && !!document.querySelector("[data-testid=cli-versions]")',
      ),
    );
    assert(
      (
        await p.eval(
          'document.querySelector("[data-testid=settings-tab-providers]").innerText',
        )
      ).includes("언어모델 공급자"),
    );
    assert(
      (
        await p.eval(
          'document.querySelector("[data-testid=settings-tab-media]").innerText',
        )
      ).includes("이미지 및 음성 공급자"),
    );
    assert.equal(
      await p.eval(
        'Array.from(document.querySelector("[data-testid=settings-panel-providers]").querySelectorAll("button")).some(b=>b.textContent.trim()==="Higgsfield")',
      ),
      false,
    );
    result.threeSettingsCategories = true;
    await shot(p, "01-language-providers.png");
    await open(p, "media");
    await p.eval(
      'document.querySelector("[data-testid=media-tab-google]").click()',
    );
    await until("Google API key", () =>
      p.eval(
        '!!document.querySelector("[data-testid=mate-provider-google-key]")',
      ),
    );
    await fill(
      p,
      '[data-testid="mate-provider-google-key"]',
      "fixture-google-key-only",
    );
    await p.eval(
      'document.querySelector("[data-testid=mate-provider-google-save]").click()',
    );
    await until("Google connected", () =>
      p.eval(
        'document.querySelector("[data-testid=mate-provider-google-status]")?.innerText.includes("연결됨")',
      ),
    );
    const settings = await api(p, "/api/mates/settings");
    assert(settings.google_key_set);
    assert(!JSON.stringify(settings).includes("fixture-google-key-only"));
    await p.eval(
      'Array.from(document.querySelectorAll("details")).find(d=>d.textContent.includes("gemini-fixture-image")).open=true',
    );
    result.googleMediaSettings = true;
    await shot(p, "02-google-media.png");
    await open(p, "mcp");
    await until("empty MCP catalog", () =>
      p.eval('!!document.querySelector("[data-testid=mcp-add]")'),
    );
    await shot(p, "03-mcp-empty.png");
    const origin = await p.eval("location.origin");
    const secondId = await app.main(
      `const native=require('electron'),path=require('path');const w=new native.BrowserWindow({show:true,width:1050,height:850,webPreferences:{preload:path.join(native.app.getAppPath(),'src/preload.js'),additionalArguments:['--hrh-surface=console','--hrh-version='+native.app.getVersion()]}});await w.loadURL(${JSON.stringify(origin + "/?view=settings&tab=mcp&testMcpSecond=1")});return w.webContents.id;`,
    );
    const second = await app.page(/testMcpSecond=1/);
    await until("second MCP catalog", () =>
      second.eval('!!document.querySelector("[data-testid=mcp-settings]")'),
    );
    // A key changed in one window must update the saved-key indicator in the other.
    await api(p, "/api/mates/settings", { google_key: null }, "PUT");
    await second.eval(
      'location.href="/?view=settings&tab=media&testMcpSecond=1"',
    );
    await until("second media view", () =>
      second.eval('!!document.querySelector("[data-testid=media-tab-google]")'),
    );
    await second.eval(
      'document.querySelector("[data-testid=media-tab-google]").click()',
    );
    await until("second key input", () =>
      second.eval(
        '!!document.querySelector("[data-testid=mate-provider-google-key]")',
      ),
    );
    await api(
      p,
      "/api/mates/settings?verify=true",
      { google_key: "fixture-google-key-only" },
      "PUT",
    );
    await until("other window key indicator", () =>
      second.eval(
        'document.querySelector("[data-testid=mate-provider-google-key]")?.placeholder.includes("저장")',
      ),
    );
    assert.equal(
      await second.eval(
        'document.querySelector("[data-testid=mate-provider-google-key]").value',
      ),
      "",
    );
    result.mediaKeyMultiWindow = true;
    await second.eval(
      'location.href="/?view=settings&tab=mcp&testMcpSecond=1"',
    );
    await until("second MCP catalog again", () =>
      second.eval('!!document.querySelector("[data-testid=mcp-settings]")'),
    );
    await p.eval('document.querySelector("[data-testid=mcp-add]").click()');
    await fill(p, '[data-testid="mcp-name"]', "검증 MCP");
    const python =
      process.env.MCP_FIXTURE_PYTHON ||
      "/home/hrjang/.cache/hrh-provider-mcp-venv/bin/python";
    await fill(p, '[data-testid="mcp-command"]', python);
    await fill(
      p,
      '[data-testid="mcp-args"]',
      JSON.stringify([path.join(ROOT, "backend/tests/fixtures/mcp_server.py")]),
    );
    await p.eval(
      'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("행 추가")).click()',
    );
    await fill(p, '[aria-label="변수 또는 헤더 이름"]', "FIXTURE_KEY");
    await fill(p, '[aria-label="값"]', "mcp-fixture-secret-only");
    await p.eval(
      'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("행 추가")).click()',
    );
    await fill(p, '[aria-label="변수 또는 헤더 이름"]', "FIXTURE_PID", 1);
    await fill(p, '[aria-label="값"]', path.join(home, "mcp-child.pid"), 1);
    await shot(p, "04-mcp-editor.png");
    await p.eval('document.querySelector("[data-testid=mcp-save]").click()');
    let catalog = await until(
      "connected MCP",
      async () => {
        const c = await api(p, "/api/mcp");
        return (
          c.items.find(
            (i) => i.name === "검증 MCP" && i.state === "connected",
          ) && c
        );
      },
      45000,
    );
    const mid = catalog.items[0].id;
    assert(catalog.items[0].tools.some((t) => t.name === "echo"));
    assert.equal(catalog.execution_mode, "local");
    assert(!JSON.stringify(catalog).includes("mcp-fixture-secret-only"));
    await until("second window catalog update", () =>
      second.eval(`!!document.querySelector('[data-testid=mcp-entry-${mid}]')`),
    );
    result.mcpMultiWindowCatalog = true;
    await p.eval(
      'document.querySelector("[data-testid=mcp-settings]").scrollIntoView({block:"start",behavior:"instant"})',
    );
    await shot(p, "05-mcp-connected.png");
    await app.main(
      `const w=require('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.id===${secondId});w.destroy();return true;`,
    );
    const session = await api(p, "/api/sessions", {
      provider: "claude",
      workspace_path: home,
      title: "MCP 연결 검증",
    });
    assert.deepEqual(session.mcp, {});
    await p.eval(`location.href='/?view=chat&session=${session.id}'`);
    await panel(p);
    assert.equal(
      await p.eval(
        `document.querySelector('[data-testid=session-mcp-toggle-${mid}]').getAttribute('aria-pressed')`,
      ),
      "false",
    );
    await click(p, `[data-testid=session-mcp-toggle-${mid}]`);
    await until(
      "MCP session enabled",
      async () =>
        (await api(p, "/api/sessions")).find((s) => s.id === session.id)?.mcp?.[
          mid
        ] === true,
    );
    await fill(p, "textarea", 'tool:echo {"text":"local UI call"}');
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
      "real session bridge tool result",
      () => p.eval('document.body.innerText.includes("echo: local UI call")'),
      45000,
    );
    result.realSessionBridgeCall = true;
    await shot(p, "06-session-mcp-on.png");
    const turns = fs
      .readFileSync(path.join(home, "fake-claude-turns.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    const argv = turns.find((t) => t.argv.includes("--mcp-config")).argv,
      configPath = argv[argv.indexOf("--mcp-config") + 1];
    const config = JSON.parse(fs.readFileSync(configPath)),
      bridge = config.mcpServers["geny_" + mid],
      token = fs.readFileSync(bridge.env.GENY_MCP_TOKEN_FILE, "utf8");
    assert(!JSON.stringify(config).includes("mcp-fixture-secret-only"));
    assert.equal(bridge.timeout, 130000);
    const gateway = JSON.parse(
      execFileSync(
        python,
        [
          path.join(ROOT, "backend/tests/fixtures/mcp_gateway_check.py"),
          configPath,
          path.join(home, "mcp-child.pid.cancelled"),
        ],
        { encoding: "utf8", timeout: 15000 },
      ),
    );
    assert(gateway.parallelGatewayCalls && gateway.individualCancellation);
    Object.assign(result, gateway);
    await until(
      "individual cancellation recorded",
      async () =>
        (await api(p, "/api/mcp")).items.find((i) => i.id === mid)?.metrics
          ?.cancelled > 0,
    );

    await click(p, `[data-testid=session-mcp-toggle-${mid}]`);
    await until(
      "session MCP off",
      async () =>
        (await api(p, "/api/sessions")).find((s) => s.id === session.id)?.mcp?.[
          mid
        ] === false,
    );
    const blocked = await fetch(origin + "/api/internal/mcp/call", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MCP-Token": token },
      body: JSON.stringify({
        method: "tools/call",
        params: { name: "echo", arguments: { text: "must not run" } },
      }),
    });
    assert.equal(blocked.status, 401);
    result.immediateSessionRevocation = true;
    await click(p, `[data-testid=session-mcp-toggle-${mid}]`);
    await until(
      "selection saved",
      async () =>
        (await api(p, "/api/sessions")).find((s) => s.id === session.id)?.mcp?.[
          mid
        ] === true,
    );
    const logs = await api(p, "/api/admin/logs?source=mcp");
    assert(logs.items.some((l) => l.code === "mcp.call_completed"));
    assert(!JSON.stringify(logs).includes("mcp-fixture-secret-only"));
    assert(!JSON.stringify(logs).includes("local UI call"));
    result.redactedPersistentLogs = true;
    await open(p, "admin");
    await until("admin tabs", () =>
      p.eval(
        'Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="시스템")',
      ),
    );
    await p.eval(
      'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="시스템").click()',
    );
    await until("MCP system log", () =>
      p.eval('!!document.querySelector("[data-testid=mcp-system]")'),
    );
    await p.eval(
      'document.querySelector("[data-testid=mcp-system]").scrollIntoView({block:"start",behavior:"instant"})',
    );
    await shot(p, "07-system-mcp.png");
    result.systemLoggingUi = true;
    const childPid = Number(
      fs.readFileSync(path.join(home, "mcp-child.pid"), "utf8"),
    );
    await quit();
    await until("MCP process released on native quit", () => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    result.nativeQuitReleasesMcp = true;
    app = new App(home, 9902, 10402);
    app.start();
    p = await app.page(/^http:\/\/127\.0\.0\.1:\d+\/(?!\?surface)/, 65000);
    await until(
      "catalog restored",
      async () =>
        (await api(p, "/api/mcp")).items.find((i) => i.id === mid)?.state ===
        "connected",
      45000,
    );
    assert(
      (await api(p, "/api/sessions")).find((s) => s.id === session.id)?.mcp?.[
        mid
      ],
    );
    assert((await api(p, "/api/mates/settings")).google_key_set);
    result.restartRestoresMcpAndSelections = true;
    await quit();
    await serverFlow();
    result.noPaidMediaCalls = mockRequests.every((r) => r.method === "GET");
    assert(result.noPaidMediaCalls);
    fs.writeFileSync(
      path.join(out, "results.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (e) {
    if (app) {
      fs.writeFileSync(path.join(out, "electron.log"), app.out);
      try {
        const p = await app.page(/^http:\/\/127\.0\.0\.1:/);
        await shot(p, "failure.png");
      } catch {}
    }
    throw e;
  } finally {
    await quit();
    await new Promise((r) => google.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
