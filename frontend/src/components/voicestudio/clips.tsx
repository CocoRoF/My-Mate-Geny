/**
 * Voice Studio's clip tools: record from the microphone (a level meter, at most a minute); the clip editor — the clip's
 * waveform, the stretch to keep (5–15 s clones best; the server suggests the best ones), hear just that stretch, the
 * feeling, the exact words (blank: the local Whisper writes them) and the language — for a new clip of a profile, or to
 * trim one it has; and a line made here saved as a profile's clip.
 */
import { useEffect, useRef, useState } from "react";
import {
  addVoiceReference,
  analyzeAudio,
  createLocalVoice,
  FEELINGS,
  saveAsReference,
  trimVoiceReference,
  type Analysis,
  type Feeling,
  type HistoryEntry,
  type LocalVoice,
  type VoiceRef,
} from "../../api/voice";
import { useT, type MsgKey } from "../../i18n";
import Icon from "../ui/Icon";
import { ErrorLine, Field } from "../mate/settings/ui";
import { FeelingDot, Modal, readableAudio, secs, usePeaks, usePlayer, useStudio, Waveform } from "./shared";

const MAX_RECORD = 60;

/** the microphone → a recording (webm / ogg, whatever the browser makes) */
export function RecorderModal({ onDone, onClose }: { onDone: (blob: Blob, name: string) => void; onClose: () => void }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "asking" | "recording" | "denied">("idle");
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const raf = useRef<number>(0);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const cleanup = () => {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((x) => x.stop());
    stream.current = null;
    void ctx.current?.close().catch(() => {});
    ctx.current = null;
  };
  useEffect(() => () => {
    if (rec.current && rec.current.state !== "inactive") {
      rec.current.onstop = null;
      rec.current.stop();
    }
    cleanup();
  }, []);
  const start = async () => {
    setErr(null);
    setState("asking");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      stream.current = s;
      const c = new AudioContext();
      ctx.current = c;
      const an = c.createAnalyser();
      an.fftSize = 1024;
      c.createMediaStreamSource(s).connect(an);
      const buf = new Float32Array(an.fftSize);
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let m = 0;
        for (const v of buf) m = Math.max(m, Math.abs(v));
        setLevel(m);
        const e = (performance.now() - started.current) / 1000;
        setElapsed(e);
        if (e >= MAX_RECORD) stop();
        else raf.current = requestAnimationFrame(tick);
      };
      const r = new MediaRecorder(s);
      chunks.current = [];
      r.ondataavailable = (ev) => ev.data.size && chunks.current.push(ev.data);
      r.onstop = () => {
        const type = r.mimeType || "audio/webm";
        const blob = new Blob(chunks.current, { type });
        cleanup();
        // (a WAV: the recorder's WebM / MP4 needs ffmpeg on the backend, which the desktop app's has not)
        void readableAudio(blob, `recording.${type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm"}`).then((a) =>
          onDone(a.blob, a.name),
        );
      };
      rec.current = r;
      started.current = performance.now();
      r.start(250);
      setState("recording");
      raf.current = requestAnimationFrame(tick);
    } catch (e) {
      cleanup();
      setState("denied");
      setErr((e as Error).message);
    }
  };
  const stop = () => {
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
  };
  const loud = level > 0.98;
  return (
    <Modal title={t("voiceStudio.recTitle")} onClose={onClose} testId="vs-recorder">
      <p className="text-[12px] leading-relaxed text-content-dim">{t("voiceStudio.recHint")}</p>
      <div className="mt-3 flex items-center gap-3">
        {state === "recording" ? (
          <button className="btn-primary !bg-danger !py-1.5 text-[12.5px]" onClick={stop} data-testid="vs-rec-stop">
            <Icon name="stop" size={12} /> {t("voiceStudio.recStop")}
          </button>
        ) : (
          <button className="btn-primary !py-1.5 text-[12.5px]" onClick={() => void start()} disabled={state === "asking"} data-testid="vs-rec-start">
            <Icon name="record" size={12} /> {t("voiceStudio.recStart")}
          </button>
        )}
        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-3">
          <div className={`h-full transition-[width] duration-75 ${loud ? "bg-danger" : level > 0.05 ? "bg-success" : "bg-content-faint/50"}`} style={{ width: `${Math.min(100, level * 100)}%` }} />
        </div>
        <span className="w-16 text-right text-[12px] tabular-nums text-content-dim">
          {elapsed.toFixed(1)} / {MAX_RECORD}s
        </span>
      </div>
      {state === "recording" && loud && <p className="mt-1.5 text-[11.5px] text-danger">{t("voiceStudio.recTooLoud")}</p>}
      {state === "recording" && elapsed > 3 && level < 0.02 && <p className="mt-1.5 text-[11.5px] text-warning">{t("voiceStudio.recQuiet")}</p>}
      {state === "denied" && <p className="mt-2 text-[12px] text-danger">{t("voiceStudio.recDenied")}</p>}
      <ErrorLine text={err} />
    </Modal>
  );
}

