/**
 * Voice Studio's shared pieces (docs/local-voice.md "Voice Studio"): the studio's state (the models' status, the
 * profiles, which page, a line to open in 생성), one audio player for the whole studio, a waveform drawn from the
 * server's audio (click to seek; the trimmer's selection on top), the download menu, a model's parameter controls, a
 * modal, and the small formatters.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AUDIO_FORMATS,
  getVoiceStatus,
  listLocalVoices,
  referenceAudioUrl,
  type AudioFormat,
  type Feeling,
  type Gate,
  type GenerateBody,
  type LocalVoice,
  type ModelParam,
  type VoiceRef,
  type VoiceStatus,
} from "../../api/voice";
import { useLang, useT, type MsgKey } from "../../i18n";
import { takeSettingsPageLink } from "../../lib/nav";
import Icon from "../ui/Icon";

export const GiB = 1024 ** 3;
export const gb = (n: number | null | undefined, digits = 1) => (n == null || !Number.isFinite(n) ? "?" : (n / GiB).toFixed(digits));
export const mb = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "?" : (n / 1024 ** 2).toFixed(0));
export const secs = (s: number | null | undefined, digits = 1) => (s == null || !Number.isFinite(s) ? "–" : `${s.toFixed(digits)}s`);
export const clock = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export type Page = "overview" | "models" | "profiles" | "generate" | "batch" | "history" | "tools" | "settings";
export const PAGES: Page[] = ["overview", "models", "profiles", "generate", "batch", "history", "tools", "settings"];

/** a feeling's dot */
export const FEELING_COLOR: Record<Feeling, string> = {
  neutral: "#9ca3af",
  joy: "#facc15",
  sadness: "#60a5fa",
  anger: "#f87171",
  surprise: "#fb923c",
  fear: "#c084fc",
  disgust: "#4ade80",
  smile: "#f472b6",
};

export function gateText(t: ReturnType<typeof useT>, g: Gate): string {
  const gpu = g.gpu;
  switch (g.code) {
    case "ok":
      return t("localVoice.gateOk");
    case "old_driver":
      return t("localVoice.gate_old_driver", { driver: gpu?.driver ?? "?", min: g.requirements.driver });
    case "old_gpu":
      return t("localVoice.gate_old_gpu", { gpu: gpu?.name ?? "GPU", cap: gpu?.capability ?? "?" });
    case "small_gpu":
      return t("localVoice.gate_small_gpu", {
        gpu: gpu?.name ?? "GPU",
        gb: gb(gpu?.total),
        min: gb(gpu?.kind === "apple" ? g.requirements.unified ?? g.requirements.vram : g.requirements.vram, 0),
      });
    case "old_os":
      return t("localVoice.gate_old_os", { os: String(g.detail.os ?? "?"), need: g.requirements.macos ?? "14.0" });
    case "platform":
      return t("localVoice.gate_platform", { platform: String(g.detail.platform ?? "?") });
    case "python":
      return t("localVoice.gate_python", { python: String(g.detail.python ?? "?"), need: g.requirements.python });
    case "packages":
      return t("localVoice.gate_packages", { list: ((g.detail.missing as string[]) ?? []).join(", ") });
    default:
      return t(`localVoice.gate_${g.code}` as MsgKey);
  }
}

/** "mate:서아" → 메이트 · 서아, "batch" → 일괄 생성, … */
export function sourceLabel(t: ReturnType<typeof useT>, source: string): string {
  const [kind, ...rest] = (source || "").split(":");
  const name = rest.join(":");
  switch (kind) {
    case "mate":
      return t("voiceStudio.src_mate", { name: name || "?" });
    case "call":
      return t("voiceStudio.src_call", { name: name || "?" });
    case "studio":
    case "compare":
    case "seed":
    case "batch":
    case "settings":
    case "system":
      return t(`voiceStudio.src_${kind}` as MsgKey);
    default:
      return kind ? kind : t("voiceStudio.src_system");
  }
}

