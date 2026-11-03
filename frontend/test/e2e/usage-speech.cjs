// Real Electron/Xvfb and isolated backend. STT receives synthetic PCM and protocol-faithful fake transcripts;
// no paid STT/model API is called. The draft/composer/WebSocket/steering paths are the production code.
const {
  App,
  fill,
  until,
  sleep,
} = require("../../../desktop/test/e2e/screen-capture-e2e");
const { chromium } = require("playwright-core");
const { execFileSync } = require("child_process");
const assert = require("assert/strict"),
  fs = require("fs"),
  path = require("path"),
  os = require("os");
const [server, password] = process.argv.slice(2),
  shots = process.env.SCREEN_SHOTS;
const capture = async (page, name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shots, name) });
};
const clickMic = (page) => page.getByTestId("mate-mic").click();
const emit = (page, type, text) =>
  page.evaluate(
    ({ type, text }) => {
      window.__stt.onmessage({
        data: JSON.stringify({ message_type: type, text }),
      });
    },
    { type, text },
  );
(async () => {
  const app = new App(
    fs.mkdtempSync(path.join(os.tmpdir(), "geny-usage-speech-")),
    9660,
    10160,
  );
  let browser;
  try {
    app.start();
    const connect = await app.page(/connect\.html/);
    await until("connect", () => connect.eval("!!window.hrhConnect"));
    await connect.eval(fill(server, "admin", password));
    const cdp = await app.page(
      new RegExp(
        "^" +
          server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "/(?!login)(?!\\?surface=)",
      ),
    );
    browser = await chromium.connectOverCDP("http://127.0.0.1:9660");
    const context = browser.contexts()[0];
    let page =
      context.pages().find((p) => p.url() === server + "/") ||
      context
        .pages()
        .find(
          (p) => p.url().startsWith(server) && !p.url().includes("surface="),
        );
    await page.evaluate(() => localStorage.setItem("hrh_lang", "ko"));
    const api = async (url, method = "GET", body) =>
      page.evaluate(
        async ({ url, method, body }) => {
          const r = await fetch(url, {
            method,
            headers: { "Content-Type": "application/json" },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          if (!r.ok) throw Error(await r.text());
          return r.json();
        },
        { url, method, body },
      );
    const mate = await api("/api/mates", "POST", {
      name: "음성 이어말하기 검증",
      voice: {
        auto_read: false,
        stt: { engine: "elevenlabs", auto_send: true, continuation_grace: 1.8 },
      },
      proactive: { enabled: false },
    });
    const sid = (await api(`/api/mates/${mate.id}/conversation`, "POST"))
      .session_id;
    const sessions = [];
    for (let i = 1; i <= 6; i++)
      sessions.push(
        await api("/api/sessions", "POST", {
          provider: "claude",
          workspace_path: process.env.SCREEN_TEST_ROOT + "/workspace",
          title: `주간 작업 ${i}`,
        }),
      );
    const data = { sessions: sessions.map((s) => s.id), sid, mate: mate.id };
    execFileSync(
      "/tmp/hrh-test-venv/bin/python",
      [
        "-c",
        `
import sqlite3,json,sys,os,datetime
v=json.load(sys.stdin);c=sqlite3.connect(os.environ['DB_PATH']);now=datetime.datetime.now(datetime.timezone.utc)
for i,sid in enumerate(v['sessions']+[v['sid']]):
 d={'cost_kind':'turn','cost_usd':(i+1)*.2,'provider':'claude','model':'claude-test','usage':{'input_tokens':(i+1)*10000,'output_tokens':1000,'cache_read_input_tokens':2000}}
 at=(now-datetime.timedelta(days=i%7)).isoformat()
 c.execute('INSERT INTO events(session_id,seq,type,data,created_at) VALUES (?,0,?,?,?)',(sid,'turn.complete',json.dumps(d),at))
c.commit()
`,
      ],
      { input: JSON.stringify(data), env: process.env },
    );
    await page.goto(server + "/?view=usage");
    await page.getByTestId("usage-week").waitFor();
    await capture(page, "usage-desktop.png");
    const report = await api("/api/usage/week?tz=Asia/Seoul");
    assert.equal(report.total.turns, 7);
    assert.equal(report.sources[0].items.length, 5);
    const trigger = page
      .getByRole("button", { name: "세션 채팅 사용량 상세" })
      .first();
    await trigger.hover();
    const detail = page.getByTestId("usage-detail-chat");
    await detail.waitFor();
    assert.equal(await detail.getByTestId("usage-detail-item").count(), 5);
    await capture(page, "usage-hover.png");
    await trigger.focus();
    await trigger.press("ArrowDown");
    await page.waitForTimeout(100);
    assert.equal(await detail.locator("button:focus").count(), 1);
    await page.keyboard.press("Escape");
    await detail.waitFor({ state: "hidden" });
    // Small viewport and tap uses the same portal; nothing may run off either edge.
    await page.setViewportSize({ width: 390, height: 844 });
    await trigger.click();
    await detail.waitFor();
    const rect = await detail.locator("..").boundingBox();
    assert(rect.x >= 0 && rect.x + rect.width <= 391);
    await capture(page, "usage-mobile-popover.png");
    await detail.getByTestId("usage-detail-item").first().click();
    await until("session navigation", () => page.url().includes("session="));
    await page.setViewportSize({ width: 1000, height: 800 });
    console.log("USAGE WEEK E2E OK",JSON.stringify({report:report.total}));
  } finally {
    await browser?.close();
    await app.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
