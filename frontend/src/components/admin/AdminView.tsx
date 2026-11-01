import { useEffect, useState } from "react";
import Icon, { type IconName } from "../ui/Icon";
import { onAdminTab, takeAdminTab, type AdminTab } from "./adminTab";
import LogsPanel from "./LogsPanel";
import SecurityPanel from "./SecurityPanel";
import SystemPanel from "./SystemPanel";
import { useT, type MsgKey } from "../../i18n";

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
    <div className="h-full overflow-y-auto">
      <div className={`mx-auto ${tab === "system" ? "max-w-6xl" : "max-w-4xl"} px-3 sm:px-6 py-5 sm:py-8`}>
        <div className="flex items-center gap-2.5 mb-1">
          <Icon name="shield" size={20} className="text-accent" />
          <h1 className="text-lg font-semibold">{t("admin.title")}</h1>
        </div>
        <p className="text-sm text-content-dim mb-5">
          {t("admin.intro")}
        </p>
        <div className="flex gap-1.5 mb-5 border-b border-border">
          {TABS.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition inline-flex items-center gap-2 ${
                tab === tb.id ? "border-accent text-content" : "border-transparent text-content-dim hover:text-content"
              }`}
            >
              <Icon name={tb.icon} size={15} className={tab === tb.id ? "text-accent" : "text-content-faint"} />
              {t(tb.label)}
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
