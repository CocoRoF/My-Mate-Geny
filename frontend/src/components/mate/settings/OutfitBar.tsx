/**
 * Her wardrobe (docs/mate.md "Outfits"): her default set and the outfits the user added. Adding one only takes a name: it
 * starts empty and is filled below like any avatar, with AI or with files. Picking one shows its settings; Wear puts the
 * whole set on her at once, in every window. A bundled outfit may wait for her affinity: until then it only says so.
 */
import { useState } from "react";
import { addOutfit, DEFAULT_OUTFIT, deleteOutfit, patchOutfit, wearOutfit, type Mate, type OutfitCard } from "../../../api/mates";
import { useT } from "../../../i18n";
import { useMateStore } from "../../../stores/mateStore";
import AlignedBox from "../../../mate/avatar/AlignedBox";
import Icon from "../../ui/Icon";
import { ErrorLine, ProgressBar, Section, Toggle } from "./ui";
import { confirmDialog } from "../../ui/ConfirmDialog";

export default function OutfitBar({ mate, selected, onSelect }: { mate: Mate; selected: string; onSelect: (id: string) => void }) {
  const t = useT();
  const upsert = useMateStore((s) => s.upsert);
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const worn = mate.outfits?.worn ?? DEFAULT_OUTFIT;
  const items = mate.outfits?.items ?? [];
  const card = items.find((c) => c.id === selected);
  const baseCard = items.find((c) => c.id === DEFAULT_OUTFIT);
  const nameOf = (c: OutfitCard) => (c.id === DEFAULT_OUTFIT ? t("mateSettings.outfitDefault") : c.name);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const name = (adding ?? "").trim();
    if (!name) return;
    void run(async () => {
      const r = await addOutfit(mate.id, name);
      upsert(r.mate);
      setAdding(null);
      onSelect(r.id);
    });
  };
  const rename = () => {
    const name = (renaming ?? "").trim();
    setRenaming(null);
    if (name && card && name !== card.name) void run(async () => upsert(await patchOutfit(mate.id, card.id, { name })));
  };
  const remove = async () => {
    if (!card || !(await confirmDialog({ body: t("mateSettings.outfitDeleteConfirm", { name: card.name }), confirmLabel: t("mateSettings.outfitDelete"), danger: true }))) return;
    void run(async () => {
      upsert(await deleteOutfit(mate.id, card.id));
      onSelect(DEFAULT_OUTFIT);
    });
  };

  return (
    <Section title={t("mateSettings.outfitWardrobe")} hint={t("mateSettings.outfitWardrobeHint")} testId="outfit-wardrobe">
      <div className="grid grid-cols-3 gap-2 min-[480px]:grid-cols-4">
        {items.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`flex min-w-0 flex-col overflow-hidden rounded-xl border text-left transition ${c.id === selected ? "border-accent/70 ring-1 ring-accent/40" : "border-border/70 hover:border-border-strong"}`}
            onClick={() => onSelect(c.id)}
            aria-pressed={c.id === selected}
            data-testid="outfit-tile"
            data-outfit={c.id}
            data-worn={c.id === worn}
            data-empty={c.kind === "none" && !c.locked}
            data-locked={!!c.locked}
          >
            <span className="relative block aspect-[4/5] w-full overflow-hidden bg-[radial-gradient(ellipse_at_50%_100%,rgb(var(--c-surface-3)),transparent_75%)]">
              {c.locked ? (
                <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-content-faint">
                  <Icon name="lock" size={18} />
                  <span className="text-[11px] tabular-nums">{t("mateSettings.outfitLockedTile", { n: c.locked.affinity })}</span>
                </span>
              ) : c.home ? (
                // (her default set's shape, her face where it is there: at a glance, only the clothes differ)
                baseCard?.home && baseCard.kind !== "none" ? (
                  <AlignedBox set={c} to={baseCard}>
                    <img src={c.home} alt="" loading="lazy" className="mate-fit" />
                  </AlignedBox>
                ) : (
                  <img src={c.home} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain object-bottom" />
                )
              ) : (
                // (a Live2D / LivLiv set has a body but no picture to show here: it isn't empty)
                <span className="absolute inset-0 grid place-items-center text-[11px] text-content-faint">
                  {c.kind === "none" ? t("mateSettings.outfitEmpty") : c.kind === "live2d" ? "Live2D" : c.kind === "livliv" ? "LivLiv" : t("mateSettings.outfitNoPicture")}
                </span>
              )}
              {c.id === worn && (
                <span className="pill absolute left-1 top-1 bg-accent !px-1.5 text-[10px] text-white">
                  <Icon name="check" size={9} /> {t("mateSettings.outfitWorn")}
                </span>
              )}
            </span>
            <span className="truncate border-t border-border/60 px-2 py-1 text-[12px] font-medium">{nameOf(c)}</span>
          </button>
        ))}
        {adding === null && (
          <button
            type="button"
            className="flex min-h-[96px] flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border text-[12px] text-content-dim transition hover:border-accent/50 hover:text-content"
            onClick={() => setAdding("")}
            data-testid="outfit-add"
          >
            <Icon name="plus" size={16} /> {t("mateSettings.outfitAdd")}
          </button>
        )}
      </div>
      {adding !== null && (
        <div className="flex gap-2" data-testid="outfit-add-form">
          <input
            autoFocus
            className="field min-w-0 flex-1 text-[13px]"
            maxLength={40}
            placeholder={t("mateSettings.outfitAddName")}
            aria-label={t("mateSettings.outfitAddName")}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
              if (e.key === "Escape") setAdding(null);
            }}
            data-testid="outfit-add-name"
          />
          <button className="btn-primary shrink-0" disabled={busy || !adding.trim()} onClick={add} data-testid="outfit-add-ok">
            {t("mateSettings.outfitAddOk")}
          </button>
          <button className="btn-ghost shrink-0 !px-2" onClick={() => setAdding(null)} aria-label={t("common.cancel")}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {card && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-3/40 px-3 py-2" data-testid="outfit-selected">
          <div className="min-w-0 flex-1">
            {renaming !== null ? (
              <input
                autoFocus
                className="field !py-0.5 text-[13px]"
                maxLength={40}
                value={renaming}
                aria-label={t("mateSettings.outfitRename")}
                onChange={(e) => setRenaming(e.target.value)}
                onBlur={rename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
                data-testid="outfit-rename-input"
              />
            ) : (
              <div className="truncate text-[13px] font-medium">{nameOf(card)}</div>
            )}
            {card.locked && (
              <div className="mt-1 space-y-1" data-testid="outfit-locked-hint">
                <p className="text-[11px] leading-relaxed text-content-faint">
                  {t("mateSettings.outfitLockedHint", { n: card.locked.affinity, now: mate.relation?.affinity ?? 0 })}
                  {(!mate.relation?.enabled || mate.relation.paused) && ` ${t("mateSettings.outfitLockedStopped")}`}
                </p>
                <ProgressBar value={(mate.relation?.affinity ?? 0) / card.locked.affinity} />
              </div>
            )}
            <div className={`truncate text-[11px] text-content-faint ${card.locked ? "hidden" : ""}`}>
              {card.kind === "none" && card.id !== DEFAULT_OUTFIT
                ? t("mateSettings.outfitEmptyHint")
                : card.kind === "video" || card.kind === "photo"
                  ? t("mateSettings.outfitMeta", { clips: card.clips, stills: card.stills })
                  : ""}
            </div>
          </div>
          {card.id !== DEFAULT_OUTFIT && !card.locked && renaming === null && (
            <>
              <button className="btn-ghost !px-1.5 !py-1" onClick={() => setRenaming(card.name)} aria-label={t("mateSettings.outfitRename")} title={t("mateSettings.outfitRename")} data-testid="outfit-rename">
                <Icon name="pencil" size={13} />
              </button>
              <button className="btn-ghost !px-1.5 !py-1 text-danger hover:bg-danger/10 hover:!text-danger" onClick={() => void remove()} aria-label={t("mateSettings.outfitDelete")} title={t("mateSettings.outfitDelete")} data-testid="outfit-delete">
                <Icon name="trash" size={13} />
              </button>
            </>
          )}
          {card.locked ? null : card.id === worn ? (
            <span className="pill bg-success/15 text-[11px] text-success" data-testid="outfit-is-worn">
              <Icon name="check" size={10} /> {t("mateSettings.outfitWorn")}
            </span>
          ) : (
            <button
              className="btn-primary !py-1 text-[12.5px]"
              disabled={busy || (card.kind === "none" && card.id !== DEFAULT_OUTFIT)}
              onClick={() => void run(async () => upsert(await wearOutfit(mate.id, card.id)))}
              data-testid="outfit-wear"
            >
              {busy ? <Icon name="spinner" size={13} spin /> : <Icon name="check" size={13} />} {t("mateSettings.outfitWear")}
            </button>
          )}
        </div>
      )}
      <ErrorLine text={error} />
      {items.length > 1 && (
        <Toggle
          on={mate.prefs?.self_outfit !== "off"}
          onChange={(on) => void run(async () => void (await useMateStore.getState().patch(mate.id, { prefs: { self_outfit: on ? "auto" : "off" } })))}
          label={t("mateSettings.outfitSelf")}
          hint={t("mateSettings.outfitSelfHint")}
          testId="outfit-self"
        />
      )}
    </Section>
  );
}
