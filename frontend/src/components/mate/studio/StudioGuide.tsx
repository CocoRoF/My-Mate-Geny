/**
 * The studio's Guide tab (docs/avatar-create.md §11 "The guide"), beside the canvas with the AI tab: making a mate one
 * step at a time, in the order a beginner follows — what to decide now in a sentence, the one or two fields it takes
 * right there, 자세히 for the rest (the node's window over the canvas), "AI에게 맡기기" when they'd rather the AI did it
 * (the AI tab, with a message for that step), and 다음. Her look branches: drawn by AI (the run's own steps: the
 * estimate, a candidate, the base picture, the faces — each a press away), a file they have (upload, fit, match her
 * emotions to its expressions and motions), or later. Editing an existing mate: the same steps, each one open to change.
 */
import { useState, type ReactNode } from "react";
import type { AvatarEnv, AvatarProject } from "../../../api/avatar";
import { prefsOf, type Mate } from "../../../api/mates";
import { useT, type MsgKey } from "../../../i18n";
import Icon, { type IconName } from "../../ui/Icon";
import { EnvNotice } from "../avatar/AvatarPanel";
import { AutoText, Choice, FieldFrame, FieldsCtx, type FieldsApi } from "./fields";
import { drawStage, fileAvatar, guideProgress, currentStep, GUIDE_STEPS, OPTIONAL, STEP_NODE, stepsDone, type Checked, type DrawStage, type GuideStepId, type LookPath } from "./guide";
import { LookChooser } from "./LookFile";
import { rowsOf } from "./canvas/graph";
import { voiceLine } from "./canvas/StudioCanvas";

export interface StudioGuideProps {
  project: AvatarProject;
  mate: Mate;
  /** a new mate still being made (else: editing her) */
  creating: boolean;
  env: AvatarEnv | null;
  reloadEnv: () => void;
  api: FieldsApi;
  busy: boolean;
  /** the AI is answering */
  streaming: boolean;
  checked: Checked;
  onCheck: (step: GuideStepId | "file", on?: boolean) => void;
  look: LookPath | null;
  onLook: (path: LookPath | null) => void;
  onOpen: (node: string) => void;
  /** to the AI tab, with this message */
  onAi: (text: string) => void;
  onCreate?: () => void;
  onDone: () => void;
}

const TITLE: Record<GuideStepId, MsgKey> = {
  concept: "studio.gConcept",
  profile: "studio.gProfile",
  style: "studio.gStyle",
  temperament: "studio.gTemperament",
  look: "studio.gLook",
  voice: "studio.gVoice",
  model: "studio.gModel",
  finish: "studio.gFinish",
};
const SAYS: Record<GuideStepId, MsgKey> = {
  concept: "studio.gConceptSays",
  profile: "studio.gProfileSays",
  style: "studio.gStyleSays",
  temperament: "studio.gTemperamentSays",
  look: "studio.gLookSays",
  voice: "studio.gVoiceSays",
  model: "studio.gModelSays",
  finish: "studio.gFinishSays",
};
const ICON: Record<GuideStepId, IconName> = {
  concept: "lightbulb",
  profile: "user",
  style: "chat",
  temperament: "heart",
  look: "image",
  voice: "volume",
  model: "brain",
  finish: "check",
};
/** what the AI is asked, step by step (none: a step the AI can't do) */
const ASK: Partial<Record<GuideStepId, MsgKey>> = {
  concept: "studio.aiAskConcept",
  profile: "studio.aiAskProfile",
  style: "studio.aiAskStyle",
  voice: "studio.aiAskVoice",
};
const EXAMPLES: MsgKey[] = ["studio.gEx1", "studio.gEx2", "studio.gEx3", "studio.gEx4"];

