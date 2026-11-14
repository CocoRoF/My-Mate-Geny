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
import { useStudio } from "../stores/studioStore";
import { useUIStore } from "../stores/uiStore";
import { useMateStore } from "../stores/mateStore";
import { conversationLocation, readLastConversation, rememberConversation, startupConversation } from "./lastConversation";
import { runBack, takeOverlayEntry } from "./back";
import { fromSearch, matePanelOf, urlOf, type Loc } from "./navUrl";

export { urlOf } from "./navUrl";

/** `from`: the URL this entry was pushed from (a phone's Settings tab goes back to the list it came from) */
type NavState = { hrhNav: number; guard?: boolean; from?: string };

const fromUrl = (search = window.location.search): Loc | null => fromSearch(search);

// (read before installNav makes the address canonical: `/?view=mate&mate=…&panel=…` → `/?view=mate`)
let matePanelLink = typeof window !== "undefined" ? matePanelOf(window.location.search) : null;

// (likewise a Settings tab's own page: Voice Studio's `/?view=settings&tab=voice-studio&page=history`)
let settingsPageLink =
  typeof window !== "undefined" && fromSearch(window.location.search)?.tab === "voice-studio"
    ? new URLSearchParams(window.location.search).get("page")
    : null;

/** the page of Voice Studio this window was opened at (once) */
export function takeSettingsPageLink(): string | null {
  const p = settingsPageLink;
  settingsPageLink = null;
  return p;
}

/** the Mate view's panel this page was opened for (once) */
export function takeMatePanelLink(): ReturnType<typeof matePanelOf> {
  const l = matePanelLink;
  matePanelLink = null;
  return l;
}

function current(): Loc {
  const { view, settingsTab } = useUIStore.getState();
  const st = useStudio.getState();
  return {
    view,
    session: view === "chat" ? useSessionStore.getState().activeId : null,
    tab: view === "settings" ? settingsTab : null,
    // the Mate Create studio: its own screen in the Mate view (a draft, or an existing mate's avatar)
    ...(view === "mate" && st.open && st.mateId
      ? { studio: { kind: st.kind, mate: st.mateId, ...(st.kind === "avatar" && st.projectId ? { project: st.projectId } : {}) } }
      : {}),
  };
}

function rememberCurrentConversation() {
  const loc = current();
  if (loc.view === "chat" && loc.session) rememberConversation({ kind: "chat", id: loc.session });
  if (loc.view === "mate" && !loc.studio) {
    const id = useMateStore.getState().activeId;
    if (id) rememberConversation({ kind: "mate", id });
  }
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
/** `create=new` (a deep link: make a draft): the draft's address replaces that entry — back never makes another */
let replaceNext = false;

function apply(loc: Loc) {
  applying = true;
  try {
    const ss = useSessionStore.getState();
    if (loc.view === "chat" && ss.activeId !== loc.session) ss.setActive(loc.session);
    const ui = useUIStore.getState();
    if (loc.view === "settings") {
      if (ui.view !== "settings" || ui.settingsTab !== loc.tab || loc.anchor) ui.openSettings(loc.tab, loc.anchor ?? null);
    } else if (ui.view !== loc.view) ui.setView(loc.view);
    if (loc.view === "mate") {
      const st = useStudio.getState();
      const s = loc.studio;
      if (!s) {
        if (st.open) st.close();
      } else if (s.kind === "create") {
        if (s.mate === "new") {
          if (!st.starting) {
            replaceNext = true;
            void st.startNew().finally(() => {
              replaceNext = false;
            });
          }
        } else if (!st.open || st.kind !== "create" || st.mateId !== s.mate) st.openCreate(s.mate);
      } else if (!st.open || st.kind !== "avatar" || st.mateId !== s.mate || (s.project ?? null) !== (st.projectId ?? null)) {
        st.openAvatar(s.mate, s.project ?? null);
      }
    }
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
  const saved = startupConversation(window.location.search, readLastConversation());
  if (saved?.kind === "mate") useMateStore.getState().setActive(saved.id);
  const start = saved ? conversationLocation(saved) : fromUrl();
  if (start) apply(start);
  rememberCurrentConversation();
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
  // (`user`: a change the user made — never mistaken for the app settling on its first screen while starting)
  const onChange = (user = false) => {
    if (applying) return;
    rememberCurrentConversation();
    const next = urlOf(current());
    if (next === here()) return;
    const s = navState();
    if (replaceNext) {
      replaceNext = false;
      window.history.replaceState(window.history.state, "", next);
    } else if (!user && Date.now() < bootUntil && navDepth() === 0 && s && !s.guard) window.history.replaceState(s, "", next);
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
  // Selecting a different mate does not change the view's URL, but must restore that mate next time.
  useMateStore.subscribe((s, prev) => s.activeId !== prev.activeId && useUIStore.getState().view === "mate" && onChange());
  // the studio opening / closing / switching drafts or projects (in the Mate view)
  useStudio.subscribe(
    (s, prev) =>
      (s.open !== prev.open || s.kind !== prev.kind || s.mateId !== prev.mateId || s.projectId !== prev.projectId) &&
      useUIStore.getState().view === "mate" &&
      onChange(true),
  );

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
    rememberCurrentConversation();
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
