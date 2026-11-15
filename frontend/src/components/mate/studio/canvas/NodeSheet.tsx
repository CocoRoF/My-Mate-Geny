/**
 * A node's sheet on the studio canvas (docs/avatar-create.md §11 "The canvas"): what a click on a node or a tile opens
 * beside the canvas — the same settings and controls the studio always had, one node at a time: the concept, profile,
 * conversation style, voice and model (fields that save themselves, the agent's fills with Undo), the references,
 * what the agent wrote down to make, the estimate and its Confirm (the ONLY place a run starts), the candidates to
 * pick from, the base picture to approve, the faces, each set's clips, one picture or clip up close with its redo,
 * the checks with the run's controls, and the mate at the end (try her moods, apply, create).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { uploadReference, type AvatarEnv, type AvatarProject, type StudioInfo } from "../../../../api/avatar";
import type { Mate } from "../../../../api/mates";
import type { MateConversation } from "../../../../mate/useMateConversation";
import { tr, useT, type MsgKey } from "../../../../i18n";
import Icon, { type IconName } from "../../../ui/Icon";
import { BriefCard, Checkpoint, Clips, EnvNotice, EstimateCard, ExtraCard, Finish, Gallery, Progress, RedoButton, Thumb, unit, type Act } from "../../avatar/AvatarPanel";
import ModelTab from "../../settings/ModelTab";
import VoiceTab from "../../settings/VoiceTab";
import { SaveBarSlot } from "../../settings/ui";
import { FieldsCtx, type FieldsApi } from "../fields";
import { AvatarStage, ConceptSection, ProfileSection, StyleSection } from "../StudioSettings";
import { candidatesOf, checksOf, rowsOf, SET_KINDS, type SetKey } from "./graph";
import { labelOr } from "./StudioCanvas";

export interface NodeSheetProps {
  /** a node key (concept, estimate, set:idle, …) or a tile key (still:smile, clip:idle_a) */
  node: string;
  project: AvatarProject;
  mate: Mate;
  env: AvatarEnv | null;
  creating: boolean;
  act: Act;
  reloadEnv: () => void;
  conv: MateConversation;
  api: FieldsApi;
  busy: boolean;
  /** tell the agent something (a reference uploaded) */
  send: (text: string) => boolean;
  onClose: () => void;
  onOpen: (key: string) => void;
  onVoiceTested: () => void;
  onSkip: (skip: boolean) => void;
  onCreate?: () => void;
}

const TITLE: Record<string, { key: MsgKey; icon: IconName }> = {
  concept: { key: "studio.secConcept", icon: "sparkles" },
  profile: { key: "studio.secProfile", icon: "user" },
  style: { key: "studio.secStyle", icon: "chat" },
  refs: { key: "studio.cvRefs", icon: "image" },
  voice: { key: "studio.secVoice", icon: "volume" },
  model: { key: "studio.secModel", icon: "brain" },
  brief: { key: "studio.cvBrief", icon: "wand" },
  estimate: { key: "studio.cvEstimate", icon: "sparkles" },
  candidates: { key: "studio.cvCandidates", icon: "layers" },
  home: { key: "studio.cvHome", icon: "user" },
  check: { key: "studio.cvCheck", icon: "check" },
  mate: { key: "studio.cvMateSheet", icon: "heart" },
  "set:faces": { key: "studio.setFaces", icon: "image" },
  "set:idle": { key: "studio.setIdle", icon: "play" },
  "set:talk": { key: "studio.setTalk", icon: "play" },
  "set:react": { key: "studio.setReact", icon: "play" },
  "set:away": { key: "studio.setAway", icon: "play" },
};

