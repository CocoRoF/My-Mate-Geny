// Real Electron restart with the same app profile and the real isolated API.
const { App, fill, until, sleep } = require('../../../desktop/test/e2e/screen-capture-e2e');
const { chromium } = require('playwright-core');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const [server, password, workspace] = process.argv.slice(2);
const profile = path.join(process.env.SCREEN_TEST_ROOT, 'desktop-profile');
const shots = process.env.SCREEN_SHOTS;
fs.mkdirSync(profile, { recursive: true });
let app, browser, context, page;
const consoleUrl = new RegExp('^' + server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(?!login)(?!\\?surface=)');
async function launch(first = false) {
  app = new App(profile, 9680, 10180);
  app.start();
  if (first) {
    const connect = await app.page(/connect\.html/);
    await until('connect bridge', () => connect.eval('!!window.hrhConnect'));
    await connect.eval(fill(server, 'admin', password));
  }
  await app.page(consoleUrl);
  browser = await chromium.connectOverCDP('http://127.0.0.1:9680');
  context = browser.contexts()[0];
  page = await until('console page', () => context.pages().find(p => consoleUrl.test(p.url())));
  await page.waitForSelector('nav');
}
async function stop() {
  await app.stop();
  await browser.close().catch(() => {});
}
const saved = p => p.evaluate(() => JSON.parse(localStorage.getItem('hrh_last_conversation') || 'null'));
const api = async (url, method = 'GET', data) => {
  const r = await context.request.fetch(server + url, { method, ...(data ? { data } : {}) });
  assert(r.ok(), await r.text());
  return r.status() === 204 ? null : r.json();
};
async function expectSaved(kind, id) {
  await until('last ' + kind, async () => { const s = await saved(page); return s?.kind === kind && s.id === id; });
}
(async () => {
  try {
    await launch(true);
    const chat = await api('/api/sessions', 'POST', { provider: 'claude', model: 'haiku', connection_id: null, workspace_path: workspace, title: 'Restored coding session' });
    const mate = await api('/api/mates', 'POST', { name: 'Restored mate', proactive: { enabled: false }, voice: { auto_read: false, tts: { engine: 'off' } } });
    await page.evaluate(id => {
      localStorage.setItem('hrh_lang', 'ko');
      localStorage.setItem('hrh_last_session', id);
      localStorage.removeItem('hrh_last_conversation');
    }, chat.id);
    await page.goto(server + '/');
    await until('legacy chat fallback', () => page.url().includes('session=' + chat.id));
    console.log('Legacy last-session fallback: OK');

    await page.goto(server + '/?view=mate&mate=' + mate.id + '&panel=relation');
    await page.getByTestId('mate-input').waitFor();
    await expectSaved('mate', mate.id);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(shots, 'mate-before-restart.png') });
    await page.goto(server + '/?view=settings&tab=usage');
    assert.equal((await saved(page)).kind, 'mate');
    await stop();

    await launch();
    await until('restored mate view', () => page.url().includes('view=mate'));
    await page.getByTestId('mate-input').waitFor();
    await expectSaved('mate', mate.id);
    assert.equal(await page.evaluate(() => localStorage.getItem('hrh_mate_active')), mate.id);
    await page.screenshot({ path: path.join(shots, 'mate-after-restart.png') });
    console.log('Mate + selected identity restored after full Electron restart; Settings did not replace it: OK');

    await page.goto(server + '/?view=chat&session=' + chat.id);
    await expectSaved('chat', chat.id);
    await page.evaluate(() => window.hrhNative.mate.showAvatar());
    await app.page(/surface=mate-overlay/);
    await sleep(1000);
    await expectSaved('chat', chat.id);
    await stop();

    await launch();
    await until('restored coding session', () => page.url().includes('session=' + chat.id));
    await expectSaved('chat', chat.id);
    console.log('Coding chat restored after restart; background avatar did not override it: OK');

    await page.evaluate(async id => { await window.hrhNative.mate.setMate(id); await window.hrhNative.mate.openChat(); }, mate.id);
    const popup = await until('native mate chat', () => context.pages().find(p => p.url().includes('surface=mate-chat')));
    await popup.getByTestId('mate-input').waitFor();
    await popup.getByTestId('mate-input').fill('마지막 대화 복원 확인');
    await popup.getByTestId('mate-send').click();
    await expectSaved('mate', mate.id);
    assert(page.url().includes('session=' + chat.id), 'sending in popup must not redirect existing console');
    await sleep(600);
    await stop();

    await launch();
    await until('mate from popup', () => page.url().includes('view=mate'));
    await page.getByTestId('mate-input').waitFor();
    await expectSaved('mate', mate.id);
    await page.screenshot({ path: path.join(shots, 'popup-conversation-restored.png') });
    console.log('Native Mate chat sends select the next startup screen across windows: OK');

    await api('/api/mates/' + mate.id, 'DELETE');
    await page.goto(server + '/');
    await page.getByTestId('mate-input').waitFor();
    await until('deleted mate fallback', async () => { const s = await saved(page); return s?.kind === 'mate' && s.id !== mate.id; });
    console.log('Deleted mate safely falls back to an existing mate: OK');
    console.log('LAST CONVERSATION ELECTRON RESTART E2E OK');
  } finally {
    if (app) await app.stop();
    if (browser) await browser.close().catch(() => {});
  }
})().catch(e => { console.error(e); process.exit(1); });
