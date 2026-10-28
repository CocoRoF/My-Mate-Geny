import { useUIStore, type View } from "../../stores/uiStore";
import { APP_VERSION } from "../../version";

const TABS: { id: View; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "providers", label: "Providers" },
  { id: "connections", label: "Connections" },
];

export default function Header() {
  const view = useUIStore((s) => s.view);
  const setView = useUIStore((s) => s.setView);
  return (
    <header className="flex items-center gap-4 px-4 h-12 border-b border-border bg-panel">
      <span className="font-semibold tracking-tight">
        hr<span className="text-accent">·</span>harnessor
      </span>
      <nav className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setView(t.id)}
            className={`px-3 py-1 rounded text-sm ${
              view === t.id ? "bg-accent/20 text-accent" : "text-gray-400 hover:text-gray-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <span className="ml-auto text-xs text-gray-500">v{APP_VERSION}</span>
    </header>
  );
}
