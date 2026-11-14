/**
 * Voice Studio → 생성: a line in a profile's voice (or a described one, or the model's own) → its waveform, how long it
 * took, the seed it was made with (keep it to make the same line again), download in a format, keep it (★), save it as
 * one of a profile's clips. Every line is also in 히스토리. Ctrl+Enter makes it.
 */
import { useEffect, useRef, useState } from "react";
import { generateVoice, historyAudioUrl, updateHistory, type GenerateBody, type HistoryEntry } from "../../api/voice";
import { useT, type MsgKey } from "../../i18n";
import Icon from "../ui/Icon";
import { ErrorLine } from "../mate/settings/ui";
import { SaveAsRefModal } from "./clips";
import { estimateSeconds, LineForm, useDefaultLine, useTts, type LineSettings } from "./lineForm";
import { Card, DownloadMenu, PlayButton, secs, sourceLabel, useStudio, usePlayer, Waveform } from "./shared";

const MAX_CHARS = 2000;

export default function GeneratePage() {
  const t = useT();
  const { draft, go, voices } = useStudio();
  const tts = useTts();
  const initial = useDefaultLine();
  // a line from elsewhere (히스토리 → 다시 만들기, 프로필 → 이 프로필로 생성, 모델 → 들어 보기): the page opens with it
  const [line, setLine] = useState<LineSettings>(() => withDraft(initial(), draft));
  const [text, setText] = useState(() => draft?.text || t("localVoice.trySample"));
  const [seed, setSeed] = useState<number | null>(() => draft?.seed ?? null);
  const [lockSeed, setLockSeed] = useState(() => draft?.seed != null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<HistoryEntry[]>([]);
  const player = usePlayer();
  const seen = useRef(draft?.nonce ?? 0);
  // (one asked for while the page is open)
  useEffect(() => {
    if (!draft || draft.nonce === seen.current) return;
    seen.current = draft.nonce;
    setLine((l) => withDraft(l, draft));
    if (draft.text) setText(draft.text);
    if (draft.seed != null) {
      setSeed(draft.seed);
      setLockSeed(true);
    }
  }, [draft]);
  // (the profiles and models came after the page opened: start from them, unless a line was asked for)
  const started = useRef(false);
  useEffect(() => {
    if (started.current || seen.current || !voices.length || !tts.length) return;
    started.current = true;
    if (!line.voice_id || !line.model_id) setLine(initial());
  }, [voices.length, tts.length, line.voice_id, line.model_id, initial]);
  const make = async (over?: Partial<{ seed: number | null }>) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const s = over && "seed" in over ? over.seed : lockSeed ? seed : null;
      const e = await generateVoice({ ...line, voice_id: line.voice_id || undefined, text: text.trim(), seed: s, source: "studio" });
      setResults((r) => [e, ...r].slice(0, 12));
      if (!lockSeed) setSeed(e.seed);
      player.play(historyAudioUrl(e.id));
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!tts.length) {
    return (
      <Card testId="vs-generate-empty">
        <p className="text-[12.5px] text-content-dim">{t("localVoice.noTts")}</p>
        <button className="btn-soft mt-2 !py-1 text-[12px]" onClick={() => go("models")}>
          {t("voiceStudio.gnToModels")}
        </button>
      </Card>
    );
  }
  const est = estimateSeconds(text, line.language);
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-testid="vs-generate">
      <div className="space-y-3">
        <Card title={t("voiceStudio.gnText")}>
          <textarea
            className="field min-h-[120px] text-[13.5px] leading-relaxed"
            value={text}
            maxLength={MAX_CHARS}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void make();
              }
            }}
            data-testid="vs-gen-text"
          />
          <div className="mt-1 flex items-center gap-2 text-[11px] tabular-nums text-content-faint">
            <span>{t("voiceStudio.gnChars", { n: text.length, max: MAX_CHARS })}</span>
            <span>· {t("voiceStudio.gnEstimate", { s: est.toFixed(0) })}</span>
            <span className="flex-1" />
            <span>{t("voiceStudio.gnShortcut")}</span>
          </div>
        </Card>
        <Card title={t("voiceStudio.gnVoice")}>
          <LineForm value={line} onChange={setLine} testId="vs-gen" />
        </Card>
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-medium text-content-dim">{t("voiceStudio.gnSeed")}</span>
            <input
              className="field !w-36 !py-1 font-mono text-[12.5px]"
              type="number"
              min={0}
              value={seed ?? ""}
              placeholder={t("voiceStudio.gnSeedRandom")}
              onChange={(e) => {
                const n = e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value)));
                setSeed(n);
                setLockSeed(n != null);
              }}
              data-testid="vs-gen-seed"
            />
            <button className="btn-ghost !p-1.5" onClick={() => (setSeed(Math.floor(Math.random() * 2 ** 31)), setLockSeed(true))} title={t("voiceStudio.gnSeedDice")}>
              <Icon name="dice" size={14} />
            </button>
            <label className="flex items-center gap-1.5 text-[12px] text-content-dim">
              <input type="checkbox" checked={lockSeed} onChange={(e) => setLockSeed(e.target.checked)} data-testid="vs-gen-seed-lock" />
              {t("voiceStudio.gnSeedLock")}
            </label>
            <span className="flex-1" />
            <button className="btn-primary !px-4 !py-1.5 text-[13px]" disabled={busy || !text.trim()} onClick={() => void make()} data-testid="vs-gen-go">
              {busy ? <Icon name="spinner" size={13} spin /> : <Icon name="sparkles" size={13} />} {t("voiceStudio.gnGo")}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-content-faint">{t("voiceStudio.gnSeedHint")}</p>
          <ErrorLine text={err} />
        </Card>
      </div>
      <div className="space-y-2" data-testid="vs-gen-results">
        {busy && (
          <Card>
            <p className="flex items-center gap-2 text-[12.5px] text-content-dim">
              <Icon name="spinner" size={13} spin /> {t("voiceStudio.gnMaking")}
            </p>
          </Card>
        )}
        {results.length === 0 && !busy ? (
          <Card>
            <p className="text-[12.5px] text-content-faint">{t("voiceStudio.gnNoResults")}</p>
          </Card>
        ) : (
          results.map((e, i) => (
            <Result
              key={e.id}
              e={e}
              first={i === 0}
              onAgain={() => void make({ seed: e.seed })}
              onKeepSeed={() => (setSeed(e.seed), setLockSeed(true))}
              onChange={(n) => setResults((r) => r.map((x) => (x.id === n.id ? n : x)))}
            />
          ))
        )}
        {results.length > 0 && (
          <button className="text-[12px] text-link hover:underline" onClick={() => go("history")}>
            {t("voiceStudio.gnAllHistory")}
          </button>
        )}
      </div>
    </div>
  );
}

