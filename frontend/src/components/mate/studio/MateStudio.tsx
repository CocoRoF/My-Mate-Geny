/**
 * The Mate Create studio (메이트 만들기 — docs/avatar-create.md §11): a screen of the Mate view of its own
 * (`/?view=mate&create=<draft>` / `/?view=mate&avatar=<mate>`; back closes it, a reload resumes the draft).
 *
 * The creation agent on the LEFT (its conversation and cards: concept directions, choices, sliders, uploads, the
 * estimate with Confirm, progress, previews) — the settings of the mate being made on the RIGHT, live (Concept,
 * Profile, Conversation style, Avatar, Voice, Language model): the agent writes them (highlighted, undo per field),
 * the user edits any of them and the agent hears what changed before its next turn. Header: the title, the draft's
 * name, the steps (Concept → Personality → Look → Avatar → Voice → Done), the credits, drafts, Save draft & exit,
 * Discard, Create mate. The same layout for an existing mate's avatar (✨ in the Mate view, "Create with AI" in
 * Avatar settings), its Avatar section open.
 *
 * Desktop: two columns with a splitter (its position remembered). Phone: two tabs (Agent | Settings), Settings marked
 * when the agent changed something there or a decision waits.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  avatarEnv,
  deleteProject,
  discardDraft,
  finishStudio,
  getProject,
  listDrafts,
  listProjects,
  openStudio,
  patchStudioFields,
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
import { prefsOf, type Mate } from "../../../api/mates";
import { useNarrowerThan, usePhone, useTouchFirst } from "../../../lib/device";
import { useCenteredChild } from "../../../lib/scrollRow";
import { cameFrom, goBack } from "../../../lib/nav";
import { useMateConversation } from "../../../mate/useMateConversation";
import { useMateStore } from "../../../stores/mateStore";
import { useStudio } from "../../../stores/studioStore";
import { useLang, useT, type MsgKey } from "../../../i18n";
import Icon, { type IconName } from "../../ui/Icon";
import { SaveBarSlot } from "../settings/ui";
import AvatarChat from "../avatar/AvatarChat";
import { StatusPill, StepBar, type Act } from "../avatar/AvatarPanel";
import { useAgentChat } from "../avatar/useAgentChat";
import { MateThumb } from "../MateStage";
import NewMateDialog, { type NewMateTab } from "../NewMateDialog";
import type { FieldsApi } from "./fields";
import StudioSettings, { type SectionId } from "./StudioSettings";
import { confirmDialog, ifConfirmed } from "../../ui/ConfirmDialog";

const LIVE = new Set(["running", "waiting"]);
const SPLIT_KEY = "hrh_studio_split";
const SPLIT_DEFAULT = 0.47;
const MIN_LEFT = 340;
const MIN_RIGHT = 380;

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

// ── the steps of a new mate ──
type StepId = "concept" | "personality" | "look" | "avatar" | "voice" | "done";
const STEPS: { id: StepId; label: MsgKey; section: SectionId | null }[] = [
  { id: "concept", label: "studio.stepConcept", section: "concept" },
  { id: "personality", label: "studio.stepPersonality", section: "profile" },
  { id: "look", label: "studio.stepLook", section: "avatar" },
  { id: "avatar", label: "studio.stepAvatar", section: "avatar" },
  { id: "voice", label: "studio.stepVoice", section: "voice" },
  { id: "done", label: "studio.stepDone", section: null },
];

function stepsDone(p: AvatarProject, m: Mate): Record<StepId, boolean> {
  const st = p.studio!;
  const skipped = st.avatar_skipped;
  // (a new mate has no avatar until one is made or the user brings their own file)
  const own = m.avatar.kind !== "none";
  return {
    concept: !!(st.concept.pitch || (m.name.trim() && m.persona.description.trim())),
    personality: !!(m.persona.personality.trim() && prefsOf(m).speech_style.trim()),
    look: skipped || own || !!p.brief.design.prompt || p.brief.reference.files.length > 0 || p.status !== "interview",
    avatar: skipped || own || p.status === "ready" || p.status === "applied",
    voice: st.voice_ok,
    done: !!st.finished_at,
  };
}

function Steps({ project, mate, onPick, compact }: { project: AvatarProject; mate: Mate; onPick: (s: SectionId) => void; compact?: boolean }) {
  const t = useT();
  const done = stepsDone(project, mate);
  const cur = STEPS.findIndex((s) => !done[s.id]);
  const row = useCenteredChild<HTMLOListElement>(cur);
  return (
    <ol ref={row} className={`no-scrollbar flex items-center gap-1 overflow-x-auto ${compact ? "-mx-3 overscroll-x-contain px-3" : "justify-center"}`} data-testid="studio-steps" aria-label={t("studio.stepsLabel")}>
      {STEPS.map((s, i) => {
        const state = done[s.id] ? "done" : i === cur ? "current" : "todo";
        return (
          <li key={s.id} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span className={`h-px w-3 sm:w-5 ${done[STEPS[i - 1].id] ? "bg-success/50" : "bg-border"}`} aria-hidden />}
            <button
              type="button"
              disabled={!s.section}
              onClick={() => s.section && onPick(s.section)}
              className={`flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-[3px] text-[11.5px] transition ${
                state === "current"
                  ? "border-accent/60 bg-accent-soft font-medium text-content"
                  : state === "done"
                    ? "border-success/30 text-content-dim hover:bg-surface-3"
                    : "border-border/70 text-content-faint hover:bg-surface-3"
              } disabled:cursor-default disabled:hover:bg-transparent`}
              aria-current={state === "current" ? "step" : undefined}
              data-step={s.id}
              data-state={state}
            >
              {state === "done" ? <Icon name="check" size={10} className="text-success" /> : <span className="text-[10px] tabular-nums opacity-70">{i + 1}</span>}
              {t(s.label)}
            </button>
          </li>
        );
      })}
    </ol>
  );
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

/** the run, above the conversation: what is being made, how far, and when it waits for the user */
function RunStatus({ project, onShow }: { project: AvatarProject; onShow: () => void }) {
  const t = useT();
  if (!project.confirmation || !["running", "waiting", "paused", "failed"].includes(project.status)) return null;
  const items = Object.values(project.items);
  const done = items.filter((i) => i.status === "done").length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const waiting = project.status === "waiting";
  const label = waiting
    ? t(project.extras.some((x) => x.status === "pending") ? "studio.wait_extra" : (`studio.wait_${project.checkpoint?.stage ?? "pick"}` as MsgKey))
    : project.status === "paused"
      ? t("avatar.status_paused")
      : project.status === "failed"
        ? t("avatar.status_failed")
        : t("studio.making", { what: t(`studio.phase_${project.phase || "design"}` as MsgKey) });
  return (
    <div className={`shrink-0 border-b px-4 py-2 ${waiting ? "border-warning/30 bg-warning/[0.06]" : "border-border/60 bg-surface-2/40"}`} data-testid="studio-run" data-status={project.status}>
      <div className="flex items-center gap-2 text-[12px]">
        <Icon name={waiting ? "bell" : project.status === "running" ? "spinner" : "pause"} size={12} spin={project.status === "running"} className={waiting ? "text-warning" : "text-accent"} />
        <span className="min-w-0 flex-1 truncate text-content">{label}</span>
        <span className="tabular-nums text-content-faint">{t("studio.runCount", { done, total: items.length })}</span>
        {waiting && (
          <button className="rounded-md px-2.5 py-0.5 text-[11.5px] font-medium text-accent hover:bg-accent-soft" onClick={onShow} data-testid="studio-run-show">
            {t("studio.filledShow")}
          </button>
        )}
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Splitter({ value, onChange, container }: { value: number; onChange: (v: number, save?: boolean) => void; container: React.RefObject<HTMLDivElement> }) {
  const t = useT();
  const clamp = (v: number) => {
    const w = container.current?.clientWidth || 1200;
    return Math.min(1 - MIN_RIGHT / w, Math.max(MIN_LEFT / w, v));
  };
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    let last = value;
    const move = (ev: PointerEvent) => {
      last = clamp((ev.clientX - rect.left) / rect.width);
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
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={20}
      aria-valuemax={80}
      tabIndex={0}
      onPointerDown={down}
      onDoubleClick={() => onChange(clamp(SPLIT_DEFAULT), true)}
      onKeyDown={(e) => {
        const step = e.key === "ArrowLeft" ? -0.03 : e.key === "ArrowRight" ? 0.03 : 0;
        if (step) {
          e.preventDefault();
          onChange(clamp(value + step), true);
        } else if (e.key === "Home" || e.key === "Enter") {
          e.preventDefault();
          onChange(clamp(SPLIT_DEFAULT), true);
        }
      }}
      className="group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize outline-none"
      data-testid="studio-splitter"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/80 transition group-hover:w-[3px] group-hover:bg-accent/50 group-focus-visible:w-[3px] group-focus-visible:bg-accent" />
    </div>
  );
}

export default function MateStudio() {
  const t = useT();
  const lang = useLang();
  // (both columns' least widths: beside the sidebar a tablet or a small window has less, whatever the viewport)
  const [narrow, rootRef] = useNarrowerThan(MIN_LEFT + MIN_RIGHT);
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
  const [tab, setTab] = useState<"agent" | "settings">("agent");
  const [saveSlot, setSaveSlot] = useState<HTMLDivElement | null>(null);
  const [focus, setFocus] = useState<{ id: SectionId; n: number } | null>(null);
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

  const show = (id: SectionId) => {
    setFocus({ id, n: Date.now() });
    if (phone) setTab("settings");
  };

  // ── phone: the Settings tab is marked when the agent filled something there (or a decision waits) ──
  const fills = useMemo(() => Object.values(project?.studio?.filled ?? {}).map((e) => e.at), [project?.studio?.filled]);
  const [seenFills, setSeenFills] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (tab === "settings" || !phone) setSeenFills(new Set(fills));
  }, [tab, phone, fills]);
  const unseen = fills.filter((a) => !seenFills.has(a)).length;
  const waits = !!project && (project.status === "waiting" || project.extras.some((x) => x.status === "pending") || (project.status === "estimate" && !!project.plan && !project.confirmation));

  // ── the splitter ──
  const box = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(() => {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v > 0.15 && v < 0.85 ? v : SPLIT_DEFAULT;
  });
  const onSplit = (v: number, save?: boolean) => {
    setSplit(v);
    if (save) localStorage.setItem(SPLIT_KEY, String(Number(v.toFixed(3))));
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
      : t("studio.titleAvatar", { name: mate?.name || "" });
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
            <Icon name="sparkles" size={13} className="shrink-0 text-accent" />
            <h1 className="truncate text-[14px] font-semibold" data-testid="studio-title">
              {title}
            </h1>
            {!phone && project && !isNew && <StatusPill project={project} />}
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
      {project && mate && (
        <div className={`border-t border-border/50 px-3 [@media(max-height:500px)]:hidden ${phone ? "py-1.5" : "py-2"}`}>
          {isNew ? <Steps project={project} mate={mate} onPick={show} compact={phone} /> : <div className={phone ? "" : "flex justify-center"}><StepBar project={project} nowrap={phone} /></div>}
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
      onShow={(s) => show(s as SectionId)}
      placeholder={isNew ? t("studio.composerNew") : undefined}
      top={<RunStatus project={project} onShow={() => show("avatar")} />}
    />
  );
  const settings = (
    <StudioSettings
      project={project}
      mate={mate}
      env={env}
      act={act}
      reloadEnv={reloadEnv}
      conv={conv}
      api={api}
      focus={focus}
      creating={isNew}
      onVoiceTested={() => pid && void studioVoiceOk(pid).then(take).catch(() => {})}
      onSkip={(skip) => pid && void act(() => skipAvatar(pid, skip))}
      saving={{ busy: saving.n > 0, error: saving.error }}
    />
  );

  if (phone) {
    return (
      <div ref={rootRef} className="touch-ui flex h-full flex-col" data-testid="mate-studio" data-kind={kind} data-layout="tabs">
        {header}
        <div className="flex shrink-0 gap-1 border-b border-border/60 px-3 py-1.5" role="tablist">
          <button role="tab" aria-selected={tab === "agent"} className="nav-tab inline-flex flex-1 items-center justify-center gap-1.5" data-active={tab === "agent"} onClick={() => setTab("agent")} data-testid="studio-tab-agent">
            <Icon name="sparkles" size={13} /> {t("studio.tabAgent")}
            {chat.streaming && <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-accent" />}
          </button>
          <button role="tab" aria-selected={tab === "settings"} className="nav-tab inline-flex flex-1 items-center justify-center gap-1.5" data-active={tab === "settings"} onClick={() => setTab("settings")} data-testid="studio-tab-settings">
            <Icon name="settings" size={13} /> {t("studio.tabSettings")}
            {tab !== "settings" && unseen > 0 ? (
              <span className="ml-1 rounded-full bg-success px-1.5 text-[10px] font-semibold leading-4 text-white" data-testid="studio-settings-badge">
                {unseen}
              </span>
            ) : (
              tab !== "settings" && waits && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-warning" data-testid="studio-settings-dot" />
            )}
          </button>
        </div>
        {banner}
        {/* (both stay mounted: switching tabs keeps the conversation's scroll and the fields being typed) */}
        <div className={`min-h-0 flex-1 flex-col ${tab === "agent" ? "flex" : "hidden"}`}>{agent}</div>
        <div className={`min-h-0 flex-1 flex-col ${tab === "settings" ? "flex" : "hidden"}`}>
          <SaveBarSlot.Provider value={saveSlot}>
            <div className="fit-fields scrollbar-stable min-h-0 flex-1 overflow-y-auto pb-safe">{settings}</div>
          </SaveBarSlot.Provider>
          <div ref={setSaveSlot} className="shrink-0" />
        </div>
        {dialogs}
      </div>
    );
  }
  return (
    <div ref={rootRef} className={`flex h-full flex-col ${touch ? "touch-ui" : ""}`} data-testid="mate-studio" data-kind={kind} data-layout="split">
      {header}
      {banner}
      <div className="flex min-h-0 flex-1" ref={box}>
        <section className="flex min-h-0 shrink-0 flex-col bg-surface/30" style={{ width: `${(split * 100).toFixed(2)}%`, minWidth: MIN_LEFT }} aria-label={t("studio.tabAgent")} data-testid="studio-agent">
          {agent}
        </section>
        <Splitter value={split} onChange={onSplit} container={box} />
        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[linear-gradient(to_bottom,rgb(var(--c-surface-2)/0.35),transparent_240px)]" style={{ minWidth: MIN_RIGHT }} aria-label={t("studio.tabSettings")} data-testid="studio-right">
          <SaveBarSlot.Provider value={saveSlot}>
            <div className="scrollbar-stable min-h-0 flex-1 overflow-y-auto">{settings}</div>
          </SaveBarSlot.Provider>
          <div ref={setSaveSlot} className="shrink-0" />
        </section>
      </div>
      {dialogs}
    </div>
  );
}
