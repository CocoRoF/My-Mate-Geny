/**
 * Voice Studio → 도구:
 *   A/B 비교      one line in up to five settings (profiles, models, feelings, seeds) side by side
 *   시드 찾기     one line with many seeds — keep the take you like (its seed makes it again)
 *   클립 분석     a recording before it becomes a clip: how it came, its level, silence, what may hurt cloning, the best
 *                 stretches to keep (hear each), its words and language (the local Whisper) → add it to a profile
 *   받아쓰기      a file → its words (the local Whisper)
 * Every line made here is in 히스토리 (비교, 시드 찾기).
 */
import { useRef, useState, type ReactNode } from "react";
import { analyzeAudio, FEELINGS, generateVoice, transcribeLocal, type Analysis, type Feeling, type HistoryEntry } from "../../api/voice";
import { useT, type MsgKey } from "../../i18n";
import Icon from "../ui/Icon";
import { ErrorLine, Field, Segmented } from "../mate/settings/ui";
import { ClipModal, type ClipSource } from "./clips";
import { Result } from "./GeneratePage";
import { LineForm, useDefaultLine, useTts, type LineSettings } from "./lineForm";
import { Card, mb, secs, useLanguages, useStudio, Waveform } from "./shared";

type Tool = "compare" | "seeds" | "analyze" | "transcribe";

export default function ToolsPage() {
  const t = useT();
  const [tool, setTool] = useState<Tool>("compare");
  return (
    <div className="space-y-3" data-testid="vs-tools">
      <Segmented
        value={tool}
        onChange={setTool}
        options={[
          { id: "compare", label: t("voiceStudio.tlCompare") },
          { id: "seeds", label: t("voiceStudio.tlSeeds") },
          { id: "analyze", label: t("voiceStudio.tlAnalyze") },
          { id: "transcribe", label: t("voiceStudio.tlTranscribe") },
        ]}
        testId="vs-tools-pick"
      />
      {tool === "compare" && <Compare />}
      {tool === "seeds" && <Seeds />}
      {tool === "analyze" && <Analyze />}
      {tool === "transcribe" && <Transcribe />}
    </div>
  );
}

function NeedTts({ children }: { children: ReactNode }) {
  const t = useT();
  const { go } = useStudio();
  const tts = useTts();
  if (tts.length) return <>{children}</>;
  return (
    <Card>
      <p className="text-[12.5px] text-content-dim">{t("localVoice.noTts")}</p>
      <button className="btn-soft mt-2 !py-1 text-[12px]" onClick={() => go("models")}>{t("voiceStudio.gnToModels")}</button>
    </Card>
  );
}

// ---- A/B ------------------------------------------------------------------------------------------------------------

const MAX_VARIANTS = 5;