function withDraft(l: LineSettings, draft: Partial<GenerateBody> | null): LineSettings {
  if (!draft) return l;
  return {
    ...l,
    ...(draft.model_id ? { model_id: draft.model_id } : {}),
    ...(draft.voice_id !== undefined ? { voice_id: draft.voice_id } : {}),
    ...(draft.feeling ? { feeling: draft.feeling } : {}),
    ...(draft.mode ? { mode: draft.mode } : {}),
    ...(draft.language ? { language: draft.language } : {}),
    ...(draft.instruct !== undefined ? { instruct: draft.instruct } : {}),
    ...(draft.params ? { params: draft.params } : {}),
  };
}

export function Result({
  e,
  first,
  onAgain,
  onKeepSeed,
  onChange,
}: {
  e: HistoryEntry;
  first?: boolean;
  onAgain?: () => void;
  onKeepSeed?: () => void;
  onChange: (n: HistoryEntry) => void;
}) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const url = historyAudioUrl(e.id);
  const star = async () => onChange(await updateHistory(e.id, { starred: !e.starred }));
  return (
    <Card className={first ? "border-accent/40" : ""} testId="vs-gen-result">
      <div className="flex items-center gap-2">
        <PlayButton url={url} testId={first ? "vs-gen-play" : undefined} />
        <div className="min-w-0 flex-1">
          <Waveform url={url} height={first ? 52 : 36} testId={first ? "vs-gen-wave" : undefined} />
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-[12.5px] leading-snug text-content">{e.text}</p>
      <p className="mt-1 text-[11px] tabular-nums text-content-faint" data-testid={first ? "vs-gen-stats" : undefined}>
        {[
          e.voice_name || t("voiceStudio.gnNoProfile"),
          t(`voiceStudio.mode_${e.mode}` as MsgKey),
          e.ref_label ? t(`localVoice.feeling_${e.ref_label}` as MsgKey) : "",
          e.model_id,
          t("voiceStudio.gnStat", { s: secs(e.seconds), gen: secs(e.generate_seconds), rtf: e.rtf != null ? e.rtf.toFixed(2) : "–" }),
          t("voiceStudio.gnSeedN", { n: String(e.seed ?? "–") }),
          e.source !== "studio" ? sourceLabel(t, e.source) : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button className="btn-ghost !p-1.5" onClick={() => void star()} title={e.starred ? t("voiceStudio.unstar") : t("voiceStudio.star")} data-testid={first ? "vs-gen-star" : undefined}>
          <Icon name="star" size={13} className={e.starred ? "fill-current text-warning" : ""} />
        </button>
        <DownloadMenu href={(f) => historyAudioUrl(e.id, f, true)} testId={first ? "vs-gen-download" : undefined} />
        {onAgain && (
          <button className="btn-ghost !py-1 text-[12px]" onClick={onAgain} title={t("voiceStudio.gnAgainHint")} data-testid={first ? "vs-gen-again" : undefined}>
            <Icon name="refresh" size={12} /> {t("voiceStudio.gnAgain")}
          </button>
        )}
        {onKeepSeed && (
          <button className="btn-ghost !py-1 text-[12px]" onClick={onKeepSeed}>
            <Icon name="lock" size={12} /> {t("voiceStudio.gnKeepSeed")}
          </button>
        )}
        <button className="btn-ghost !py-1 text-[12px]" onClick={() => setSaving(true)} data-testid={first ? "vs-gen-save-ref" : undefined}>
          <Icon name="user" size={12} /> {t("voiceStudio.sarOpen")}
        </button>
      </div>
      {saving && <SaveAsRefModal entry={e} onClose={() => setSaving(false)} />}
    </Card>
  );
}