// ---- the studio's state ----------------------------------------------------------------------------------------

interface StudioCtx {
  status: VoiceStatus | null;
  statusErr: string | null;
  voices: LocalVoice[];
  reloadStatus: () => Promise<void>;
  reloadVoices: () => Promise<void>;
  page: Page;
  go: (page: Page) => void;
  /** a line to open in 생성 (history → 다시 만들기, a profile → 이 프로필로 생성) */
  draft: (Partial<GenerateBody> & { nonce: number }) | null;
  openInGenerate: (body: Partial<GenerateBody>) => void;
}

const Ctx = createContext<StudioCtx | null>(null);

export function useStudio(): StudioCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useStudio outside Voice Studio"); // i18n-ignore (a programming error)
  return c;
}

const isPage = (p: string | null): p is Page => (PAGES as string[]).includes(p ?? "");

/** the page the address names: a link this window was opened at (the console makes its address canonical first), or
 *  the one `go` wrote */
const pageFromUrl = (): Page => {
  const link = takeSettingsPageLink();
  if (isPage(link)) return link;
  const p = new URLSearchParams(window.location.search).get("page");
  return isPage(p) ? p : "overview";
};

/** the page in the address (a link opens it, a reload stays on it); the Settings tab stays the history entry */
function writePage(p: Page) {
  const u = new URL(window.location.href);
  if (u.searchParams.get("view") !== "settings") return;
  u.searchParams.set("page", p);
  window.history.replaceState(window.history.state, "", u.pathname + u.search);
}

export function StudioProvider({ children }: { children: ReactNode }) {
  const lang = useLang();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [voices, setVoices] = useState<LocalVoice[]>([]);
  const [page, setPage] = useState<Page>(pageFromUrl);
  const [draft, setDraft] = useState<StudioCtx["draft"]>(null);
  const reloadStatus = useCallback(async () => {
    try {
      setStatus(await getVoiceStatus(lang));
      setStatusErr(null);
    } catch (e) {
      setStatusErr((e as Error).message);
    }
  }, [lang]);
  const reloadVoices = useCallback(async () => {
    try {
      setVoices(await listLocalVoices());
    } catch {
      /* (the next reload) */
    }
  }, []);
  // (often while a model installs or loads; otherwise now and then, and when the window comes back)
  const busy = !!status?.models.some(
    (m) => (m.progress && ["queued", "runtime", "source", "weights"].includes(m.progress.state)) || (m.resident && ["starting", "loading", "stopping"].includes(m.resident.state)),
  );
  useEffect(() => {
    void reloadStatus();
    const timer = setInterval(() => void reloadStatus(), busy ? 1500 : 8000);
    const back = () => document.visibilityState === "visible" && void reloadStatus();
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [reloadStatus, busy]);
  useEffect(() => void reloadVoices(), [reloadVoices]);
  useEffect(() => writePage(page), []); // (the page opened at: a reload stays on it)
  const go = useCallback((p: Page) => {
    setPage(p);
    writePage(p);
  }, []);
  const openInGenerate = useCallback(
    (body: Partial<GenerateBody>) => {
      setDraft({ ...body, nonce: Date.now() });
      go("generate");
    },
    [go],
  );
  const value = useMemo(
    () => ({ status, statusErr, voices, reloadStatus, reloadVoices, page, go, draft, openInGenerate }),
    [status, statusErr, voices, reloadStatus, reloadVoices, page, go, draft, openInGenerate],
  );
  return (
    <Ctx.Provider value={value}>
      <PlayerProvider>{children}</PlayerProvider>
    </Ctx.Provider>
  );
}

/** the languages offered: the models' own, and the common ones */
export function useLanguages(): string[] {
  const { status } = useStudio();
  return useMemo(() => {
    const s = new Set<string>(["auto", "ko", "en", "ja", "zh"]);
    for (const m of status?.models ?? []) for (const l of m.languages) s.add(l);
    return [...s];
  }, [status]);
}

/** a profile's clip (its length in the address: a trimmed clip is read again) */
export const refUrl = (v: LocalVoice, r: VoiceRef) => `${referenceAudioUrl(v.id, r.id)}?d=${r.duration}`;

// ---- one player for the studio ---------------------------------------------------------------------------------

interface PlayerCtx {
  playing: string | null;
  /** 0–1 of the one playing */
  progress: number;
  play: (url: string, from?: number) => void;
  stop: () => void;
  seek: (url: string, fraction: number) => void;
}

const Player = createContext<PlayerCtx | null>(null);

export function usePlayer(): PlayerCtx {
  const c = useContext(Player);
  if (!c) throw new Error("usePlayer outside Voice Studio"); // i18n-ignore (a programming error)
  return c;
}

function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const a = new Audio();
    a.preload = "auto";
    audio.current = a;
    const tick = () => setProgress(a.duration ? a.currentTime / a.duration : 0);
    const end = () => {
      setPlaying(null);
      setProgress(0);
    };
    a.addEventListener("timeupdate", tick);
    a.addEventListener("ended", end);
    a.addEventListener("error", end);
    return () => {
      a.pause();
      a.removeEventListener("timeupdate", tick);
      a.removeEventListener("ended", end);
      a.removeEventListener("error", end);
    };
  }, []);
  const play = useCallback((url: string, from = 0) => {
    const a = audio.current;
    if (!a) return;
    if (a.getAttribute("data-url") !== url) {
      a.src = url;
      a.setAttribute("data-url", url);
    }
    const start = () => {
      if (from > 0 && a.duration) a.currentTime = from * a.duration;
      void a.play().catch(() => setPlaying(null));
    };
    if (a.readyState >= 1) start();
    else a.addEventListener("loadedmetadata", start, { once: true });
    setPlaying(url);
  }, []);
  const stop = useCallback(() => {
    audio.current?.pause();
    setPlaying(null);
    setProgress(0);
  }, []);
  const seek = useCallback(
    (url: string, fraction: number) => {
      const a = audio.current;
      if (a && a.getAttribute("data-url") === url && a.duration) {
        a.currentTime = fraction * a.duration;
        if (a.paused) void a.play().then(() => setPlaying(url));
      } else play(url, fraction);
    },
    [play],
  );
  const value = useMemo(() => ({ playing, progress, play, stop, seek }), [playing, progress, play, stop, seek]);
  return <Player.Provider value={value}>{children}</Player.Provider>;
}

