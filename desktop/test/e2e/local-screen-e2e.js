// Real Electron/X11 capture through a normal session's real MCP bridge; isolated fake-model backend.
// Also drives Chromium with a known canvas stream to check browser consent/reuse/cancel/stop.
// CHROME=<binary> xvfb-run -a node test/e2e/local-screen-e2e.js <test-server> <test-password> <workspace> <shots>
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const assert = require("assert/strict");
const { App, Cdp, fill, until, sleep, SAMPLE, SHA } = require("./screen-capture-e2e");
const [server, password, workspace, shots] = process.argv.slice(2);
const chromePath = process.env.CHROME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "geny-local-screen-"));
fs.mkdirSync(shots, { recursive: true });
const port = 9555;
const app = new App(home, port, port + 500);
let chrome;
let webBrowser;
const req = (url, body, method = "POST") => `fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>{if(!r.ok)throw new Error(r.status+':'+await r.text());return r.json()})`;
const evalClick = (page, selector) => page.eval(`document.querySelector(${JSON.stringify(selector)}).click(), true`);
async function openSetup(page) {
  await evalClick(page,'button[title="Attach photos or files"]');
  await until("attach menu",()=>page.eval("!!document.querySelector('[data-testid=attach-share-screen]')"));
  await evalClick(page,'[data-testid=attach-share-screen]');
  await until("sharing settings",()=>page.eval("!!document.querySelector('[data-testid=screen-setup]')"));
}
async function screenshot(page, name) { const r = await page.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, "base64")); }
async function send(page, sid, text) {
  return page.eval(`new Promise((resolve,reject)=>{const w=new WebSocket(location.origin.replace(/^http/,'ws')+'/ws/chat/'+${JSON.stringify(sid)});let sent=false;
  w.onopen=()=>{w.send(JSON.stringify({type:'chat',input:${JSON.stringify(text)},client_msg_id:'test~'+localStorage.getItem('hrh_device_id')}));sent=true;resolve(true)};w.onerror=reject;setTimeout(()=>w.close(),60000)})`);
}
async function history(page, sid) { return page.eval(`fetch('/api/history/'+${JSON.stringify(sid)}).then(r=>r.json())`); }
async function finished(page, sid, marker = "") {
  return until("model reply "+marker, async () => {
    const h = await history(page, sid);
    const text = JSON.stringify(h);
    return text.includes(marker) && h.events?.some(e => e.type === "turn.complete") ? h : null;
  }, 45000);
}
(async () => {
  try {
    // A distinct screen window, not the web server's workspace.
    const url = 'data:text/html,'+encodeURIComponent('<title>GENY-LOCAL-KNOWN</title><body style="margin:0;background:#d81b9c;color:white;font:44px sans-serif;height:100vh">LOCAL-DEVICE-739</body>');
    chrome = spawn(chromePath, ["--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${home}/known`, `--remote-debugging-port=${port+1}`, `--app=${url}`, "--window-size=900,700"], { stdio: "ignore", detached: true });
    await sleep(1500);
    for (const id of execFileSync("xdotool", ["search", "--name", "GENY-LOCAL-KNOWN"], { encoding: "utf8" }).trim().split(/\s+/)) {
      execFileSync("xprop", ["-id", id, "-f", "WM_STATE", "32c", "-set", "WM_STATE", "1"]);
    }
    app.start();
    const connect = await app.page(/connect\.html/);
    await until("connect page", () => connect.eval("!!window.hrhConnect"));
    await connect.eval(fill(server, "admin", password));
    let con = await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)'));
    await until("console", () => con.eval("!!document.querySelector('#root > *')"));
    await con.eval("localStorage.setItem('hrh_lang','en')");
    const spec = { provider: "claude", workspace_path: workspace, title: "Local screen normal chat" };
    if (process.env.SCREEN_REMOTE_JSON) {
      const remote = JSON.parse(fs.readFileSync(process.env.SCREEN_REMOTE_JSON));
      spec.workspace_path = remote.workspace_path; spec.connection_id = remote.connection_id;
    }
    const session = await con.eval(req("/api/sessions", spec));
    await con.eval(`location.href='/?view=chat&session=${session.id}',true`);
    await until("composer", () => con.eval("!!document.querySelector('textarea')"));
    await openSetup(con);
    await evalClick(con, '[data-testid="screen-start"]');
    await until("native source picker", () => con.eval("!!document.querySelector('[data-testid=share-source]')"));
    await con.eval(`Array.from(document.querySelectorAll('[data-testid=share-source]')).find(e=>e.textContent.includes('GENY-LOCAL-KNOWN')).click(),true`);
    await evalClick(con, '[data-testid="share-go"]');
    await until("sharing active", async () => !!(await con.eval("window.hrhNative.capture.sharing.get()")).state);
    await screenshot(con, "desktop-sharing.png");
    await send(con, session.id, "look at my local screen");
    const prompt = await app.page(/capture-ask\.html/);
    await until("native approval", () => prompt.eval("!!document.querySelector('[data-testid=capture-allow]')"));
    await evalClick(prompt, '[data-testid="capture-allow"]');
    const h = await finished(con, session.id, "SEESCREEN listed=yes error=no");
    const result = h.events.find(e=>e.type==='tool.result' && e.data.images?.length);
    assert.ok(result, "normal chat has screenshot attachment");
    assert.equal(result.data.images.length, 1);
    const image = result.data.images[0];
    const sha = await con.eval(SHA(`/api/attachments/${image.id}/content?variant=preview`));
    assert.ok(JSON.stringify(h).includes(sha), "model receives the exact attachment bytes");
    const sample = await con.eval(SAMPLE(`/api/attachments/${image.id}/content`, [[300,400]]));
    assert.ok(Math.abs(sample.px[0][0]-216)<30 && Math.abs(sample.px[0][2]-156)<30, "captures the chosen pink local window");
    fs.writeFileSync(path.join(shots,"desktop-proof.json"),JSON.stringify({sample,sha}));
    console.log("PASS real Electron source → normal session MCP → model bytes → conversation image");
    await openSetup(con);
    await con.eval(`(()=>{const s=document.querySelector('[data-testid=screen-mode]');s.value='on_turn';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await evalClick(con,'[data-testid=screen-apply]');
    await sleep(300);
    await send(con, session.id, "auto frame message");
    const h2 = await until("auto-frame user message", async()=>{
      const h=await history(con,session.id);return h.messages?.find(m=>m.content==='auto frame message'&&m.attachments?.length) ? h : null;
    });
    assert.ok(h2.messages.find(m=>m.content==='auto frame message').attachments.length);
    await con.eval("window.hrhNative.capture.sharing.stop(),true");
    await until("sharing stopped", async () => (await con.eval("window.hrhNative.capture.sharing.get()")).state === null);
    console.log("PASS native on-turn attachment and stop");
    await until("native auto turn finished",async()=>{const h=await history(con,session.id);return h.events.filter(e=>e.type==='turn.complete').length>=2});

    // Browser stream ownership: this bypasses only the system picker, not capture/upload/WS/MCP.
    const { chromium } = require("playwright-core");
    webBrowser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const context = await webBrowser.newContext({ viewport: { width: 1280, height: 900 } });
    assert.ok((await context.request.post(server+"/api/auth/login",{data:{username:"admin",password}})).ok());
    const page = await context.newPage();
    await page.addInitScript(()=>localStorage.setItem('hrh_lang','en'));
    await page.goto(`${server}/?view=chat&session=${session.id}`);
    await page.waitForSelector('textarea');
    const cdp = await context.newCDPSession(page);
    const browserPage = { eval: expression => page.evaluate(s=>eval(s), expression), send: (method,args)=>cdp.send(method,args), close: ()=>context.close() };
    await browserPage.eval(`window.__captures=0;window.__stopped=0;navigator.mediaDevices.getDisplayMedia=async()=>{window.__captures++;const c=document.createElement('canvas');c.width=1280;c.height=720;const g=c.getContext('2d');g.fillStyle='#12ab34';g.fillRect(0,0,1280,720);g.fillStyle='white';g.font='48px sans-serif';g.fillText('BROWSER-STREAM-739',40,100);const s=c.captureStream(2);window.__displayStream=s;const tr=s.getVideoTracks()[0];const old=tr.stop.bind(tr);tr.stop=()=>{window.__stopped++;old()};return s};true`);
    await openSetup(browserPage);
    await evalClick(browserPage,'[data-testid="screen-start"]');
    await until("browser sharing",()=>browserPage.eval("window.__captures===1 && !document.querySelector('[data-testid=screen-setup]')"));
    await send(browserPage,session.id,"look at my local screen");
    await until("browser approval",()=>browserPage.eval("!!document.querySelector('[data-testid=screen-approval]')"));
    await screenshot(browserPage,"browser-approval.png");
    await evalClick(browserPage,'[data-testid="screen-allow"]');
    await until("second model screen result",async()=>{const h=await history(browserPage,session.id);return h.events.filter(e=>e.type==='tool.result'&&e.data.images?.length).length>=2});
    assert.equal(await browserPage.eval("window.__captures"),1);
    await until("browser turn finished",async()=>{const h=await history(browserPage,session.id);return h.events.filter(e=>e.type==='turn.complete').length>=3});
    await openSetup(browserPage);
    await browserPage.eval(`(()=>{const s=document.querySelector('[data-testid=screen-mode]');s.value='observe';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await evalClick(browserPage,'[data-testid=screen-apply]');
    await sleep(300);
    const observed = await browserPage.eval(req(`/api/sessions/${session.id}/screen/observe`, { device: await browserPage.eval("localStorage.getItem('hrh_device_id')") }));
    assert.equal(observed.status, "sent");
    const throttled = await browserPage.eval(req(`/api/sessions/${session.id}/screen/observe`, { device: await browserPage.eval("localStorage.getItem('hrh_device_id')") }));
    assert.equal(throttled.status, "busy"); // the observation's reply is still running; never queue another
    console.log("PASS periodic observation captures a current frame and skips a busy conversation");

    await browserPage.eval("window.__displayStream.getVideoTracks()[0].dispatchEvent(new Event('ended'));true");
    assert.equal(await browserPage.eval("window.__stopped"),1);
    console.log("PASS browser shared stream → approval → normal agent image; no repeated picker; tracks stop");
    browserPage.close();
    console.log("LOCAL SCREEN E2E OK");
  } finally {
    await webBrowser?.close();
    await app.stop();
    try {process.kill(-chrome.pid,"SIGKILL")}catch{}
  }
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