function Compare() {
  const t = useT();
  const initial = useDefaultLine();
  const [text, setText] = useState(() => t("localVoice.trySample"));
  const [variants, setVariants] = useState<{ line: LineSettings; seed: number | null }[]>(() => [
    { line: initial(), seed: null },
    { line: initial(), seed: null },
  ]);
  const [results, setResults] = useState<(HistoryEntry | null)[]>([]);
  const [errors, setErrors] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [sameSeed, setSameSeed] = useState(true);
  const run = async () => {
    setResults([]);
    setErrors([]);
    const shared = sameSeed ? Math.floor(Math.random() * 2 ** 31) : null;
    for (let i = 0; i < variants.length; i++) {
      setBusy(i);
      const v = variants[i];
      try {
        const e = await generateVoice({ ...v.line, voice_id: v.line.voice_id || undefined, text: text.trim(), seed: v.seed ?? shared, source: "compare" });
        setResults((r) => Object.assign([...r], { [i]: e }));
      } catch (x) {
        setErrors((r) => Object.assign([...r], { [i]: (x as Error).message }));
      }
    }
    setBusy(null);
  };
  const letter = (i: number) => String.fromCharCode(65 + i);
  return (
    <NeedTts>
      <Card title={t("voiceStudio.tlCompare")} testId="vs-compare">
        <p className="mb-2 text-[12px] leading-snug text-content-dim">{t("voiceStudio.tlCompareHint")}</p>
        <textarea className="field min-h-[72px]" value={text} onChange={(e) => setText(e.target.value)} data-testid="vs-compare-text" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px] text-content-dim">
            <input type="checkbox" checked={sameSeed} onChange={(e) => setSameSeed(e.target.checked)} />
            {t("voiceStudio.tlSameSeed")}
          </label>
          <span className="flex-1" />
          <button
            className="btn-soft !py-1 text-[12px]"
            disabled={variants.length >= MAX_VARIANTS}
            onClick={() => setVariants((v) => [...v, { ...v[v.length - 1] }])}
            data-testid="vs-compare-add"
          >
            <Icon name="plus" size={12} /> {t("voiceStudio.tlAddVariant")}
          </button>
          <button className="btn-primary !py-1.5 text-[12.5px]" disabled={busy !== null || !text.trim()} onClick={() => void run()} data-testid="vs-compare-go">
            {busy !== null ? <Icon name="spinner" size={12} spin /> : <Icon name="play" size={12} />} {t("voiceStudio.tlCompareGo", { n: variants.length })}
          </button>
        </div>
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        {variants.map((v, i) => (
          <div key={i} className="space-y-2" data-testid={`vs-variant-${i}`}>
            <Card
              title={t("voiceStudio.tlVariant", { x: letter(i) })}
              right={
                variants.length > 2 && (
                  <button className="btn-ghost !p-1" onClick={() => setVariants((xs) => xs.filter((_, j) => j !== i))} title={t("voiceStudio.delete")}>
                    <Icon name="x" size={12} />
                  </button>
                )
              }
            >
              <LineForm value={v.line} onChange={(line) => setVariants((xs) => xs.map((x, j) => (j === i ? { ...x, line } : x)))} testId={`vs-variant-${i}-line`} />
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[12px] text-content-dim">{t("voiceStudio.gnSeed")}</span>
                <input
                  className="field !w-36 !py-1 font-mono text-[12px]"
                  type="number"
                  min={0}
                  value={v.seed ?? ""}
                  placeholder={sameSeed ? t("voiceStudio.tlSeedShared") : t("voiceStudio.gnSeedRandom")}
                  onChange={(e) => setVariants((xs) => xs.map((x, j) => (j === i ? { ...x, seed: e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value))) } : x)))}
                />
              </div>
            </Card>
            {busy === i && (
              <p className="flex items-center gap-1.5 px-1 text-[12px] text-content-dim">
                <Icon name="spinner" size={12} spin /> {t("voiceStudio.gnMaking")}
              </p>
            )}
            {results[i] && <Result e={results[i]!} first onChange={(n) => setResults((r) => r.map((x) => (x?.id === n.id ? n : x)))} />}
            <ErrorLine text={errors[i] ?? null} />
          </div>
        ))}
      </div>
    </NeedTts>
  );
}

// ---- seeds ------------------------------------------------------------------------------------------------------------

