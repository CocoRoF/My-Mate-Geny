import { useEffect } from "react";
import Sidebar from "./components/layout/Sidebar";
import ChatView from "./components/chat/ChatView";
import ProvidersView from "./components/providers/ProvidersView";
import ConnectionsView from "./components/connections/ConnectionsView";
import { useUIStore } from "./stores/uiStore";
import { useProviderStore } from "./stores/providerStore";
import { useConnectionStore } from "./stores/connectionStore";
import { useSessionStore } from "./stores/sessionStore";

export default function App() {
  const view = useUIStore((s) => s.view);
  const loadProviders = useProviderStore((s) => s.load);
  const loadConnections = useConnectionStore((s) => s.load);
  const loadSessions = useSessionStore((s) => s.load);

  useEffect(() => {
    loadProviders();
    loadConnections();
    loadSessions();
  }, [loadProviders, loadConnections, loadSessions]);

  return (
    <div className="h-screen flex overflow-hidden text-content">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-hidden">
        {view === "chat" && <ChatView />}
        {view === "providers" && <ProvidersView />}
        {view === "connections" && <ConnectionsView />}
      </main>
    </div>
  );
}