function Hint({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-surface-3/50 px-3 py-2 text-[12px] leading-relaxed text-content-dim">{children}</p>;
}

/** the references: what she is drawn from (the agent decides how: redraw in the style, or use as the base picture) */
function Refs({ project, send }: { project: AvatarProject; send: (text: string) => boolean }) {
  const t = useT();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = !!project.confirmation;
  const take = async (f: File) => {
    setBusy(true);
    setErr(null);
    try {
      const p = await uploadReference(project.id, f);
      send(tr("avatar.uploadedRef", { name: p.brief.reference.files[p.brief.reference.files.length - 1] || f.name }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  return (
    <div className="space-y-3" data-testid="sheet-refs">
      <Hint>{t("studio.cvRefsHint")}</Hint>
      {project.files.refs.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {project.files.refs.map((r) => (
            <a key={r.name} href={r.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-border">
              <img src={r.url} alt={r.name} className="aspect-[3/4] w-full object-cover object-top" />
            </a>
          ))}
        </div>
      )}
      <p className="text-[12px] text-content-dim">{t(`avatar.ref_${project.brief.reference.mode}` as MsgKey)}</p>
      {!live && (
        <>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void take(e.target.files[0])} data-testid="sheet-refs-file" />
          <button type="button" className="btn-soft" disabled={busy} onClick={() => file.current?.click()} data-testid="sheet-refs-upload">
            <Icon name={busy ? "spinner" : "upload"} size={13} spin={busy} /> {t("studio.cvRefsUpload")}
          </button>
        </>
      )}
      {err && <p className="text-[12px] text-danger">{err}</p>}
    </div>
  );
}

/** one picture or clip up close: as big as it gets, what it is, its check, its redo (at its price) */
function TileDetail({ project, act, tileKey }: { project: AvatarProject; act: Act; tileKey: string }) {
  const t = useT();
  const tile = rowsOf(project)
    .flatMap((r) => r.tiles)
    .find((x) => x.key === tileKey);
  if (!tile) return <Hint>{t("studio.cvGone")}</Hint>;
  const clip = tile.kind === "clip" ? project.files.clips.find((c) => c.id === tile.id) : null;
  const label = labelOr(t, tile.kind === "still" ? `studio.still_${tile.id}` : `studio.clip_${tile.id}`, tile.id);
  const cost = tile.kind === "still" ? unit(project, "stills") : (unit(project, "clips") ?? 0) + (unit(project, "matte") ?? 0);
  const chk = tile.check;
  return (
    <div className="space-y-3" data-testid="sheet-tile" data-key={tileKey}>
      <div className="overflow-hidden rounded-xl border border-border bg-[rgb(213,212,217)]">
        {tile.video ? (
          <video src={tile.video} poster={tile.src ?? undefined} controls autoPlay muted loop playsInline className="mx-auto max-h-[52vh] w-full object-contain" data-testid="sheet-tile-video" />
        ) : tile.src ? (
          <img src={tile.src} alt={label} className="mx-auto max-h-[52vh] w-full object-contain" />
        ) : (
          <div className="grid aspect-[3/4] place-items-center text-[12px] text-content-faint">{t("studio.cvNotYet")}</div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-semibold text-content">{label}</span>
        <span className="text-[12px] text-content-faint">
          {tile.kind === "clip" ? `${tile.sub}${tile.emotion ? ` · ${tile.emotion}` : ""}` : t(tile.sub === "mechanic" ? "studio.cvMechanic" : "studio.cvFace")}
        </span>
        <span className="flex-1" />
        <span className={`pill ${tile.state === "done" ? "bg-success/15 text-success" : tile.state === "failed" ? "bg-danger/15 text-danger" : "bg-surface-3 text-content-dim"}`}>{t(`studio.cvState_${tile.state}` as MsgKey)}</span>
      </div>
      {clip && <p className="text-[12px] leading-relaxed text-content-dim">{clip.action}</p>}
      {tile.error && <p className="break-words rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{tile.error}</p>}
      {chk && !chk.missing && (
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 rounded-lg border border-border/70 px-3 py-2 text-[12px]" data-testid="sheet-tile-check">
          <dt className="text-content-faint">{t("studio.cvSeam")}</dt>
          <dd className={(chk.seam ?? 99) < 3 ? "text-success" : "text-warning"}>{chk.seam ?? "—"}</dd>
          <dt className="text-content-faint">{t("studio.cvStart")}</dt>
          <dd className={(chk.start ?? 99) < 4 ? "text-success" : "text-warning"}>{chk.start ?? "—"}</dd>
          <dt className="text-content-faint">{t("studio.cvClean")}</dt>
          <dd className={(chk.drift ?? 99) < 10 && (chk.soft ?? 1) < 0.12 ? "text-success" : "text-warning"}>
            {chk.drift ?? "—"} · {chk.soft ?? "—"}
          </dd>
        </dl>
      )}
      {project.confirmation && (tile.state === "done" || tile.state === "failed") && (
        <div className="flex justify-end">
          <RedoButton project={project} item={tile.key} credits={cost} act={act} label={t("avatar.redo")} />
        </div>
      )}
    </div>
  );
}

/** the faces outside their checkpoint: every still with its redo */
function Faces({ project, act }: { project: AvatarProject; act: Act }) {
  const t = useT();
  const f = project.files;
  if (project.checkpoint?.stage === "stills") return <Checkpoint project={project} act={act} />;
  if (!f.stills.length) return <Hint>{t("studio.cvFacesEmpty")}</Hint>;
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="sheet-faces">
      {f.home && <Thumb src={f.home} label={t("avatar.neutral")} />}
      {f.stills.map((s) => (
        <Thumb key={s.name} src={s.url} label={labelOr(t, `studio.still_${s.name}`, s.name)} testId="sheet-face">
          {project.confirmation && (s.status === "done" || s.status === "failed") && <RedoButton project={project} item={`still:${s.name}`} credits={unit(project, "stills")} act={act} label="" />}
        </Thumb>
      ))}
    </div>
  );
}

function Checks({ project, act }: { project: AvatarProject; act: Act }) {
  const t = useT();
  const c = checksOf(project);
  const missing = project.studio?.missing ?? [];
  return (
    <div className="space-y-3" data-testid="sheet-check">
      {missing.length > 0 && (
        <Hint>{t("studio.createNeeds", { what: missing.map((m) => labelOr(t, `studio.need_${m.split(" ")[0].replace(".", "_")}`, m)).join(", ") })}</Hint>
      )}
      {c ? (
        <dl className="grid grid-cols-[1fr,auto] gap-x-4 gap-y-1.5 rounded-lg border border-border/70 px-3 py-2.5 text-[12.5px]">
          <dt className="text-content-dim">{t("studio.cvSeamLong")}</dt>
          <dd className="tabular-nums">{c.seam.join("/")}</dd>
          <dt className="text-content-dim">{t("studio.cvStartLong")}</dt>
          <dd className="tabular-nums">{c.start.join("/")}</dd>
          <dt className="text-content-dim">{t("studio.cvCleanLong")}</dt>
          <dd className="tabular-nums">{c.clean.join("/")}</dd>
        </dl>
      ) : (
        <Hint>{t("studio.cvChecksLater")}</Hint>
      )}
      {c && c.failed.length > 0 && <Clips project={project} act={act} />}
      {project.confirmation && <Progress project={project} act={act} />}
    </div>
  );
}

export default function NodeSheet(props: NodeSheetProps) {
  const { node, project, mate, env, creating, act, reloadEnv, conv, api, busy, send, onClose, onOpen, onVoiceTested, onSkip, onCreate } = props;
  const t = useT();
  const studio = project.studio as StudioInfo | undefined;
  const isTile = node.startsWith("still:") || node.startsWith("clip:");
  const head = TITLE[node];
  const tileName = isTile ? labelOr(t, node.startsWith("still:") ? `studio.still_${node.slice(6)}` : `studio.clip_${node.slice(5)}`, node.split(":")[1]) : "";
  const panel = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    panel.current?.scrollTo({ top: 0 });
  }, [node]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as Element)?.closest?.("input,textarea,select")) onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const panelStudio = studio ? { kind: studio.kind, mateId: mate.id, mateName: mate.name || t("studio.untitled") } : undefined;
  const pending = project.extras.filter((x) => x.status === "pending");

  let body: ReactNode = null;
  if (isTile) body = <TileDetail project={project} act={act} tileKey={node} />;
  else if (node === "concept" && studio) body = <ConceptSection studio={studio} />;
  else if (node === "profile") body = <ProfileSection mate={mate} />;
  else if (node === "style") body = <StyleSection mate={mate} />;
  else if (node === "refs") body = <Refs project={project} send={send} />;
  else if (node === "voice")
    body = (
      <>
        {studio?.concept.voice && <Hint>{t("studio.voiceHint", { voice: studio.concept.voice })}</Hint>}
        <VoiceTab key={mate.id} mate={mate} conv={conv} onTest={onVoiceTested} />
      </>
    );
  else if (node === "model") body = <ModelTab key={mate.id} mate={mate} />;
  else if (node === "brief")
    body = (
      <>
        <AvatarStage project={project} mate={mate} kind={creating ? "new" : "existing"} onSkip={onSkip} />
        <BriefCard project={project} studio />
        <Hint>{t("studio.cvBriefHint")}</Hint>
      </>
    );
  else if (node === "estimate")
    body = (
      <>
        <EnvNotice env={env} reloadEnv={reloadEnv} />
        {pending.map((x) => (
          <ExtraCard key={x.id} project={project} x={x} act={act} />
        ))}
        {project.plan && !project.confirmation ? (
          <EstimateCard project={project} env={env} act={act} />
        ) : project.confirmation ? (
          <Progress project={project} act={act} />
        ) : (
          <Hint>{t("studio.cvEstimateHint")}</Hint>
        )}
      </>
    );
  else if (node === "candidates")
    body =
      project.checkpoint?.stage === "pick" ? (
        <Checkpoint project={project} act={act} />
      ) : candidatesOf(project).some((c) => c.src) ? (
        <Gallery project={project} />
      ) : (
        <Hint>{t("studio.cvCandidatesHint")}</Hint>
      );
  else if (node === "home")
    body =
      project.checkpoint?.stage === "home" ? (
        <Checkpoint project={project} act={act} />
      ) : project.files.home ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Thumb src={project.files.home} label={t("avatar.basePicture")} />
            <Thumb src={project.files.face} label={t("avatar.faceRegion")} />
          </div>
          <Hint>{t("studio.cvHomeHint")}</Hint>
          {project.confirmation && (
            <div className="flex justify-end">
              <RedoButton project={project} item="home" credits={unit(project, "home")} act={act} />
            </div>
          )}
        </div>
      ) : (
        <Hint>{t("studio.cvHomeHint")}</Hint>
      );
  else if (node === "set:faces") body = <Faces project={project} act={act} />;
  else if (node.startsWith("set:")) {
    const k = node.slice(4) as SetKey;
    const has = project.files.clips.some((c) => SET_KINDS[k].includes(c.kind));
    body = has ? (
      <>
        <Hint>{t(`studio.set${k[0].toUpperCase()}${k.slice(1)}Rule` as MsgKey)}</Hint>
        <Clips project={project} act={act} kinds={SET_KINDS[k]} all />
        <div className="flex flex-wrap gap-1.5">
          {project.files.clips
            .filter((c) => SET_KINDS[k].includes(c.kind))
            .map((c) => (
              <button key={c.id} type="button" className="rounded-full border border-border px-2.5 py-0.5 text-[11.5px] text-content-dim hover:bg-surface-3" onClick={() => onOpen(`clip:${c.id}`)}>
                {labelOr(t, `studio.clip_${c.id}`, c.id)}
              </button>
            ))}
        </div>
      </>
    ) : (
      <Hint>{t("studio.cvSetHint")}</Hint>
    );
  } else if (node === "check") body = <Checks project={project} act={act} />;
  else if (node === "mate")
    body = (
      <>
        {project.preview && (project.status === "ready" || project.status === "applied") ? (
          <Finish project={project} act={act} studio={panelStudio} />
        ) : (
          <AvatarStage project={project} mate={mate} kind={creating ? "new" : "existing"} onSkip={onSkip} />
        )}
        {creating && onCreate && (
          <div className="flex justify-end">
            <button className="btn-primary" disabled={busy || (studio?.missing.length ?? 0) > 0} onClick={onCreate} data-testid="sheet-create">
              <Icon name="check" size={14} /> {t("studio.create")}
            </button>
          </div>
        )}
      </>
    );

  return (
    <FieldsCtx.Provider value={api}>
      <aside className="flex h-full min-h-0 flex-col border-l border-border/70 bg-surface/95 shadow-float backdrop-blur-xl" data-testid="node-sheet" data-node={node} aria-label={head ? t(head.key) : tileName}>
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-3 text-content-dim">
            <Icon name={head?.icon ?? (node.startsWith("clip:") ? "play" : "image")} size={14} />
          </span>
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{head ? t(head.key) : tileName}</h2>
          <button className="btn-ghost !px-2" onClick={onClose} aria-label={t("common.close")} data-testid="node-sheet-close">
            <Icon name="x" size={15} />
          </button>
        </div>
        <SaveBarSlot.Provider value={slot}>
          <div ref={panel} className="fit-fields scrollbar-stable min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {body}
          </div>
        </SaveBarSlot.Provider>
        <div ref={setSlot} className="shrink-0" />
      </aside>
    </FieldsCtx.Provider>
  );
}
