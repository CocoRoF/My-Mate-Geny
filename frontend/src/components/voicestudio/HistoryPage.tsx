/**
 * Voice Studio → 히스토리: every line made here (생성, 비교, 시드 찾기, 일괄 생성) with everything that made it — search it,
 * filter by profile / model / where it came from / ★, hear it, download it in a format, make it again (opens 생성 with
 * its settings and seed), save it as one of a profile's clips, delete. The oldest lines go when the history is over
 * its limits (설정); ★ ones and a batch's lines stay.
 */
import { useCallback, useEffect, useState } from "react";
import {
  deleteHistory,
  historyAudioUrl,
  historyFacets,
  listHistory,
  updateHistory,
  type Feeling,
  type HistoryEntry,
  type HistoryPage as Page,
} from "../../api/voice";
import { useT, type MsgKey } from "../../i18n";
import { confirmDialog } from "../ui/ConfirmDialog";
import Icon from "../ui/Icon";
import { ErrorLine, ProgressBar } from "../mate/settings/ui";
import { SaveAsRefModal } from "./clips";
import { Card, DownloadMenu, gb, PlayButton, secs, sourceLabel, useStudio, Waveform } from "./shared";

const PAGE = 40;
type Facets = Awaited<ReturnType<typeof historyFacets>>;

