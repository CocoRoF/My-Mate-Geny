// Isolated fake-model server + actual Electron/X11; native app settings, toolbar, cancellation and steering layout.
const fs = require("fs"),
  os = require("os"),
  path = require("path"),
  assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { App, fill, until, sleep } = require("./screen-capture-e2e");
const [server, password, workspace, shots] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const { chromium } = require("playwright-core");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "geny-device-test-"));
const app = new App(home, 9666, 10166);
let browser;
const req = (url, body, method = "POST") =>
  `fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>{if(!r.ok)throw new Error(r.status+':'+await r.text());return r.json()})`;
const click = (page, sel) =>
  page.eval(`document.querySelector(${JSON.stringify(sel)}).click(),true`);
const shot = async (page, name) => {
  const r = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, "base64"));
};
const countAttachments = () =>
  Number(
    execFileSync(
      "/tmp/hrh-test-venv/bin/python",
      [
        "-c",
        `import sqlite3; c=sqlite3.connect(${JSON.stringify(process.env.SCREEN_TEST_ROOT + "/db.sqlite")}); print(c.execute('SELECT COUNT(*) FROM attachments').fetchone()[0])`,
      ],
      { encoding: "utf8" },
    ).trim(),
  );
const setRange = (p, selector, value) =>
  p.eval(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
  );
