/**
 * Back / forward like an app, not a website.
 *
 * Every in-app screen change (the sidebar's views, opening a chat) is a history entry with its own URL
 * (`/?view=usage`, `/?view=chat&session=<id>`, `/` = a new chat), so back goes to the previous screen and a reload
 * stays on it. Below the first screen sits a guard entry: going back past it (browser back, swipe, the mouse's back
 * button, Alt+←) stays in the app — it never falls through to the login page or the desktop app's connect screen
 * that came before. Overlays (drawers, sheets, dialogs — lib/back.ts) close first.
 *
 * Desktop app: the mouse's back / forward buttons (Windows also reports them as app-commands — desktop/src/main.js
 * sends those here), Alt+← / Alt+→. Android: the hardware back button (native.ts) goes back, and at the first screen
 * asks for a second press before leaving the app.
 */
import { useSessionStore } from "../stores/sessionStore";
import { useUIStore, type View } from "../stores/uiStore";
import { runBack } from "./back";

const VIEWS: readonly View[] = ["mate", "chat", "providers", "connections", "usage", "admin", "downloads", "settings"];

interface Loc {
  view: View;
  session: string | null;
}

type NavState = { hrhNav: number; guard?: boolean };

function fromUrl(search = window.location.search): Loc | null {
  const q = new URLSearchParams(search);
  const v = q.get("view");
  const session = q.get("session");
  if (v && (VIEWS as readonly string[]).includes(v)) return { view: v as View, session: v === "chat" ? session : null };
  if (session) return { view: "chat", session };
  if (!v && !q.get("surface")) return { view: "chat", session: null };
  return null;
}

function current(): Loc {
  const view = useUIStore.getState().view;
  return { view, session: view === "chat" ? useSessionStore.getState().activeId : null };
}

export function urlOf(loc: Loc): string {
  if (loc.view === "chat") return loc.session ? `/?view=chat&session=${encodeURIComponent(loc.session)}` : "/";
  return `/?view=${loc.view}`;
}

const here = () => window.location.pathname + window.location.search;
const navState = (): NavState | null => {
  const s = window.history.state;
  return s && typeof s.hrhNav === "number" ? (s as NavState) : null;
};

/** how many in-app screens are behind this one (0: the first) */
export function navDepth(): number {
  const s = navState();
  return s && !s.guard ? Math.max(0, s.hrhNav - 1) : 0;
}

let installed = false;
let applying = false;
let lastAction = 0;

function apply(loc: Loc) {
  applying = true;
  try {
    const ss = useSessionStore.getState();
    if (loc.view === "chat" && ss.activeId !== loc.session) ss.setActive(loc.session);
    if (useUIStore.getState().view !== loc.view) useUIStore.getState().setView(loc.view);
  } finally {
    applying = false;
  }
}

/** Back: the top overlay closes; else the previous screen; at the first screen nothing (false). */
export function goBack(): boolean {
  if (runBack()) return true;
  if (navDepth() > 0) {
    window.history.back();
    return true;
  }
  return false;
}

export function goForward(): void {
  window.history.forward();
}

/** (one press arrives twice on some systems — the mouse button and the OS app-command) */
function once(fn: () => void) {
  const t = Date.now();
  if (t - lastAction < 250) return;
  lastAction = t;
  fn();
}

export function installNav(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // a deep link (/?view=…, a desktop "open that chat") applies first
  const start = fromUrl();
  if (start) apply(start);
  const url = urlOf(current());
  if (!navState()) {
    // fresh page: the guard below the first screen, then the first screen
    window.history.replaceState({ hrhNav: 0, guard: true } satisfies NavState, "", url);
    window.history.pushState({ hrhNav: 1 } satisfies NavState, "", url);
  } else if (here() !== url) {
    window.history.replaceState(window.history.state, "", url);
  }

  // in-app changes → history entries (what the app picks by itself while starting — the last open chat — replaces
  // the first screen instead of adding one)
  const bootUntil = Date.now() + 2500;
  const onChange = () => {
    if (applying) return;
    const next = urlOf(current());
    if (next === here()) return;
    const s = navState();
    if (Date.now() < bootUntil && navDepth() === 0 && s && !s.guard) window.history.replaceState(s, "", next);
    else window.history.pushState({ hrhNav: (s && !s.guard ? s.hrhNav : 1) + 1 } satisfies NavState, "", next);
  };
  useUIStore.subscribe((s, prev) => s.view !== prev.view && onChange());
  useSessionStore.subscribe((s, prev) => s.activeId !== prev.activeId && useUIStore.getState().view === "chat" && onChange());

  // history → the app
  window.addEventListener("popstate", (ev) => {
    const s = ev.state as (NavState & { hrhOverlay?: boolean }) | null;
    if (s?.hrhOverlay) return; // lib/back.ts's own entries
    if (s?.guard) {
      // back past the first screen: stay (never the login page / connect screen behind it)
      window.history.go(1);
      return;
    }
    const loc = fromUrl();
    if (loc) apply(loc);
  });

  // desktop app: mouse back / forward buttons and Alt+← / Alt+→ (a browser does these itself)
  if (window.hrhNative && /^desktop-/.test(window.hrhNative.platform)) {
    window.addEventListener("mouseup", (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      once(() => (e.button === 3 ? goBack() : goForward()));
    });
    window.addEventListener("keydown", (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      once(() => (e.key === "ArrowLeft" ? goBack() : goForward()));
    });
    window.hrhNative.onNav?.((dir) => once(() => (dir === "back" ? goBack() : goForward())));
  }
}