export function PlayButton({ url, testId, small }: { url: string; testId?: string; small?: boolean }) {
  const t = useT();
  const p = usePlayer();
  const on = p.playing === url;
  return (
    <button
      type="button"
      className={`flex shrink-0 items-center justify-center rounded-full border border-border bg-surface-3/60 text-content hover:bg-surface-3 ${small ? "h-7 w-7" : "h-9 w-9"}`}
      onClick={() => (on ? p.stop() : p.play(url))}
      aria-label={on ? t("voiceStudio.stop") : t("voiceStudio.play")}
      title={on ? t("voiceStudio.stop") : t("voiceStudio.play")}
      data-testid={testId}
      data-playing={on}
    >
      <Icon name={on ? "pause" : "play"} size={small ? 12 : 14} />
    </button>
  );
}

// ---- audio the backend reads ------------------------------------------------------------------------------------------

const NATIVE_NAME = /\.(wav|wave|flac|ogg|oga|mp3)$/i;
const NATIVE_TYPE = /^audio\/(wav|wave|x-wav|vnd\.wave|flac|x-flac|ogg|mpeg|mp3)$/i;

/** audio the backend reads without ffmpeg (the desktop app's local backend has none): WAV, FLAC, OGG and MP3 as they
 *  are; anything else the browser can play — a recording's WebM, an M4A, a video's sound — decoded here into a WAV.
 *  (Undecodable: sent as it is — a server with ffmpeg may still read it.) */
