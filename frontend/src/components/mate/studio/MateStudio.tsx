/**
 * The Mate Create studio (메이트 만들기 / 메이트 편집 — docs/avatar-create.md §11): a screen of the Mate view of its own
 * (`/?view=mate&create=<draft>` / `/?view=mate&avatar=<mate>`; back closes it, a reload resumes the draft).
 *
 * The making on the LEFT, as a canvas (StudioCanvas: who she is → what she will look like and what it costs → the
 * candidates → the base picture → every set's pictures and clips, made at the same time → the checks → the mate; or,
 * for a look from a file, the file → her emotions matched to it → the mate). On the RIGHT two tabs: 가이드 (StudioGuide:
 * the steps in order, one at a time, with the fields each takes) and AI (the creation agent: its conversation and
 * cards — concept directions, choices, sliders, uploads, the estimate with Confirm). A click on a node or a step opens
 * its window in the middle of the screen (NodeSheet): the agent's fills glow there, the user edits anything and the
 * agent hears what changed before its next turn. Header: the title, the draft's name, the credits, drafts, Save draft &
 * exit, Discard, Create mate. The same screen edits an existing mate (메이트 편집 in the Mate view: everything about
 * her — profile, style, temperament, look and wardrobe, voice, model) and makes an outfit.
 *
 * Desktop: the canvas and the right side with a splitter (its width remembered; it folds to a rail). Phone: three tabs
 * (Guide | Canvas | AI), Canvas marked when the agent changed something there or a decision waits.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  avatarEnv,
  checkpoint,
  deleteProject,
  discardDraft,
  finishStudio,
  getProject,
  listDrafts,
  listProjects,
  openStudio,
  patchStudioFields,
  pauseRun,
  resumeRun,
  skipAvatar,
  studioTemplate,
  studioVoiceOk,
  undoStudioField,
  type AvatarEnv,
  type AvatarProject,
  type DraftSummary,
  type ProjectSummary,
  type StudioFieldsPatch,
} from "../../../api/avatar";
import type { Mate } from "../../../api/mates";
import { useNarrowerThan, usePhone, useTouchFirst } from "../../../lib/device";
import { cameFrom, goBack } from "../../../lib/nav";
import { useMateConversation } from "../../../mate/useMateConversation";
import { useMateStore } from "../../../stores/mateStore";
import { useStudio } from "../../../stores/studioStore";
import { useLang, useT, type MsgKey } from "../../../i18n";
import Icon, { type IconName } from "../../ui/Icon";
import AvatarChat from "../avatar/AvatarChat";
import { StatusPill, StepBar, type Act } from "../avatar/AvatarPanel";
import { useAgentChat } from "../avatar/useAgentChat";
import { MateThumb } from "../MateStage";
import NewMateDialog, { type NewMateTab } from "../NewMateDialog";
import type { FieldsApi } from "./fields";
import { lookPathOf, type Checked, type GuideStepId, type LookPath } from "./guide";
import StudioGuide from "./StudioGuide";
import type { SectionId } from "./StudioSettings";
import StudioCanvas, { type CanvasActivity } from "./canvas/StudioCanvas";
import NodeSheet from "./canvas/NodeSheet";
import { nodesOfTool, progressOf, waitingFor, type NodeKey } from "./canvas/graph";
import { useAvatarChat } from "../avatar/useAgentChat";
import { confirmDialog, ifConfirmed } from "../../ui/ConfirmDialog";

const LIVE = new Set(["running", "waiting"]);
const CHAT_KEY = "hrh_studio_chat";
const CHAT_DEFAULT = 400;
const CHAT_MIN = 340;
const CANVAS_MIN = 420;
const CHAT_FOLDED = "hrh_studio_chat_folded";
const SIDE_KEY = "hrh_studio_side";
const GUIDE_KEY = (pid: string) => `hrh_studio_guide_${pid}`;

/** the guide's own state for a project, in this browser: the steps looked at, how her look is made */
function useGuideState(pid: string | null): { checked: Checked; look: LookPath | null; check: (s: GuideStepId | "file", on?: boolean) => void; setLook: (p: LookPath | null) => void } {
  const read = () => {
    try {
      const v = pid ? JSON.parse(localStorage.getItem(GUIDE_KEY(pid)) || "{}") : {};
      return { checked: (v.checked ?? {}) as Checked, look: (v.look ?? null) as LookPath | null };
    } catch {
      return { checked: {}, look: null };
    }
  };
  const [st, setSt] = useState(read);
  useEffect(() => setSt(read()), [pid]); // eslint-disable-line react-hooks/exhaustive-deps
  // (from the latest state: two changes in one go both stay)
  const put = (change: (s: { checked: Checked; look: LookPath | null }) => { checked: Checked; look: LookPath | null }) =>
    setSt((prev) => {
      const next = change(prev);
      try {
        if (pid) localStorage.setItem(GUIDE_KEY(pid), JSON.stringify(next));
      } catch {
        /* private mode: for this visit */
      }
      return next;
    });
  return {
    ...st,
    check: (s, on = true) => put((x) => ({ ...x, checked: { ...x.checked, [s]: on } })),
    setLook: (look) => put((x) => ({ ...x, look, checked: look === null ? { ...x.checked, look: false } : x.checked })),
  };
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : Number(n.toFixed(1)).toLocaleString());