function Seeds() {
  const t = useT();
  const { openInGenerate } = useStudio();
  const initial = useDefaultLine();
  const [line, setLine] = useState<LineSettings>(initial);
  const [text, setText] = useState(() => t("localVoice.trySample"));
  const [count, setCount] = useState(4);
  const [results, setResults] = useState<HistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stop = useRef(false);
  const run = async () => {
    setBusy(true);
    setErr(null);
    setResults([]);
    stop.current = false;
    for (let i = 0; i < count && !stop.current; i++) {
      try {
        const e = await generateVoice({ ...line, voice_id: line.voice_id || undefined, text: text.trim(), seed: null, source: "seed" });
        setResults((r) => [...r, e]);
      } catch (x) {
        setErr((x as Error).message);
        break;
      }
    }
    setBusy(false);
  };
  return (
    <NeedTts>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-testid="vs-seeds">
        <Card title={t("voiceStudio.tlSeeds")}>
          <p className="mb-2 text-[12px] leading-snug text-content-dim">{t("voiceStudio.tlSeedsHint")}</p>
          <textarea className="field min-h-[72px]" value={text} onChange={(e) => setText(e.target.value)} data-testid="vs-seeds-text" />
          <div className="mt-3">
            <LineForm value={line} onChange={setLine} testId="vs-seeds-line" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Field label={t("voiceStudio.tlSeedCount", { n: count })}>
              <input type="range" min={2} max={12} value={count} onChange={(e) => setCount(parseInt(e.target.value, 10))} className="w-40 accent-[rgb(var(--c-accent))]" data-testid="vs-seeds-count" />
            </Field>
            <span className="flex-1" />
            {busy ? (
              <button className="btn-soft !py-1.5 text-[12.5px]" onClick={() => (stop.current = true)}>
                <Icon name="stop" size={12} /> {t("voiceStudio.tlStop")}
              </button>
            ) : (
              <button className="btn-primary !py-1.5 text-[12.5px]" disabled={!text.trim()} onClick={() => void run()} data-testid="vs-seeds-go">
                <Icon name="dice" size={12} /> {t("voiceStudio.tlSeedsGo", { n: count })}
              </button>
            )}
          </div>
          <ErrorLine text={err} />
        </Card>
        <div className="space-y-2" data-testid="vs-seeds-results">
          {results.map((e, i) => (
            <div key={e.id}>
              <p className="px-1 text-[11.5px] font-medium tabular-nums text-content-dim">
                {t("voiceStudio.tlTake", { n: i + 1 })} · {t("voiceStudio.gnSeedN", { n: String(e.seed ?? "–") })}
              </p>
              <Result
                e={e}
                onChange={(n) => setResults((r) => r.map((x) => (x.id === n.id ? n : x)))}
                onKeepSeed={() => openInGenerate({ ...line, text: e.text, seed: e.seed })}
              />
            </div>
          ))}
          {busy && (
            <p className="flex items-center gap-1.5 px-1 text-[12px] text-content-dim">
              <Icon name="spinner" size={12} spin /> {t("voiceStudio.tlTakeMaking", { n: results.length + 1, total: count })}
            </p>
          )}
        </div>
      </div>
    </NeedTts>
  );
}

// ---- a clip's analysis --------------------------------------------------------------------------------------------

