/**
 * Mate settings (this mate only): Profile · Conversation style · Avatar and outfits · Language model · Voice · Screen · Danger zone.
 * Memory and relationship management live in the header's heart panel.
 * App-wide things (voice service keys / URLs, the Live2D runtime, the desktop app, the default mate) are in Global
 * settings — opened from here ("Global settings", "Set up in Global settings") in place of this panel.
 */
import { useEffect, useRef, useState } from "react";
import type { Mate } from "../../../api/mates";
import { useBackHandler } from "../../../lib/back";
import { useCenteredChild } from "../../../lib/scrollRow";
import type { MateConversation } from "../../../mate/useMateConversation";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { BuiltinBadge } from "../MateStage";
import ProfileTab from "./ProfileTab";
import StyleTab from "./StyleTab";
import AvatarTab from "./AvatarTab";
import ModelTab from "./ModelTab";
import VoiceTab from "./VoiceTab";
import { SaveBarSlot } from "./ui";
import ScreenTab from "./ScreenTab";
import ProactiveTab from "./ProactiveTab";
import DangerTab from "./DangerTab";
import GlobalSettings from "./GlobalSettings";
import { useT, type MsgKey } from "../../../i18n";

export type Tab = "profile" | "style" | "avatar" | "model" | "voice" | "proactive" | "screen" | "danger";

const TABS: { id: Tab; label: MsgKey }[] = [
  { id: "profile", label: "mateSettings.tabProfile" },
  { id: "style", label: "mateSettings.tabStyle" },
  { id: "avatar", label: "mateSettings.tabAvatar" },
  { id: "model", label: "mateSettings.modelTitle" },
  { id: "voice", label: "mateSettings.voiceVoice" },
  { id: "proactive", label: "screen.proactiveTitle" },
  { id: "screen", label: "mateSettings.tabScreen" },
  { id: "danger", label: "mateSettings.tabDanger" },
];

export default function MateSettings({ mate, conv, onClose, initialTab = "profile" }: { mate: Mate; conv: MateConversation; onClose: () => void; initialTab?: Tab }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [saveSlot, setSaveSlot] = useState<HTMLDivElement | null>(null);
  const tabs = useCenteredChild<HTMLDivElement>(TABS.findIndex((x) => x.id === tab));
  // another tab starts at its top, not where the last one was scrolled to
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo(0, 0);
  }, [tab]);
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
      <div ref={tabs} className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto overscroll-x-contain border-b border-border/70 px-3 py-2" role="tablist">
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
      <SaveBarSlot.Provider value={saveSlot}>
      <div ref={body} className="fit-fields min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-safe">
        <div className="mx-auto max-w-xl space-y-4 pb-6">
          {/* key: a different mate starts from its own values */}
          {tab === "profile" && <ProfileTab key={mate.id} mate={mate} onOpenStyle={() => setTab("style")} />}
          {tab === "style" && <StyleTab key={mate.id} mate={mate} conv={conv} />}
          {tab === "avatar" && <AvatarTab key={mate.id} mate={mate} conv={conv} />}
          {tab === "model" && <ModelTab key={mate.id} mate={mate} />}
          {tab === "voice" && <VoiceTab key={mate.id} mate={mate} conv={conv} />}
          {tab === "proactive" && <ProactiveTab key={mate.id} mate={mate} />}
          {tab === "screen" && <ScreenTab key={mate.id} mate={mate} sid={conv.sessionId} />}
          {tab === "danger" && <DangerTab key={mate.id} mate={mate} onDeleted={onClose} />}
        </div>
      </div>
      </SaveBarSlot.Provider>
      <div ref={setSaveSlot} className="shrink-0" />
    </div>
  );
}
