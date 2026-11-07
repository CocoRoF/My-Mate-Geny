/** Outfits: her wardrobe. What she has on changes at once, the way the Wear button in her settings does it. */
import { useState } from "react";
import { DEFAULT_OUTFIT, wearOutfit, type Mate, type OutfitCard } from "../../../api/mates";
import { useT } from "../../../i18n";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import StageWindow from "./StageWindow";

export default function OutfitsWindow({ mate, phone, onClose, onManage }: { mate: Mate; phone: boolean; onClose: () => void; onManage: () => void }) {
  const t = useT();
  const upsert = useMateStore((s) => s.upsert);
  const worn = mate.outfits?.worn ?? DEFAULT_OUTFIT;
  const items = (mate.outfits?.items ?? []).filter((c) => c.kind !== "none" || c.locked);
  const [picked, setPicked] = useState(worn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = items.find((c) => c.id === picked);
  const nameOf = (c: OutfitCard) => (c.id === DEFAULT_OUTFIT ? t("mateSettings.outfitDefault") : c.name);
  const wear = async () => {
    if (!card) return;
    setBusy(true);
    setError(null);
    try {
      upsert(await wearOutfit(mate.id, card.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <StageWindow title={t("stage.outfitsTitle")} sub={t("stage.outfitsSub", { name: mate.name })} icon="shirt" phone={phone} onClose={onClose} testId="stage-outfits">
      <div className="grid grid-cols-3 gap-2 min-[520px]:grid-cols-4" data-testid="stage-outfit-grid">
        {items.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setPicked(c.id)}
            aria-pressed={c.id === picked}
            className={`relative flex min-w-0 flex-col overflow-hidden rounded-xl border text-left transition ${c.id === picked ? "border-violet ring-1 ring-violet/60" : "border-white/10"} bg-white/[0.04]`}
            data-testid="stage-outfit"
            data-outfit={c.id}
            data-locked={!!c.locked}
            data-worn={c.id === worn}
          >
            <span className="relative block aspect-[4/5] w-full overflow-hidden bg-[radial-gradient(ellipse_at_50%_100%,rgba(255,255,255,.08),transparent_75%)]">
              {c.locked ? (
                <span className="absolute inset-0 grid place-items-center text-content-faint">
                  <span className="flex flex-col items-center gap-1">
                    <Icon name="lock" size={18} />
                    <span className="text-[11px] tabular-nums">{t("mateSettings.outfitLockedTile", { n: c.locked.affinity })}</span>
                  </span>
                </span>
              ) : c.home ? (
                <img src={c.home} alt="" className="absolute inset-0 h-full w-full object-contain object-bottom" loading="lazy" draggable={false} />
              ) : null}
              {c.id === worn && <span className="absolute left-1.5 top-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white">{t("stage.wearing")}</span>}
            </span>
            <span className="truncate px-2 py-1.5 text-[11.5px] font-medium text-content">{nameOf(c)}</span>
          </button>
        ))}
      </div>
      {card && (
        <div className="flex items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.04] p-3" data-testid="stage-outfit-detail">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-content">{nameOf(card)}</p>
            <p className="line-clamp-2 text-[11.5px] leading-snug text-content-faint">
              {card.locked ? t("mateSettings.outfitLockedHint", { n: card.locked.affinity, now: mate.relation?.affinity ?? 0 }) : card.note || t("stage.outfitNoNote")}
            </p>
          </div>
          {card.locked ? null : card.id === worn ? (
            <span className="shrink-0 text-[12px] text-content-faint">{t("stage.wearing")}</span>
          ) : (
            <button type="button" className="btn-primary shrink-0 !py-1.5 text-[12.5px]" disabled={busy} onClick={() => void wear()} data-testid="stage-outfit-wear">
              {busy && <Icon name="spinner" size={13} spin />} {t("stage.wear")}
            </button>
          )}
        </div>
      )}
      {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
      <button type="button" className="btn-ghost mx-auto block !py-1 text-[12px] text-content-faint" onClick={onManage} data-testid="stage-outfit-manage">
        {t("stage.outfitManage")}
      </button>
    </StageWindow>
  );
}