export async function readableAudio(blob: Blob, name: string): Promise<{ blob: Blob; name: string }> {
  if (NATIVE_NAME.test(name) || NATIVE_TYPE.test(blob.type)) return { blob, name };
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor();
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    return { blob: wavOf(audio), name: `${name.replace(/\.[^./\\]+$/, "") || "audio"}.wav` };
  } catch {
    return { blob, name };
  } finally {
    void ctx.close();
  }
}

/** 16-bit mono PCM WAV at the audio's own rate */
function wavOf(a: AudioBuffer): Blob {
  const n = a.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < a.numberOfChannels; c++) {
    const d = a.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / a.numberOfChannels;
  }
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const tag = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, a.sampleRate, true);
  v.setUint32(28, a.sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, mono[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// ---- the waveform ------------------------------------------------------------------------------------------------

const peakCache = new Map<string, { peaks: Float32Array; duration: number }>();

/** the audio's loudness in `bars` columns (decoded once per address) */
export function usePeaks(url: string | null, bars = 160) {
  const [state, setState] = useState<{ peaks: Float32Array; duration: number } | null>(() => (url ? peakCache.get(`${url}#${bars}`) ?? null : null));
  useEffect(() => {
    if (!url) return;
    const key = `${url}#${bars}`;
    const hit = peakCache.get(key);
    if (hit) {
      setState(hit);
      return;
    }
    let dead = false;
    void (async () => {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        const buf = await res.arrayBuffer();
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctor();
        const audio = await ctx.decodeAudioData(buf);
        void ctx.close();
        const ch = audio.getChannelData(0);
        const step = Math.max(1, Math.floor(ch.length / bars));
        const peaks = new Float32Array(bars);
        for (let i = 0; i < bars; i++) {
          let m = 0;
          for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j++) m = Math.max(m, Math.abs(ch[j]));
          peaks[i] = m;
        }
        const max = Math.max(...peaks, 1e-4);
        for (let i = 0; i < bars; i++) peaks[i] /= max;
        const v = { peaks, duration: audio.duration };
        peakCache.set(key, v);
        if (!dead) setState(v);
      } catch {
        /* (no waveform: the player still plays) */
      }
    })();
    return () => {
      dead = true;
    };
  }, [url, bars]);
  return state;
}