export default function HistoryPage() {
  const t = useT();
  const { openInGenerate } = useStudio();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [voice, setVoice] = useState("");
  const [model, setModel] = useState("");
  const [source, setSource] = useState("");
  const [starred, setStarred] = useState(false);
  const [page, setPage] = useState<Page | null>(null);
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState<HistoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // (the search waits for a pause in typing)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);
  const load = useCallback(
    async (offset = 0) => {
      setBusy(true);
      try {
        const p = await listHistory({ q: query, voice_id: voice, model_id: model, source, starred, limit: PAGE, offset });
        setPage(p);
        setItems((old) => (offset ? [...old, ...p.items] : p.items));
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [query, voice, model, source, starred],
  );
  useEffect(() => {
    void load(0);
    setPicked(new Set());
  }, [load]);
  useEffect(() => void historyFacets().then(setFacets).catch(() => {}), []);
  const patch = (n: HistoryEntry) => setItems((xs) => xs.map((x) => (x.id === n.id ? n : x)));
  const remove = async (ids: string[]) => {
    if (!ids.length) return;
    if (!(await confirmDialog({ body: t("voiceStudio.hsDeleteConfirm", { n: ids.length }), confirmLabel: t("voiceStudio.delete"), danger: true }))) return;
    try {
      await deleteHistory(ids);
      setPicked(new Set());
      await load(0);
      setFacets(await historyFacets());
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const again = (e: HistoryEntry) =>
    openInGenerate({
      text: e.text,
      model_id: e.model_id,
      voice_id: e.voice_id,
      feeling: (e.feeling || "neutral") as Feeling,
      mode: e.mode,
      language: e.language,
      instruct: e.instruct,
      params: e.params,
      seed: e.seed,
    });
  const u = page?.usage;
  const lim = page?.limits;
  const all = items.length > 0 && items.every((x) => picked.has(x.id));
  return (
    <div className="space-y-3" data-testid="vs-history">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-faint" />
            <input className="field !pl-8 !py-1.5 text-[12.5px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("voiceStudio.hsSearch")} data-testid="vs-history-search" />
          </div>
          <select className="field !w-auto !py-1.5 text-[12.5px]" value={voice} onChange={(e) => setVoice(e.target.value)} aria-label={t("voiceStudio.gnProfile")} data-testid="vs-history-voice">
            <option value="">{t("voiceStudio.hsAllProfiles")}</option>
            {(facets?.voices ?? []).map((v) => <option key={v.value} value={v.value}>{(v.name || t("voiceStudio.gnNoProfile")) + ` (${v.count})`}</option>)}
          </select>
          <select className="field !w-auto !py-1.5 text-[12.5px]" value={model} onChange={(e) => setModel(e.target.value)} aria-label={t("voiceStudio.gnModel")} data-testid="vs-history-model">
            <option value="">{t("voiceStudio.hsAllModels")}</option>
            {(facets?.models ?? []).map((m) => <option key={m.value} value={m.value}>{`${m.value} (${m.count})`}</option>)}
          </select>
          <select className="field !w-auto !py-1.5 text-[12.5px]" value={source} onChange={(e) => setSource(e.target.value)} aria-label={t("voiceStudio.colWho")} data-testid="vs-history-source">
            <option value="">{t("voiceStudio.hsAllSources")}</option>
            {(facets?.sources ?? []).map((s) => <option key={s.value} value={s.value}>{`${sourceLabel(t, s.value)} (${s.count})`}</option>)}
          </select>
          <button className={`btn-ghost !py-1.5 text-[12.5px] ${starred ? "text-warning" : ""}`} onClick={() => setStarred((v) => !v)} aria-pressed={starred} data-testid="vs-history-starred">
            <Icon name="star" size={13} className={starred ? "fill-current" : ""} /> {t("voiceStudio.hsStarred")}
          </button>
        </div>
        {u && lim && (
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2" data-testid="vs-history-usage">
            <div>
              <div className="flex justify-between text-[11px] tabular-nums text-content-faint">
                <span>{t("voiceStudio.hsCount", { n: u.count, max: lim.entries })}</span>
                <span>{t("voiceStudio.hsStarCount", { n: u.starred })}</span>
              </div>
              <ProgressBar value={Math.min(1, u.count / Math.max(1, lim.entries))} />
            </div>
            <div>
              <div className="flex justify-between text-[11px] tabular-nums text-content-faint">
                <span>{t("voiceStudio.hsBytes", { gb: gb(u.bytes, 2), max: gb(lim.bytes, 1) })}</span>
                <span>{t("voiceStudio.hsBatchBytes", { gb: gb(u.batch_bytes, 2) })}</span>
              </div>
              <ProgressBar value={Math.min(1, u.bytes / Math.max(1, lim.bytes))} />
            </div>
            <p className="text-[11px] leading-snug text-content-faint sm:col-span-2">{t("voiceStudio.hsPruneHint")}</p>
          </div>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-2 px-1">
        <label className="flex items-center gap-1.5 text-[12px] text-content-dim">
          <input type="checkbox" checked={all} onChange={(e) => setPicked(e.target.checked ? new Set(items.map((x) => x.id)) : new Set())} data-testid="vs-history-all" />
          {t("voiceStudio.hsPickAll")}
        </label>
        {picked.size > 0 && (
          <button className="btn-ghost !py-0.5 text-[12px] text-danger" onClick={() => void remove([...picked])} data-testid="vs-history-delete-picked">
            <Icon name="trash" size={12} /> {t("voiceStudio.hsDeletePicked", { n: picked.size })}
          </button>
        )}
        <span className="flex-1" />
        <span className="text-[11.5px] tabular-nums text-content-faint">{page ? t("voiceStudio.hsShown", { n: items.length, total: page.total }) : ""}</span>
      </div>

      {items.length === 0 && !busy ? (
        <Card>
          <p className="text-[12.5px] text-content-faint">{query || voice || model || source || starred ? t("voiceStudio.hsNoMatch") : t("voiceStudio.hsEmpty")}</p>
        </Card>
      ) : (
        <ul className="space-y-1.5" data-testid="vs-history-list">
          {items.map((e) => (
            <Row
              key={e.id}
              e={e}
              picked={picked.has(e.id)}
              onPick={(v) => setPicked((s) => {
                const n = new Set(s);
                if (v) n.add(e.id);
                else n.delete(e.id);
                return n;
              })}
              open={open === e.id}
              onToggle={() => setOpen(open === e.id ? null : e.id)}
              onStar={async () => patch(await updateHistory(e.id, { starred: !e.starred }))}
              onAgain={() => again(e)}
              onSave={() => setSaving(e)}
              onDelete={() => void remove([e.id])}
            />
          ))}
        </ul>
      )}
      {busy && <ProgressBar indeterminate />}
      {page && items.length < page.total && !busy && (
        <button className="btn-soft w-full !py-1.5 text-[12.5px]" onClick={() => void load(items.length)} data-testid="vs-history-more">
          {t("voiceStudio.hsMore", { n: page.total - items.length })}
        </button>
      )}
      <ErrorLine text={err} />
      {saving && <SaveAsRefModal entry={saving} onClose={() => setSaving(null)} />}
    </div>
  );
}

function Row({
  e,
  picked,
  onPick,
  open,
  onToggle,
  onStar,
  onAgain,
  onSave,
  onDelete,
}: {
  e: HistoryEntry;
  picked: boolean;
  onPick: (v: boolean) => void;
  open: boolean;
  onToggle: () => void;
  onStar: () => Promise<void>;
  onAgain: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const url = historyAudioUrl(e.id);
  const when = new Date(e.created_at);
  return (
    <li className={`rounded-lg border bg-surface-2/40 px-2.5 py-2 ${picked ? "border-accent/50" : "border-border/70"}`} data-testid="vs-history-row" data-id={e.id}>
      <div className="flex items-center gap-2">
        <input type="checkbox" checked={picked} onChange={(x) => onPick(x.target.checked)} aria-label={t("voiceStudio.hsPick")} />
        <PlayButton url={url} small testId="vs-history-play" />
        <button className="min-w-0 flex-1 text-left" onClick={onToggle} aria-expanded={open}>
          <span className="block truncate text-[12.5px] text-content">{e.text}</span>
          <span className="block truncate text-[11px] tabular-nums text-content-faint">
            {[
              when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
              e.voice_name || t("voiceStudio.gnNoProfile"),
              e.ref_label ? t(`localVoice.feeling_${e.ref_label}` as MsgKey) : t(`voiceStudio.mode_${e.mode}` as MsgKey),
              e.model_id,
              secs(e.seconds),
              sourceLabel(t, e.source),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </button>
        <button className="btn-ghost !p-1.5" onClick={() => void onStar()} title={e.starred ? t("voiceStudio.unstar") : t("voiceStudio.star")} data-testid="vs-history-star">
          <Icon name="star" size={13} className={e.starred ? "fill-current text-warning" : ""} />
        </button>
        <DownloadMenu href={(f) => historyAudioUrl(e.id, f, true)} />
      </div>
      {open && (
        <div className="mt-2 space-y-2 border-t border-border/60 pt-2" data-testid="vs-history-detail">
          <Waveform url={url} height={44} />
          <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-content">{e.text}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
            <dt className="text-content-faint">{t("voiceStudio.gnMode")}</dt>
            <dd className="text-content-dim">
              {t(`voiceStudio.mode_${e.mode}` as MsgKey)}
              {e.ref_label ? ` · ${t("voiceStudio.hsClip", { feeling: t(`localVoice.feeling_${e.ref_label}` as MsgKey) })}` : ""}
            </dd>
            <dt className="text-content-faint">{t("voiceStudio.language")}</dt>
            <dd className="text-content-dim">{e.language === "auto" ? t("voiceStudio.langAuto") : e.language}</dd>
            {e.instruct && (
              <>
                <dt className="text-content-faint">{t("voiceStudio.gnInstruct")}</dt>
                <dd className="text-content-dim">{e.instruct}</dd>
              </>
            )}
            <dt className="text-content-faint">{t("voiceStudio.gnSeed")}</dt>
            <dd className="font-mono text-content-dim">{e.seed ?? "–"}</dd>
            <dt className="text-content-faint">{t("voiceStudio.hsTook")}</dt>
            <dd className="tabular-nums text-content-dim">
              {t("voiceStudio.gnStat", { s: secs(e.seconds), gen: secs(e.generate_seconds), rtf: e.rtf != null ? e.rtf.toFixed(2) : "–" })}
              {e.ready_seconds ? ` · ${t("voiceStudio.hsReady", { s: secs(e.ready_seconds) })}` : ""}
            </dd>
            {Object.keys(e.params).length > 0 && (
              <>
                <dt className="text-content-faint">{t("voiceStudio.gnParams")}</dt>
                <dd className="break-all font-mono text-[11px] text-content-dim">
                  {Object.entries(e.params)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(", ")}
                </dd>
              </>
            )}
          </dl>
          <div className="flex flex-wrap gap-1.5">
            <button className="btn-soft !py-1 text-[12px]" onClick={onAgain} data-testid="vs-history-again">
              <Icon name="refresh" size={12} /> {t("voiceStudio.hsAgain")}
            </button>
            <button className="btn-ghost !py-1 text-[12px]" onClick={onSave} data-testid="vs-history-save-ref">
              <Icon name="user" size={12} /> {t("voiceStudio.sarOpen")}
            </button>
            <span className="flex-1" />
            <button className="btn-ghost !py-1 text-[12px] text-danger" onClick={onDelete} data-testid="vs-history-delete">
              <Icon name="trash" size={12} /> {t("voiceStudio.delete")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