function Btn({ children, onClick, kind = "ghost", icon, testId, disabled }: { children: ReactNode; onClick: () => void; kind?: "primary" | "soft" | "ghost"; icon?: IconName; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" className={`${kind === "primary" ? "btn-primary" : kind === "soft" ? "btn-soft" : "btn-ghost"} !px-3 !py-1.5 text-[12.5px]`} onClick={onClick} disabled={disabled} data-testid={testId}>
      {icon && <Icon name={icon} size={13} />} {children}
    </button>
  );
}

/** one step of her look's own way (the picture way, the file way): done, now, or later */
function SubStep({ n, state, title, children, testId }: { n: number; state: "done" | "now" | "todo"; title: string; children?: ReactNode; testId: string }) {
  return (
    <li className="flex gap-2.5" data-testid={testId} data-state={state}>
      <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold ${state === "done" ? "bg-success/15 text-success" : state === "now" ? "bg-accent text-white" : "bg-surface-3 text-content-faint"}`}>
        {state === "done" ? <Icon name="check" size={10} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-[12.5px] ${state === "now" ? "font-semibold text-content" : state === "done" ? "text-content-dim" : "text-content-faint"}`}>{title}</p>
        {state === "now" && children && <div className="mt-1.5 space-y-2">{children}</div>}
      </div>
    </li>
  );
}

const DRAW_ORDER: DrawStage[] = ["brief", "estimate", "pick", "home", "stills", "making", "ready"];

function DrawSteps({ project: p, env, reloadEnv, streaming, onOpen, onAi, creating }: Pick<StudioGuideProps, "project" | "env" | "reloadEnv" | "streaming" | "onOpen" | "onAi" | "creating">) {
  const outfit = !!p.outfit;
  const stage = drawStage(p);
  // (made: a new mate has it on by itself; an existing mate's or an outfit's waits for Apply / Wear)
  const toApply = stage === "ready" && p.status === "ready" && !creating;
  const t = useT();
  const at = stage === "extra" ? DRAW_ORDER.indexOf(p.confirmation ? "making" : "estimate") : stage === "failed" ? DRAW_ORDER.indexOf("making") : DRAW_ORDER.indexOf(stage);
  const asBase = p.brief.reference.mode === "as_base";
  const tiles = rowsOf(p).flatMap((r) => r.tiles);
  const made = tiles.filter((x) => x.state === "done").length;
  const steps: { id: DrawStage; title: MsgKey }[] = [
    { id: "brief", title: "studio.gDrawBrief" },
    { id: "estimate", title: "studio.gDrawEstimate" },
    ...(asBase ? [] : [{ id: "pick" as const, title: "studio.gDrawPick" as MsgKey }]),
    { id: "home", title: "studio.gDrawHome" },
    { id: "stills", title: "studio.gDrawStills" },
    { id: "making", title: "studio.gDrawMaking" },
    { id: "ready", title: "studio.gDrawReady" },
  ];
  const state = (id: DrawStage) => {
    const i = DRAW_ORDER.indexOf(id);
    return i < at ? "done" : i === at ? "now" : "todo";
  };
  return (
    <ol className="space-y-2.5" data-testid="guide-draw" data-stage={stage}>
      {steps.map((s, i) => (
        <SubStep key={s.id} n={i + 1} state={s.id === "ready" && stage === "ready" ? (toApply ? "now" : "done") : state(s.id)} title={t(s.title)} testId={`guide-draw-${s.id}`}>
          {s.id === "brief" && (
            <>
              <p className="text-[12px] leading-relaxed text-content-dim">{t("studio.gDrawBriefSays")}</p>
              <EnvNotice env={env} reloadEnv={reloadEnv} />
              <div className="flex flex-wrap gap-1.5">
                <Btn kind="primary" icon="sparkles" onClick={() => onAi(t(outfit ? "studio.aiAskOutfit" : "studio.aiAskDraw"))} testId="guide-draw-ai" disabled={streaming}>
                  {streaming ? t("studio.gAiWorking") : t("studio.gDrawAsk")}
                </Btn>
                <Btn icon="image" onClick={() => onOpen("refs")} testId="guide-draw-refs">
                  {t("studio.gDrawRefs")}
                </Btn>
              </div>
            </>
          )}
          {s.id === "estimate" && (
            <>
              <p className="text-[12px] text-content-dim">{stage === "extra" ? t("studio.wait_extra") : p.plan ? t("studio.gDrawEstimateSays", { credits: Number(p.plan.total.toFixed(1)).toLocaleString(), minutes: Math.max(1, Math.round(p.plan.minutes)) }) : ""}</p>
              <Btn kind="primary" icon="check" onClick={() => onOpen("estimate")} testId="guide-draw-estimate">
                {t("studio.gDrawEstimateOpen")}
              </Btn>
            </>
          )}
          {s.id === "pick" && (
            <Btn kind="primary" icon="layers" onClick={() => onOpen("candidates")} testId="guide-draw-pick">
              {t("studio.cvPickOne")}
            </Btn>
          )}
          {s.id === "home" && (
            <Btn kind="primary" icon="user" onClick={() => onOpen("home")} testId="guide-draw-home">
              {t("studio.gDrawHomeOpen")}
            </Btn>
          )}
          {s.id === "stills" && (
            <Btn kind="primary" icon="image" onClick={() => onOpen("set:faces")} testId="guide-draw-stills">
              {t("studio.gDrawStillsOpen")}
            </Btn>
          )}
          {s.id === "ready" && toApply && (
            <>
              <p className="text-[12px] leading-relaxed text-content-dim">{t(outfit ? "studio.gDrawReadyOutfit" : "studio.gDrawReadySays")}</p>
              <Btn kind="primary" icon="check" onClick={() => onOpen("mate")} testId="guide-draw-apply">
                {t(outfit ? "studio.cvWearIt" : "studio.cvApplyIt")}
              </Btn>
            </>
          )}
          {s.id === "making" && (
            <>
              <p className="text-[12px] leading-relaxed text-content-dim">
                {stage === "failed" ? t("studio.gDrawFailed") : t("studio.gDrawMakingSays", { done: made, total: tiles.length })}
              </p>
              <Btn icon={stage === "failed" ? "warning" : "activity"} onClick={() => onOpen(stage === "failed" ? "check" : "estimate")} testId="guide-draw-progress">
                {t("studio.gDrawProgress")}
              </Btn>
            </>
          )}
        </SubStep>
      ))}
    </ol>
  );
}

