/** Mate settings: Profile · Avatar · Language model · Voice · Memory · Desktop (desktop app only) · Danger zone. */
import { useState } from "react";
import type { Mate } from "../../../api/mates";
import type { MateConversation } from "../../../mate/useMateConversation";
import { desktopMate } from "../../../mate/desktop";
import Icon from "../../ui/Icon";
import { BuiltinBadge } from "../MateStage";
import ProfileTab from "./ProfileTab";
import AvatarTab from "./AvatarTab";
import ModelTab from "./ModelTab";
import VoiceTab from "./VoiceTab";
import MemoryTab from "./MemoryTab";
import DesktopTab from "./DesktopTab";
import DangerTab from "./DangerTab";

type Tab = "profile" | "avatar" | "model" | "voice" | "memory" | "desktop" | "danger";

export default function MateSettings({ mate, conv, onClose }: { mate: Mate; conv: MateConversation; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("profile");
  const tabs: { id: Tab; label: string }[] = [
    { id: "profile", label: "Profile" },
    { id: "avatar", label: "Avatar" },
    { id: "model", label: "Language model" },
    { id: "voice", label: "Voice" },
    { id: "memory", label: "Memory" },
    ...(desktopMate() ? [{ id: "desktop" as Tab, label: "Desktop" }] : []),
    { id: "danger", label: "Danger zone" },
  ];
  return (
    <div className="flex h-full flex-col" data-testid="mate-settings">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon name="settings" size={15} className="text-content-faint" />
        <h2 className="min-w-0 truncate text-[14px] font-semibold">{mate.name} — settings</h2>
        <BuiltinBadge mate={mate} />
        <span className="flex-1" />
        <button onClick={onClose} className="btn-ghost !px-2" aria-label="Close settings" data-testid="mate-settings-close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-border/70 px-3 py-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`nav-tab shrink-0 whitespace-nowrap !py-1 !text-[12.5px] ${t.id === "danger" ? "data-[active=true]:!text-danger" : ""}`}
            data-active={tab === t.id}
            onClick={() => setTab(t.id)}
            data-testid={`mate-tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-safe">
        <div className="mx-auto max-w-xl space-y-4 pb-6">
          {/* key: a different mate starts from its own values */}
          {tab === "profile" && <ProfileTab key={mate.id} mate={mate} />}
          {tab === "avatar" && <AvatarTab key={mate.id} mate={mate} conv={conv} />}
          {tab === "model" && <ModelTab key={mate.id} mate={mate} />}
          {tab === "voice" && <VoiceTab key={mate.id} mate={mate} conv={conv} />}
          {tab === "memory" && <MemoryTab key={mate.id} mate={mate} />}
          {tab === "desktop" && <DesktopTab key={mate.id} mate={mate} />}
          {tab === "danger" && <DangerTab key={mate.id} mate={mate} onDeleted={onClose} />}
        </div>
      </div>
    </div>
  );
}
