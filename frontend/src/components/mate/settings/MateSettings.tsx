/**
 * Mate settings (this mate only): Profile · Conversation style · Avatar · Language model · Voice · Memory · Relationship · Danger zone.
 * App-wide things (voice service keys / URLs, the Live2D runtime, the desktop app, the default mate) are in Global
 * settings — opened from here ("Global settings", "Set up in Global settings") in place of this panel.
 */
import { useEffect, useState } from "react";
import type { Mate } from "../../../api/mates";
import { useBackHandler } from "../../../lib/back";
import type { MateConversation } from "../../../mate/useMateConversation";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { BuiltinBadge } from "../MateStage";
import ProfileTab from "./ProfileTab";
import StyleTab from "./StyleTab";
import AvatarTab from "./AvatarTab";
import ModelTab from "./ModelTab";
import VoiceTab from "./VoiceTab";
import MemoryTab from "./MemoryTab";
import RelationshipTab from "./RelationshipTab";
import DangerTab from "./DangerTab";
import GlobalSettings from "./GlobalSettings";
import { useT, type MsgKey } from "../../../i18n";

export type Tab = "profile" | "style" | "avatar" | "model" | "voice" | "memory" | "relation" | "danger";

const TABS: { id: Tab; label: MsgKey }[] = [
  { id: "profile", label: "mateSettings.tabProfile" },
  { id: "style", label: "mateSettings.tabStyle" },
  { id: "avatar", label: "mateSettings.tabAvatar" },
  { id: "model", label: "mateSettings.modelTitle" },
  { id: "voice", label: "mateSettings.voiceVoice" },
  { id: "memory", label: "mateSettings.memTitle" },
  { id: "relation", label: "mateSettings.relTitle" },
  { id: "danger", label: "mateSettings.tabDanger" },
];

export default function MateSettings({ mate, conv, onClose, initialTab = "profile" }: { mate: Mate; conv: MateConversation; onClose: () => void; initialTab?: Tab }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(initialTab);
  const globalOpen = useMateStore((s) => s.globalOpen);
  const closeGlobal = useMateStore((s) => s.closeGlobal);
  useBackHandler(globalOpen, closeGlobal);
  // the voice tab needs to know what Global settings has working; refresh it whenever settings open
  useEffect(() => {
    void useMateStore.getState().loadProviders();
  }, []);
  // closing the mate settings closes a Global settings opened from them
  useEffect(() => () => useMateStore.getState().closeGlobal(), []);

  if (globalOpen) return <GlobalSettings onClose={closeGlobal} />;

  return (
    <div className="flex h-full flex-col" data-testid="mate-settings">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon name="settings" size={15} className="text-content-faint" />
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-center gap-2 text-[14px] font-semibold">
            <span className="truncate">{mate.name}</span>
            <BuiltinBadge mate={mate} />
          </h2>
          <p className="truncate text-[11px] text-content-faint">{t("mateSettings.settingsSub")}</p>
        </div>
        <button
          onClick={() => useMateStore.getState().openGlobal()}
          className="btn-ghost shrink-0 !px-2.5 !py-1 text-[12px]"
          title={t("mateSettings.globalTitleHint")}
          data-testid="mate-open-global"
        >
          <Icon name="sparkles" size={13} /> <span className="hidden min-[400px]:inline">{t("mateSettings.globalTitle")}</span>
        </button>
        <button onClick={onClose} className="btn-ghost !px-2" aria-label={t("mateSettings.closeSettings")} data-testid="mate-settings-close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-border/70 px-3 py-2" role="tablist">
        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            className={`nav-tab shrink-0 whitespace-nowrap !py-1 !text-[12.5px] ${x.id === "danger" ? "data-[active=true]:!text-danger" : ""}`}
            data-active={tab === x.id}
            onClick={() => setTab(x.id)}
            data-testid={`mate-tab-${x.id}`}
          >
            {t(x.label)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-safe">
        <div className="mx-auto max-w-xl space-y-4 pb-6">
          {/* key: a different mate starts from its own values */}
          {tab === "profile" && <ProfileTab key={mate.id} mate={mate} />}
          {tab === "style" && <StyleTab key={mate.id} mate={mate} conv={conv} />}
          {tab === "avatar" && <AvatarTab key={mate.id} mate={mate} conv={conv} />}
          {tab === "model" && <ModelTab key={mate.id} mate={mate} />}
          {tab === "voice" && <VoiceTab key={mate.id} mate={mate} conv={conv} />}
          {tab === "memory" && <MemoryTab key={mate.id} mate={mate} />}
          {tab === "relation" && <RelationshipTab key={mate.id} mate={mate} />}
          {tab === "danger" && <DangerTab key={mate.id} mate={mate} onDeleted={onClose} />}
        </div>
      </div>
    </div>
  );
}
