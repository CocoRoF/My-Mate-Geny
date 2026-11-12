/**
 * The avatar project (docs/avatar-create.md §4–6) — the Mate Create studio's Avatar section: what the server knows
 * about the project — the steps, the estimate card (the ONLY place a run starts: Confirm), the checkpoints (pick a
 * candidate, approve the base picture, approve the stills), progress and credits, redo / extra requests, what was
 * made so far (candidates, stills, clips with their checks), and at the end the avatar playing with Apply / Restore
 * (a new mate's avatar goes on her by itself).
 */
import { useCenteredChild } from "../../../lib/scrollRow";
import { useEffect, useRef, useState } from "react";
import {
  applyAvatar,
  cancelRun,
  changePlan,
  checkpoint,
  confirmExtra,
  confirmPlan,
  declineExtra,
  discardPlan,
  installDeps,
  pauseRun,
  reEstimate,
  redoItem,
  restoreAvatar,
  resumeRun,
  type AvatarEnv,
  type AvatarProject,
  type Extra,
  type Plan,
  type PlanLine,
} from "../../../api/avatar";
import { MateAvatar } from "../../../mate/avatar/MateAvatar";
import type { BodyMood, MateReact } from "../../../mate/types";
import { useMateStore } from "../../../stores/mateStore";
import Icon, { type IconName } from "../../ui/Icon";
import { useT, type MsgKey } from "../../../i18n";
import { confirmDialog, ifConfirmed } from "../../ui/ConfirmDialog";

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : Number(n.toFixed(2)).toLocaleString());

export type Act = (fn: () => Promise<unknown>) => Promise<void>;

const STEPS: { id: string; label: MsgKey }[] = [
  { id: "interview", label: "avatar.stepInterview" },
  { id: "estimate", label: "avatar.stepEstimate" },
  { id: "design", label: "avatar.stepCandidates" },
  { id: "home", label: "avatar.stepBase" },
  { id: "stills", label: "avatar.stepStills" },
  { id: "clips", label: "avatar.stepClips" },
  { id: "finish", label: "avatar.stepFinish" },
  { id: "ready", label: "avatar.stepReady" },
];

function stepOf(p: AvatarProject): string {
  if (p.status === "interview") return "interview";
  if (p.status === "estimate") return "estimate";
  if (p.status === "ready" || p.status === "applied") return "ready";
  const ph = p.checkpoint?.stage === "pick" ? "design" : p.checkpoint?.stage === "home" ? "home" : p.checkpoint?.stage === "stills" ? "stills" : p.phase || "";
  if (ph === "design" || ph === "pick") return "design";
  if (ph === "home" || ph === "approve_home") return "home";
  if (ph === "stills" || ph === "approve_stills") return "stills";
  if (ph === "clips") return "clips";
  if (ph) return "finish";
  return p.confirmation ? "design" : "estimate";
}

