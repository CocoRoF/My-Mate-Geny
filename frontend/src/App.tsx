import { useMateStore } from "./stores/mateStore";
import { ScreenCaptureApproval } from "./components/composer/LocalScreenControls";
import { lazy, Suspense, useEffect, useState } from "react";
import Sidebar from "./components/layout/Sidebar";
import ChatView from "./components/chat/ChatView";
import MobileTopBar from "./components/layout/MobileTopBar";
import UpdateBanner from "./components/layout/UpdateBanner";
import DefaultPasswordBanner from "./components/admin/DefaultPasswordBanner";
import { useBackHandler } from "./lib/back";
import { installNav } from "./lib/nav";
import { useSessionSync } from "./hooks/useSessionSync";
import { useUIStore } from "./stores/uiStore";
import { useProviderStore } from "./stores/providerStore";
import { useConnectionStore } from "./stores/connectionStore";
import { useSessionStore } from "./stores/sessionStore";
import { useConfigStore } from "./stores/configStore";
import { useCliToolsStore } from "./stores/cliToolsStore";
import ErrorBoundary from "./components/ui/ErrorBoundary";
import TitleBar from "./components/layout/TitleBar";
import PageLoading from "./components/ui/Loading";
import { nativeWindow } from "./lib/nativeWindow";
import { useT, type MsgKey } from "./i18n";
import { installLanguageSync } from "./i18n/sync";
import { tabMeta } from "./components/settings/tabs";
import SetupAssistant, {setupCompleted} from "./components/setup/SetupAssistant";
import { fillLocation, fillTimezone } from "./stores/mateStore";

// Secondary views load on demand: the chat (first screen) stays light.
// (Providers, Connections, Usage, Admin and Download are Settings tabs, loaded with their tab — settings/SettingsView)
const MateView = lazy(() => import("./components/mate/MateView"));
const SettingsView = lazy(() => import("./components/settings/SettingsView"));

const TITLES: Record<string, MsgKey> = {
  mate: "nav.mate",
  chat: "nav.newChat",
  settings: "nav.settings",
};

export default function App() {
  const t = useT();
  const [setup,setSetup]=useState<boolean|null>(null);
  useEffect(()=>{void setupCompleted().then(done=>setSetup(!done));const reopen=()=>setSetup(true);window.addEventListener("geny:setup",reopen);return()=>window.removeEventListener("geny:setup",reopen);},[]);
  const view = useUIStore((s) => s.view);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebar = useUIStore((s) => s.setSidebar);
  const activeId = useSessionStore((s) => s.activeId);
  // Back closes the drawer first; screens are history entries (lib/nav.ts)
  useBackHandler(sidebarOpen, () => setSidebar(false));
  const loadProviders = useProviderStore((s) => s.load);
  const loadConnections = useConnectionStore((s) => s.load);
  const loadSessions = useSessionStore((s) => s.load);
  const loadConfig = useConfigStore((s) => s.load);
  useSessionSync(); // every device's session list follows server-pushed changes

  // Screens ↔ URL + history (lib/nav.ts): deep links (/?view=settings&tab=… — and the old /?view=downloads from
  // the desktop menu and update banners —, /?view=mate, /?view=chat&session=<id> from a mate's activity chip) open
  // their screen; back / forward move between screens and Settings tabs and never fall through to the login page.
  useEffect(() => {
    installNav();
    installLanguageSync(); // the account's language (every device follows a switch) — i18n/sync.ts
    fillTimezone(); // the mates' timezone from this browser, when none is set yet (not only once Mate is opened)
    fillLocation(); // and where the user is (her weather, their holidays), from this connection
  }, []);

  useEffect(() => {
    loadProviders();
    loadConnections();
    loadSessions();
    loadConfig();
    if(!useMateStore.getState().loaded) void useMateStore.getState().load();
    useCliToolsStore.getState().load(); // the Settings badge when a CLI update can be installed (lib/attention.ts)
  }, [loadProviders, loadConnections, loadSessions, loadConfig]);

  const title = setup ? t("setup.title") : TITLES[view] ? t(TITLES[view]) : "";
  const tab = tabMeta(useUIStore((s) => (s.view === "settings" ? s.settingsTab : null)));

  const sessionTitle = useSessionStore((s) => (s.activeId ? s.sessions.find((x) => x.id === s.activeId)?.title : undefined));
  const chrome = !!nativeWindow(); // the desktop app without a system title bar: ours on top (TitleBar)
  const context = setup ? t("setup.title") : view === "chat" ? sessionTitle || t("nav.newChat") : tab ? `${title} · ${t(tab.label)}` : title;

  const shell = (
    // the visible height: 100dvh, or what the keyboard leaves where the layout viewport doesn't shrink (lib/keyboard.ts)
    // (a phone on its side: no room for the sidebar, which opens as on a phone; its notch and bar are on the sides)
    <div className={`${chrome ? "min-h-0 flex-1" : "h-[var(--app-h,100dvh)]"} flex overflow-hidden pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-content`}>
      <div className="hidden md:flex [@media(max-height:500px)]:!hidden">
        <Sidebar />
      </div>
      {sidebarOpen && (
        <div className="md:hidden [@media(max-height:500px)]:!flex fixed inset-0 top-[var(--window-chrome-height,0px)] z-[60] flex" data-testid="sidebar-drawer">
          <div className="absolute inset-0 bg-scrim/55 animate-fade-in" onClick={() => setSidebar(false)} />
          <div className="relative h-full w-[min(86vw,300px)] shadow-float animate-fade-in">
            <Sidebar />
          </div>
        </div>
      )}
      <ScreenCaptureApproval />
      <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <UpdateBanner />
        <DefaultPasswordBanner />
        {/* chat with an open session, the Mate and Settings (its list / a tab with a back button) have their own header */}
        {(setup || (!(view === "chat" && activeId) && view !== "mate" && view !== "settings")) && <MobileTopBar title={title} />}
        {/* (a new screen fades in: keyed by the screen) */}
        <div key={view} className="flex-1 min-h-0 animate-fade-in">
          {/* one view failing (or its code gone after a deploy) never takes the sidebar with it */}
          <ErrorBoundary variant="view" resetKey={view}>
          <Suspense fallback={<PageLoading />}>
          {setup===null?<PageLoading/>:setup?<SetupAssistant onDone={()=>setSetup(false)}/>:<>
          {view === "mate" && <MateView />}
          {view === "chat" && <ChatView />}
          {view === "settings" && <SettingsView />}
          </>}
          </Suspense>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
  if (!chrome) return shell;
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden" data-testid="app-window">
      <TitleBar context={context} />
      {shell}
    </div>
  );
}

