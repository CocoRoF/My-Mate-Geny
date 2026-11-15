/**
 * Image Studio's shared pieces (docs/local-image.md "Image Studio"): the studio's state (the status, which page, a
 * result handed to 시험 as its input), the server's pushes (`hrh:image-changed`), the gate's words, a result's
 * preview, and the small formatters.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getImageStatus, IMAGE_CHANGED, imageJobFileUrl, type ImageJob, type ImageStatus, type ImageUse, type JobKind } from "../../api/image";
import type { Gate } from "../../api/voice";
import { useLang, useT, type MsgKey } from "../../i18n";
import { takeSettingsPageLink } from "../../lib/nav";
import Icon from "../ui/Icon";
import { gb } from "../voicestudio/shared";

export { Card, gb, Modal, ParamControls } from "../voicestudio/shared";

export type Page = "overview" | "models" | "try" | "history" | "settings";
export const PAGES: Page[] = ["overview", "models", "try", "history", "settings"];

export const KIND_ICON: Record<JobKind, "image" | "wand" | "play" | "scissors" | "layers"> = {
  draft: "image",
  edit: "wand",
  loop: "play",
  cutout: "scissors",
  matte: "layers",
};

/** "avatar:<project>" → 아바타 만들기, "studio" → Image Studio */
export function sourceLabel(t: ReturnType<typeof useT>, source: string): string {
  if (source.startsWith("avatar:")) return t("imageStudio.src_avatar");
  return t("imageStudio.src_studio");
}

export function gateText(t: ReturnType<typeof useT>, g: Gate): string {
  const gpu = g.gpu;
  switch (g.code) {
    case "ok":
      return t("imageStudio.gateOk");
    case "old_driver":
      return t("imageStudio.gate_old_driver", { driver: gpu?.driver ?? "?", min: g.requirements.driver });
    case "old_gpu":
      return t("imageStudio.gate_old_gpu", { gpu: gpu?.name ?? "GPU", cap: gpu?.capability ?? "?" });
    case "small_gpu":
      return t("imageStudio.gate_small_gpu", {
        gpu: gpu?.name ?? "GPU",
        gb: gb(gpu?.total),
        min: gb(gpu?.kind === "apple" ? g.requirements.unified ?? g.requirements.vram : g.requirements.vram, 0),
      });
    case "old_os":
      return t("imageStudio.gate_old_os", { os: String(g.detail.os ?? "?"), need: g.requirements.macos ?? "14.0" });
    case "platform":
      return t("imageStudio.gate_platform", { platform: String(g.detail.platform ?? "?") });
    case "python":
      return t("imageStudio.gate_python", { python: String(g.detail.python ?? "?"), need: g.requirements.python });
    default:
      return t(`imageStudio.gate_${g.code}` as MsgKey);
  }
}

