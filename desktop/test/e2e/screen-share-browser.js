// Share screen in a browser (docs/mate.md §4 "Seeing the screen"): no desktop app → the composer's + menu offers
// Share screen through getDisplayMedia; one frame becomes a PNG in the tray; the Screen tab says the mate's own look
// needs the desktop app; a phone gets no Share screen. English pinned.
//
//   NODE_PATH=<playwright>/node_modules CHROME=<chrome> xvfb-run -a node test/e2e/screen-share-browser.js <server> <password> [shots dir]
//
// Chromium under Xvfb cannot start a real desktop video source ("NotReadableError: Could not start video source"),
// so the browser's own picker is stood in for by a known stream (a 1280×720 #d81b9c canvas): what is checked is the
// page's path — one frame → PNG → the tray.
const { chromium } = require("playwright");

const [server, password, shots] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: false, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const r = await page.request.post(`${server}/api/auth/login`, { data: { username: "admin", password } });
    if (!r.ok()) throw new Error(`login ${r.status()}`);
    await page.addInitScript(() => {
      localStorage.setItem("hrh_lang", "en");
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement("canvas");
        c.width = 1280;
        c.height = 720;
        const g = c.getContext("2d");
        const paint = () => {
          g.fillStyle = "#d81b9c";
          g.fillRect(0, 0, 1280, 720);
        };
        paint();
        setInterval(paint, 50);
        window.__gdmCalled = true;
        return c.captureStream(20);
      };
    });
    await page.goto(`${server}/?view=mate`);
    await page.waitForSelector('[data-testid="mate-attach"]', { timeout: 30000 });
    await page.click('[data-testid="mate-attach"]');
    await page.click('[data-testid="attach-share-screen"]');
    await page.click('[data-testid="screen-once"]');
    await page.waitForSelector('[data-testid="mate-composer"] img', { timeout: 30000 });
    const tray = await page.evaluate(async () => {
      const img = document.querySelector('[data-testid="mate-composer"] img');
      await img.decode();
      const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return { w: img.naturalWidth, h: img.naturalHeight, px: Array.from(g.getImageData(40, 40, 1, 1).data.slice(0, 3)), called: !!window.__gdmCalled };
    });
    console.log("tray:", JSON.stringify(tray));
    if (!tray.called || tray.w !== 1280 || tray.h !== 720 || Math.abs(tray.px[0] - 216) > 8) throw new Error("not the shared frame");
    if (shots) await page.screenshot({ path: `${shots}/web-share-tray.png` });
    await page.click('[data-testid="mate-settings-open"]');
    await page.click('[data-testid="mate-tab-screen"]');
    const note = await page.textContent('[data-testid="mate-screen-noapp"]');
    console.log("Screen tab in a browser:", note.trim());
    if (!/desktop app/.test(note)) throw new Error("the Screen tab should point to the desktop app");

    const phone = await browser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true });
    const pp = await phone.newPage();
    await pp.request.post(`${server}/api/auth/login`, { data: { username: "admin", password } });
    await pp.addInitScript(() => localStorage.setItem("hrh_lang", "en"));
    await pp.goto(`${server}/?view=mate`);
    await pp.waitForSelector('[data-testid="mate-attach"]', { timeout: 30000 });
    await pp.tap('[data-testid="mate-attach"]');
    await pp.waitForSelector('[data-testid="attach-menu"]');
    const items = await pp.$$eval('[data-testid="attach-menu"] button', (b) => b.map((x) => x.dataset.testid));
    console.log("phone + menu:", JSON.stringify(items));
    if (items.includes("attach-share-screen")) throw new Error("Share screen offered on a phone");
    console.log("SCREEN SHARE BROWSER OK");
  } catch (e) {
    console.error("FAILED", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
