/**
 * Mate settings (docs/settings.md): Relationship and memory (this mate) · Common (every mate: the same as Settings →
 * 메이트 — her on the desktop, reading aloud, speaking first, screen sharing, Live2D; done by the mate picked here) ·
 * Delete. Who she is — profile, conversation style, temperament, look and outfits, voice, language model — is set in
 * 메이트 편집 (the studio, studio/MateStudio), where she was made: the card on top opens it. The header's 가이드 opens
 * her step-by-step guide again (guide/MateGuide).
 */
import { useEffect, useRef, useState } from "react";
import type { Mate } from "../../../api/mates";
import Icon from "../../ui/Icon";
import ScrollRow from "../../ui/ScrollRow";
import { BuiltinBadge } from "../MateStage";
import { SaveBarSlot } from "./ui";
import BondTab from "./BondTab";
import DangerTab from "./DangerTab";
import MateTab from "../../settings/MateTab";
import { openAppSettings } from "../../../lib/openAppSettings";
import { useT, type MsgKey } from "../../../i18n";

export type Tab = "bond" | "common" | "danger";

const TABS: { id: Tab; label: MsgKey }[] = [
  { id: "bond", label: "mateSettings.tabBond" },
  // (what holds for every mate — the same as Settings → 메이트, here too)
  { id: "common", label: "mateSettings.tabCommon" },
  { id: "danger", label: "mateSettings.tabDanger" },
];

/** who she is is changed where she was made: a card that opens 메이트 편집 */
function EditCard({ mate, onEdit }: { mate: Mate; onEdit: () => void }) {
  const t = useT();
  return (
    <button type="button" onClick={onEdit} className="flex w-full items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/40 px-3.5 py-3 text-left transition hover:bg-accent-soft/70" data-testid="mate-settings-edit">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
        <Icon name="pencil" size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-semibold text-content">{t("mateSettings.editCard", { name: mate.name })}</span>
        <span className="block text-[11.5px] text-content-dim">{t("mateSettings.editCardSub")}</span>
      </span>
      <Icon name="chevron" size={15} className="shrink-0 text-content-faint" />
    </button>
  );
}

export default function MateSettings({ mate, onClose, initialTab = "bond", onGuide, onEdit }: { mate: Mate; onClose: () => void; initialTab?: Tab; onGuide?: () => void; onEdit: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [saveSlot, setSaveSlot] = useState<HTMLDivElement | null>(null);
  // another tab starts at its top, not where the last one was scrolled to
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo(0, 0);
  }, [tab]);

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
        {onGuide && (
          <button onClick={onGuide} className="btn-ghost shrink-0 !px-2.5 !py-1 text-[12px]" title={t("guide.openTitle", { name: mate.name })} data-testid="mate-guide-open">
            <Icon name="book" size={13} /> <span className="hidden min-[400px]:inline">{t("guide.open")}</span>
          </button>
        )}
        <button
          onClick={() => openAppSettings("mate")}
          className="btn-ghost shrink-0 !px-2.5 !py-1 text-[12px]"
          title={t("mateSettings.appSettingsHint")}
          data-testid="mate-open-app-settings"
        >
          <Icon name="external" size={13} /> <span className="hidden min-[400px]:inline">{t("mateSettings.appSettings")}</span>
        </button>
        <button onClick={onClose} className="btn-ghost !px-2" aria-label={t("mateSettings.closeSettings")} data-testid="mate-settings-close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <ScrollRow className="shrink-0 gap-1 border-b border-border/70 px-3 py-2" role="tablist" watch={tab}>
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
      </ScrollRow>
      <SaveBarSlot.Provider value={saveSlot}>
      <div ref={body} className="fit-fields scrollbar-stable min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-safe">
        <div className="mx-auto max-w-xl space-y-4 pb-6">
          {tab !== "common" && <EditCard mate={mate} onEdit={onEdit} />}
          {/* key: a different mate starts from its own values */}
          {tab === "bond" && <BondTab key={mate.id} mate={mate} />}
          {tab === "common" && <MateTab />}
          {tab === "danger" && <DangerTab key={mate.id} mate={mate} onDeleted={onClose} />}
        </div>
      </div>
      </SaveBarSlot.Provider>
      <div ref={setSaveSlot} className="shrink-0" />
    </div>
  );
}