export const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return `${Math.max(0, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(iso).toLocaleDateString();
};

export const duration = (s: number) => (s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);

/** a job's main result: its first picture or its clip */
export function mainOutput(job: ImageJob): { name: string; kind: "image" | "video" } | null {
  const order = ["loop.mp4", "nobg.mp4", "cut.png", "edit.png", "1.png"];
  for (const n of order) {
    const o = job.outputs.find((x) => x.name === n);
    if (o) return { name: o.name, kind: o.kind === "video" ? "video" : "image" };
  }
  const o = job.outputs.find((x) => x.kind !== "file");
  return o ? { name: o.name, kind: o.kind === "video" ? "video" : "image" } : null;
}

/** a result, as a picture or a playing clip (a cut-out on a checkerboard) */
export function Preview({ job, name, className = "", controls = false }: { job: ImageJob; name?: string; className?: string; controls?: boolean }) {
  const out = name ? job.outputs.find((o) => o.name === name) : mainOutput(job);
  if (!out) return <div className={`grid place-items-center bg-surface-3/40 text-content-faint ${className}`}><Icon name={KIND_ICON[job.kind]} size={18} /></div>;
  const url = imageJobFileUrl(job.id, out.name);
  const checker = out.name === "cut.png" || out.name === "nobg.mp4";
  if (out.kind === "video")
    return <video src={url} className={`bg-black object-contain ${className}`} muted loop playsInline autoPlay={!controls} controls={controls} data-testid={`is-preview-${job.id}`} />;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className={`object-contain ${checker ? "is-checker" : "bg-surface-3/30"} ${className}`}
      data-testid={`is-preview-${job.id}`}
    />
  );
}

// ---- the studio's state ----------------------------------------------------------------------------------------

/** a result handed to 시험 as the input of the next step (a draft → change it, animate it, cut it out) */
export interface Handoff {
  use: ImageUse;
  from: string; // "<job id>/<file>"
  nonce: number;
}

interface StudioCtx {
  status: ImageStatus | null;
  statusErr: string | null;
  reload: () => Promise<void>;
  page: Page;
  go: (page: Page) => void;
  handoff: Handoff | null;
  tryWith: (use: ImageUse, from: string) => void;
  /** bumped on every push from the server (pages refetch what they show) */
  tick: number;
}

const Ctx = createContext<StudioCtx | null>(null);

export function useImageStudio(): StudioCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useImageStudio outside Image Studio"); // i18n-ignore (a programming error)
  return c;
}

const isPage = (p: string | null): p is Page => (PAGES as string[]).includes(p ?? "");

const pageFromUrl = (): Page => {
  const link = takeSettingsPageLink();
  if (isPage(link)) return link;
  const p = new URLSearchParams(window.location.search).get("page");
  return isPage(p) ? p : "overview";
};

function writePage(p: Page) {
  const u = new URL(window.location.href);
  if (u.searchParams.get("view") !== "settings") return;
  u.searchParams.set("page", p);
  window.history.replaceState(window.history.state, "", u.pathname + u.search);
}

export function ImageStudioProvider({ children }: { children: ReactNode }) {
  const lang = useLang();
  const [status, setStatus] = useState<ImageStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [page, setPage] = useState<Page>(pageFromUrl);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [tick, setTick] = useState(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reload = useCallback(async () => {
    try {
      setStatus(await getImageStatus(lang));
      setStatusErr(null);
    } catch (e) {
      setStatusErr((e as Error).message);
    }
  }, [lang]);
  const busy = !!status?.models.some((m) => m.busy) || !!status?.queue.running;
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), busy ? 2000 : 10000);
    const back = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [reload, busy]);
  useEffect(() => {
    // (the server's pushes come in bursts while a job runs: one refetch per burst)
    const on = () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        void reload();
        setTick((n) => n + 1);
      }, 250);
    };
    window.addEventListener(IMAGE_CHANGED, on);
    return () => window.removeEventListener(IMAGE_CHANGED, on);
  }, [reload]);
  useEffect(() => writePage(page), []); // (the page opened at: a reload stays on it)
  const go = useCallback((p: Page) => {
    setPage(p);
    writePage(p);
  }, []);
  const tryWith = useCallback(
    (use: ImageUse, from: string) => {
      setHandoff({ use, from, nonce: Date.now() });
      go("try");
    },
    [go],
  );
  const value = useMemo(() => ({ status, statusErr, reload, page, go, handoff, tryWith, tick }), [status, statusErr, reload, page, go, handoff, tryWith, tick]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** a running job's progress line (step · n / m · elapsed) */
export function LiveLine({ live }: { live: NonNullable<ImageJob["live"]> }) {
  const t = useT();
  const [, setNow] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  const el = Math.max(0, Date.now() / 1000 - live.started);
  return (
    <span className="tabular-nums">
      {t(`imageStudio.step_${live.step}` as MsgKey)}
      {live.max > 0 ? ` · ${live.value} / ${live.max}` : ""} · {duration(el)}
    </span>
  );
}