function FileSteps({ mate, checked, onOpen, onAi, onCheck }: Pick<StudioGuideProps, "mate" | "checked" | "onOpen" | "onAi" | "onCheck">) {
  const t = useT();
  // (a drawn look is no file: brought in here, or a model / package she has)
  const has = fileAvatar(mate) || !!checked.file;
  const maps = fileAvatar(mate);
  const now = !has ? 0 : maps && !checked.look ? 2 : 3;
  return (
    <ol className="space-y-2.5" data-testid="guide-file">
      <SubStep n={1} state={has ? "done" : "now"} title={t("studio.gFileUpload")} testId="guide-file-upload">
        <p className="text-[12px] leading-relaxed text-content-dim">{t("studio.gFileUploadSays")}</p>
        <Btn kind="primary" icon="upload" onClick={() => onOpen("import")} testId="guide-file-open">
          {t("studio.gFileUploadOpen")}
        </Btn>
      </SubStep>
      {has && (
        <div className="-mt-1.5 pl-[30px]">
          <button type="button" className="text-[11.5px] text-accent hover:underline" onClick={() => onOpen("import")} data-testid="guide-file-other">
            {t("studio.fileOther")}
          </button>
        </div>
      )}
      <SubStep n={2} state={!has ? "todo" : "done"} title={t("studio.gFileFit")} testId="guide-file-fit" />
      {has && maps && (
        <div className="-mt-1.5 pl-[30px]">
          <button type="button" className="text-[11.5px] text-accent hover:underline" onClick={() => onOpen("import")} data-testid="guide-file-fit-open">
            {t("studio.gFileFitOpen")}
          </button>
        </div>
      )}
      {maps || !has ? (
        <SubStep n={3} state={now === 2 ? "now" : now === 3 ? "done" : "todo"} title={t("studio.gFileMap")} testId="guide-file-map">
          <p className="text-[12px] leading-relaxed text-content-dim">{t("studio.gFileMapSays")}</p>
          <div className="flex flex-wrap gap-1.5">
            <Btn kind="primary" icon="play" onClick={() => onOpen("motions")} testId="guide-file-map-open">
              {t("studio.gFileMapOpen")}
            </Btn>
            <Btn icon="sparkles" onClick={() => onAi(t("studio.aiAskMap"))} testId="guide-file-map-ai">
              {t("studio.askAi")}
            </Btn>
            <Btn icon="check" onClick={() => onCheck("look")} testId="guide-file-map-ok">
              {t("studio.gFileMapOk")}
            </Btn>
          </div>
        </SubStep>
      ) : null}
      {now === 3 && maps && (
        <div className="pl-[30px]">
          <button type="button" className="text-[11.5px] text-accent hover:underline" onClick={() => onOpen("motions")} data-testid="guide-file-map-again">
            {t("studio.gFileMapAgain")}
          </button>
        </div>
      )}
    </ol>
  );
}

