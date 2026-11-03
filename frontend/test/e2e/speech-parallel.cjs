// Real Electron + production API/WebSocket code in an isolated backend. The recognition protocol and LLM are fake.
const { App, fill, until, sleep } = require("../../../desktop/test/e2e/screen-capture-e2e");
const { chromium } = require("playwright-core");
const fs = require("fs"),
  os = require("os"),
  path = require("path"),
  assert = require("assert/strict");
const [server, password] = process.argv.slice(2),
  shots = process.env.SCREEN_SHOTS;
(async () => {
  const app = new App(fs.mkdtempSync(path.join(os.tmpdir(), "geny-speech-parallel-")), 9670, 10170);
  let browser;
  try {
    app.start();
    const connect = await app.page(/connect\.html/);
    await until("connect", () => connect.eval("!!window.hrhConnect"));
    await connect.eval(fill(server, "admin", password));
    await app.page(new RegExp("^" + server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/(?!login)(?!\\?surface=)"));
    browser = await chromium.connectOverCDP("http://127.0.0.1:9670");
    const context = browser.contexts()[0];
    await context.addInitScript(() => {
      localStorage.setItem("hrh_lang", "ko");
      window.__wire = [];
      window.__events = [];
      const Native = window.WebSocket,
        send = Native.prototype.send;
      Native.prototype.send = function (raw) {
        try {
          const m = JSON.parse(raw);
          if (m.type === "speech") window.__wire.push({ ...m, at: Date.now() });
        } catch {}
        return send.call(this, raw);
      };
      class Stt {
        constructor() {
          this.readyState = 1;
          window.__stt = this;
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({ message_type: "session_started", session_id: "fake" }) }), 20);
        }
        send() {}
        close() {
          this.readyState = 3;
          this.onclose?.({ code: 1000, reason: "" });
        }
      }
      window.WebSocket = function (url, protocols) {
        if (String(url).includes("fake-parallel-stt.invalid")) return new Stt();
        const ws = protocols ? new Native(url, protocols) : new Native(url);
        if (String(url).includes("/ws/chat/")) {
          window.__chat = ws;
          ws.addEventListener("message", (e) => {
            try {
              const m = JSON.parse(e.data);
              if (["speech.pending", "speech.closed", "run.state", "user.message", "user.steer"].includes(m.type))
                window.__events.push({ ...m, at: Date.now() });
            } catch {}
          });
        }
        return ws;
      };
      window.WebSocket.prototype = Native.prototype;
      Object.assign(window.WebSocket, { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 });
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext(),
          dest = ctx.createMediaStreamDestination(),
          osc = ctx.createOscillator(),
          gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain).connect(dest);
        osc.start();
        await ctx.resume();
        return dest.stream;
      };
    });
    await context.route(/\/stt\/realtime$/, (r) => r.fulfill({ json: { url: "wss://fake-parallel-stt.invalid/speech-to-text/realtime", fallback: null } }));
    const page = context.pages().find((p) => p.url().startsWith(server) && !p.url().includes("surface="));
    const api = async (url, method = "GET", body) => {
      const r = await context.request.fetch(server + url, { method, ...(body ? { data: body } : {}) });
      assert(r.ok(), await r.text());
      return r.json();
    };
    const results = [];
    let lastMate;
    for (const [name, offsets] of [
      ["pause3", [0, 3000]],
      ["afterSend", [0, 1900]],
      ["newAfter4", [0, 4300]],
      ["threePieces", [0, 3000, 6000]],
      ["runningReply", [0, 1900]],
    ]) {
      const mate = await api("/api/mates", "POST", {
        name: "Parallel " + name,
        voice: { auto_read: false, stt: { engine: "elevenlabs", auto_send: true, silence: 1.8, continuation_grace: 4, merge_fragments: true } },
        proactive: { enabled: false },
      });
      lastMate=mate.id;
      const sid = (await api("/api/mates/" + mate.id + "/conversation", "POST")).session_id;
      await page.goto(server + "/?surface=mate-chat&mate=" + mate.id);
      await page.getByTestId("mate-input").waitFor();
      await page.waitForFunction(() => window.__events.some((e) => e.type === "run.state" && e.data.speech_protocol === 2));
      await page.getByTestId("mate-mic").click();
      await page.waitForFunction(() => !!window.__stt);
      if (name === "runningReply") {
        await page.getByTestId("mate-input").fill("md1");
        await page.getByTestId("mate-send").click();
        await sleep(200);
        await page.evaluate(() => {
          window.__events = [];
          window.__wire = [];
        });
      }
      const t0 = Date.now(),
        actual = [];
      for (let i = 0; i < offsets.length; i++) {
        const wait = t0 + offsets[i] - Date.now();
        if (wait > 0) await sleep(wait);
        actual.push(Date.now() - t0);
        const text = ["첫 조각", "다음 조각", "마지막 조각"][i];
        await page.evaluate((text) => {
          window.__stt.onmessage({ data: JSON.stringify({ message_type: "partial_transcript", text }) });
          setTimeout(() => window.__stt?.onmessage({ data: JSON.stringify({ message_type: "committed_transcript", text }) }), 1800);
        }, text);
        if (i === 0 && name !== "afterSend") {
          await page.getByTestId("speech-received-label").waitFor();
          await page.screenshot({ path: path.join(shots, name + "-received.png") });
        }
      }
      const untilRelease = t0 + actual.at(-1) + 4400 - Date.now();
      if (untilRelease > 0) await sleep(untilRelease);
      const data = await page.evaluate(() => ({ wire: window.__wire, events: window.__events }));
      const sends = data.wire.filter((x) => x.op === "submit"),
        groups = [...new Set(sends.map((x) => x.group_id))];
      const received = data.events.filter((e) => e.type === "speech.pending").map((e) => ({ ms: e.at - t0, group: e.data.group_id, text: e.data.text }));
      const starts = data.events.filter((e) => e.type === "run.state" && e.data.running).map((e) => e.at - t0);
      assert(Math.abs(received[0].ms - 1800) < 450, JSON.stringify(received));
      const expected = name === "newAfter4" ? 2 : 1;
      assert.equal(groups.length, expected);
      assert.equal(await page.getByTestId("mate-user-message").count(), expected + (name === "runningReply" ? 1 : 0));
      if (name !== "runningReply")
        assert(
          starts.some((t) => Math.abs(t - (actual.at(-1) + 4000)) < 450),
          JSON.stringify({ actual, starts, received, sends }),
        );
      else
        assert(
          data.events.some((e) => e.type === "speech.closed" && e.data.state === "delivered"),
          "the active reply must accept the combined steer",
        );
      const history = await api("/api/history/" + sid + "?turns=5");
      const messages = history.messages.filter((m) => m.meta?.speech_group);
      assert.equal(messages.length, expected);
      if (expected === 1) assert.equal(messages[0].content, offsets.map((_, i) => ["첫 조각", "다음 조각", "마지막 조각"][i]).join(" "));
      await page.screenshot({ path: path.join(shots, name + "-result.png") });
      await page.reload();
      await page.getByTestId("mate-input").waitFor();
      await sleep(300);
      assert.equal(
        await page.getByTestId("mate-user-message").count(),
        expected + (name === "runningReply" ? 1 : 0),
        "history must not duplicate a pending steer promoted to a new turn",
      );
      results.push({ name, actualSpeechMs: actual, received, starts, messageCount: messages.length });
      console.log("PARALLEL MEASURE", JSON.stringify(results.at(-1)));
    }
    await page.evaluate(id=>localStorage.setItem('hrh_mate_active',id),lastMate);
    await page.goto(server+'/?view=mate');await page.getByTestId('mate-settings-open').click();await page.getByTestId('mate-tab-voice').click();
    const pause=page.getByTestId('mate-stt-silence'),window=page.getByTestId('mate-stt-grace');
    assert.equal(await pause.inputValue(),'1.8');assert.equal(await window.inputValue(),'4');
    assert((await page.getByTestId('mate-stt-deadline-preview').textContent()).includes('4.0'));
    await pause.focus();await pause.press('End');await window.focus();await window.press('Home');await window.press('ArrowLeft');
    assert.equal(await pause.inputValue(),'3');assert.equal(await window.inputValue(),'3');
    await window.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(shots,'speech-timer-settings.png')});
    const invalid=await context.request.patch(server+'/api/mates/'+lastMate,{data:{voice:{stt:{continuation_grace:1}}}});assert.equal(invalid.status(),400);
    console.log("PARALLEL SPEECH E2E OK", JSON.stringify(results));
  } finally {
    await browser?.close();
    await app.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
