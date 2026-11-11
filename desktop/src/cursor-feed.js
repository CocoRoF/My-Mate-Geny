// Where the pointer is on the whole desktop, for a page whose avatar (Live2D, LivLiv) looks at it: a window only hears
// the pointer while it is over the window, and her small window is small. A page asks for it (cursor:follow) while
// such an avatar is shown; then, a few times a second, the pointer's position — when it is outside that window (inside,
// the page's own pointer events say it) and moved — goes to the page in its window's coordinates (CSS px from the
// content's top left; outside the window, so below 0 or past its size).
"use strict";

const EVERY_MS = 50;

function createCursorFeed({ screen, fromWebContents, setInterval: si = setInterval, clearInterval: ci = clearInterval, every = EVERY_MS }) {
  const followers = new Map(); // webContents -> the last point sent ("x,y") or ""
  let timer = null;

  function tick() {
    if (!followers.size) return stop();
    const pt = screen.getCursorScreenPoint();
    for (const [wc, last] of followers) {
      if (wc.isDestroyed()) {
        followers.delete(wc);
        continue;
      }
      const win = fromWebContents(wc);
      if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) continue;
      const b = win.getContentBounds();
      const x = pt.x - b.x, y = pt.y - b.y;
      if (x >= 0 && y >= 0 && x < b.width && y < b.height) {
        followers.set(wc, ""); // (over the window: its own events)
        continue;
      }
      const key = `${x},${y}`;
      if (key === last) continue;
      followers.set(wc, key);
      wc.send("cursor:point", { x, y });
    }
  }
  function stop() {
    if (timer) ci(timer);
    timer = null;
  }
  function follow(wc, on) {
    if (!on) followers.delete(wc);
    else if (!followers.has(wc)) {
      followers.set(wc, "");
      wc.once?.("destroyed", () => followers.delete(wc));
    }
    if (followers.size && !timer) {
      timer = si(tick, every);
      timer.unref?.();
    } else if (!followers.size) stop();
  }
  return { follow, tick, stop, size: () => followers.size };
}

module.exports = { createCursorFeed, EVERY_MS };