export default function StudioGuide(props: StudioGuideProps) {
  const { project: p, mate, creating, api, busy, streaming, checked, onCheck, look, onLook, onOpen, onAi, onCreate, onDone } = props;
  const t = useT();
  const st = p.studio;
  const outfit = !!p.outfit;
  const prefs = prefsOf(mate);
  const done = stepsDone(p, mate, checked, look);
  const steps = creating ? GUIDE_STEPS : GUIDE_STEPS.filter((s) => s !== "finish");
  const cur = creating ? currentStep(done, checked, steps) : null;
  const prog = guideProgress(done, checked, steps);
  // the open step: the current one when the guide opens, then the one the user opened or went on to (it never moves
  // by itself: a step done while they type in it stays open until they press 다음)
  const [open, setOpen] = useState<GuideStepId | null>(cur);
  /** choosing her look's way again (다른 방법 고르기) */
  const [choosing, setChoosing] = useState(false);
  const missing = st?.missing ?? [];
  const next = (s: GuideStepId) => {
    if (OPTIONAL.has(s) || s === "style" || s === "voice") onCheck(s);
    const i = steps.indexOf(s);
    const after = steps.slice(i + 1).find((x) => !done[x]) ?? steps[Math.min(i + 1, steps.length - 1)];
    setOpen(after);
  };
  const ask = (s: GuideStepId) => {
    const k = ASK[s];
    if (!k) return;
    onAi(t(k, { pitch: st?.concept.pitch || "", name: mate.name || "" }));
  };

  if (outfit)
    return (
      <div className="space-y-3 px-4 py-4" data-testid="studio-guide" data-mode="outfit">
        <div>
          <h2 className="text-[15px] font-semibold text-content">{t("studio.gOutfitTitle", { name: mate.name })}</h2>
          <p className="mt-0.5 text-[12px] text-content-dim">{t("studio.gOutfitSays")}</p>
        </div>
        <DrawSteps project={p} env={props.env} reloadEnv={props.reloadEnv} streaming={streaming} onOpen={onOpen} onAi={onAi} creating={creating} />
      </div>
    );

  const summary = (s: GuideStepId): string => {
    if (s === "concept") return st?.concept.pitch || "";
    if (s === "profile") return [mate.name, mate.persona.personality].filter(Boolean).join(" · ");
    if (s === "style") return [prefs.formality !== "auto" ? t(`studio.formality_${prefs.formality}` as MsgKey) : "", prefs.address].filter(Boolean).join(" · ");
    if (s === "temperament") return prefs.temperament ? t("studio.gTemperamentOwn") : t("studio.gTemperamentAuto");
    if (s === "look") return look ? t(look === "draw" ? "studio.lookDraw" : look === "file" ? "studio.lookFile" : "studio.lookLater") : mate.avatar.kind !== "none" ? t("studio.avatarCurrent") : "";
    if (s === "voice") return voiceLine(mate, t);
    if (s === "model") return mate.llm.model;
    return "";
  };

  const body = (s: GuideStepId): ReactNode => {
    const detail = s !== "look" && s !== "finish" ? (
      <Btn kind={creating ? "ghost" : "soft"} icon="pencil" onClick={() => onOpen(STEP_NODE[s])} testId={`guide-${s}-open`}>
        {creating ? t("studio.gMore") : t("studio.gChange")}
      </Btn>
    ) : null;
    const aiBtn = ASK[s] ? (
      <Btn icon="sparkles" onClick={() => ask(s)} testId={`guide-${s}-ai`}>
        {t("studio.askAi")}
      </Btn>
    ) : null;
    const nextBtn = creating ? (
      <Btn kind="primary" onClick={() => next(s)} testId={`guide-${s}-next`} disabled={s === "profile" && !done.profile}>
        {OPTIONAL.has(s) && !done[s] ? t("studio.gSkip") : t("studio.gNext")} <Icon name="chevron" size={12} />
      </Btn>
    ) : null;
    const row = (...xs: ReactNode[]) => <div className="flex flex-wrap items-center gap-1.5 pt-1">{xs}</div>;

    if (s === "concept")
      return (
        <>
          {creating && (
            <>
              <FieldFrame path="concept.pitch" label={t("studio.gConceptField")}>
                <AutoText path="concept.pitch" value={st?.concept.pitch ?? ""} maxLength={600} placeholder={t("studio.conceptPitchPh")} testId="guide-concept-pitch" />
              </FieldFrame>
              <div className="flex flex-wrap gap-1.5" data-testid="guide-concept-examples">
                {EXAMPLES.map((k) => (
                  <button key={k} type="button" className="rounded-full border border-border px-2.5 py-0.5 text-[11.5px] text-content-dim hover:border-accent/50 hover:bg-accent-soft/40 hover:text-content" onClick={() => void api.save("concept.pitch", t(k))}>
                    {t(k)}
                  </button>
                ))}
              </div>
            </>
          )}
          {row(detail, aiBtn, nextBtn)}
        </>
      );
    if (s === "profile")
      return (
        <>
          {creating && (
            <>
              <FieldFrame path="name" label={t("mateSettings.profName")}>
                <AutoText path="name" value={mate.name} maxLength={40} placeholder={t("studio.namePh")} testId="guide-name" />
              </FieldFrame>
              <FieldFrame path="persona.personality" label={t("mateSettings.profPersonality")}>
                <AutoText path="persona.personality" value={mate.persona.personality} multiline rows={2} placeholder={t("mateSettings.profPersonalityPh")} testId="guide-personality" />
              </FieldFrame>
              {missing.length > 0 && <p className="text-[11.5px] text-warning" data-testid="guide-profile-needs">{t("studio.gProfileNeeds")}</p>}
            </>
          )}
          {row(detail, aiBtn, nextBtn)}
        </>
      );
    if (s === "style")
      return (
        <>
          {creating && (
            <>
              <FieldFrame as="div" path="prefs.formality" label={t("mateSettings.styleFormality")}>
                <Choice
                  path="prefs.formality"
                  value={prefs.formality}
                  options={[
                    { id: "auto", label: t("studio.gFormalityAuto") },
                    { id: "haeyo", label: t("mateSettings.styleHaeyo") },
                    { id: "hapsyo", label: t("mateSettings.styleHapsyo") },
                    { id: "banmal", label: t("mateSettings.styleBanmal") },
                  ]}
                  testId="guide-formality"
                />
              </FieldFrame>
              <FieldFrame path="prefs.address" label={t("mateSettings.profCallsYou")}>
                <AutoText path="prefs.address" value={prefs.address} maxLength={40} placeholder={t("studio.gAddressPh")} testId="guide-address" />
              </FieldFrame>
            </>
          )}
          {row(detail, aiBtn, nextBtn)}
        </>
      );
    if (s === "temperament" || s === "model")
      return (
        <>
          {row(
            <Btn key="o" kind="soft" icon={s === "model" ? "brain" : "heart"} onClick={() => onOpen(STEP_NODE[s])} testId={`guide-${s}-open`}>
              {s === "model" ? t("studio.gModelOpen") : t("studio.gTemperamentOpen")}
            </Btn>,
            creating ? (
              <Btn key="k" icon="check" onClick={() => next(s)} testId={`guide-${s}-keep`}>
                {t("studio.gKeep")}
              </Btn>
            ) : null,
          )}
        </>
      );
    if (s === "voice")
      return (
        <>
          {st?.concept.voice && <p className="rounded-lg bg-accent-soft/40 px-2.5 py-1.5 text-[11.5px] text-content-dim">{t("studio.voiceHint", { voice: st.concept.voice })}</p>}
          {row(
            <Btn key="o" kind="soft" icon="volume" onClick={() => onOpen("voice")} testId="guide-voice-open">
              {t("studio.gVoiceOpen")}
            </Btn>,
            aiBtn,
            creating ? (
              <Btn key="k" kind="primary" onClick={() => next(s)} testId="guide-voice-next">
                {done.voice ? t("studio.gNext") : t("studio.gVoiceKeep")} <Icon name="chevron" size={12} />
              </Btn>
            ) : null,
          )}
        </>
      );
    if (s === "look") {
      const started = !!(p.plan || p.confirmation);
      return (
        <>
          {!look || choosing ? (
            <>
              <LookChooser
                path={look}
                creating={creating}
                onPick={(x) => {
                  setChoosing(false);
                  onLook(x);
                }}
                onWardrobe={creating ? undefined : () => onOpen("wardrobe")}
              />
              {choosing && (
                <button type="button" className="text-[11.5px] text-content-faint hover:underline" onClick={() => setChoosing(false)} data-testid="guide-look-cancel">
                  {t("common.cancel")}
                </button>
              )}
            </>
          ) : (
            <>
              {look === "draw" && <DrawSteps project={p} env={props.env} reloadEnv={props.reloadEnv} streaming={streaming} onOpen={onOpen} onAi={onAi} creating={creating} />}
              {look === "file" && <FileSteps mate={mate} checked={checked} onOpen={onOpen} onAi={onAi} onCheck={onCheck} />}
              {look === "later" && <p className="text-[12px] leading-relaxed text-content-dim" data-testid="guide-look-later">{t("studio.gLookLaterSays")}</p>}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1">
                {!started && (
                  <button type="button" className="text-[11.5px] text-accent hover:underline" onClick={() => setChoosing(true)} data-testid="guide-look-change">
                    {t("studio.gLookChange")}
                  </button>
                )}
                {!creating && (
                  <button type="button" className="text-[11.5px] text-accent hover:underline" onClick={() => onOpen("wardrobe")} data-testid="guide-look-wardrobe">
                    {t("studio.lookWardrobe")}
                  </button>
                )}
                <span className="flex-1" />
                {creating && (look === "later" || done.look || (look === "draw" && started)) && (
                  <Btn kind="primary" onClick={() => next(s)} testId="guide-look-next">
                    {t("studio.gNext")} <Icon name="chevron" size={12} />
                  </Btn>
                )}
              </div>
            </>
          )}
        </>
      );
    }
    // finish
    return (
      <>
        {missing.length > 0 ? (
          <ul className="space-y-1" data-testid="guide-finish-needs">
            {missing.map((m) => (
              <li key={m}>
                <button type="button" className="flex items-center gap-1.5 text-[12px] text-warning hover:underline" onClick={() => setOpen("profile")}>
                  <Icon name="warning" size={12} /> {t(`studio.need_${m.split(" ")[0].replace(".", "_")}` as MsgKey)}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] leading-relaxed text-content-dim">{p.status === "running" || p.status === "waiting" ? t("studio.gFinishMaking") : t("studio.gFinishReady", { name: mate.name || t("studio.untitled") })}</p>
        )}
        {onCreate && (
          <div className="pt-1">
            <button type="button" className="btn-primary w-full justify-center !py-2.5 text-[14px]" disabled={busy || missing.length > 0} onClick={onCreate} data-testid="guide-create">
              {busy ? <Icon name="spinner" size={15} spin /> : <Icon name="check" size={15} />} {t("studio.create")}
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <FieldsCtx.Provider value={api}>
      <div className="flex min-h-0 flex-1 flex-col" data-testid="studio-guide" data-mode={creating ? "create" : "edit"} data-step={cur ?? ""}>
        <div className="shrink-0 border-b border-border/60 px-4 pb-3 pt-3.5">
          <h2 className="text-[15px] font-semibold text-content">{creating ? t("studio.gTitleNew") : t("studio.gTitleEdit", { name: mate.name })}</h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-content-dim">{creating ? t("studio.gSubNew") : t("studio.gSubEdit")}</p>
          {creating && (
            <div className="mt-2.5 flex items-center gap-2">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                <span className="block h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%` }} />
              </span>
              <span className="shrink-0 text-[11.5px] tabular-nums text-content-faint" data-testid="guide-progress">
                {t("studio.gProgress", { done: prog.done, total: prog.total })}
              </span>
            </div>
          )}
        </div>
        <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3" aria-label={t("studio.gTitleNew")}>
          {steps.map((s, i) => {
            const isOpen = open === s;
            const state = done[s] || (OPTIONAL.has(s) && checked[s]) ? "done" : s === cur ? "current" : "todo";
            const sum = summary(s);
            return (
              <li
                key={s}
                className={`rounded-xl border transition-colors ${isOpen ? "border-accent/50 bg-surface-2 shadow-card" : state === "done" ? "border-border/60 bg-surface/40" : "border-border/60"}`}
                data-testid={`guide-step-${s}`}
                data-state={state}
                data-open={isOpen ? "1" : "0"}
              >
                <button type="button" className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left" onClick={() => setOpen(isOpen ? null : s)} aria-expanded={isOpen} data-testid={`guide-step-${s}-toggle`}>
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                      state === "done" && creating ? "bg-success/15 text-success" : isOpen || state === "current" ? "bg-accent text-white" : "bg-surface-3 text-content-dim"
                    }`}
                  >
                    {state === "done" && creating ? <Icon name="check" size={12} /> : creating ? i + 1 : <Icon name={ICON[s]} size={12} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={`text-[13.5px] ${isOpen || state === "current" ? "font-semibold text-content" : "font-medium text-content-dim"}`}>{t(TITLE[s])}</span>
                      {creating && OPTIONAL.has(s) && <span className="rounded-full bg-surface-3 px-1.5 text-[10px] text-content-faint">{t("studio.gOptional")}</span>}
                    </span>
                    {!isOpen && sum && <span className="block truncate text-[11.5px] text-content-faint">{sum}</span>}
                  </span>
                  <Icon name="chevron-down" size={13} className={`shrink-0 text-content-faint transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>
                {isOpen && (
                  <div className="space-y-2.5 border-t border-border/50 px-3 pb-3 pt-2.5 animate-fade-in" data-testid={`guide-step-${s}-body`}>
                    <p className="text-[12.5px] leading-relaxed text-content-dim">{t(SAYS[s], { name: mate.name || t("studio.untitled") })}</p>
                    {body(s)}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {!creating && (
          <div className="shrink-0 border-t border-border/60 px-4 py-2.5">
            <button type="button" className="btn-soft w-full justify-center" onClick={onDone} data-testid="guide-done">
              <Icon name="check" size={13} /> {t("studio.done")}
            </button>
          </div>
        )}
      </div>
    </FieldsCtx.Provider>
  );
}