function Analyze() {
  const t = useT();
  const { status, voices, reloadVoices } = useStudio();
  const languages = useLanguages();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [a, setA] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [win, setWin] = useState(10);
  const [target, setTarget] = useState("");
  const [feeling, setFeeling] = useState<Feeling>("neutral");
  const [clip, setClip] = useState<ClipSource | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const stt = !!status?.gate.ok && !!status?.models.some((m) => m.kind === "stt" && m.installed);
  const mine = voices.filter((v) => !v.builtin);
  const run = async (f: File, w = win) => {
    setBusy(true);
    setErr(null);
    try {
      setA(await analyzeAudio(f, { transcribe: stt, window: w, filename: f.name }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = (f: File) => {
    if (url) URL.revokeObjectURL(url);
    setFile(f);
    setUrl(URL.createObjectURL(f));
    setA(null);
    void run(f);
  };
  const addTo = (range?: { start: number; end: number }) => {
    const v = mine.find((x) => x.id === (target || mine[0]?.id));
    if (!v || !file) return;
    setClip({ kind: "new", blob: file, name: file.name, voice: v, feeling, range, transcript: range ? "" : a?.transcript?.text ?? "" });
  };
  return (
    <Card title={t("voiceStudio.tlAnalyze")} testId="vs-analyze">
      <p className="mb-2 text-[12px] leading-snug text-content-dim">{t("voiceStudio.tlAnalyzeHint")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} data-testid="vs-analyze-file" />
        <button className="btn-primary !py-1.5 text-[12.5px]" onClick={() => input.current?.click()}>
          <Icon name="upload" size={12} /> {t("voiceStudio.tlChoose")}
        </button>
        {file && <span className="min-w-0 truncate text-[12px] text-content-dim">{file.name} · {file.size < 1024 ** 2 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${mb(file.size)} MB`}</span>}
        <span className="flex-1" />
        <Field label={t("voiceStudio.tlWindow", { s: win })}>
          <input type="range" min={5} max={15} value={win} onChange={(e) => setWin(parseInt(e.target.value, 10))} onMouseUp={() => file && void run(file)} onTouchEnd={() => file && void run(file)} className="w-32 accent-[rgb(var(--c-accent))]" />
        </Field>
      </div>
      {busy && (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-content-dim">
          <Icon name="spinner" size={12} spin /> {t("voiceStudio.tlAnalyzing")}
        </p>
      )}
      {url && a && (
        <div className="mt-3 space-y-3" data-testid="vs-analyze-result">
          <Waveform url={url} height={64} bars={200} selection={a.windows[0] ?? null} />
          <dl className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
            {[
              [t("voiceStudio.tlLength"), secs(a.stats.duration)],
              [t("voiceStudio.tlFormat"), `${a.probe.format || "?"}${a.probe.subtype ? ` ${a.probe.subtype}` : ""}`],
              [t("voiceStudio.tlRate"), a.probe.sample_rate ? `${a.probe.sample_rate} Hz · ${a.probe.channels ?? "?"}ch` : "?"],
              [t("voiceStudio.tlLevel"), `${a.stats.rms_db.toFixed(1)} dB · ${t("voiceStudio.tlPeak", { n: a.stats.peak.toFixed(2) })}`],
              [t("voiceStudio.tlSilence"), `${Math.round(a.stats.silence * 100)}%`],
              [t("voiceStudio.tlClipped"), `${a.stats.clipped}`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-border/60 bg-surface/40 px-2.5 py-1.5">
                <dt className="text-[11px] text-content-faint">{k}</dt>
                <dd className="tabular-nums text-content">{v}</dd>
              </div>
            ))}
          </dl>
          {a.stats.warnings.length > 0 ? (
            <ul className="space-y-0.5 text-[12px] text-warning">
              {a.stats.warnings.map((w) => <li key={w}>· {t(`localVoice.warn_${w}` as MsgKey)}</li>)}
            </ul>
          ) : (
            <p className="text-[12px] text-success">{t("voiceStudio.tlNoWarnings")}</p>
          )}
          {a.transcript && (
            <div className="rounded-lg border border-border/60 bg-surface/40 p-2.5" data-testid="vs-analyze-transcript">
              <p className="text-[11px] text-content-faint">{t("voiceStudio.tlHeard", { lang: a.transcript.language, s: secs(a.transcript.elapsed) })}</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-content">{a.transcript.text || "—"}</p>
            </div>
          )}
          {!stt && <p className="text-[11.5px] text-content-faint">{t("voiceStudio.pfNoStt")}</p>}

          <div className="rounded-lg border border-border/60 bg-surface/40 p-2.5">
            <p className="text-[12px] font-medium text-content-dim">{t("voiceStudio.clipSuggest")}</p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label={t("voiceStudio.sarProfile")}>
                <select className="field !w-auto" value={target || mine[0]?.id || ""} onChange={(e) => setTarget(e.target.value)} data-testid="vs-analyze-profile">
                  {mine.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </Field>
              <Field label={t("localVoice.clipFeeling")}>
                <select className="field !w-auto" value={feeling} onChange={(e) => setFeeling(e.target.value as Feeling)}>
                  {FEELINGS.map((f) => (
                    <option key={f} value={f}>{t(`localVoice.feeling_${f}` as MsgKey)}</option>
                  ))}
                </select>
              </Field>
              {a.stats.duration <= 15 && (
                <button className="btn-soft !py-1.5 text-[12px]" disabled={!mine.length} onClick={() => addTo()}>
                  <Icon name="plus" size={12} /> {t("voiceStudio.tlAddWhole")}
                </button>
              )}
            </div>
            {!mine.length && <p className="mt-1.5 text-[11.5px] text-content-faint">{t("voiceStudio.tlNoOwnProfile")}</p>}
            <ul className="mt-2 space-y-1">
              {a.windows.map((w, i) => (
                <li key={i} className="flex items-center gap-2 text-[12px]" data-testid={`vs-analyze-window-${i}`}>
                  <span className="w-5 text-right tabular-nums text-content-faint">{i + 1}</span>
                  <span className="tabular-nums text-content">{secs(w.start)} – {secs(w.end)}</span>
                  <span className="tabular-nums text-content-faint">{t("voiceStudio.tlWindowStats", { db: w.level_db.toFixed(0), n: Math.round(w.silence * 100) })}</span>
                  <span className="flex-1" />
                  <button className="btn-ghost !py-0.5 text-[11.5px]" disabled={!mine.length} onClick={() => addTo({ start: w.start, end: w.end })} data-testid={`vs-analyze-add-${i}`}>
                    <Icon name="plus" size={11} /> {t("voiceStudio.tlAddWindow")}
                  </button>
                </li>
              ))}
              {a.windows.length === 0 && <li className="text-[11.5px] text-content-faint">{t("voiceStudio.clipNoWindows")}</li>}
            </ul>
          </div>
        </div>
      )}
      <ErrorLine text={err} />
      {clip && <ClipModal src={clip} languages={languages} onClose={() => setClip(null)} onSaved={() => void reloadVoices()} />}
    </Card>
  );
}

// ---- transcription ------------------------------------------------------------------------------------------------

function Transcribe() {
  const t = useT();
  const { status, go } = useStudio();
  const languages = useLanguages();
  const [language, setLanguage] = useState("auto");
  const [out, setOut] = useState<{ name: string; text: string; language: string; seconds: number; elapsed: number; model_id: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const stt = !!status?.gate.ok && !!status?.models.some((m) => m.kind === "stt" && m.installed);
  const run = async (files: FileList) => {
    setBusy(true);
    setErr(null);
    try {
      for (const f of Array.from(files)) {
        const r = await transcribeLocal(f, language, f.name);
        setOut((o) => [{ name: f.name, ...r }, ...o]);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  if (!stt) {
    return (
      <Card>
        <p className="text-[12.5px] text-content-dim">{t("voiceStudio.tlNoStt")}</p>
        <button className="btn-soft mt-2 !py-1 text-[12px]" onClick={() => go("models")}>{t("voiceStudio.gnToModels")}</button>
      </Card>
    );
  }
  return (
    <Card title={t("voiceStudio.tlTranscribe")} testId="vs-transcribe">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("voiceStudio.language")}>
          <select className="field !w-auto" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {languages.map((l) => <option key={l} value={l}>{l === "auto" ? t("voiceStudio.langAuto") : l}</option>)}
          </select>
        </Field>
        <input ref={input} type="file" multiple accept="audio/*,video/*" className="hidden" onChange={(e) => e.target.files?.length && void run(e.target.files)} data-testid="vs-transcribe-file" />
        <button className="btn-primary !py-1.5 text-[12.5px]" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Icon name="spinner" size={12} spin /> : <Icon name="upload" size={12} />} {t("voiceStudio.tlChooseMany")}
        </button>
      </div>
      <ul className="mt-3 space-y-2" data-testid="vs-transcribe-results">
        {out.map((r, i) => (
          <li key={i} className="rounded-lg border border-border/60 bg-surface/40 p-2.5">
            <div className="flex items-center gap-2 text-[11px] tabular-nums text-content-faint">
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span>{t("voiceStudio.tlHeardLine", { lang: r.language, s: secs(r.seconds), took: secs(r.elapsed), model: r.model_id })}</span>
              <button className="btn-ghost !p-1" onClick={() => void navigator.clipboard?.writeText(r.text)} title={t("voiceStudio.copy")}>
                <Icon name="copy" size={11} />
              </button>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-content">{r.text || "—"}</p>
          </li>
        ))}
      </ul>
      <ErrorLine text={err} />
    </Card>
  );
}