(async () => {
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    const context = await browser.newContext();
    const login = await context.request.post(server + "/api/auth/login", {
      data: { username: "admin", password },
    });
    assert.ok(login.ok());
    const mates = await (
      await context.request.get(server + "/api/mates")
    ).json();
    const a = mates[0],
      b = mates[1] || mates[0];
    await context.request.patch(server + "/api/mates/" + a.id, {
      data: { voice: { volume: 0.4 } },
    });
    await context.request.patch(server + "/api/mates/" + b.id, {
      data: {
        voice: { volume: 2.35, auto_read: false, tts: { engine: "off" } },
        screen: {
          enabled: true,
          approval: "ask",
          max_edge: 1280,
          format: "jpeg",
          quality: 70,
          hide_avatar: false,
        },
      },
    });
    const settingsDir = path.join(home, ".config", "hr-harnessor");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "settings.json"),
      JSON.stringify({
        mateId: b.id,
        captureSources: {
          [a.id]: { id: "screen:old-a:0", name: "Old A", kind: "screen" },
          [b.id]: { id: "screen:old-b:0", name: "Old B", kind: "screen" },
        },
      }),
    );
    const debugPage = await context.newPage();
    debugPage.on("pageerror", (e) => console.log("BROWSER ERROR:", e.message));
    await debugPage.goto(server);
    await debugPage.waitForTimeout(600);
    await debugPage.close();
    app.start();
    const connect = await app.page(/connect\.html/);
    await until("connect", () => connect.eval("!!window.hrhConnect"));
    await connect.eval(fill(server, "admin", password));
    const con = await app.page(
      new RegExp(
        "^" + server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/(?!login)",
      ),
    );
    await until(
      "device migration",
      async () =>
        await con.eval(
          "window.hrhNative.device.get().then(p=>p.migration.imported)",
        ),
    ).catch(async (e) => {
      console.log("APP DOCUMENT:", await con.eval("document.body.innerText"));
      await shot(con, "load-failed.png");
      throw e;
    });
    const initial = await con.eval("window.hrhNative.device.get()");
    assert.equal(initial.volume, 2.35);
    assert.equal(initial.screen.format, "jpeg");
    assert.equal(initial.screen.hide_avatar, false);
    assert.equal(initial.migration.sources[a.id].name, "Old A");
    console.log(
      "PASS active-mate migration, all alternatives archived, device settings persisted",
    );
    await con.eval(
      `window.hrhNative.mate.setMate(${JSON.stringify(b.id)}).then(()=>window.hrhNative.mate.showAvatar(${JSON.stringify(b.id)})).then(()=>window.hrhNative.mate.openChat()).then(()=>true)`,
    );
    const chat = await app.page(/surface=mate-chat/);
    await until("chat composer", () =>
      chat.eval("!!document.querySelector('[data-testid=mate-input]')"),
    );
    await app.main(
      `win('surface=mate-overlay').setBounds({x:180,y:60,width:220,height:320});win('surface=mate-chat').setBounds({x:580,y:80,width:540,height:800});cwin().setBounds({x:1140,y:60,width:750,height:950});return true`,
    );
    execFileSync("xdotool", ["mousemove", "280", "220"]);
    const bar = await app.page(/bar\.html/);
    await until("toolbar screen button", () =>
      bar.eval("!!document.querySelector('[data-act=screen]')"),
    );
    const bounds = await bar.eval(
      `(()=>{const b=document.querySelector('[data-act=screen]').getBoundingClientRect();return {x:b.left,right:b.right,width:innerWidth}})()`,
    );
    assert.ok(bounds.x >= 0 && bounds.right <= bounds.width);
    await shot(bar, "toolbar-small.png");
    const before = countAttachments();
    await click(bar, "[data-act=screen]");
    await until("toolbar setup",()=>chat.eval("!!document.querySelector('[data-testid=screen-setup]')"));
    await click(chat,"[data-testid=screen-start]");
    await until("toolbar picker", () =>
      chat.eval("!!document.querySelector('[data-testid=share-picker]')"),
    );
    await shot(chat, "toolbar-picker.png");
    await chat.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await until("escape cancelled", () =>
      chat.eval("!document.querySelector('[data-testid=share-picker]')"),
    );
    assert.equal(countAttachments(), before);
    await click(bar, "[data-act=screen]");
    await until("toolbar setup",()=>chat.eval("!!document.querySelector('[data-testid=screen-setup]')"));
    await click(chat,"[data-testid=screen-start]");
    await until("picker again", () =>
      chat.eval("!!document.querySelector('[data-testid=share-picker]')"),
    );
    await chat.eval(
      `document.querySelector('[data-testid=share-picker]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true})),true`,
    );
    await until("outside click cancelled", () =>
      chat.eval("!document.querySelector('[data-testid=share-picker]')"),
    );
    assert.equal(countAttachments(), before);
    await click(bar, "[data-act=screen]");
    await until("toolbar setup",()=>chat.eval("!!document.querySelector('[data-testid=screen-setup]')"));
    await click(chat,"[data-testid=screen-start]");
    await until("picker for sharing", () =>
      chat.eval("!!document.querySelector('[data-testid=share-source]')"),
    );
    await chat.eval(
      `document.querySelector('[data-testid=share-source]').click();true`,
    );
    await click(chat, "[data-testid=share-go]");
    await until("toolbar active", () =>
      bar.eval(
        "document.querySelector('[data-act=screen]').classList.contains('sharing')",
      ),
    );
    assert.equal(
      (await con.eval("window.hrhNative.capture.sharing.get()")).owner,
      false,
    );
    assert.equal(
      (await chat.eval("window.hrhNative.capture.sharing.get()")).owner,
      true,
    );
    await shot(bar, "toolbar-sharing.png");
    await con.eval(
      `window.hrhNative.device.patch({volume:2.75,screen:{format:'png',hide_avatar:true}})`,
    );
    await until("settings synced", async () => {
      const p = await chat.eval("window.hrhNative.device.get()");
      return (
        p.volume === 2.75 && p.screen.format === "png" && !p.screen.hide_avatar
      );
    });
    const overlay = await app.page(/surface=mate-overlay/);
    assert.equal(
      await overlay.eval("window.hrhNative.device.get().then(p=>p.volume)"),
      2.75,
    );
    const serverMate = await con.eval(
      `fetch('/api/mates/${b.id}').then(r=>r.json())`,
    );
    assert.equal(serverMate.voice.volume, 2.35);
    assert.equal(serverMate.screen.format, "jpeg");
    await click(bar, "[data-act=screen]");
    await until("toolbar stop", () =>
      bar.eval(
        "!document.querySelector('[data-act=screen]').classList.contains('sharing')",
      ),
    );
    assert.equal(
      (await con.eval("window.hrhNative.capture.sharing.get()")).state,
      null,
    );
    assert.equal(countAttachments(), before);
    console.log(
      "PASS toolbar start/stop, small-width fit, Esc/outside cancel, all-window settings sync; server values unchanged",
    );
    await con.eval(`location.href='/?view=mate',true`);
    // the volume is this device's, for every mate: Settings → Mate (docs/settings.md)
    await con.eval(`location.href='/?view=settings&tab=mate',true`);
    await until("native volume slider", () =>
      con.eval("!!document.querySelector('[data-testid=mate-volume-slider]')"),
    );
    await setRange(con, "[data-testid=mate-volume-slider]", "180");
    await until(
      "native slider persisted",
      async () =>
        await overlay.eval(
          "window.hrhNative.device.get().then(p=>p.volume===1.8)",
        ),
    );
    await until("overlay playback volume follows", () =>
      overlay.eval(
        "document.querySelector('[data-voice-volume]')?.getAttribute('data-voice-volume') === '1.8'",
      ),
    );
    await con.eval("window.hrhNative.mate.openQuick().then(()=>true)");
    const quick = await app.page(/surface=mate-quick/);
    await until("quick device volume", () => quick.eval("window.hrhNative.device.get().then(p=>p.volume===1.8)"));
    await app.main("win('surface=mate-quick').hide();return true");
    await shot(con, "app-volume-settings.png");
    await con.eval(`location.href='/?view=settings&tab=screen',true`);
    await until("screen sharing settings", () => con.eval("!!document.querySelector('[data-testid=device-capture-approval]')"));
    await shot(con, "app-screen-settings.png");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(settingsDir, "settings.json")))
        .devicePreferences.volume,
      1.8,
    );
    console.log(
      "PASS native volume slider persists locally and updates the avatar window",
    );

    // Real request and native approval rejection: no upload is created.
    await con.eval(
      `window.hrhNative.device.patch({screen:{source:null,approval:'ask'}})`,
    );
    await chat.eval(
      `(()=>{const e=document.querySelector('[data-testid=mate-input]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'look at my screen');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
    );
    await click(chat, "[data-testid=mate-send]");
    const prompt = await app.page(/capture-ask\.html/);
    await until("approval deny button", () =>
      prompt.eval("!!document.querySelector('[data-testid=capture-deny]')"),
    );
    await prompt.eval("setTimeout(()=>document.querySelector('[data-testid=capture-deny]').click(),50),true");
    await until("denial result", () =>
      chat.eval("document.body.innerText.includes('SEESCREEN')"),
    );
    assert.equal(countAttachments(), before);
    console.log(
      "PASS native agent permission denied without retained attachments",
    );
    await app.main(`global.__captureWindowEvents=[];global.__watchCapture=false;for(const w of require('electron').BrowserWindow.getAllWindows()){const url=w.webContents.getURL();if(url.includes('bar.html')||url.includes('capture-ask.html'))continue;for(const e of ['hide','show','minimize','restore','focus','blur'])w.on(e,()=>{if(global.__watchCapture)global.__captureWindowEvents.push({id:w.id,event:e});});}return true`);
    // Hold an actual native screenshot after the OS returns it, then cancel before it can reach the page.
    await app.main(
      `global.__originalCapture=require('electron').desktopCapturer.getSources;global.__captureEntered=false;require('electron').desktopCapturer.getSources=async function(o){const result=await global.__originalCapture.call(this,o);if(o.thumbnailSize.width>640){global.__captureEntered=true;await new Promise(r=>global.__releaseCapture=r);}return result;};return true`,
    );
    await click(bar, "[data-act=screen]");
    await until("toolbar setup",()=>chat.eval("!!document.querySelector('[data-testid=screen-setup]')"));
    await click(chat,"[data-testid=screen-once]");
    await until("picker for in-flight cancel", () =>
      chat.eval("!!document.querySelector('[data-testid=share-source]')"),
    );
    await click(chat, "[data-testid=share-source]");
    await app.main("global.__captureWindowEvents=[];global.__watchCapture=true;return true");
    await click(chat, "[data-testid=share-go]");
    await until("native capture held", () =>
      app.main("return global.__captureEntered"),
    );
    await bar.eval("window.hrhBar.act('screen'),true");
    await until("cancel leaves avatar continuously visible", () =>
      app.main("return win('surface=mate-overlay').isVisible()"),
    );
    await click(chat, "[data-testid=share-cancel]");
    await app.main(
      "global.__releaseCapture();require('electron').desktopCapturer.getSources=global.__originalCapture;return true",
    );
    await sleep(500);
    assert.deepEqual(await app.main("global.__watchCapture=false;return global.__captureWindowEvents"),[],'capture/cancel must never hide/show or refocus app windows');
    assert.equal(countAttachments(), before);
    assert.equal(
      await chat.eval("!!document.querySelector('[data-testid=share-picker]')"),
      false,
    );
    console.log(
      "PASS cancel during real native capture keeps windows visible and discards late image",
    );

    await shot(chat, "request-denied.png");
    // Local browser contexts have independent volumes. Same-context tabs synchronize.
    await context.addInitScript((id) => {
      localStorage.setItem("hrh_mate_active", id);
      localStorage.setItem("hrh_lang", "en");
    }, b.id);
    const page = await context.newPage();
    await page.goto(server + "/?view=settings&tab=mate");
    await page.waitForSelector("[data-testid=mate-volume-slider]");
    await page.evaluate(() => {
      const e = document.querySelector("[data-testid=mate-volume-slider]");
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(e, "150");
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() =>
      document
        .querySelector("[data-testid=mate-volume-value]")
        ?.textContent.includes("150"),
    );
    const tab = await context.newPage();
    await tab.goto(server + "/?view=settings&tab=mate");
    await tab.waitForFunction(() =>
      document
        .querySelector("[data-testid=mate-volume-value]")
        ?.textContent.includes("150"),
    );
    const separate = await browser.newContext();
    await separate.request.post(server + "/api/auth/login", {
      data: { username: "admin", password },
    });
    await separate.addInitScript(
      (id) => localStorage.setItem("hrh_mate_active", id),
      b.id,
    );
    const independent = await separate.newPage();
    await independent.goto(server + "/?view=settings&tab=mate");
    await independent.waitForFunction(() =>
      document
        .querySelector("[data-testid=mate-volume-value]")
        ?.textContent.includes("235"),
    );
    console.log(
      "PASS browser same-device sync and independent-device isolation",
    );
    await tab.close();
    await separate.close();
    // Feed an actual streaming UI and send two additional messages; save old CSS reproduction and repaired layout.
    await page.click("[data-testid=mate-settings-close]");
    await page.goto(server + "/?view=mate");
    await page.waitForSelector("[data-testid=mate-input]");
    await page.fill("[data-testid=mate-input]", "q88 start streaming");
    await page.click("[data-testid=mate-send]");
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll("[data-testid=mate-bubble]")).some(
        (e) => e.textContent.includes("Reply 88"),
      ),
    );
    await page.fill("[data-testid=mate-input]", "Steering one while replying");
    await page.click("[data-testid=mate-send]");
    await page.fill("[data-testid=mate-input]", "Steering two while replying");
    await page.click("[data-testid=mate-send]");
    await page.waitForFunction(() =>
      Array.from(
        document.querySelectorAll("[data-testid=mate-user-bubble]"),
      ).some((e) => e.textContent.includes("Steering two")),
    );
    const old = await page.addStyleTag({
      content:
        '[data-testid="mate-turn"] [data-testid="mate-user-message"]{width:auto;min-width:auto}',
    });
    await page.screenshot({ path: path.join(shots, "steering-before.png") });
    await old.evaluate((e) => e.remove());
    const box = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-testid=mate-user-message]"))
        .filter((e) => e.textContent.includes("Steering"))
        .map((e) => {
          const b = e
              .querySelector("[data-testid=mate-user-bubble]")
              .getBoundingClientRect(),
            r = e.getBoundingClientRect();
          return {
            right: b.right,
            containerRight: r.right,
            width: r.width,
            kind: e.parentElement.dataset.testid,
          };
        }),
    );
    assert.equal(box.length, 2);
    for (const b of box)
      assert.ok(
        Math.abs(b.right - b.containerRight) < 2,
        "user bubble is right aligned across full row",
      );
    await page.screenshot({ path: path.join(shots, "steering-after.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shots, "steering-phone.png") });
    console.log(
      "PASS actual streamed reply + two steers stay right aligned; before/after and phone screenshots saved",
    );
    // Opt-in through the actual settings UI; wait for a real automatic native frame, not a manual API trigger.
    // (speaking first is this device's: Settings → Mate, one switch)
    await page.setViewportSize({width:1200,height:900});
    await page.goto(server + "/?view=settings&tab=mate");
    await page.waitForSelector('[data-testid=proactive-enabled]');
    assert.equal(await page.getAttribute('[data-testid=proactive-enabled]','aria-checked'),'false');
    await page.click('[data-testid=proactive-enabled]');
    await page.waitForFunction(()=>document.querySelector('[data-testid=proactive-enabled]').getAttribute('aria-checked')==='true');
    await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'hrh_lang',newValue:'ko'})));
    await page.waitForTimeout(200);
    await page.screenshot({path:path.join(shots,'proactive-settings.png')});
    // The browser above is a different device: its local switch must not enable native observation.
    assert.equal(await con.eval("window.hrhNative.device.get().then(p=>p.screen.proactive_enabled)"),false);
    await con.eval(`location.href='/?view=settings&tab=mate',true`);
    await until('native proactive settings',()=>con.eval("!!document.querySelector('[data-testid=proactive-enabled]')"));
    await click(con,'[data-testid=proactive-enabled]');
    await until('native reach-out enabled locally',()=>con.eval("window.hrhNative.device.get().then(p=>p.screen.proactive_enabled && p.screen.proactive_interval===60)"));
    const conversation=await (await context.request.post(server+'/api/mates/'+b.id+'/conversation')).json();
    await until('previous reply done',async()=>!(await (await context.request.post(server+'/api/mates/'+b.id+'/conversation')).json()).running);
    await chat.eval("window.dispatchEvent(new StorageEvent('storage',{key:'hrh_lang',newValue:'ko'})),true");
    await click(bar,'[data-act=screen]');
    await shot(chat,'sharing-start-setup.png');
    await click(chat,'[data-testid=screen-start]');
    await until('automatic source picker',()=>chat.eval("!!document.querySelector('[data-testid=share-source]')"));
    await click(chat,'[data-testid=share-source]');
    await click(chat,'[data-testid=share-go]');
    await until('shared without expanded settings',()=>chat.eval("!document.querySelector('[data-testid=screen-setup]')"));
    assert.equal(await chat.eval("document.querySelectorAll('[data-testid=local-screen-controls],[data-testid=screen-sharing-banner]').length"),0);
    await shot(chat,'sharing-compact.png');
    assert.equal(await app.main("return win('surface=mate-chat').webContents.getBackgroundThrottling()"),false);
    await app.main("global.__watchCapture=false;win('surface=mate-chat').hide();return true");
    await sleep(250);
    await app.main("global.__captureWindowEvents=[];global.__watchCapture=true;return true");
    await until('automatic mate screen observation',async()=>{
      const h=await (await context.request.get(server+'/api/history/'+conversation.session_id)).json();
      return h.messages?.some(m=>m.meta?.kind==='screen_observation' && m.attachments?.length);
    },110000);
    await until('automatic reply finished',async()=>!(await (await context.request.post(server+'/api/mates/'+b.id+'/conversation')).json()).running,30000);
    assert.deepEqual(await app.main("global.__watchCapture=false;return global.__captureWindowEvents"),[],'automatic observation must never change app visibility or focus');
    await app.main("win('surface=mate-chat').show();return true");
    await shot(chat,'proactive-reply.png');
    await context.request.patch(server+'/api/mates/'+b.id,{data:{prefs:{proactive:{guidance:'GENY_TEST_SILENT'}}}});
    const oldComplete=await chat.eval(`fetch('/api/history/${conversation.session_id}').then(r=>r.json()).then(h=>h.events.filter(e=>e.type==='turn.complete').length)`);
    const silent=await chat.eval(req('/api/sessions/'+conversation.session_id+'/screen/observe',{device:await chat.eval("localStorage.getItem('hrh_device_id')"),force:true}));
    assert.equal(silent.status,'sent');
    await until('silent turn completed',()=>chat.eval(`fetch('/api/history/${conversation.session_id}').then(r=>r.json()).then(h=>h.events.filter(e=>e.type==='turn.complete').length>${oldComplete})`));
    const silence=await chat.eval(`fetch('/api/history/${conversation.session_id}').then(r=>r.json()).then(h=>({last:h.events.filter(e=>e.type==='turn.complete').at(-1).data,leaked:h.events.some(e=>e.type==='text.delta' && e.data.text.includes('[SILENT]'))}))`);
    assert.equal(silence.last.silent,true);assert.equal(silence.last.text,'');assert.equal(silence.leaked,false);
    assert.equal(await chat.eval("document.body.innerText.includes('[SILENT]')"),false);
    console.log('PASS real native force-show path → fragmented [SILENT] → no text event, bubble or TTS input');
    await click(bar,'[data-act=screen]');
    await until('server consent revoked',async()=>{const stopped=await context.request.post(server+'/api/sessions/'+conversation.session_id+'/screen/observe',{data:{device:await chat.eval("localStorage.getItem('hrh_device_id')")}});return stopped.status()===409;});
    assert.equal(await app.main("return win('surface=mate-chat').webContents.getBackgroundThrottling()"),true);
    console.log('PASS actual settings opt-in → 60-second timer → native image → autonomous mate reply; stop revokes access');
    await context.close();
    console.log("DEVICE SETTINGS E2E OK");
  } finally {
    await browser?.close();
    await app.stop();
  }
})().catch((e) => {
  console.error(e.stack || e);
  console.error(app.out?.slice(-1800));
  process.exitCode = 1;
});
