/**
 * Back / forward like an app, not a website.
 *
 * Every in-app screen change (Mate, a chat, a Settings tab) is a history entry with its own URL
 * (`/?view=settings&tab=usage`, `/?view=chat&session=<id>`, `/` = a new chat — lib/navUrl.ts), so back goes to the
 * previous screen and a reload stays on it. The screens that became Settings tabs (`/?view=usage`, `downloads`, …)
 * open their tab, and the address shows the tab's. Below the first screen sits a guard entry: going back past it (browser back, swipe, the mouse's back
 * button, Alt+←) stays in the app — it never falls through to the login page or the desktop app's connect screen
 * that came before. Overlays (drawers, sheets, dialogs — lib/back.ts) close first.
 *
 * Desktop app: the mouse's back / forward buttons (Windows also reports them as app-commands — desktop/src/main.js
 * sends those here), Alt+← / Alt+→. Android: the hardware back button (native.ts) goes back, and at the first screen
 * asks for a second press before leaving the app.
 */
import { useSessionStore } from "../stores/sessionStore";
import { useUIStore } from "../stores/uiStore";
import { runBack, takeOverlayEntry } from "./back";
import { fromSearch, matePanelOf, urlOf, type Loc } from "./navUrl";

export { urlOf } from "./navUrl";

/** `from`: the URL this entry was pushed from (a phone's Settings tab goes back to the list it came from) */
type NavState = { hrhNav: number; guard?: boolean; from?: string };

const fromUrl = (search = window.location.search): Loc | null => fromSearch(search);

// (read before installNav makes the address canonical: `/?view=mate&mate=…&panel=…` → `/?view=mate`)
let matePanelLink = typeof window !== "undefined" ? matePanelOf(window.location.search) : null;

/** the Mate view's panel this page was opened for (once) */
export function takeMatePanelLink(): ReturnType<typeof matePanelOf> {
  const l = matePanelLink;
  matePanelLink = null;
  return l;
}

function current(): Loc {
  const { view, settingsTab } = useUIStore.getState();
  return {
    view,
    session: view === "chat" ? useSessionStore.getState().activeId : null,
    tab: view === "settings" ? settingsTab : null,
  };
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
/** the screen entry under any overlay entries (lib/back.ts pushes those on a touch browser) */
let lastScreen: NavState = { hrhNav: 1 };
let applying = false;
let lastAction = 0;

function apply(loc: Loc) {
  applying = true;
  try {
    const ss = useSessionStore.getState();
    if (loc.view === "chat" && ss.activeId !== loc.session) ss.setActive(loc.session);
    const ui = useUIStore.getState();
    if (loc.view === "settings") {
      if (ui.view !== "settings" || ui.settingsTab !== loc.tab || loc.anchor) ui.openSettings(loc.tab, loc.anchor ?? null);
    } else if (ui.view !== loc.view) ui.setView(loc.view);
  } finally {
    applying = false;
  }
}

/** whether this screen was opened from `url` (back returns there) */
export function cameFrom(url: string): boolean {
  return navState()?.from === url && navDepth() > 0;
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
  lastScreen = navState() ?? lastScreen;

  // in-app changes → history entries (what the app picks by itself while starting — the last open chat — replaces
  // the first screen instead of adding one)
  const bootUntil = Date.now() + 2500;
  const onChange = () => {
    if (applying) return;
    const next = urlOf(current());
    if (next === here()) return;
    const s = navState();
    if (Date.now() < bootUntil && navDepth() === 0 && s && !s.guard) window.history.replaceState(s, "", next);
    else if (!s && takeOverlayEntry()) {
      // opened from the phone drawer: its entry (on top) becomes this screen's — closing the drawer then has
      // nothing to step back over (lib/back.ts)
      lastScreen = { hrhNav: lastScreen.hrhNav + 1, from: here() };
      window.history.replaceState(lastScreen, "", next);
    } else {
      lastScreen = { hrhNav: (s && !s.guard ? s.hrhNav : 1) + 1, from: here() };
      window.history.pushState(lastScreen, "", next);
    }
  };
  useUIStore.subscribe((s, prev) => (s.view !== prev.view || s.settingsTab !== prev.settingsTab) && onChange());
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
    if (s && typeof s.hrhNav === "number") lastScreen = s;
    const loc = fromUrl();
    if (!loc) return;
    apply(loc);
    // (an entry from before the screens became Settings tabs, `/?view=usage`: it shows the tab's address now)
    const canonical = urlOf(current());
    if (canonical !== here()) window.history.replaceState(window.history.state, "", canonical);
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