export function StepBar({ project, nowrap = false }: { project: AvatarProject; nowrap?: boolean }) {
  const t = useT();
  const cur = STEPS.findIndex((s) => s.id === stepOf(project));
  const row = useCenteredChild<HTMLOListElement>(cur);
  return (
    <ol ref={row} className={`flex gap-1 ${nowrap ? "no-scrollbar -mx-3 overflow-x-auto overscroll-x-contain px-3" : "flex-wrap"}`} data-testid="avatar-steps">
      {STEPS.map((s, i) => (
        <li
          key={s.id}
          className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${
            i === cur ? "border-accent/60 bg-accent-soft text-content" : i < cur ? "border-border text-content-dim" : "border-border/60 text-content-faint"
          }`}
          data-active={i === cur}
        >
          {i < cur && <Icon name="check" size={10} className="mr-0.5 inline text-success" />}
          {t(s.label)}
        </li>
      ))}
    </ol>
  );
}

const STATUS_TONE: Record<string, string> = {
  running: "bg-accent-soft text-accent",
  waiting: "bg-warning/15 text-warning",
  paused: "bg-surface-3 text-content-dim",
  failed: "bg-danger/15 text-danger",
  ready: "bg-success/15 text-success",
  applied: "bg-success/15 text-success",
  canceled: "bg-surface-3 text-content-faint",
};

export function StatusPill({ project }: { project: AvatarProject }) {
  const t = useT();
  return (
    <span className={`pill ${STATUS_TONE[project.status] || "bg-surface-3 text-content-dim"}`} data-testid="avatar-status">
      {t(`avatar.status_${project.status}` as MsgKey)}
    </span>
  );
}

function Card({ title, icon, children, tone, testId, right }: { title: string; icon?: IconName; children: React.ReactNode; tone?: "accent" | "warn"; testId?: string; right?: React.ReactNode }) {
  return (
    <section
      className={`rounded-xl border p-3.5 ${tone === "accent" ? "border-accent/40 bg-accent-soft/40" : tone === "warn" ? "border-warning/40 bg-warning/[0.06]" : "border-border bg-surface-2/50"}`}
      data-testid={testId}
    >
      <div className="mb-2.5 flex items-center gap-2">
        {icon && <Icon name={icon} size={14} className="text-content-dim" />}
        <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-content">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

const LINE_LABEL: Record<PlanLine["stage"], MsgKey> = {
  design: "avatar.lineCandidates",
  home: "avatar.lineCutout",
  stills: "avatar.lineStills",
  clips: "avatar.lineClips",
  matte: "avatar.lineMatte",
};

/** The estimate with Confirm / Change plan / Cancel — the only way a run starts. */
export function EstimateCard({ project, env, act, inline = false }: { project: AvatarProject; env: AvatarEnv | null; act: Act; inline?: boolean }) {
  const t = useT();
  const plan = project.plan as Plan;
  const stale = Date.now() - Date.parse(plan.quoted_at) > 29 * 60_000;
  const hfOk = !!env?.higgsfield.connected && !!env?.higgsfield.cli;
  const depsOk = !!env?.deps.ready;
  const can = plan.complete && !stale && hfOk && depsOk;
  return (
    <Card title={t("avatar.estimateTitle")} icon="sparkles" tone="accent" testId={inline ? "avatar-estimate-inline" : "avatar-estimate"}>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-content-faint">
            <th className="pb-1 font-normal">{t("avatar.colItem")}</th>
            <th className="pb-1 font-normal">{t("avatar.colModel")}</th>
            <th className="pb-1 text-right font-normal">{t("avatar.colCount")}</th>
            <th className="pb-1 text-right font-normal">{t("avatar.colCredits")}</th>
          </tr>
        </thead>
        <tbody>
          {plan.lines.map((l) => (
            <tr key={l.key} className="border-t border-border/60" data-testid="avatar-estimate-line">
              <td className="py-1 pr-2 text-content">{t(LINE_LABEL[l.stage])}</td>
              <td className="py-1 pr-2 font-mono text-[11px] text-content-dim">{l.job_type}</td>
              <td className="py-1 text-right text-content-dim">
                {l.count} × {l.unit === null ? "?" : fmt(l.unit)}
              </td>
              <td className={`py-1 text-right font-medium ${l.error ? "text-danger" : "text-content"}`}>{l.error ? t("avatar.noQuote") : fmt(l.credits)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-2 text-[12px]">
        <span className="text-content-dim">{t("avatar.total")}</span>
        <span className="text-right text-[14px] font-semibold text-content" data-testid="avatar-estimate-total">
          {t("avatar.credits", { n: fmt(plan.total) })}
          {plan.usd !== null && <span className="ml-1 text-[11.5px] font-normal text-content-faint">≈ ${plan.usd.toFixed(2)}</span>}
        </span>
        <span className="text-content-dim">{t("avatar.reserve")}</span>
        <span className="text-right text-content-dim">{t("avatar.credits", { n: fmt(plan.reserve) })}</span>
        <span className="text-content-dim">{t("avatar.balance")}</span>
        <span className="text-right text-content-dim">
          {fmt(plan.balance)} → <span className={plan.balance_after !== null && plan.balance_after < 0 ? "text-danger" : "text-content"}>{fmt(plan.balance_after)}</span>
        </span>
        <span className="text-content-dim">{t("avatar.time")}</span>
        <span className="text-right text-content-dim">{t("avatar.minutes", { n: Math.round(plan.minutes) })}</span>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-content-faint">{t("avatar.reserveHint", { cap: fmt(plan.cap) })}</p>
      {plan.errors.length > 0 && <p className="mt-1.5 text-[11.5px] text-danger">{t("avatar.quoteErrors", { errors: plan.errors.join("; ") })}</p>}
      {stale && <p className="mt-1.5 text-[11.5px] text-warning">{t("avatar.staleQuote")}</p>}
      {!hfOk && <p className="mt-1.5 text-[11.5px] text-warning">{t("avatar.needHiggsfield")}</p>}
      {!depsOk && <p className="mt-1.5 text-[11.5px] text-warning">{t("avatar.needDeps")}</p>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button className="btn-ghost" onClick={() => act(() => discardPlan(project.id))} data-testid="avatar-estimate-cancel">
          {t("common.cancel")}
        </button>
        <button className="btn-soft" onClick={() => act(() => (stale ? reEstimate(project.id) : changePlan(project.id)))} data-testid="avatar-estimate-change">
          {stale ? t("avatar.requote") : t("avatar.changePlan")}
        </button>
        <button className="btn-primary" disabled={!can} onClick={() => act(() => confirmPlan(project.id, plan))} data-testid="avatar-estimate-confirm">
          <Icon name="check" size={14} /> {t("avatar.confirmCredits", { n: fmt(plan.total) })}
        </button>
      </div>
    </Card>
  );
}

function DepsCard({ env, onDone }: { env: AvatarEnv; onDone: () => void }) {
  const t = useT();
  const [lines, setLines] = useState<string[]>(env.deps.log || []);
  const [busy, setBusy] = useState(env.deps.installing);
  const [err, setErr] = useState<string | null>(env.deps.error);
  const install = async () => {
    setBusy(true);
    setErr(null);
    try {
      await installDeps((o) => {
        if (o.line) setLines((l) => [...l.slice(-7), o.line as string]);
        if (o.error) setErr(o.error);
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <Card title={t("avatar.depsTitle")} icon="cpu" tone="warn" testId="avatar-deps">
      <p className="text-[12px] leading-relaxed text-content-dim">{t("avatar.depsHint")}</p>
      {(busy || lines.length > 0) && (
        <pre className="mt-2 max-h-28 overflow-auto rounded-lg bg-surface px-2 py-1.5 font-mono text-[10.5px] text-content-faint">{lines.join("\n")}</pre>
      )}
      {err && <p className="mt-1.5 text-[11.5px] text-danger">{err}</p>}
      <div className="mt-2.5 flex justify-end">
        <button className="btn-primary" onClick={install} disabled={busy} data-testid="avatar-deps-install">
          {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="download" size={14} />} {t("avatar.depsInstall")}
        </button>
      </div>
    </Card>
  );
}

function Thumb({ src, label, selected, onClick, testId, children }: { src: string | null; label: string; selected?: boolean; onClick?: () => void; testId?: string; children?: React.ReactNode }) {
  return (
    <div
      className={`group relative overflow-hidden rounded-lg border bg-[rgb(213,212,217)] ${selected ? "border-accent ring-2 ring-accent/40" : "border-border"}`}
      data-testid={testId}
    >
      {src ? (
        <img src={src} alt={label} className={`aspect-[3/4] w-full object-cover ${onClick ? "cursor-pointer" : ""}`} onClick={onClick} loading="lazy" />
      ) : (
        <div className="grid aspect-[3/4] w-full place-items-center bg-surface-3 text-content-faint">
          <Icon name="spinner" size={16} spin />
        </div>
      )}
      <div className="flex items-center gap-1 bg-surface/90 px-1.5 py-1 text-[11px] text-content-dim">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {children}
      </div>
    </div>
  );
}

export function ExtraCard({ project, x, act }: { project: AvatarProject; x: Extra; act: Act }) {
  const t = useT();
  const it = x.items?.[0];
  const reason =
    it?.kind === "reroll"
      ? it.base
        ? t("avatar.extraRerollFrom", { id: it.base })
        : t("avatar.extraReroll", { n: it.count ?? 0 })
      : it?.kind === "item"
        ? t("avatar.extraRedo", { item: it.key })
        : it?.kind === "add"
          ? t("avatar.extraAdd", { clips: it.clips?.length ?? 0, stills: it.stills?.length ?? 0 })
          : it?.kind === "cap"
            ? t("avatar.extraCap")
            : x.reason;
  return (
    <Card title={t("avatar.extraTitle")} icon="warning" tone="warn" testId="avatar-extra">
      <p className="text-[12px] text-content-dim">{t("avatar.extraBody", { reason, n: fmt(x.total) })}</p>
      <div className="mt-2.5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={() => act(() => declineExtra(project.id, x))}>
          {t("avatar.decline")}
        </button>
        <button className="btn-primary" onClick={() => act(() => confirmExtra(project.id, x))} data-testid="avatar-extra-confirm">
          {t("avatar.confirmCredits", { n: fmt(x.total) })}
        </button>
      </div>
    </Card>
  );
}

/** a redo: the price on the button; above the auto threshold the browser asks once more */
function RedoButton({ project, item, credits, act, label }: { project: AvatarProject; item: string; credits: number | null; act: Act; label?: string }) {
  const t = useT();
  return (
    <button
      className="inline-flex items-center gap-0.5 rounded px-1 text-[10.5px] text-content-faint hover:bg-surface-3 hover:text-content"
      onClick={async () => {
        if (credits !== null && credits > 5 && !(await confirmDialog({ body: t("avatar.redoConfirm", { item, n: fmt(credits) }), confirmLabel: t("avatar.redo") }))) return;
        void act(() => redoItem(project.id, item));
      }}
      data-testid={`avatar-redo-${item}`}
    >
      <Icon name="rotate" size={10} /> {label ?? t("avatar.redo")} {credits !== null && `· ${fmt(credits)}`}
    </button>
  );
}

const unit = (p: AvatarProject, stage: PlanLine["stage"]) => p.plan?.lines.find((l) => l.stage === stage)?.unit ?? null;

function Checkpoint({ project, act }: { project: AvatarProject; act: Act }) {
  const t = useT();
  const cp = project.checkpoint;
  const f = project.files;
  if (!cp) return null;
  if (cp.stage === "pick") {
    const n = project.brief.candidates;
    return (
      <Card title={t("avatar.pickTitle")} icon="image" tone="accent" testId="avatar-checkpoint-pick">
        <p className="mb-2 text-[12px] text-content-dim">{t("avatar.pickHint")}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {f.candidates.map((c) => (
            <Thumb key={c.id} src={c.url} label={c.id} testId="avatar-candidate">
              <button className="rounded-md bg-accent px-2.5 py-0.5 text-[11.5px] font-medium text-white" onClick={() => act(() => checkpoint(project.id, "pick", c.id))} data-testid={`avatar-pick-${c.id}`}>
                {t("avatar.useThis")}
              </button>
            </Thumb>
          ))}
        </div>
        <div className="mt-2 flex justify-end">
          <RedoButton project={project} item="design" credits={unit(project, "design") !== null ? (unit(project, "design") as number) * n : null} act={act} label={t("avatar.reroll")} />
        </div>
      </Card>
    );
  }
  if (cp.stage === "home") {
    return (
      <Card title={t("avatar.homeTitle")} icon="user" tone="accent" testId="avatar-checkpoint-home">
        <p className="mb-2 text-[12px] text-content-dim">{t("avatar.homeHint")}</p>
        <div className="grid grid-cols-2 gap-2">
          <Thumb src={f.home} label={t("avatar.basePicture")} />
          <Thumb src={f.face} label={t("avatar.faceRegion")} />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
          <RedoButton project={project} item="home" credits={unit(project, "home")} act={act} />
          {project.brief.reference.mode !== "as_base" && (
            <button className="btn-ghost" onClick={() => act(() => checkpoint(project.id, "back"))} data-testid="avatar-home-back">
              {t("avatar.backToCandidates")}
            </button>
          )}
          <button className="btn-primary" onClick={() => act(() => checkpoint(project.id, "approve"))} data-testid="avatar-approve-home">
            <Icon name="check" size={14} /> {t("avatar.approve")}
          </button>
        </div>
      </Card>
    );
  }
  if (cp.stage === "stills") {
    return (
      <Card title={t("avatar.stillsTitle")} icon="image" tone="accent" testId="avatar-checkpoint-stills">
        <p className="mb-2 text-[12px] text-content-dim">{t("avatar.stillsHint")}</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          <Thumb src={f.home} label={t("avatar.neutral")} />
          {f.stills.map((s) => (
            <Thumb key={s.name} src={s.url} label={s.name} testId="avatar-still">
              <RedoButton project={project} item={`still:${s.name}`} credits={unit(project, "stills")} act={act} label="" />
            </Thumb>
          ))}
        </div>
        <div className="mt-2.5 flex justify-end">
          <button className="btn-primary" onClick={() => act(() => checkpoint(project.id, "approve"))} data-testid="avatar-approve-stills">
            <Icon name="check" size={14} /> {t("avatar.approveStills", { n: project.brief.clips.length })}
          </button>
        </div>
      </Card>
    );
  }
  return null;
}

function Progress({ project, act }: { project: AvatarProject; act: Act }) {
  const t = useT();
  const c = project.credits;
  const pct = c.cap ? Math.min(100, (c.committed / c.cap) * 100) : 0;
  const stages: { id: string; label: MsgKey }[] = [
    { id: "design", label: "avatar.lineCandidates" },
    { id: "home", label: "avatar.lineCutout" },
    { id: "stills", label: "avatar.lineStills" },
    { id: "clips", label: "avatar.lineClips" },
    { id: "matte", label: "avatar.lineMatte" },
  ];
  const items = Object.values(project.items);
  const live = project.status === "running" || project.status === "waiting";
  return (
    <Card
      title={t("avatar.progressTitle")}
      icon="activity"
      testId="avatar-progress"
      right={
        <div className="flex gap-1">
          {live && !project.paused && (
            <button className="btn-ghost !px-2 !py-1 text-[11.5px]" onClick={() => act(() => pauseRun(project.id))} data-testid="avatar-pause">
              <Icon name="pause" size={12} /> {t("avatar.pause")}
            </button>
          )}
          {(project.status === "paused" || project.status === "failed") && (
            <button className="btn-soft !px-2 !py-1 text-[11.5px]" onClick={() => act(() => resumeRun(project.id))} data-testid="avatar-resume">
              <Icon name="play" size={12} /> {t("avatar.resume")}
            </button>
          )}
          {(live || project.status === "paused" || project.status === "failed") && (
            <button
              className="btn-ghost !px-2 !py-1 text-[11.5px] text-danger"
              onClick={() => ifConfirmed({ body: t("avatar.cancelConfirm"), confirmLabel: t("common.stop"), cancelLabel: t("common.back"), danger: true }, () => act(() => cancelRun(project.id)))}
              data-testid="avatar-cancel"
            >
              {t("common.cancel")}
            </button>
          )}
        </div>
      }
    >
      <div className="text-[12px] text-content-dim">
        <div className="flex justify-between">
          <span>{t("avatar.creditsCounted")}</span>
          <span className="font-medium text-content" data-testid="avatar-credits-counted">
            {fmt(c.committed)} / {fmt(c.cap)}
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-[11px] text-content-faint">{t("avatar.creditsHint", { total: fmt(c.confirmed) })}</p>
      </div>
      <ul className="mt-2.5 space-y-1 text-[12px]">
        {stages.map((s) => {
          const mine = items.filter((i) => i.stage === s.id);
          if (!mine.length) return null;
          const done = mine.filter((i) => i.status === "done").length;
          const running = mine.filter((i) => i.status === "running").length;
          const failed = mine.filter((i) => i.status === "failed").length;
          return (
            <li key={s.id} className="flex items-center gap-2" data-testid={`avatar-stage-${s.id}`}>
              <Icon name={running ? "spinner" : done === mine.length ? "check" : failed ? "warning" : "clock"} size={12} spin={!!running} className={done === mine.length ? "text-success" : failed ? "text-danger" : "text-content-faint"} />
              <span className="flex-1 text-content-dim">{t(s.label)}</span>
              <span className="text-content">
                {done}/{mine.length}
              </span>
              {failed > 0 && <span className="text-danger">{t("avatar.failedN", { n: failed })}</span>}
            </li>
          );
        })}
      </ul>
      {project.processing && (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-content-faint" data-testid="avatar-processing">
          <Icon name="cpu" size={11} /> {t("avatar.processing", { step: [project.processing.step, ...project.processing.args.slice(1)].join(" ") })}
        </p>
      )}
      {project.paused && project.status === "running" && <p className="mt-2 text-[11.5px] text-warning">{t("avatar.pausing")}</p>}
      {project.error && <p className="mt-2 break-words text-[11.5px] text-danger">{project.error}</p>}
    </Card>
  );
}

function Clips({ project, act }: { project: AvatarProject; act: Act }) {
  const t = useT();
  const clips = project.files.clips.filter((c) => c.status !== "pending" || c.raw);
  if (!clips.length) return null;
  const cost = (unit(project, "clips") ?? 0) + (unit(project, "matte") ?? 0);
  return (
    <Card title={t("avatar.clipsTitle", { n: project.brief.clips.length })} icon="play" testId="avatar-clips">
      <ul className="divide-y divide-border/60">
        {project.files.clips.map((c) => {
          const chk = c.check;
          return (
            <li key={c.id} className="flex items-center gap-2 py-1.5 text-[12px]" data-testid="avatar-clip">
              {c.raw ? (
                <video src={c.raw} muted loop playsInline preload="metadata" className="h-10 w-10 shrink-0 rounded bg-surface-3 object-cover" onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} />
              ) : (
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded bg-surface-3 text-content-faint">
                  <Icon name={c.status === "running" ? "spinner" : "clock"} size={12} spin={c.status === "running"} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-content">{c.id}</span>
                  <span className="text-content-faint">
                    {c.kind}
                    {c.emotion ? ` · ${c.emotion}` : ""}
                  </span>
                </div>
                <div className="truncate text-[11px] text-content-faint">{c.error || c.action}</div>
              </div>
              {chk && !chk.missing && (
                <span className={`pill ${chk.ok ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`} title={t("avatar.checkDetail", { seam: String(chk.seam ?? "—"), start: String(chk.start ?? "—"), bg: String(chk.drift ?? "—") })} data-testid="avatar-clip-check">
                  {chk.ok ? t("avatar.checkOk") : t("avatar.checkRedo")}
                </span>
              )}
              {project.confirmation && (c.status === "done" || c.status === "failed") && <RedoButton project={project} item={`clip:${c.id}`} credits={cost} act={act} label="" />}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

const TRY_MOODS: BodyMood[] = ["idle", "listening", "thinking", "talking", "away"];

export interface PanelStudio {
  kind: "new" | "existing";
  mateId: string;
  mateName: string;
}

function Finish({ project, act, studio }: { project: AvatarProject; act: Act; studio?: PanelStudio }) {
  const t = useT();
  const mates = useMateStore((s) => s.mates);
  const target = project.brief.target;
  const [mood, setMood] = useState<BodyMood>("idle");
  const [react, setReact] = useState<MateReact>(null);
  const [newName, setNewName] = useState(target.mode === "new" ? target.name : "");
  const [mateId, setMateId] = useState(target.mate_id || "");
  const emotions = Object.keys(project.preview?.kind === "video" ? project.preview.rig.emotions || {} : {});
  if (!project.preview) return null;
  const applied = project.applied;
  return (
    <Card title={t("avatar.readyTitle")} icon="sparkles" tone="accent" testId="avatar-finish">
      <div className="relative mx-auto h-[300px] w-full max-w-[300px] rounded-xl bg-[radial-gradient(ellipse_at_50%_100%,rgb(var(--c-surface-3)),transparent_70%)]" data-testid="avatar-preview">
        <MateAvatar avatar={project.preview} name={project.title} size="lg" mood={mood} react={react} className="h-full w-full" />
      </div>
      <div className="mt-2 flex flex-wrap justify-center gap-1">
        {TRY_MOODS.map((m) => (
          <button key={m} className={`nav-tab !px-2 !py-0.5 text-[11px]`} data-active={mood === m} onClick={() => setMood(m)} data-testid={`avatar-try-${m}`}>
            {t(`avatar.mood_${m}` as MsgKey)}
          </button>
        ))}
        {emotions.map((e) => (
          <button key={e} className="nav-tab !px-2 !py-0.5 text-[11px]" onClick={() => setReact({ name: e, at: Date.now() })}>
            {e}
          </button>
        ))}
      </div>
      {project.check && (
        <p className="mt-2 text-center text-[11.5px] text-content-faint">
          {project.check.passed ? t("avatar.allChecksPassed") : t("avatar.someChecksFailed", { ids: project.check.redo.join(", ") })}
        </p>
      )}
      {!project.outfit && applied && !applied.restored_at && (
        <p className="mt-2 rounded-lg bg-success/10 px-2.5 py-1.5 text-center text-[12px] text-success" data-testid="avatar-applied">
          {studio?.kind === "new" ? t("studio.avatarOnHer") : t("avatar.appliedTo", { name: applied.name })}
        </p>
      )}
      {project.outfit ? (
        <div className="mt-2 space-y-2" data-testid="outfit-finish">
          <p className="text-center text-[12px] text-content-dim">{t("studio.outfitInWardrobe", { name: project.outfit.name })}</p>
          {mates.find((m) => m.id === target.mate_id)?.outfits?.worn === project.outfit.id && project.outfit.id ? (
            <p className="rounded-lg bg-success/10 px-2.5 py-1.5 text-center text-[12px] text-success" data-testid="outfit-worn">
              {t("studio.outfitWorn", { name: target.name })}
            </p>
          ) : (
            <button className="btn-primary w-full" onClick={() => act(() => applyAvatar(project.id, { mate_id: target.mate_id || "" }))} data-testid="outfit-wear">
              <Icon name="check" size={14} /> {t("studio.outfitWear", { name: target.name })}
            </button>
          )}
        </div>
      ) : studio?.kind === "new" ? (
        !applied && (
          <p className="mt-2 flex items-center justify-center gap-1.5 text-[12px] text-content-faint">
            <Icon name="spinner" size={12} spin /> {t("studio.avatarApplying")}
          </p>
        )
      ) : studio ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {!!applied?.backup && !applied.restored_at && applied.mate_id === studio.mateId && (
            <button className="btn-ghost text-[12px]" onClick={() => ifConfirmed({ body: t("avatar.restoreConfirm", { name: applied.name }), confirmLabel: t("avatar.restore", { name: applied.name }) }, () => act(() => restoreAvatar(project.id)))} data-testid="avatar-restore">
              <Icon name="rotate" size={12} /> {t("avatar.restore", { name: applied.name })}
            </button>
          )}
          {!(applied && !applied.restored_at && applied.mate_id === studio.mateId) && (
            <button
              className="btn-primary"
              onClick={() => ifConfirmed({ body: t("avatar.applyConfirm", { name: studio.mateName }), confirmLabel: t("avatar.apply") }, () => act(() => applyAvatar(project.id, { mate_id: studio.mateId })))}
              data-testid="avatar-apply"
            >
              <Icon name="check" size={14} /> {t("studio.applyTo", { name: studio.mateName })}
            </button>
          )}
        </div>
      ) : (
      <div className="mt-3 space-y-2">
        <div className="flex gap-2">
          <select className="field min-w-0 flex-1 text-[12.5px]" value={mateId} onChange={(e) => setMateId(e.target.value)} data-testid="avatar-apply-mate">
            <option value="">{t("avatar.chooseMate")}</option>
            {mates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <button
            className="btn-primary shrink-0"
            disabled={!mateId}
            onClick={() => ifConfirmed({ body: t("avatar.applyConfirm", { name: mates.find((m) => m.id === mateId)?.name || "" }), confirmLabel: t("avatar.apply") }, () => act(() => applyAvatar(project.id, { mate_id: mateId })))}
            data-testid="avatar-apply"
          >
            {t("avatar.apply")}
          </button>
        </div>
        <div className="flex gap-2">
          <input className="field min-w-0 flex-1 text-[12.5px]" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("avatar.newMateName")} data-testid="avatar-new-name" />
          <button className="btn-soft shrink-0" disabled={!newName.trim()} onClick={() => act(() => applyAvatar(project.id, { new: true, new_name: newName.trim() }))} data-testid="avatar-create-mate">
            <Icon name="plus" size={13} /> {t("avatar.createMate")}
          </button>
        </div>
        {applied?.backup && !applied.restored_at ? (
          <button className="btn-ghost w-full text-[12px]" onClick={() => ifConfirmed({ body: t("avatar.restoreConfirm", { name: applied.name }), confirmLabel: t("avatar.restore", { name: applied.name }) }, () => act(() => restoreAvatar(project.id)))} data-testid="avatar-restore">
            <Icon name="rotate" size={12} /> {t("avatar.restore", { name: applied.name })}
          </button>
        ) : null}
      </div>
      )}
    </Card>
  );
}

/** what was made so far (outside the checkpoints that show it): the candidates (the picked one marked), the base
 *  picture and the stills — fixed-ratio tiles, so nothing jumps when a picture arrives */
function Gallery({ project }: { project: AvatarProject }) {
  const t = useT();
  const f = project.files;
  const cp = project.checkpoint?.stage;
  const cands = cp === "pick" ? [] : f.candidates;
  const stills = cp === "stills" ? [] : f.stills.filter((x) => x.url || x.status === "running");
  const home = cp === "home" ? null : f.home;
  if (!cands.length && !stills.length && !home) return null;
  return (
    <Card title={t("studio.galleryTitle")} icon="image" testId="avatar-gallery">
      {cands.length > 0 && (
        <>
          <p className="mb-1.5 text-[11.5px] text-content-faint">{t("avatar.lineCandidates")}</p>
          <div className="grid grid-cols-4 gap-1.5">
            {cands.map((c) => (
              <Thumb key={c.id} src={c.url} label={c.id} selected={project.picked === c.id} testId="avatar-gallery-candidate" />
            ))}
          </div>
        </>
      )}
      {(home || stills.length > 0) && (
        <>
          <p className="mb-1.5 mt-2.5 text-[11.5px] text-content-faint">{t("avatar.lineStills")}</p>
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
            {home && <Thumb src={home} label={t("avatar.neutral")} />}
            {stills.map((x) => (
              <Thumb key={x.name} src={x.url} label={x.name} testId="avatar-gallery-still" />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

export default function AvatarPanel({ project, env, act, reloadEnv, studio, hideSteps = false }: {
  project: AvatarProject;
  env: AvatarEnv | null;
  act: Act;
  reloadEnv: () => void;
  /** in the Mate Create studio: whose avatar (a new mate's goes on her by itself) */
  studio?: PanelStudio;
  /** the steps are shown elsewhere (the studio's header) */
  hideSteps?: boolean;
}) {
  const t = useT();
  const top = useRef<HTMLDivElement>(null);
  const cp = project.checkpoint?.stage;
  useEffect(() => {
    if (cp) top.current?.scrollIntoView({ block: "nearest" });
  }, [cp]);
  const pending = project.extras.filter((x) => x.status === "pending");
  const b = project.brief;
  return (
    <div className={`flex flex-col gap-3 ${studio ? "" : "p-3 sm:p-4"}`} ref={top} data-testid="avatar-panel">
      {!hideSteps && <StepBar project={project} />}
      {env && (!env.higgsfield.connected || !env.higgsfield.cli) && (
        <div className="rounded-lg border border-warning/30 bg-warning/[0.07] px-3 py-2 text-[12px] text-warning" data-testid="avatar-no-higgsfield">
          {!env.higgsfield.connected ? t("avatar.connectHiggsfield") : t("avatar.noCli")}
        </div>
      )}
      {env && !env.deps.ready && <DepsCard env={env} onDone={reloadEnv} />}
      {pending.map((x) => (
        <ExtraCard key={x.id} project={project} x={x} act={act} />
      ))}
      {project.status === "estimate" && project.plan && !project.confirmation && <EstimateCard project={project} env={env} act={act} />}
      <Checkpoint project={project} act={act} />
      {project.preview && (project.status === "ready" || project.status === "applied") && <Finish project={project} act={act} studio={studio} />}
      {project.confirmation && <Progress project={project} act={act} />}
      {project.confirmation && <Gallery project={project} />}
      <Clips project={project} act={act} />
      <Card title={t("avatar.briefTitle")} icon="file-text" testId="avatar-brief">
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-content-faint">{t("avatar.briefReference")}</dt>
          <dd className="text-content-dim">{t(`avatar.ref_${b.reference.mode}` as MsgKey)}</dd>
          {b.design.prompt && (
            <>
              <dt className="text-content-faint">{t("avatar.briefDesign")}</dt>
              <dd className="text-content-dim">{b.design.prompt}</dd>
            </>
          )}
          <dt className="text-content-faint">{t("avatar.briefShape")}</dt>
          <dd className="text-content-dim">
            {b.aspect} · {t(`avatar.tier_${b.tier}` as MsgKey)}
          </dd>
          <dt className="text-content-faint">{t("avatar.briefMotions")}</dt>
          <dd className="text-content-dim">{t("avatar.briefMotionsValue", { preset: t(`avatar.preset_${b.preset}` as MsgKey), clips: b.clips.length, stills: b.stills.length })}</dd>
          {!studio && (
            <>
              <dt className="text-content-faint">{t("avatar.briefTarget")}</dt>
              <dd className="text-content-dim">{b.target.mode === "existing" ? b.target.name : t("avatar.newMateNamed", { name: b.target.name || "—" })}</dd>
            </>
          )}
        </dl>
        {project.files.refs.length > 0 && (
          <div className="mt-2 flex gap-1.5">
            {project.files.refs.map((r) => (
              <img key={r.name} src={r.url} alt={r.name} className="h-16 w-12 rounded border border-border object-cover" />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
