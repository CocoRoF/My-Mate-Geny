/**
 * The pointer on the whole desktop for an avatar that looks at it (Live2D, LivLiv). A window only hears the pointer
 * over itself — her small window is small; the desktop app sends where it is outside the window (desktop
 * src/cursor-feed.js), and it comes in here as the page's own pointer moves: whatever follows the pointer anywhere on
 * the page follows it on the whole desktop. Elsewhere (a browser) there is nothing to add: the page is all there is.
 */
let users = 0;
let off: (() => void) | null = null;

/** while the returned function isn't called: the desktop's pointer moves come in as this page's */
export function followDesktopCursor(): () => void {
  const bridge = typeof window !== "undefined" ? window.hrhNative?.cursor : undefined;
  if (!bridge) return () => {};
  if (users++ === 0) {
    bridge.follow(true);
    off = bridge.onPoint((p) => window.dispatchEvent(new PointerEvent("pointermove", { clientX: p.x, clientY: p.y, pointerType: "mouse" })));
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--users === 0) {
      bridge.follow(false);
      off?.();
      off = null;
    }
  };
}
