/**
 * Outfits (docs/mate.md "Outfits"): her wardrobe. Each set is a whole avatar (base picture, expressions, motions); picking
 * one puts all of it on her at once, in every window. Her default set always stays. A new set is made in the studio: in a
 * conversation with the agent, or from a preset, each with the usual estimate and confirmation before any credit is spent.
 */
import { useCallback, useEffect, useState } from "react";
import { listProjects, type ProjectSummary } from "../../../api/avatar";
import { DEFAULT_OUTFIT, deleteOutfit, getOutfits, renameOutfit, wearOutfit, type Mate, type OutfitCard, type OutfitPreset } from "../../../api/mates";
import { useLang, useT, type MsgKey } from "../../../i18n";
import { useMateStore } from "../../../stores/mateStore";
import { useStudio } from "../../../stores/studioStore";
import Icon from "../../ui/Icon";
import { ErrorLine, Section } from "./ui";

/** projects still going somewhere: the rest are in the wardrobe, or were given up */
const DONE = new Set(["ready", "applied", "canceled"]);

function Tile({ mate, card, worn, busy, onWear, onError }: { mate: Mate; card: OutfitCard; worn: boolean; busy: boolean; onWear: () => void; onError: (e: unknown) => void }) {
  const t = useT();
  const isDefault = card.id === DEFAULT_OUTFIT;
  const label = isDefault ? t("mateSettings.outfitDefault") : card.name;
  const [renaming, setRenaming] = useState<string | null>(null);
  const upsert = useMateStore((s) => s.upsert);
  const saveName = async () => {
    const name = (renaming ?? "").trim();
    setRenaming(null);
    if (!name || name === card.name) return;
    try {
      upsert(await renameOutfit(mate.id, card.id, name));
    } catch (e) {
      onError(e);
    }
  };
  const remove = async () => {
    if (!window.confirm(t("mateSettings.outfitDeleteConfirm", { name: label }))) return;
    try {
      upsert(await deleteOutfit(mate.id, card.id));
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className={`flex min-w-0 flex-col overflow-hidden rounded-xl border transition ${worn ? "border-accent/70 ring-1 ring-accent/40" : "border-border/70 hover:border-border"}`} data-testid="outfit-tile" data-outfit={card.id} data-worn={worn}>
      <button
        type="button"
        className="relative block aspect-[4/5] w-full bg-[radial-gradient(ellipse_at_50%_100%,rgb(var(--c-surface-3)),transparent_75%)] disabled:cursor-default"
        disabled={worn || busy}
        onClick={onWear}
        aria-label={t("mateSettings.outfitWear", { name: label })}
        aria-pressed={worn}
        title={worn ? t("mateSettings.outfitWorn") : t("mateSettings.outfitWear", { name: label })}
        data-testid={`outfit-wear-${card.id}`}
      >
        {card.home ? (
          <img src={card.home} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain object-bottom" />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-content-faint">
            <Icon name="image" size={20} />
          </span>
        )}
        {worn && (
          <span className="pill absolute left-1.5 top-1.5 bg-accent text-[10.5px] text-white">
            <Icon name="check" size={10} /> {t("mateSettings.outfitWorn")}
          </span>
        )}
        {busy && (
          <span className="absolute inset-0 flex items-center justify-center bg-surface-1/50">
            <Icon name="spinner" size={18} spin />
          </span>
        )}
      </button>
      <div className="flex items-center gap-1 border-t border-border/60 px-2 py-1.5">
        {renaming !== null ? (
          <input
            autoFocus
            className="field min-w-0 flex-1 !py-0.5 text-[12px]"
            maxLength={40}
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setRenaming(null);
            }}
            aria-label={t("mateSettings.outfitRename")}
            data-testid="outfit-rename-input"
          />
        ) : (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium">{label}</div>
            {card.clips > 0 && <div className="truncate text-[10.5px] text-content-faint">{t("mateSettings.outfitMeta", { clips: card.clips, stills: card.stills })}</div>}
          </div>
        )}
        {!isDefault && renaming === null && (
          <>
            <button className="btn-ghost !px-1.5 !py-1" onClick={() => setRenaming(card.name)} aria-label={t("mateSettings.outfitRename")} title={t("mateSettings.outfitRename")} data-testid="outfit-rename">
              <Icon name="pencil" size={12} />
            </button>
            <button className="btn-ghost !px-1.5 !py-1 text-content-faint" onClick={() => void remove()} aria-label={t("mateSettings.outfitDelete")} title={t("mateSettings.outfitDelete")} data-testid="outfit-delete">
              <Icon name="trash" size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function OutfitTab({ mate }: { mate: Mate }) {
  const t = useT();
  const lang = useLang();
  const upsert = useMateStore((s) => s.upsert);
  const [presets, setPresets] = useState<OutfitPreset[]>([]);
  const [making, setMaking] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const starting = useStudio((s) => s.starting);
  const onError = useCallback((e: unknown) => setError((e as Error).message), []);
  const worn = mate.outfits?.worn ?? DEFAULT_OUTFIT;
  const items = mate.outfits?.items ?? [];

  useEffect(() => {
    let alive = true;
    getOutfits(mate.id)
      .then((o) => alive && setPresets(o.presets))
      .catch((e) => alive && onError(e));
    listProjects()
      .then((all) => alive && setMaking(all.filter((p) => p.mate_id === mate.id && p.outfit && !DONE.has(p.status))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mate.id, onError]);

  const wear = async (oid: string) => {
    setBusy(oid);
    setError(null);
    try {
      upsert(await wearOutfit(mate.id, oid));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Section title={t("mateSettings.outfitWardrobe")} hint={t("mateSettings.outfitWardrobeHint")} testId="outfit-wardrobe">
        <div className="grid grid-cols-2 gap-2.5 min-[480px]:grid-cols-3">
          {items.map((c) => (
            <Tile key={c.id} mate={mate} card={c} worn={c.id === worn} busy={busy === c.id} onWear={() => void wear(c.id)} onError={onError} />
          ))}
        </div>
        <ErrorLine text={error} />
      </Section>
      {making.length > 0 && (
        <Section title={t("mateSettings.outfitMaking")} testId="outfit-making">
          <ul className="space-y-1.5">
            {making.map((p) => (
              <li key={p.id}>
                <button className="flex w-full items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-left hover:bg-surface-3" onClick={() => useStudio.getState().openAvatar(mate.id, p.id)} data-testid="outfit-making-item">
                  <Icon name="sparkles" size={13} className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{p.outfit?.name || p.title}</span>
                  <span className="shrink-0 text-[11px] text-content-faint">{t(`avatar.status_${p.status}` as MsgKey)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={t("mateSettings.outfitMakeTitle")} hint={t("mateSettings.outfitMakeHint")} testId="outfit-make">
        <button className="btn-primary w-full" disabled={starting} onClick={() => void useStudio.getState().openOutfit(mate.id, null)} data-testid="outfit-chat">
          <Icon name={starting ? "spinner" : "sparkles"} size={14} spin={starting} /> {t("mateSettings.outfitChat")}
        </button>
        <p className="mt-1.5 text-[11.5px] text-content-faint">{t("mateSettings.outfitChatHint")}</p>
        {presets.length > 0 && (
          <>
            <div className="mb-1.5 mt-3 text-[12px] font-medium text-content-dim">{t("mateSettings.outfitPresets")}</div>
            <div className="grid grid-cols-1 gap-1.5 min-[480px]:grid-cols-2">
              {presets.map((p) => (
                <button
                  key={p.id}
                  className="rounded-lg border border-border/70 px-3 py-2 text-left transition hover:border-accent/50 hover:bg-surface-3 disabled:opacity-60"
                  disabled={starting}
                  onClick={() => void useStudio.getState().openOutfit(mate.id, p.id)}
                  data-testid={`outfit-preset-${p.id}`}
                >
                  <div className="truncate text-[12.5px] font-medium">{p.name[lang] ?? p.name.en}</div>
                  <div className="truncate text-[11px] text-content-faint">{p.hint[lang] ?? p.hint.en}</div>
                </button>
              ))}
            </div>
          </>
        )}
      </Section>
    </>
  );
}
