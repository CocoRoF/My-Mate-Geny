import { useEffect, useState } from "react";
import Icon, { type IconName } from "../ui/Icon";
import { onAdminTab, takeAdminTab, type AdminTab } from "./adminTab";
import LogsPanel from "./LogsPanel";
import SecurityPanel from "./SecurityPanel";
import SystemPanel from "./SystemPanel";
import { useT, type MsgKey } from "../../i18n";
import ScrollRow from "../ui/ScrollRow";

type Tab = AdminTab;

const TABS: { id: Tab; label: MsgKey; icon: IconName }[] = [
  { id: "logs", label: "admin.tabLogs", icon: "warning" },
  { id: "system", label: "admin.tabSystem", icon: "activity" },
  { id: "security", label: "admin.tabSecurity", icon: "shield" },
];

export default function AdminView() {
  const t = useT();
  const [tab, setTab] = useState<Tab>(() => takeAdminTab() || "logs");
  useEffect(() => onAdminTab(setTab), []);
  return (
    // (Settings → Admin: the tab's title and intro are Settings')
    <div>
      <div className={tab === "system" ? "" : "max-w-4xl"}>
        <ScrollRow className="mb-5 gap-1.5 border-b border-border" role="tablist" watch={tab}>
          {TABS.map((tb) => (
            <button
              key={tb.id}
              role="tab"
              aria-selected={tab === tb.id}
              onClick={() => setTab(tb.id)}
              className={`-mb-px shrink-0 border-b-2 px-4 py-2 text-sm font-medium transition inline-flex items-center gap-2 ${
                tab === tb.id ? "border-accent text-content" : "border-transparent text-content-dim hover:text-content"
              }`}
            >
              <Icon name={tb.icon} size={15} className={tab === tb.id ? "text-accent" : "text-content-faint"} />
              {t(tb.label)}
            </button>
          ))}
        </ScrollRow>
        {tab === "logs" && <LogsPanel />}
        {tab === "system" && <SystemPanel />}
        {tab === "security" && <SecurityPanel />}
      </div>
    </div>
  );
}
