import { useEffect, useState } from "react";
import Icon, { type IconName } from "../ui/Icon";
import { onAdminTab, takeAdminTab, type AdminTab } from "./adminTab";
import LogsPanel from "./LogsPanel";
import SecurityPanel from "./SecurityPanel";
import SystemPanel from "./SystemPanel";

type Tab = AdminTab;

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "logs", label: "Error logs", icon: "warning" },
  { id: "system", label: "System", icon: "activity" },
  { id: "security", label: "Security", icon: "shield" },
];

export default function AdminView() {
  const [tab, setTab] = useState<Tab>(() => takeAdminTab() || "logs");
  useEffect(() => onAdminTab(setTab), []);
  return (
    <div className="h-full overflow-y-auto">
      <div className={`mx-auto ${tab === "system" ? "max-w-6xl" : "max-w-4xl"} px-3 sm:px-6 py-5 sm:py-8`}>
        <div className="flex items-center gap-2.5 mb-1">
          <Icon name="shield" size={20} className="text-accent" />
          <h1 className="text-lg font-semibold">Admin</h1>
        </div>
        <p className="text-sm text-content-dim mb-5">
          Everything that went wrong — provider failures, failed tools, crashes, rejected uploads, browser errors, login
          attempts — plus live system health.
        </p>
        <div className="flex gap-1.5 mb-5 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition inline-flex items-center gap-2 ${
                tab === t.id ? "border-accent text-content" : "border-transparent text-content-dim hover:text-content"
              }`}
            >
              <Icon name={t.icon} size={15} className={tab === t.id ? "text-accent" : "text-content-faint"} />
              {t.label}
            </button>
          ))}
        </div>
        {tab === "logs" && <LogsPanel />}
        {tab === "system" && <SystemPanel />}
        {tab === "security" && <SecurityPanel />}
      </div>
    </div>
  );
}