/** a flat field path → the patch the server takes */
function patchOf(path: string, value: unknown): StudioFieldsPatch {
  if (path === "name") return { name: String(value ?? "") };
  const [head, a, b] = path.split(".");
  if (head === "persona") return { persona: { [a]: value } as StudioFieldsPatch["persona"] };
  if (head === "prefs") return a === "tone" ? { prefs: { tone: { [b]: value } } } : { prefs: { [a]: value } };
  if (head === "concept") return { concept: { [a]: String(value ?? "") } };
  return {};
}

/** a small dropdown (drafts, projects, more): closes on a press outside or Escape */
function Menu({ label, icon, children, testId, align = "right", compact }: { label: string; icon: IconName; children: (close: () => void) => ReactNode; testId: string; align?: "left" | "right"; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button className={`btn-ghost !px-2.5 text-[12.5px] ${open ? "!bg-surface-3 !text-content" : ""}`} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} data-testid={testId}>
        <Icon name={icon} size={15} />
        {!compact && <span className="ml-1">{label}</span>}
      </button>
      {open && (
        <div className={`absolute top-10 z-50 w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-border bg-surface-2 py-1 shadow-float animate-fade-in ${align === "right" ? "right-0" : "left-0"}`} role="menu" data-testid={`${testId}-menu`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, children, onClick, danger, testId, active }: { icon: IconName; children: ReactNode; onClick: () => void; danger?: boolean; testId?: string; active?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-surface-3 ${danger ? "text-danger" : active ? "text-content" : "text-content-dim hover:text-content"}`} data-testid={testId}>
      <Icon name={icon} size={13} className="shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {active && <Icon name="check" size={12} className="text-accent" />}
    </button>
  );
}

/** the run, above the canvas: how far the making is, what happens now, what waits for the user (a press opens it),
 *  and the run's own controls */
function RunBar({ project, creating, activity, act, onShow }: { project: AvatarProject; creating: boolean; activity: CanvasActivity; act: Act; onShow: (node: string) => void }) {
  const t = useT();
  const studio = project.studio;
  const missing = studio?.missing ?? [];
  const needs = creating ? 2 : 0;
  const prog = progressOf(project, { needs, filled: needs - Math.min(needs, missing.length), skipped: !!studio?.avatar_skipped });
  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
  const wait = waitingFor(project);
  const running = project.status === "running";
  const live = running || project.status === "waiting";
  const label = wait
    ? t(wait === "extra" ? "studio.wait_extra" : wait === "estimate" ? "studio.cvWaitEstimate" : (`studio.wait_${wait}` as MsgKey))
    : project.status === "paused"
      ? t("avatar.status_paused")
      : project.status === "failed"
        ? t("avatar.status_failed")
        : running
          ? t("studio.making", { what: t(`studio.phase_${project.phase || "design"}` as MsgKey) })
          : project.status === "ready" || project.status === "applied"
            ? t("studio.cvAllReady")
            : activity.working.size
              ? t("studio.cvAgentWriting")
              : activity.thinking
                ? t("studio.cvThinking")
                : creating
                  ? t("studio.cvIdle")
                  : t("studio.cvIdleEdit");
  const waitNode = wait === "pick" ? "candidates" : wait === "home" ? "home" : wait === "stills" ? "set:faces" : wait ? "estimate" : null;
  return (
    <div className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 sm:px-4 ${wait ? "border-warning/30 bg-warning/[0.06]" : "border-border/60 bg-surface/60"}`} data-testid="studio-run" data-status={project.status} data-wait={wait ?? ""}>
      {/* (how far the making is: once there is a run to count; the guide counts the steps) */}
      {(project.plan || project.confirmation) && (
        <>
          <span className="shrink-0 text-[12px] font-semibold tabular-nums text-content" data-testid="studio-progress">
            {t("studio.cvProgress", { done: prog.done, total: prog.total })}
          </span>
          <span className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-surface-3 sm:w-32" aria-hidden>
            <span className="block h-full rounded-full bg-success transition-[width] duration-700 ease-out" style={{ width: `${pct}%` }} />
          </span>
        </>
      )}
      <span className={`flex min-w-0 flex-1 items-center gap-1.5 text-[12px] ${wait ? "text-warning" : running ? "text-accent" : "text-content-dim"}`}>
        <Icon name={wait ? "bell" : running ? "spinner" : project.status === "paused" ? "pause" : "sparkles"} size={12} spin={running && !wait} className="shrink-0" />
        <span className="truncate" data-testid="studio-run-label">{label}</span>
      </span>
      {project.confirmation && (
        <span className="hidden shrink-0 text-[11.5px] tabular-nums text-content-faint sm:inline">
          {t("studio.creditsSpent", { spent: fmt(project.credits.committed), cap: fmt(project.credits.cap) })}
        </span>
      )}
      {waitNode && (
        <button className="shrink-0 rounded-md px-2.5 py-0.5 text-[11.5px] font-medium text-warning hover:bg-warning/10" onClick={() => onShow(waitNode)} data-testid="studio-run-show">
          {t("studio.filledShow")}
        </button>
      )}
      {live && !project.paused && (
        <button className="btn-ghost shrink-0 !px-2 !py-0.5 text-[11.5px]" onClick={() => act(() => pauseRun(project.id))} data-testid="studio-run-pause">
          <Icon name="pause" size={11} /> {t("avatar.pause")}
        </button>
      )}
      {(project.status === "paused" || project.status === "failed") && project.confirmation && (
        <button className="btn-soft shrink-0 !px-2 !py-0.5 text-[11.5px]" onClick={() => act(() => resumeRun(project.id))} data-testid="studio-run-resume">
          <Icon name="play" size={11} /> {t("avatar.resume")}
        </button>
      )}
    </div>
  );
}

/** the agent's width: dragged from its left edge (its width in pixels, remembered), double-click for the default */
function ChatSplitter({ width, onChange, container }: { width: number; onChange: (w: number, save?: boolean) => void; container: React.RefObject<HTMLDivElement> }) {
  const t = useT();
  const clamp = (w: number) => {
    const total = container.current?.clientWidth || 1400;
    return Math.round(Math.min(total - CANVAS_MIN, Math.max(CHAT_MIN, w)));
  };
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    let last = width;
    const move = (ev: PointerEvent) => {
      last = clamp(rect.right - ev.clientX);
      onChange(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onChange(last, true);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("studio.splitter")}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={down}
      onDoubleClick={() => onChange(clamp(CHAT_DEFAULT), true)}
      onKeyDown={(e) => {
        const step = e.key === "ArrowLeft" ? 40 : e.key === "ArrowRight" ? -40 : 0;
        if (step) {
          e.preventDefault();
          onChange(clamp(width + step), true);
        } else if (e.key === "Home" || e.key === "Enter") {
          e.preventDefault();
          onChange(clamp(CHAT_DEFAULT), true);
        }
      }}
      className="group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize outline-none"
      data-testid="studio-splitter"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/80 transition group-hover:w-[3px] group-hover:bg-accent/50 group-focus-visible:w-[3px] group-focus-visible:bg-accent" />
    </div>
  );
}

/** what the creation agent works on right now: its running tools' nodes, or thinking (a turn with no tool going) */
function useActivity(streaming: boolean): CanvasActivity {
  const turns = useAvatarChat((s) => s.turns);
  return useMemo(() => {
    const working = new Set<NodeKey>();
    const last = [...turns].reverse().find((x) => x.role === "assistant");
    let tools = 0;
    if (streaming && last && !last.complete) {
      for (const tool of last.tools) {
        if (tool.durationMs !== undefined) continue;
        tools++;
        for (const k of nodesOfTool(tool.name, tool.input)) working.add(k);
      }
    }
    return { working, thinking: streaming && tools === 0 };
  }, [turns, streaming]);
}

/** a section of the old right side (the agent's "Show", a step) → its node on the canvas */
function nodeOfSection(id: string, p: AvatarProject): string {
  if (id !== "avatar") return id;
  const w = waitingFor(p);
  if (w === "pick") return "candidates";
  if (w === "home") return "home";
  if (w === "stills") return "set:faces";
  if (w) return "estimate";
  if (p.status === "ready" || p.status === "applied") return "mate";
  return p.plan || p.confirmation ? "estimate" : "brief";
}

export default function MateStudio() {
  const t = useT();
  const lang = useLang();
  // (both columns' least widths: beside the sidebar a tablet or a small window has less, whatever the viewport)
  const [narrow, rootRef] = useNarrowerThan(CANVAS_MIN + CHAT_MIN);
  const phone = usePhone() || narrow;
  const touch = useTouchFirst();
  const kind = useStudio((s) => s.kind);
  const wantMate = useStudio((s) => s.mateId);
  const wantProject = useStudio((s) => s.projectId);
  const starting = useStudio((s) => s.starting);
  const startError = useStudio((s) => s.startError);
  const [project, setProject] = useState<AvatarProject | null>(null);
  const [env, setEnv] = useState<AvatarEnv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  /** the phone's tab */
  const [tab, setTab] = useState<"guide" | "canvas" | "agent">("guide");
  /** the right side's tab (desktop) */
  const [side, setSideState] = useState<"guide" | "agent">(() => (localStorage.getItem(SIDE_KEY) === "agent" ? "agent" : "guide"));
  const setSide = (v: "guide" | "agent") => {
    setSideState(v);
    try {
      localStorage.setItem(SIDE_KEY, v);
    } catch {
      /* private mode */
    }
  };
  /** the node or tile whose sheet is open over the canvas */
  const [sheet, setSheet] = useState<string | null>(null);
  const [dialog, setDialog] = useState<NewMateTab | null>(null);
  const [template, setTemplate] = useState(false);
  const [saving, setSaving] = useState<{ n: number; error: string | null }>({ n: 0, error: null });
  const since = useRef(Date.now()).current;
  const pid = project?.id ?? null;

  const reloadEnv = useCallback(() => {
    avatarEnv().then(setEnv).catch(() => {});
  }, []);
  useEffect(reloadEnv, [reloadEnv]);

  /** a view from the server: the project, and its mate into the store (drafts apart — never in the picker) */
  const take = useCallback((p: AvatarProject) => {
    setProject(p);
    if (p.studio?.mate) useMateStore.getState().upsert(p.studio.mate);
  }, []);

  // open: the draft's project, the mate's latest (or the one asked for)
  useEffect(() => {
    if (!wantMate || wantMate === "new") return;
    let alive = true;
    setProject(null);
    setError(null);
    setGone(false);
    (async () => {
      try {
        const p = wantProject ? await getProject(wantProject) : await openStudio({ mate_id: wantMate, language: lang });
        if (alive) take(p);
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
        setGone(true);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantMate, wantProject, kind]);

  const load = useCallback(async () => {
    if (!pid) return;
    try {
      take(await getProject(pid));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [pid, take]);
  const loadRef = useRef(load);
  loadRef.current = load;
  const live = !!project && (LIVE.has(project.status) || project.agent_running || !!project.processing);
  useEffect(() => {
    if (!pid) return;
    const timer = setInterval(() => void loadRef.current(), live ? 2500 : 10000);
    return () => clearInterval(timer);
  }, [pid, live]);

  const chat = useAgentChat(project?.session_id ?? null, () => void loadRef.current());
  const activity = useActivity(chat.streaming);

  // the mate: the newest copy of the server's view and the store's (a settings tab saved it)
  const storeDraft = useMateStore((s) => (project?.studio ? s.drafts[project.studio.mate_id] : undefined));
  const storeMate = useMateStore((s) => (project?.studio ? s.mates.find((m) => m.id === project.studio!.mate_id) : undefined));
  const mate = useMemo(() => {
    const all = [project?.studio?.mate, storeDraft, storeMate].filter(Boolean) as Mate[];
    return all.sort((a, b) => (b.updated_at > a.updated_at ? 1 : b.updated_at < a.updated_at ? -1 : 0))[0] ?? null;
  }, [project?.studio?.mate, storeDraft, storeMate]);
  // the voice test (a draft has no conversation: only her voice)
  const conv = useMateConversation(mate, { connect: false });

  const act: Act = async (fn) => {
    setBusy(true);
    try {
      const r = (await fn()) as any;
      if (r && typeof r === "object") {
        if ("project" in r && r.project) take(r.project);
        else if ("id" in r && "brief" in r) take(r as AvatarProject);
        if (r.mate) useMateStore.getState().upsert(r.mate);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void load();
    }
  };

  const api: FieldsApi = useMemo(
    () => ({
      filled: project?.studio?.filled ?? {},
      since,
      save: async (path, value) => {
        if (!pid) return;
        setSaving((s) => ({ n: s.n + 1, error: null }));
        try {
          take(await patchStudioFields(pid, patchOf(path, value)));
          setSaving((s) => ({ n: s.n - 1, error: null }));
        } catch (e) {
          setSaving((s) => ({ n: s.n - 1, error: (e as Error).message }));
        }
      },
      undo: async (path) => {
        if (!pid) return;
        try {
          take(await undoStudioField(pid, path));
        } catch (e) {
          setSaving((s) => ({ ...s, error: (e as Error).message }));
        }
      },
    }),
    [pid, project?.studio?.filled, since, take],
  );

  /** open a node's window (a node or tile key, or a section: the agent's "Show") */
  const show = (id: SectionId | string) => {
    if (!project) return;
    setSheet(nodeOfSection(id, project));
  };
  // 메이트 편집 opened on one of its windows (her wardrobe from the outfits window, …): once she is there
  useEffect(() => {
    if (!pid) return;
    const n = useStudio.getState().takeNode();
    if (n) setSheet(n);
  }, [pid]);
  const guide = useGuideState(pid);

  // ── phone: the Settings tab is marked when the agent filled something there (or a decision waits) ──
  const fills = useMemo(() => Object.values(project?.studio?.filled ?? {}).map((e) => e.at), [project?.studio?.filled]);
  const [seenFills, setSeenFills] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (tab === "canvas" || !phone) setSeenFills(new Set(fills));
  }, [tab, phone, fills]);
  const unseen = fills.filter((a) => !seenFills.has(a)).length;
  const waits = !!project && (project.status === "waiting" || project.extras.some((x) => x.status === "pending") || (project.status === "estimate" && !!project.plan && !project.confirmation));

  // ── the agent's width (folds to a rail) ──
  const box = useRef<HTMLDivElement>(null);
  const [chatW, setChatW] = useState(() => {
    const v = Number(localStorage.getItem(CHAT_KEY));
    return v >= CHAT_MIN && v < 2400 ? v : CHAT_DEFAULT;
  });
  const [folded, setFolded] = useState(() => localStorage.getItem(CHAT_FOLDED) === "1");
  const onChatW = (w: number, save?: boolean) => {
    setChatW(w);
    if (save) localStorage.setItem(CHAT_KEY, String(w));
  };
  const fold = (on: boolean) => {
    setFolded(on);
    localStorage.setItem(CHAT_FOLDED, on ? "1" : "0");
  };

  // ── leaving ──
  const exit = () => {
    if (cameFrom("/?view=mate")) goBack();
    else useStudio.getState().close();
  };
  const created = !!project?.studio?.finished_at;
  /** still making a new mate (once created, her project is an avatar studio like any mate's) */
  const isNew = project?.studio?.kind === "new" && !created;
  /** a forward / reload onto a draft that was created meanwhile */
  const createdHere = kind === "create" && created;
  const missing = project?.studio?.missing ?? [];
  const finish = async () => {
    if (!pid || busy) return;
    setBusy(true);
    try {
      const r = await finishStudio(pid);
      const st = useMateStore.getState();
      st.upsert(r.mate);
      st.setActive(r.mate.id);
      useStudio.getState().note(t("studio.createdInfo", { name: r.mate.name }));
      useStudio.getState().askGuide(r.mate.id); // (her guide, once the Mate view is back)
      exit();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!pid || !(await confirmDialog({ body: t("studio.discardConfirm", { name: mate?.name || t("studio.untitled") }), confirmLabel: t("studio.discard"), danger: true }))) return;
    try {
      await discardDraft(pid);
      useStudio.getState().note(t("studio.discarded"));
      exit();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const openHer = () => {
    if (mate) useMateStore.getState().setActive(mate.id);
    exit();
  };

  // ── drafts / projects menus ──
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const loadDrafts = () => listDrafts().then(setDrafts).catch(() => setDrafts([]));
  const loadProjects = () => listProjects().then(setProjects).catch(() => setProjects([]));
  useEffect(() => {
    if (kind === "create") void loadDrafts();
    if (!isNew) void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, pid, isNew]);
  const mates = useMateStore((s) => s.mates);

  const title = isNew || (kind === "create" && !created)
    ? t("studio.titleNew")
    : project?.outfit
      ? t("studio.titleOutfit", { name: mate?.name || "" })
      : t("studio.titleEdit", { name: mate?.name || "" });
  const name = mate ? mate.name || t("studio.untitled") : "";
  const credits = project?.confirmation ? (
    <span className="pill bg-surface-3 tabular-nums text-content-dim" title={t("avatar.creditsCounted")} data-testid="studio-credits">
      <Icon name="sparkles" size={11} /> {t("studio.creditsSpent", { spent: fmt(project.credits.committed), cap: fmt(project.credits.cap) })}
    </span>
  ) : project?.plan ? (
    <span className="pill bg-accent-soft tabular-nums text-content" data-testid="studio-credits">
      <Icon name="sparkles" size={11} /> {t("studio.creditsEstimate", { total: fmt(project.plan.total) })}
    </span>
  ) : null;

  const draftsMenu = kind === "create" && (
    <Menu label={t("studio.drafts", { count: drafts?.length ?? 0 })} icon="files" testId="studio-drafts" compact={phone}>
      {(close) => (
        <>
          <div className="px-3 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-content-faint">{t("studio.draftsTitle")}</div>
          <div className="max-h-64 overflow-y-auto">
            {(drafts ?? []).map((d) => (
              <button
                key={d.project_id}
                role="menuitem"
                className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-3 ${d.project_id === pid ? "text-content" : "text-content-dim"}`}
                onClick={() => {
                  close();
                  if (d.project_id !== pid) useStudio.getState().openCreate(d.mate_id);
                }}
                data-testid="studio-draft-item"
              >
                {d.thumb ? <img src={d.thumb} alt="" className="h-8 w-8 shrink-0 rounded-lg object-cover object-top" /> : <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-[12px] font-semibold">{[...(d.name || "?")][0]}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{d.name || t("studio.untitled")}</span>
                  <span className="block truncate text-[11px] text-content-faint">{d.pitch || t(`avatar.status_${d.status}` as MsgKey)}</span>
                </span>
                {d.project_id === pid && <Icon name="check" size={12} className="text-accent" />}
              </button>
            ))}
          </div>
          <div className="border-t border-border/70 pt-1">
            <MenuItem
              icon="plus"
              onClick={() => {
                close();
                void useStudio.getState().startNew();
              }}
              testId="studio-draft-new"
            >
              {t("studio.startAnother")}
            </MenuItem>
          </div>
        </>
      )}
    </Menu>
  );

  const projectsMenu = !isNew && !!project && mate && (
    <Menu label={t("avatar.projects")} icon="files" testId="studio-projects" compact={phone}>
      {(close) => (
        <>
          <div className="max-h-64 overflow-y-auto">
            {(projects ?? [])
              .filter((p) => p.mate_id === mate.id)
              .map((p) => (
                <div key={p.id} className="flex items-center">
                  <MenuItem
                    icon="image"
                    active={p.id === pid}
                    onClick={() => {
                      close();
                      if (p.id !== pid) useStudio.getState().setProject(p.id);
                    }}
                    testId="studio-project-item"
                  >
                    <span className="block truncate">{p.outfit ? p.outfit.name : new Date(p.created_at).toLocaleString()}</span>
                    <span className="block text-[11px] text-content-faint">{t(`avatar.status_${p.status}` as MsgKey)}</span>
                  </MenuItem>
                  {p.id !== pid && !LIVE.has(p.status) && (
                    <button
                      className="btn-ghost !px-2 text-content-faint"
                      aria-label={t("common.delete")}
                      onClick={() => ifConfirmed({ body: t("avatar.deleteConfirm", { name: p.title }), confirmLabel: t("common.delete"), danger: true }, () => deleteProject(p.id).then(loadProjects))}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </div>
              ))}
          </div>
          <div className="border-t border-border/70 pt-1">
            <MenuItem
              icon="plus"
              onClick={async () => {
                close();
                try {
                  const p = await openStudio({ mate_id: mate.id, language: lang, fresh: true });
                  useStudio.getState().setProject(p.id);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              testId="studio-project-new"
            >
              {t("studio.newAvatarProject")}
            </MenuItem>
          </div>
        </>
      )}
    </Menu>
  );

  const moreMenu = isNew && (
    <Menu label={t("studio.more")} icon="more" testId="studio-more" compact>
      {(close) => (
        <>
          <MenuItem
            icon="user"
            onClick={() => {
              close();
              setTemplate(true);
            }}
            testId="studio-template"
          >
            {t("studio.fromTemplate")}
          </MenuItem>
          <MenuItem
            icon="download"
            onClick={() => {
              close();
              setDialog("import");
            }}
            testId="studio-import"
          >
            {t("studio.importPack")}
          </MenuItem>
          <MenuItem
            icon="pencil"
            onClick={() => {
              close();
              setDialog("blank");
            }}
            testId="studio-quick"
          >
            {t("studio.quickCreate")}
          </MenuItem>
          <div className="my-1 border-t border-border/70" />
          <MenuItem
            icon="trash"
            danger
            onClick={() => {
              close();
              void discard();
            }}
            testId="studio-discard"
          >
            {t("studio.discard")}
          </MenuItem>
        </>
      )}
    </Menu>
  );

  const createBtn = isNew && (
    <button
      className={`btn-primary ${phone ? "!px-2.5 !py-1.5 text-[12.5px]" : ""}`}
      onClick={finish}
      disabled={busy || missing.length > 0}
      title={missing.length ? t("studio.createNeeds", { what: missing.map((m) => t(`studio.need_${m.split(" ")[0].replace(".", "_")}` as MsgKey)).join(", ") }) : t("studio.createTitle")}
      data-testid="studio-create"
    >
      {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="check" size={14} />} {phone ? t("studio.createShort") : t("studio.create")}
    </button>
  );

  const header = (
    <div className="relative z-30 shrink-0 border-b border-border/70 bg-surface/80 pt-safe backdrop-blur-xl" data-testid="studio-header">
      <div className={`flex items-center gap-2 px-2 sm:px-3 ${phone ? "h-12" : "h-14"}`}>
        <button className="btn-ghost !px-2" onClick={exit} aria-label={isNew ? t("studio.saveExit") : t("avatar.close")} title={isNew ? t("studio.saveExit") : t("avatar.close")} data-testid="studio-back">
          <Icon name="chevron-left" size={17} />
        </button>
        {mate && !phone && <MateThumb mate={mate} className="h-8 w-8" />}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex min-w-0 items-center gap-1.5">
            <Icon name={isNew || project?.outfit ? "sparkles" : "pencil"} size={13} className="shrink-0 text-accent" />
            <h1 className="truncate text-[14px] font-semibold" data-testid="studio-title">
              {title}
            </h1>
            {!phone && project && !isNew && project.status !== "interview" && <StatusPill project={project} />}
          </div>
          {(isNew || createdHere) && (
            <div className="truncate text-[11.5px] text-content-faint" data-testid="studio-draft-name">
              {created ? t("studio.createdLine", { name }) : t("studio.draftLine", { name })}
            </div>
          )}
        </div>
        {!phone && credits}
        {draftsMenu}
        {projectsMenu}
        {moreMenu}
        {!phone && isNew && (
          <button className="btn-ghost text-[12.5px]" onClick={exit} data-testid="studio-save-exit">
            {t("studio.saveExit")}
          </button>
        )}
        {createdHere && (
          <button className="btn-primary" onClick={openHer} data-testid="studio-open-her">
            {t("studio.openHer", { name })}
          </button>
        )}
        {!isNew && !createdHere && !phone && (
          <button className="btn-soft" onClick={exit} data-testid="studio-done">
            {t("studio.done")}
          </button>
        )}
        {createBtn}
      </div>
      {/* (a run going: its steps; the guide has the rest) */}
      {project && mate && (project.plan || project.confirmation) && (
        <div className={`border-t border-border/50 px-3 [@media(max-height:500px)]:hidden ${phone ? "py-1.5" : "py-2"}`}>
          <div className={phone ? "" : "flex justify-center"}>
            <StepBar project={project} nowrap={phone} />
          </div>
          {phone && credits && <div className="mt-1.5 flex">{credits}</div>}
        </div>
      )}
    </div>
  );

  const banner = (error || startError) && !gone && (
    <div className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-danger/10 px-3 py-1.5 text-[12px] text-danger" data-testid="studio-error">
      <Icon name="warning" size={12} />
      <span className="min-w-0 flex-1 break-words">{error || startError}</span>
      <button onClick={() => setError(null)} aria-label={t("common.dismiss")}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );

  const dialogs = (
    <>
      <NewMateDialog
        open={dialog !== null}
        initialTab={dialog ?? "blank"}
        onClose={() => setDialog(null)}
        onDone={(msg) => {
          setDialog(null);
          if (msg) useStudio.getState().note(msg);
          exit();
        }}
      />
      {template && (
        <div className="fixed inset-0 z-[70] grid place-items-center p-4">
          <div className="absolute inset-0 bg-scrim/55 animate-fade-in" onClick={() => setTemplate(false)} />
          <div className="card relative w-full max-w-sm p-5 animate-fade-in" role="dialog" aria-modal="true" aria-label={t("studio.fromTemplate")} data-testid="studio-template-dialog">
            <h2 className="text-[15px] font-semibold">{t("studio.fromTemplate")}</h2>
            <p className="mt-1 text-[12px] text-content-faint">{t("studio.templateHint")}</p>
            <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
              {mates.map((m) => (
                <button
                  key={m.id}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-3"
                  onClick={async () => {
                    setTemplate(false);
                    if (pid) await act(() => studioTemplate(pid, m.id));
                  }}
                  data-testid="studio-template-item"
                >
                  <MateThumb mate={m} className="h-7 w-7" />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                </button>
              ))}
            </div>
            <div className="mt-3 flex justify-end">
              <button className="btn-ghost" onClick={() => setTemplate(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // ── not there (yet) ──
  if (!project || !mate) {
    return (
      <div ref={rootRef} className="flex h-full flex-col" data-testid="mate-studio" data-state={gone ? "gone" : "loading"}>
        {header}
        <div className="grid flex-1 place-items-center p-6 text-center">
          {gone ? (
            <div className="max-w-sm" data-testid="studio-gone">
              <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-surface-3 text-content-faint">
                <Icon name="warning" size={18} />
              </span>
              <p className="mt-3 text-[13.5px] font-medium">{kind === "create" ? t("studio.goneDraft") : t("studio.goneMate")}</p>
              {error && <p className="mt-1 text-[12px] text-content-faint">{error}</p>}
              <div className="mt-4 flex justify-center gap-2">
                <button className="btn-ghost" onClick={exit}>
                  {t("avatar.close")}
                </button>
                {kind === "create" && (
                  <button className="btn-primary" onClick={() => void useStudio.getState().startNew()}>
                    <Icon name="plus" size={14} /> {t("studio.startAnother")}
                  </button>
                )}
              </div>
            </div>
          ) : startError ? (
            <div className="max-w-sm text-[12.5px] text-danger">{startError}</div>
          ) : (
            <div className="flex flex-col items-center gap-3 text-content-faint" data-testid="studio-loading">
              <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent-soft text-accent">
                <Icon name="sparkles" size={18} />
              </span>
              <span className="flex items-center gap-1.5 text-[13px]">
                <Icon name="spinner" size={13} spin /> {starting ? t("studio.starting") : t("common.loading")}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  const agent = (
    <AvatarChat
      project={project}
      env={env}
      act={act}
      chat={chat}
      onShow={(sec) => show(sec)}
      placeholder={isNew ? t("studio.composerNew") : undefined}
    />
  );
  const look = lookPathOf(project, mate, guide.look);
  const toAi = (text: string) => {
    setSide("agent");
    if (phone) setTab("agent");
    setSheet(null);
    if (!chat.send(text)) setError(t("studio.aiOffline"));
  };
  const pickLook = (path: LookPath | null) => {
    guide.setLook(path);
    // (later: the avatar is skipped on the server, so Create needs nothing more; another way takes it back)
    if (isNew && pid) {
      if (path === "later" && !project.studio?.avatar_skipped) void act(() => skipAvatar(pid, true));
      else if (path !== "later" && project.studio?.avatar_skipped) void act(() => skipAvatar(pid, false));
    }
  };
  const guideEl = (
    <StudioGuide
      project={project}
      mate={mate}
      creating={isNew}
      env={env}
      reloadEnv={reloadEnv}
      api={api}
      busy={busy}
      streaming={chat.streaming}
      checked={guide.checked}
      onCheck={guide.check}
      look={look}
      onLook={pickLook}
      onOpen={setSheet}
      onAi={toAi}
      onCreate={isNew ? finish : undefined}
      onDone={exit}
    />
  );
  const sheetEl = sheet && (
    <NodeSheet
      key={sheet}
      node={sheet}
      project={project}
      mate={mate}
      env={env}
      creating={isNew}
      act={act}
      reloadEnv={reloadEnv}
      conv={conv}
      api={api}
      busy={busy}
      send={(text) => chat.send(text)}
      onClose={() => setSheet(null)}
      onOpen={setSheet}
      onVoiceTested={() => pid && void studioVoiceOk(pid).then(take).catch(() => {})}
      onSkip={(skip) => pickLook(skip ? "later" : null)}
      onCreate={isNew ? finish : undefined}
      onAi={toAi}
      look={look}
      onLook={pickLook}
      onCheck={guide.check}
    />
  );
  const approve = () => pid && void act(() => checkpoint(pid, "approve"));
  const canvas = (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <RunBar project={project} creating={isNew} activity={activity} act={act} onShow={show} />
      {(saving.n > 0 || saving.error) && (
        <div className={`absolute right-3 top-12 z-[6] rounded-full border px-2.5 py-0.5 text-[11px] ${saving.error ? "border-danger/40 bg-danger/10 text-danger" : "border-border bg-surface-2 text-content-faint"}`} data-testid="studio-save-state" aria-live="polite">
          {saving.error ? saving.error : t("studio.saving")}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <StudioCanvas project={project} mate={mate} creating={isNew} activity={activity} open={sheet} busy={busy} onOpen={setSheet} onApprove={approve} onCreate={isNew ? finish : undefined} fileMode={look === "file" && !project.outfit} />
      </div>
    </div>
  );

  const aiDot = chat.streaming && <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-accent" />;
  if (phone) {
    const tabBtn = (id: "guide" | "canvas" | "agent", icon: IconName, label: string, extra?: ReactNode) => (
      <button role="tab" aria-selected={tab === id} className="nav-tab inline-flex flex-1 items-center justify-center gap-1.5" data-active={tab === id} onClick={() => setTab(id)} data-testid={`studio-tab-${id}`}>
        <Icon name={icon} size={13} /> {label}
        {extra}
      </button>
    );
    return (
      <div ref={rootRef} className="touch-ui flex h-full flex-col" data-testid="mate-studio" data-kind={kind} data-layout="tabs">
        {header}
        <div className="flex shrink-0 gap-1 border-b border-border/60 px-3 py-1.5" role="tablist">
          {tabBtn("guide", "map", t("studio.tabGuide"))}
          {tabBtn(
            "canvas",
            "layers",
            t("studio.tabCanvas"),
            tab !== "canvas" && unseen > 0 ? (
              <span className="ml-1 rounded-full bg-success px-1.5 text-[10px] font-semibold leading-4 text-white" data-testid="studio-canvas-badge">
                {unseen}
              </span>
            ) : (
              tab !== "canvas" && waits && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-warning" data-testid="studio-canvas-dot" />
            ),
          )}
          {tabBtn("agent", "sparkles", t("studio.tabAgent"), aiDot)}
        </div>
        {banner}
        {/* (all stay mounted: switching tabs keeps the conversation's scroll and the canvas's camera) */}
        <div className={`min-h-0 flex-1 flex-col pb-safe ${tab === "guide" ? "flex" : "hidden"}`}>{guideEl}</div>
        <div className={`min-h-0 flex-1 flex-col ${tab === "agent" ? "flex" : "hidden"}`}>{agent}</div>
        <div className={`min-h-0 flex-1 flex-col pb-safe ${tab === "canvas" ? "flex" : "hidden"}`}>{canvas}</div>
        {sheetEl}
        {dialogs}
      </div>
    );
  }
  return (
    <div ref={rootRef} className={`flex h-full flex-col ${touch ? "touch-ui" : ""}`} data-testid="mate-studio" data-kind={kind} data-layout="split">
      {header}
      {banner}
      <div className="flex min-h-0 flex-1" ref={box}>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ minWidth: CANVAS_MIN }} aria-label={t("studio.tabCanvas")} data-testid="studio-left">
          {canvas}
        </section>
        {folded ? (
          <section className="flex w-11 shrink-0 flex-col items-center gap-2 border-l border-border/70 bg-surface/40 py-3" aria-label={t("studio.sideLabel")} data-testid="studio-agent-rail">
            <button className="btn-ghost !p-2" onClick={() => fold(false)} title={t("studio.chatUnfold")} aria-label={t("studio.chatUnfold")} data-testid="studio-agent-unfold">
              <Icon name="map" size={16} />
            </button>
            {chat.streaming && <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-accent" />}
            {waits && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
          </section>
        ) : (
          <>
            <ChatSplitter width={chatW} onChange={onChatW} container={box} />
            <section className="relative flex min-h-0 shrink-0 flex-col border-l border-border/50 bg-surface/30" style={{ width: chatW }} aria-label={t("studio.sideLabel")} data-testid="studio-agent" data-side={side}>
              <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5" role="tablist">
                <button role="tab" aria-selected={side === "guide"} className="nav-tab inline-flex flex-1 items-center justify-center gap-1.5 !py-1" data-active={side === "guide"} onClick={() => setSide("guide")} data-testid="studio-side-guide">
                  <Icon name="map" size={13} /> {t("studio.tabGuide")}
                </button>
                <button role="tab" aria-selected={side === "agent"} className="nav-tab inline-flex flex-1 items-center justify-center gap-1.5 !py-1" data-active={side === "agent"} onClick={() => setSide("agent")} data-testid="studio-side-agent">
                  <Icon name="sparkles" size={13} /> {t("studio.tabAgent")}
                  {side !== "agent" && aiDot}
                </button>
                <button className="btn-ghost shrink-0 !p-1.5 text-content-faint" onClick={() => fold(true)} title={t("studio.chatFold")} aria-label={t("studio.chatFold")} data-testid="studio-agent-fold">
                  <Icon name="chevron-left" size={13} className="rotate-180" />
                </button>
              </div>
              {/* (both stay mounted: the conversation keeps its scroll) */}
              <div className={`min-h-0 flex-1 flex-col ${side === "guide" ? "flex" : "hidden"}`}>{guideEl}</div>
              <div className={`min-h-0 flex-1 flex-col ${side === "agent" ? "flex" : "hidden"}`}>{agent}</div>
            </section>
          </>
        )}
      </div>
      {sheetEl}
      {dialogs}
    </div>
  );
}
