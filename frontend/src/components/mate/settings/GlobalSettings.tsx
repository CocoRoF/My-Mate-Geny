/**
 * Global (app-wide) Mate settings — configured once, shared by every mate: voice services (keys / URLs, each
 * verified), the Live2D runtime, the desktop app (this computer; only inside the desktop app) and defaults.
 * Per-mate choices (which voice, which model…) are in Mate settings, which only offer what works here.
 *
 * Opened from the Mate view's header, and from Mate settings ("Set up in Global settings"): `useMateStore().openGlobal(section)`.
 */
import { useEffect } from "react";
import { useMateStore, type GlobalSection } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import DefaultsPanel from "./global/DefaultsPanel";
import DesktopPanel from "./global/DesktopPanel";
import Live2DPanel from "./global/Live2DPanel";
import ProvidersPanel from "./global/ProvidersPanel";
import { useT, type MsgKey } from "../../../i18n";

export default function GlobalSettings({ onClose, section }: { onClose: () => void; section?: GlobalSection }) {
  // the section lives in the store: "Set up in Global settings" (openGlobal(section)) jumps there while open
  const t = useT();
  const tab = useMateStore((s) => s.globalSection);
  useEffect(() => {
    if (section) useMateStore.setState({ globalSection: section });
  }, [section]);
  const tabs: { id: GlobalSection; label: MsgKey }[] = [
    { id: "voice", label: "mateSettings.provTitle" },
    { id: "live2d", label: "mateSettings.tabLive2d" },
    { id: "desktop", label: "mateSettings.deskTitle" },
    { id: "defaults", label: "mateSettings.tabDefaults" },
  ];
  const pick = (t: GlobalSection) => useMateStore.setState({ globalSection: t });
  return (
    <div className="flex h-full flex-col" data-testid="mate-global-settings">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon name="settings" size={15} className="text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold">{t("mateSettings.globalTitle")}</h2>
          <p className="truncate text-[11px] text-content-faint">{t("mateSettings.globalSub")}</p>
        </div>
        <button onClick={onClose} className="btn-ghost !px-2" aria-label={t("mateSettings.globalClose")} data-testid="mate-global-close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-border/70 px-3 py-2" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            className="nav-tab shrink-0 whitespace-nowrap !py-1 !text-[12.5px]"
            data-active={tab === x.id}
            onClick={() => pick(x.id)}
            data-testid={`mate-global-tab-${x.id}`}
          >
            {t(x.label)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-safe">
        <div className="mx-auto max-w-xl space-y-4 pb-6">
          {tab === "voice" && <ProvidersPanel />}
          {tab === "live2d" && <Live2DPanel />}
          {tab === "desktop" && <DesktopPanel />}
          {tab === "defaults" && <DefaultsPanel />}
        </div>
      </div>
    </div>
  );
}