export function Waveform({
  url,
  height = 56,
  bars = 160,
  selection,
  testId,
}: {
  url: string;
  height?: number;
  bars?: number;
  /** a highlighted stretch, in seconds (the trimmer, a suggested cut) */
  selection?: { start: number; end: number } | null;
  testId?: string;
}) {
  const p = usePlayer();
  const data = usePeaks(url, bars);
  const progress = p.playing === url ? p.progress : 0;
  const onClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    p.seek(url, Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };
  const dur = data?.duration ?? 0;
  return (
    <div className="relative w-full cursor-pointer select-none" style={{ height }} onClick={onClick} data-testid={testId} data-duration={dur ? dur.toFixed(2) : undefined}>
      {selection && dur > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 rounded bg-accent/15 ring-1 ring-accent/50"
          style={{ left: `${(selection.start / dur) * 100}%`, width: `${((selection.end - selection.start) / dur) * 100}%` }}
        />
      )}
      <div className="absolute inset-0 flex items-center gap-[1px]">
        {(data ? Array.from(data.peaks) : Array.from({ length: bars }, () => 0.06)).map((v, i) => (
          <span
            key={i}
            className={`flex-1 rounded-sm ${i / bars < progress ? "bg-accent" : "bg-content-faint/45"}`}
            style={{ height: `${Math.max(6, v * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

// ---- download in a format ------------------------------------------------------------------------------------------

export function DownloadMenu({ href, testId }: { href: (f: AudioFormat) => string; testId?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn-soft !px-2 !py-1 text-[12px]" onClick={() => setOpen((v) => !v)} data-testid={testId} aria-haspopup="menu" aria-expanded={open}>
        <Icon name="download" size={12} /> {t("voiceStudio.download")}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 min-w-[120px] rounded-lg border border-border bg-surface-2 p-1 shadow-lg">
          {AUDIO_FORMATS.map((f) => (
            <a key={f} role="menuitem" href={href(f)} download className="block rounded-md px-2.5 py-1.5 text-[12.5px] text-content hover:bg-surface-3" onClick={() => setOpen(false)} data-testid={testId ? `${testId}-${f}` : undefined}>
              {f.toUpperCase()}
              <span className="ml-1.5 text-[11px] text-content-faint">{t(`voiceStudio.fmt_${f}` as MsgKey)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- a model's parameters ------------------------------------------------------------------------------------------

export function ParamControls({
  params,
  values,
  onChange,
  showAdvanced,
  testId,
}: {
  params: ModelParam[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  showAdvanced: boolean;
  testId?: string;
}) {
  const t = useT();
  const shown = params.filter((p) => showAdvanced || !p.advanced);
  if (!shown.length) return <p className="text-[12px] text-content-faint">{t("voiceStudio.noParams")}</p>;
  const set = (name: string, v: unknown) => onChange({ ...values, [name]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid={testId}>
      {shown.map((p) => {
        const v = values[p.name] ?? p.default;
        const changed = values[p.name] !== undefined && values[p.name] !== p.default;
        return (
          <label key={p.name} className="block" data-testid={testId ? `${testId}-${p.name}` : undefined}>
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-content-dim">
              <span className="min-w-0 flex-1 truncate" title={p.help}>{p.label}</span>
              {p.type !== "bool" && p.type !== "choice" && <span className="tabular-nums text-content">{String(v)}</span>}
              {changed && (
                <button type="button" className="text-[11px] text-link hover:underline" onClick={(e) => { e.preventDefault(); const n = { ...values }; delete n[p.name]; onChange(n); }}>
                  {t("voiceStudio.resetOne")}
                </button>
              )}
            </span>
            <div className="mt-1">
              {p.type === "bool" ? (
                <input type="checkbox" checked={!!v} onChange={(e) => set(p.name, e.target.checked)} />
              ) : p.type === "choice" ? (
                <select className="field !py-1 text-[12.5px]" value={String(v)} onChange={(e) => set(p.name, e.target.value)}>
                  {(p.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input
                  type="range"
                  className="w-full accent-[rgb(var(--c-accent))]"
                  min={p.min}
                  max={p.max}
                  step={p.step ?? (p.type === "int" ? 1 : 0.01)}
                  value={Number(v)}
                  onChange={(e) => set(p.name, p.type === "int" ? parseInt(e.target.value, 10) : parseFloat(e.target.value))}
                />
              )}
            </div>
            {p.help && <span className="mt-0.5 block text-[11px] leading-snug text-content-faint">{p.help}</span>}
          </label>
        );
      })}
    </div>
  );
}

// ---- a modal -----------------------------------------------------------------------------------------------------

export function Modal({ title, onClose, children, wide, testId }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; testId?: string }) {
  const t = useT();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid={testId}>
      <div role="dialog" aria-modal="true" className={`max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-surface-2 p-4 shadow-xl sm:rounded-2xl ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`}>
        <div className="mb-3 flex items-center gap-2">
          <h3 className="min-w-0 flex-1 text-[14px] font-semibold text-content">{title}</h3>
          <button type="button" className="btn-ghost !p-1.5" onClick={onClose} aria-label={t("voiceStudio.close")}>
            <Icon name="x" size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** a small card on a studio page */
export function Card({ title, right, children, testId, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; testId?: string; className?: string }) {
  return (
    <section className={`rounded-xl border border-border bg-surface-2/50 p-3.5 ${className}`} data-testid={testId}>
      {(title || right) && (
        <div className="mb-2.5 flex items-center gap-2">
          {title && <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-content">{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/** a feeling chip with its dot */
export function FeelingDot({ feeling, size = 8 }: { feeling: Feeling; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: FEELING_COLOR[feeling] }} />;
}
