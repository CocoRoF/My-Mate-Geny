import { useEffect } from "react";
import Sidebar from "./components/layout/Sidebar";
import ChatView from "./components/chat/ChatView";
import ProvidersView from "./components/providers/ProvidersView";
import ConnectionsView from "./components/connections/ConnectionsView";
import UsageView from "./components/usage/UsageView";
import AdminView from "./components/admin/AdminView";
import DownloadsView from "./components/downloads/DownloadsView";
import MobileTopBar from "./components/layout/MobileTopBar";
import { useUIStore } from "./stores/uiStore";
import { useProviderStore } from "./stores/providerStore";
import { useConnectionStore } from "./stores/connectionStore";
import { useSessionStore } from "./stores/sessionStore";
import { useConfigStore } from "./stores/configStore";

export default function App() {
  const view = useUIStore((s) => s.view);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebar = useUIStore((s) => s.setSidebar);
  const activeId = useSessionStore((s) => s.activeId);
  const loadProviders = useProviderStore((s) => s.load);
  const loadConnections = useConnectionStore((s) => s.load);
  const loadSessions = useSessionStore((s) => s.load);
  const loadConfig = useConfigStore((s) => s.load);

  useEffect(() => {
    loadProviders();
    loadConnections();
    loadSessions();
    loadConfig();
  }, [loadProviders, loadConnections, loadSessions, loadConfig]);

  const titles: Record<string, string> = {
    chat: "New chat", providers: "Providers", connections: "Connections", usage: "Usage", admin: "Admin", downloads: "Download",
  };

  return (
    <div className="h-[100dvh] flex overflow-hidden text-content">
      <div className="hidden md:flex">
        <Sidebar />
      </div>
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-[60] flex">
          <div className="absolute inset-0 bg-black/55 animate-fade-in" onClick={() => setSidebar(false)} />
          <div className="relative h-full w-[min(86vw,300px)] shadow-float animate-fade-in">
            <Sidebar />
          </div>
        </div>
      )}
      <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {/* chat with an open session has its own header */}
        {!(view === "chat" && activeId) && <MobileTopBar title={titles[view] || ""} />}
        <div className="flex-1 min-h-0">
          {view === "chat" && <ChatView />}
          {view === "providers" && <ProvidersView />}
          {view === "connections" && <ConnectionsView />}
          {view === "usage" && <UsageView />}
          {view === "admin" && <AdminView />}
          {view === "downloads" && <DownloadsView />}
        </div>
      </main>
    </div>
  );
}
