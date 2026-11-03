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
    await context.route(/\/stt\/realtime$/, (route) =>
      route.fulfill({
        json: {
          url: "wss://fake-stt.invalid/speech-to-text/realtime",
          model: "scribe_v2_realtime",
          sample_rate: 16000,
          language: "ko",
          commit_strategy: "vad",
          silence: 1.2,
          expires_in: 600,
          fallback: null,
        },
      }),
    );
    await context.addInitScript(() => {
      const Native = window.WebSocket;
      class SttSocket {
        constructor() {
          this.readyState = 1;
          window.__stt = this;
          setTimeout(
            () =>
              this.onmessage?.({
                data: JSON.stringify({
                  message_type: "session_started",
                  session_id: "test",
                }),
              }),
            25,
          );
        }
        send() {
          window.__audioFrames = (window.__audioFrames || 0) + 1;
        }
        close() {
          this.readyState = 3;
          this.onclose?.({ code: 1000, reason: "" });
        }
      }
      window.WebSocket = function (url, protocols) {
        return String(url).includes("fake-stt.invalid")
          ? new SttSocket()
          : protocols
            ? new Native(url, protocols)
            : new Native(url);
      };
      window.WebSocket.prototype = Native.prototype;
      Object.assign(window.WebSocket, {
        CONNECTING: 0,
        OPEN: 1,
        CLOSING: 2,
        CLOSED: 3,
      });
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext(),
          dest = ctx.createMediaStreamDestination(),
          osc = ctx.createOscillator(),
          gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain).connect(dest);
        osc.start();
        await ctx.resume();
        window.__micSignal = { ctx, gain };
        return dest.stream;
      };
      window.__sent = [];
      const send = Native.prototype.send;
      Native.prototype.send = function (data) {
        try {
          const d = JSON.parse(data);
          if (d.type === "chat" || d.type === "steer") window.__sent.push(d);
        } catch {}
        return send.call(this, data);
      };
    });
    await page.goto(server + `/?surface=mate-chat&mate=${mate.id}`);
    await page.getByTestId("mate-input").waitFor();
    await page.getByTestId("mate-send").waitFor();
    const waitSent = async (n) =>
      until("sent " + n, () =>
        page.evaluate((n) => window.__sent.length >= n, n),
      );
    await clickMic(page);
    await until("STT socket", () =>
      page.evaluate(() => !!window.__stt && window.__audioFrames > 0),
    );
    for (const text of ["화면 공유를", "켜 둔 상태로", "다시 열어 줘."]) {
      await emit(page, "partial_transcript", text);
      await sleep(150);
      await emit(page, "committed_transcript", text);
      await sleep(650);
    }
    assert.equal(
      await page.getByTestId("mate-input").inputValue(),
      "화면 공유를 켜 둔 상태로 다시 열어 줘.",
    );
    assert.equal(await page.evaluate(() => window.__sent.length), 0);
    await capture(page, "speech-three-fragments-draft.png");
    await waitSent(1);
    assert.equal(
      (await page.evaluate(() => window.__sent[0])).input,
      "화면 공유를 켜 둔 상태로 다시 열어 줘.",
    );
    await emit(page, "committed_transcript", "두 번째 요청은");
    await sleep(900);
    await emit(page, "partial_transcript", "계속 말하는 중");
    await sleep(2400);
    assert.equal(await page.evaluate(() => window.__sent.length), 1);
    await emit(page, "committed_transcript", "계속 말하는 중");
    await page.getByTestId("mate-input").fill("직접 수정한 초안");
    await sleep(2200);
    assert.equal(await page.evaluate(() => window.__sent.length), 1);
    await emit(page, "committed_transcript", "추가 설명");
    await sleep(2000);
    assert.equal(await page.evaluate(() => window.__sent.length), 1);
    await capture(page, "speech-edit-holds-send.png");
    await page.getByTestId("mate-send").click();
    await waitSent(2);
    assert.equal(
      (await page.evaluate(() => window.__sent[1])).input,
      "직접 수정한 초안 추가 설명",
    );
    await emit(page, "partial_transcript", "확정 전에도 바로 보내");
    await page.getByTestId("mate-input").press("Enter");
    await waitSent(3);
    assert.equal((await page.evaluate(() => window.__sent[2])).type, "steer");
    await emit(page, "committed_transcript", "확정 전에도 바로 보내");
    await sleep(2200);
    assert.equal(await page.evaluate(() => window.__sent.length), 3);
    await capture(page, "speech-after-manual-send.png");
    // A new window uses exactly the same finalizer. Quick chat stays one draft; streaming decides send vs steer downstream.
    await clickMic(page);
    await api(`/api/mates/${mate.id}`, "PATCH", {
      voice: { stt: { engine: "whisper" } },
    });
    let transcripts = ["Whisper 조각 하나", "조각 둘", "조각 셋"];
    await context.route(/\/transcribe$/, (route) =>
      route.fulfill({ json: { text: transcripts.shift() } }),
    );
    await page.reload();
    await page.getByTestId("mate-input").waitFor();
    for (let i = 0; i < 3; i++) {
      await clickMic(page);
      await sleep(400);
      await clickMic(page);
      await sleep(250);
    }
    await until("Whisper draft", async () =>
      (await page.getByTestId("mate-input").inputValue()).includes("조각 셋"),
    );
    assert.equal(
      await page.getByTestId("mate-input").inputValue(),
      "Whisper 조각 하나 조각 둘 조각 셋",
    );
    assert.equal(await page.evaluate(() => window.__sent.length), 0);
    await waitSent(1);
    await capture(page, "speech-whisper-fragments.png");
    // Native quick card: the same transcript policy, with a narrow editable composer.
    await api(`/api/mates/${mate.id}`, "PATCH", {
      voice: { stt: { engine: "elevenlabs" } },
    });
    await page.evaluate(
      (mid) =>
        window.hrhNative.mate
          .setMate(mid)
          .then(() => window.hrhNative.mate.openQuick()),
      mate.id,
    );
    const quick = await until("quick page", () =>
      context.pages().find((p) => p.url().includes("surface=mate-quick")),
    );
    await quick.getByTestId("mate-input").waitFor();
    await clickMic(quick);
    await until("quick STT", () => quick.evaluate(() => !!window.__stt));
    await emit(quick, "committed_transcript", "퀵 채팅도");
    await sleep(700);
    await emit(quick, "committed_transcript", "하나로 보내");
    assert.equal(
      await quick.getByTestId("mate-input").inputValue(),
      "퀵 채팅도 하나로 보내",
    );
    await capture(quick, "speech-quick-draft.png");
    await until("quick sent", () =>
      quick.evaluate(() => window.__sent.length === 1),
    );
    await clickMic(quick);
    // Console Mate surface also renders the shared composer.
    await page.evaluate(
      (mid) => localStorage.setItem("hrh_mate_active", mid),
      mate.id,
    );
    await page.goto(server + "/?view=mate");
    await page.getByTestId("mate-input").waitFor();
    await clickMic(page);
    await until("console STT", () => page.evaluate(() => !!window.__stt));
    await emit(page, "committed_transcript", "콘솔에서도");
    await sleep(700);
    await emit(page, "committed_transcript", "같은 초안");
    assert.equal(
      await page.getByTestId("mate-input").inputValue(),
      "콘솔에서도 같은 초안",
    );
    await capture(page, "speech-console-draft.png");
    await waitSent(1);
    // Actual Chromium (outside Electron) exercises the browser recognizer path and a mobile-sized composer.
    await clickMic(page);
    await api(`/api/mates/${mate.id}`, "PATCH", {
      voice: { stt: { engine: "browser" } },
    });
    const web = await chromium.launch({
      executablePath: process.env.CHROME,
      headless: false,
      args: ["--no-sandbox"],
    });
    try {
      const webContext = await web.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await webContext.addCookies(await context.cookies());
      await webContext.addInitScript(() => {
        window.SpeechRecognition = class {
          start() {
            window.__recognition = this;
          }
          stop() {
            this.onend?.();
          }
          abort() {
            this.onend?.();
          }
        };
        window.__sent = [];
        const original = WebSocket.prototype.send;
        WebSocket.prototype.send = function (raw) {
          try {
            const d = JSON.parse(raw);
            if (d.type === "chat" || d.type === "steer") window.__sent.push(d);
          } catch {}
          return original.call(this, raw);
        };
      });
      const phone = await webContext.newPage();
      await phone.goto(server + `/?surface=mate-chat&mate=${mate.id}`);
      await phone.getByTestId("mate-input").waitFor();
      await clickMic(phone);
      await until("browser recognizer", () =>
        phone.evaluate(() => !!window.__recognition),
      );
      for (const text of [
        "브라우저 음성도",
        "조각마다 보내지 말고",
        "하나로 보내",
      ]) {
        await phone.evaluate((text) => {
          const result = [{ transcript: text }];
          result.isFinal = true;
          window.__results = window.__results || [];
          window.__results.push(result);
          window.__recognition.onresult({
            resultIndex: window.__results.length - 1,
            results: window.__results,
          });
        }, text);
        await sleep(300);
      }
      assert.equal(
        await phone.getByTestId("mate-input").inputValue(),
        "브라우저 음성도 조각마다 보내지 말고 하나로 보내",
      );
      assert.equal(await phone.evaluate(() => window.__sent.length), 0);
      await capture(phone, "speech-mobile-browser-draft.png");
      await until("browser sent once", () =>
        phone.evaluate(() => window.__sent.length === 1),
      );
      await phone.evaluate(() => window.__recognition.onend());
      await sleep(2000);
      assert.equal(await phone.evaluate(() => window.__sent.length), 1);
    } finally {
      await web.close();
    }
    console.log(
      "USAGE + SPEECH E2E OK",
      JSON.stringify({
        report: report.total,
        sourceTokens: report.sources.map((s) => [s.source, s.tokens]),
        syntheticPcm: true,
      }),
    );
  } finally {
    await browser?.close();
    await app.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