export type ClipSource =
  | { kind: "new"; blob: Blob; name: string; voice: LocalVoice; feeling: Feeling; range?: { start: number; end: number }; transcript?: string }
  | { kind: "trim"; url: string; voice: LocalVoice; ref: VoiceRef };

/** a new clip for a profile (from a file, a recording, a line made here) or a clip it has, cut to the stretch kept */
export function ClipModal({ src, onSaved, onClose, languages }: { src: ClipSource; onSaved: () => void; onClose: () => void; languages: string[] }) {
  const t = useT();
  const player = usePlayer();
  const [url] = useState(() => (src.kind === "new" ? URL.createObjectURL(src.blob) : src.url));
  useEffect(() => () => {
    if (src.kind === "new") URL.revokeObjectURL(url);
  }, [src.kind, url]);
  const peaks = usePeaks(url, 200);
  const dur = peaks?.duration ?? 0;
  const [range, setRange] = useState<{ start: number; end: number } | null>(src.kind === "new" ? src.range ?? null : null);
  const [feeling, setFeeling] = useState<Feeling>(src.kind === "new" ? src.feeling : src.ref.label);
  const [transcript, setTranscript] = useState(src.kind === "new" ? src.transcript ?? "" : "");
  const [language, setLanguage] = useState(src.kind === "new" ? src.voice.language || "auto" : src.ref.language || "auto");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const preview = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // (the whole clip when it is short, else its first ten seconds — until the suggestions come)
  useEffect(() => {
    if (dur && !range) setRange({ start: 0, end: Math.min(dur, 12) });
  }, [dur, range]);
  const analyze = async () => {
    setAnalyzing(true);
    setErr(null);
    try {
      const blob = src.kind === "new" ? src.blob : await (await fetch(url, { credentials: "same-origin" })).blob();
      const a = await analyzeAudio(blob, { window: 10, filename: src.kind === "new" ? src.name : "clip.wav" });
      setAnalysis(a);
      if (a.windows[0] && dur > 15 && !(src.kind === "new" && src.range)) setRange({ start: a.windows[0].start, end: a.windows[0].end });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };
  const ready = dur > 0;
  useEffect(() => {
    if (ready) void analyze();
  }, [ready]); // (once the clip is read)
  useEffect(() => () => preview.current?.pause(), []);
  const hear = () => {
    if (!range) return;
    player.stop();
    if (previewing) {
      preview.current?.pause();
      setPreviewing(false);
      return;
    }
    const a = preview.current ?? new Audio(url);
    preview.current = a;
    a.currentTime = range.start;
    const end = range.end;
    a.ontimeupdate = () => {
      if (a.currentTime >= end) {
        a.pause();
        setPreviewing(false);
      }
    };
    a.onended = () => setPreviewing(false);
    void a.play().then(() => setPreviewing(true)).catch(() => setPreviewing(false));
  };
  const save = async () => {
    if (!range) return;
    setBusy(true);
    setErr(null);
    try {
      const whole = range.start <= 0.01 && range.end >= dur - 0.01;
      if (src.kind === "new") {
        await addVoiceReference(src.voice.id, src.blob, feeling, transcript.trim(), src.name, {
          start: whole ? null : range.start,
          end: whole ? null : range.end,
          language,
        });
      } else if (!whole) {
        await trimVoiceReference(src.ref.id, range.start, range.end);
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const len = range ? range.end - range.start : 0;
  const good = len >= 5 && len <= 15;
  const has = src.kind === "new" && src.voice.references.some((r) => r.label === feeling);
  return (
    <Modal title={src.kind === "new" ? t("voiceStudio.clipNewTitle", { name: src.voice.name }) : t("voiceStudio.clipTrimTitle")} onClose={onClose} wide testId="vs-clip-modal">
      {!peaks ? (
        <p className="text-[12px] text-content-faint">{t("voiceStudio.clipReading")}</p>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-border/60 bg-surface/40 p-2">
            <Waveform url={url} height={72} bars={200} selection={range} testId="vs-clip-wave" />
            <div className="mt-1 flex justify-between text-[10.5px] tabular-nums text-content-faint">
              <span>0s</span>
              <span>{secs(dur)}</span>
            </div>
          </div>
          {range && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-[12px] text-content-dim">
                {t("voiceStudio.clipStart", { s: range.start.toFixed(2) })}
                <input
                  type="range"
                  className="w-full accent-[rgb(var(--c-accent))]"
                  min={0}
                  max={dur}
                  step={0.05}
                  value={range.start}
                  onChange={(e) => setRange({ start: Math.min(parseFloat(e.target.value), range.end - 0.5), end: range.end })}
                  data-testid="vs-clip-start"
                />
              </label>
              <label className="block text-[12px] text-content-dim">
                {t("voiceStudio.clipEnd", { s: range.end.toFixed(2) })}
                <input
                  type="range"
                  className="w-full accent-[rgb(var(--c-accent))]"
                  min={0}
                  max={dur}
                  step={0.05}
                  value={range.end}
                  onChange={(e) => setRange({ start: range.start, end: Math.max(parseFloat(e.target.value), range.start + 0.5) })}
                  data-testid="vs-clip-end"
                />
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-soft !py-1 text-[12px]" onClick={hear} disabled={!range} data-testid="vs-clip-hear">
              <Icon name={previewing ? "pause" : "play"} size={12} /> {t("voiceStudio.clipHear")}
            </button>
            <button className="btn-ghost !py-1 text-[12px]" onClick={() => setRange({ start: 0, end: dur })}>
              {t("voiceStudio.clipWhole")}
            </button>
            <span className={`text-[12px] tabular-nums ${good ? "text-success" : "text-warning"}`} data-testid="vs-clip-length">
              {t("voiceStudio.clipLength", { s: len.toFixed(1) })} · {good ? t("voiceStudio.clipGood") : len < 5 ? t("voiceStudio.clipShort") : t("voiceStudio.clipLong")}
            </span>
          </div>
          <div className="rounded-lg border border-border/60 bg-surface/40 p-2.5" data-testid="vs-clip-analysis">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium text-content-dim">{t("voiceStudio.clipSuggest")}</span>
              {analyzing && <Icon name="spinner" size={12} spin />}
            </div>
            {analysis && (
              <>
                <p className="mt-1 text-[11.5px] tabular-nums text-content-faint">
                  {t("voiceStudio.clipStats", {
                    db: analysis.stats.rms_db.toFixed(1),
                    peak: analysis.stats.peak.toFixed(2),
                    silence: Math.round(analysis.stats.silence * 100),
                  })}
                  {analysis.stats.warnings.map((w) => (
                    <span key={w} className="ml-1 text-warning">· {t(`localVoice.warn_${w}` as MsgKey)}</span>
                  ))}
                </p>
                {analysis.windows.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {analysis.windows.map((w, i) => {
                      const on = range && Math.abs(range.start - w.start) < 0.01 && Math.abs(range.end - w.end) < 0.01;
                      return (
                        <button
                          key={i}
                          className={`rounded-md border px-2 py-1 text-[11.5px] tabular-nums ${on ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface-3/40 text-content-dim hover:text-content"}`}
                          onClick={() => setRange({ start: w.start, end: w.end })}
                          data-testid={`vs-clip-window-${i}`}
                        >
                          {secs(w.start)}–{secs(w.end)} · {w.level_db.toFixed(0)} dB
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-1 text-[11.5px] text-content-faint">{t("voiceStudio.clipNoWindows")}</p>
                )}
              </>
            )}
          </div>
          {src.kind === "new" && (
            <div className="grid gap-2 sm:grid-cols-[160px_1fr_120px]">
              <Field label={t("localVoice.clipFeeling")}>
                <select className="field" value={feeling} onChange={(e) => setFeeling(e.target.value as Feeling)} data-testid="vs-clip-feeling">
                  {FEELINGS.map((f) => <option key={f} value={f}>{t(`localVoice.feeling_${f}` as MsgKey)}</option>)}
                </select>
              </Field>
              <Field label={t("localVoice.clipText")}>
                <input className="field" value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={t("localVoice.clipTextPh")} data-testid="vs-clip-transcript" />
              </Field>
              <Field label={t("voiceStudio.language")}>
                <select className="field" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {languages.map((l) => <option key={l} value={l}>{l === "auto" ? t("voiceStudio.langAuto") : l}</option>)}
                </select>
              </Field>
            </div>
          )}
          {src.kind === "new" && has && (
            <p className="flex items-center gap-1.5 text-[11.5px] text-warning">
              <FeelingDot feeling={feeling} /> {t("voiceStudio.clipReplaces", { feeling: t(`localVoice.feeling_${feeling}` as MsgKey) })}
            </p>
          )}
          {src.kind === "trim" && <p className="text-[11.5px] text-content-faint">{t("voiceStudio.clipTrimHint")}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-3">
            <button className="btn-ghost !py-1.5 text-[12.5px]" onClick={onClose}>{t("voiceStudio.cancel")}</button>
            <button className="btn-primary !py-1.5 text-[12.5px]" onClick={() => void save()} disabled={busy || !range || len < 0.5} data-testid="vs-clip-save">
              {busy ? <Icon name="spinner" size={12} spin /> : <Icon name="check" size={12} />} {src.kind === "new" ? t("voiceStudio.clipAdd") : t("voiceStudio.clipTrim")}
            </button>
          </div>
          <ErrorLine text={err} />
        </div>
      )}
    </Modal>
  );
}

/** a line made here as one of a profile's clips (the user's own profiles; or a new one) */
export function SaveAsRefModal({ entry, onClose }: { entry: HistoryEntry; onClose: () => void }) {
  const t = useT();
  const { voices, reloadVoices } = useStudio();
  const mine = voices.filter((v) => !v.builtin);
  const [vid, setVid] = useState(mine.find((v) => v.id === entry.voice_id)?.id ?? mine[0]?.id ?? "");
  const [newName, setNewName] = useState("");
  const [feeling, setFeeling] = useState<Feeling>(((FEELINGS as string[]).includes(entry.feeling) ? entry.feeling : "neutral") as Feeling);
  const [transcript, setTranscript] = useState(entry.text);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const target = vid ? mine.find((v) => v.id === vid) : null;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      let id = vid;
      if (!id) id = (await createLocalVoice(newName.trim(), entry.language || "auto")).id;
      await saveAsReference(entry.id, id, feeling, transcript.trim());
      await reloadVoices();
      setDone(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("voiceStudio.sarTitle")} onClose={onClose} testId="vs-save-ref">
      <p className="mb-2 text-[12px] leading-relaxed text-content-dim">{t("voiceStudio.sarHint")}</p>
      <div className="space-y-2">
        <Field label={t("voiceStudio.sarProfile")}>
          <select className="field" value={vid} onChange={(e) => setVid(e.target.value)} data-testid="vs-save-ref-profile">
            {mine.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            <option value="">{t("voiceStudio.sarNewProfile")}</option>
          </select>
        </Field>
        {!vid && (
          <Field label={t("localVoice.voiceName")}>
            <input className="field" value={newName} onChange={(e) => setNewName(e.target.value)} data-testid="vs-save-ref-name" />
          </Field>
        )}
        <Field label={t("localVoice.clipFeeling")}>
          <select className="field" value={feeling} onChange={(e) => setFeeling(e.target.value as Feeling)} data-testid="vs-save-ref-feeling">
            {FEELINGS.map((f) => <option key={f} value={f}>{t(`localVoice.feeling_${f}` as MsgKey)}</option>)}
          </select>
        </Field>
        <Field label={t("localVoice.clipText")}>
          <textarea className="field min-h-[56px]" value={transcript} onChange={(e) => setTranscript(e.target.value)} />
        </Field>
        {target?.references.some((r) => r.label === feeling) && (
          <p className="text-[11.5px] text-warning">{t("voiceStudio.clipReplaces", { feeling: t(`localVoice.feeling_${feeling}` as MsgKey) })}</p>
        )}
        {entry.seconds > 15 && <p className="text-[11.5px] text-warning">{t("voiceStudio.sarLong", { s: entry.seconds.toFixed(1) })}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          {done && <span className="mr-auto text-[12px] text-success" data-testid="vs-save-ref-done">{t("voiceStudio.sarDone")}</span>}
          <button className="btn-ghost !py-1.5 text-[12.5px]" onClick={onClose}>{t("voiceStudio.close")}</button>
          <button className="btn-primary !py-1.5 text-[12.5px]" disabled={busy || done || (!vid && !newName.trim())} onClick={() => void save()} data-testid="vs-save-ref-save">
            {busy ? <Icon name="spinner" size={12} spin /> : null} {t("voiceStudio.sarSave")}
          </button>
        </div>
        <ErrorLine text={err} />
      </div>
    </Modal>
  );
}
