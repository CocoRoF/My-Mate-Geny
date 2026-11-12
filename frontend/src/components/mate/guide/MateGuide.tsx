/**
 * The Mate panel's guide: a few steps with only what matters most for one mate, each saved as it is left (mate/guide.ts
 * decides what): 1 프로필 (name, a short intro, personality, birthday) · 2 대화 방식 (what she calls you, warmth, humour)
 * · 3 아바타·의상 (the feelings her avatar shows) · 4 음성 (engine and voice) · 5 화면 공유와 먼저 말 걸기 (this
 * device: asking before a capture, the picture's size, speaking first, the volume — the 공통 tab's store) · then a
 * closing page. Everything else stays in Mate settings.
 *
 * It opens by itself the first time the Mate panel opens (once per account on this device) and right after a new mate
 * is created in the studio (for her); Mate settings' header (and the phone's ⋯) opens it again (MateView). Every step
 * has 건너뛰기 (on, nothing saved), 나중에 할래요 (closed, nothing more), 이전 and 저장하고 다음; closing it any other way
 * (×, Esc, a press outside) is 나중에 할래요.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fillAddress, prefsOf, type Mate, type MateVoice, type MatePrefs, type ToneLevel } from "../../../api/mates";
import {
  avatarPatch,
  deviceDraft,
  devicePatch,
  emotionList,
  GUIDE_EMOTIONS,
  GUIDE_STEPS,
  guideMove,
  guideTts,
  profileDraft,
  profilePatch,
  stepNumber,
  styleDraft,
  stylePatch,
  voicePatch,
  withEmotionToggles,
  withTtsEngine,
  type DeviceDraft,
  type GuideAction,
  type GuidePage,
  type GuideStep,
  type ProfileDraft,
  type StyleDraft,
} from "../../../mate/guide";
import { emotionLabel } from "../../../mate/emotionLabel";
import { canShareScreen } from "../../../mate/screenCapture";
import { patchDevicePreferences, useDevicePreferences } from "../../../stores/devicePreferences";
import { useMateStore } from "../../../stores/mateStore";
import { useStudio } from "../../../stores/studioStore";
import { useT, type MsgKey } from "../../../i18n";
import Icon, { type IconName } from "../../ui/Icon";
import BirthdayPicker from "../../ui/BirthdayPicker";
import { MateThumb } from "../MateStage";
import { Field, Segmented, Toggle } from "../settings/ui";
import { addressChips } from "../settings/StyleTab";
import { QuickVoice, SPEED, VolumeField } from "../settings/VoiceTab";

const STEP: Record<GuideStep, { label: MsgKey; hint: MsgKey; icon: IconName }> = {
  profile: { label: "guide.stepProfile", hint: "guide.stepProfileHint", icon: "user" },
  style: { label: "guide.stepStyle", hint: "guide.stepStyleHint", icon: "chat" },
  avatar: { label: "guide.stepAvatar", hint: "guide.stepAvatarHint", icon: "sparkles" },
  voice: { label: "guide.stepVoice", hint: "guide.stepVoiceHint", icon: "volume" },
  device: { label: "guide.stepDevice", hint: "guide.stepDeviceHint", icon: "monitor" },
};

const TONE: { key: "warmth" | "humor"; label: MsgKey; low: MsgKey; high: MsgKey }[] = [
  { key: "warmth", label: "mateSettings.styleWarmth", low: "mateSettings.styleWarmthLow", high: "mateSettings.styleWarmthHigh" },
  { key: "humor", label: "mateSettings.styleHumor", low: "mateSettings.styleHumorLow", high: "mateSettings.styleHumorHigh" },
];

const SIZES = [0, 2560, 1920, 1280];

type Tts = MateVoice["tts"];

export default function MateGuide({ mate, onClose }: { mate: Mate; onClose: () => void }) {
  const t = useT();
  const [page, setPage] = useState<GuidePage>("profile");
  const prefs = prefsOf(mate);
  const device = useDevicePreferences();
  // what the user changed on each step (null / {}: nothing yet — the step shows what is saved now)
  const [profile, setProfile] = useState<ProfileDraft | null>(null);
  const [style, setStyle] = useState<StyleDraft | null>(null);
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [tts, setTts] = useState<Tts | null>(null);
  const [dev, setDev] = useState<DeviceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const savedProfile = profileDraft(mate);
  const savedStyle = styleDraft(prefs);
  const shownProfile = profile ?? savedProfile;
  const shownStyle = style ?? savedStyle;
  const avatar = withEmotionToggles(mate.avatar, toggles);
  const shownTts = tts ?? guideTts(mate.voice.tts);
  const shownDev = dev ?? deviceDraft(device);

  /** this step's save, when it has anything to save */
  const store = useMateStore.getState;
  const saveStep = (): (() => Promise<unknown>) | null => {
    const patch =
      page === "profile" ? profile && profilePatch(savedProfile, profile)
      : page === "style" ? style && stylePatch(savedStyle, style)
      : page === "avatar" ? avatarPatch(mate.avatar, avatar)
      : page === "voice" ? tts && voicePatch(mate.voice.tts, tts)
      : null;
    if (patch) return () => store().patch(mate.id, patch);
    const local = page === "device" && dev ? devicePatch(device, dev, mate.id) : null;
    return local ? () => patchDevicePreferences(local) : null;
  };
  const pending = saveStep();
  /** a step left without saving (skipped) starts from what is saved when it comes back */
  const forget = (p: GuidePage) => {
    if (p === "profile") setProfile(null);
    if (p === "style") setStyle(null);
    if (p === "avatar") setToggles({});
    if (p === "voice") setTts(null);
    if (p === "device") setDev(null);
  };
  const go = (action: GuideAction) => {
    setErr(null);
    const to = guideMove(page, action);
    if (to === null) onClose();
    else setPage(to);
  };
  const next = async () => {
    if (busy) return;
    if (!pending) return go("next");
    setBusy(true);
    setErr(null);
    try {
      await pending();
      forget(page);
      go("next");
    } catch (e) {
      setErr((e as Error).message || t("common.couldNotSave"));
    } finally {
      setBusy(false);
    }
  };
  const skip = () => {
    forget(page);
    go("skip");
  };

  // a new page: it reads from its top, and the dialog has the focus (Esc closes it, Tab stays in it)
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo(0, 0);
    box.current?.focus({ preventScroll: true });
  }, [page]);
  const back = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => () => void (back.current?.isConnected && back.current.focus({ preventScroll: true })), []);
  const pressedOutside = useRef(false);

  const name = mate.name;
  const n = stepNumber(page);
  const done = page === "done";

  return createPortal(
    <div
      className="fixed inset-0 top-[var(--window-chrome-height,0px)] z-[105] flex items-end justify-center bg-scrim/50 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-[2px] animate-fade-in sm:items-center sm:p-4"
      onPointerDown={(e) => (pressedOutside.current = e.target === e.currentTarget)}
      onClick={(e) => e.target === e.currentTarget && pressedOutside.current && !busy && go("later")}
      data-testid="mate-guide"
      data-page={page}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mate-guide-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            // (Tab goes round the dialog: what is under it can't be reached)
            const all = [...(box.current?.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])") ?? [])].filter((x) => !x.hasAttribute("disabled") && x.offsetParent !== null);
            const first = all[0];
            const last = all[all.length - 1];
            if (!first) return;
            if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
            return;
          }
          // Esc: 나중에 할래요 (a field's own Esc — a list being searched — stays the field's)
          const el = e.target as HTMLElement;
          if (e.key !== "Escape" || e.defaultPrevented || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
          e.preventDefault();
          if (!busy) go("later");
        }}
        className="flex max-h-[min(92dvh,760px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface-2 shadow-xl outline-none"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border/70 px-5 pb-3 pt-4">
          <MateThumb mate={mate} className="h-9 w-9" />
          <div className="min-w-0 flex-1">
            <h2 id="mate-guide-title" className="truncate text-[14.5px] font-semibold text-content">
              {t("guide.title", { name })}
            </h2>
            <p className="truncate text-[11.5px] text-content-faint" data-testid="mate-guide-step">
              {done ? t("guide.doneSub") : t("guide.stepOf", { n, total: GUIDE_STEPS.length, step: t(STEP[page].label) })}
            </p>
          </div>
          <button type="button" className="btn-ghost !px-2" onClick={() => go("later")} disabled={busy} aria-label={t("guide.later")} title={t("guide.later")} data-testid="mate-guide-close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <ol className="flex shrink-0 gap-1 px-5 pt-3" aria-label={t("guide.steps")}>
          {GUIDE_STEPS.map((s, i) => (
            <li key={s} className={`h-1 flex-1 rounded-full ${done || i < n - 1 ? "bg-accent" : i === n - 1 ? "bg-accent/60" : "bg-surface-3"}`} aria-current={!done && i === n - 1 ? "step" : undefined} title={t(STEP[s].label)} />
          ))}
        </ol>

        <div ref={body} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {done ? (
            <div className="py-6 text-center" data-testid="mate-guide-done">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-accent-soft text-accent">
                <Icon name="heart" size={24} />
              </div>
              <p className="mx-auto mt-4 max-w-sm text-[15px] font-semibold leading-relaxed text-content">{t("guide.doneTitle", { name })}</p>
              <p className="mx-auto mt-2 max-w-sm text-[12px] leading-relaxed text-content-faint">{t("guide.doneHint")}</p>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                  <Icon name={STEP[page].icon} size={15} />
                </span>
                <div className="min-w-0">
                  <h3 className="text-[14px] font-semibold text-content">{t(STEP[page].label)}</h3>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-content-faint">{t(STEP[page].hint, { name })}</p>
                </div>
              </div>
              {page === "profile" && <ProfileStep mate={mate} d={shownProfile} set={(k, v) => setProfile((x) => ({ ...(x ?? savedProfile), [k]: v }))} />}
              {page === "style" && <StyleStep mate={mate} prefs={prefs} d={shownStyle} set={(p) => setStyle((x) => ({ ...(x ?? savedStyle), ...p }))} />}
              {page === "avatar" && (
                <AvatarStep
                  mate={mate}
                  avatar={avatar}
                  onToggle={(e, on) =>
                    setToggles((x) => {
                      const was = emotionList(mate.avatar)?.find((y) => y.emotion === e)?.on;
                      const next = { ...x };
                      if (on === was) delete next[e];
                      else next[e] = on;
                      return next;
                    })
                  }
                />
              )}
              {page === "voice" && (
                <QuickVoice
                  mate={mate}
                  tts={shownTts}
                  set={(p) => setTts((x) => ({ ...(x ?? shownTts), ...p }))}
                  onEngine={(engine) => setTts((x) => withTtsEngine(x ?? shownTts, engine, mate.voice.tts, SPEED[engine]))}
                />
              )}
              {page === "device" && <DeviceStep mate={mate} d={shownDev} set={(p) => setDev((x) => ({ ...(x ?? shownDev), ...p }))} />}
            </>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border/70 px-5 py-3">
          {err && (
            <p className="w-full text-[12px] text-danger break-words" role="alert" data-testid="mate-guide-error">
              {err}
            </p>
          )}
          {!done && (
            <button type="button" className="btn-ghost !px-2.5 text-[12.5px] text-content-dim" onClick={() => go("later")} disabled={busy} data-testid="mate-guide-later">
              {t("guide.later")}
            </button>
          )}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {page !== "profile" && (
              <button type="button" className="btn-ghost !px-2.5" onClick={() => go("back")} disabled={busy} data-testid="mate-guide-back">
                <Icon name="chevron-left" size={14} /> {t("guide.back")}
              </button>
            )}
            {!done && (
              <button type="button" className="btn-ghost !px-2.5" onClick={skip} disabled={busy} data-testid="mate-guide-skip">
                {t("guide.skip")}
              </button>
            )}
            <button type="button" className="btn-primary" onClick={() => void next()} disabled={busy} data-testid="mate-guide-next">
              {busy && <Icon name="spinner" size={14} spin />}
              {done ? t("guide.finish") : pending ? t("guide.saveNext") : t("guide.next")}
              {!done && !busy && <Icon name="chevron" size={14} />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ProfileStep({ mate, d, set }: { mate: Mate; d: ProfileDraft; set: (k: keyof ProfileDraft, v: string) => void }) {
  const t = useT();
  return (
    <div className="space-y-3" data-testid="mate-guide-profile">
      <Field label={t("mateSettings.profName")}>
        <input className="field" value={d.name} onChange={(e) => set("name", e.target.value)} maxLength={80} placeholder={mate.name} data-testid="mate-guide-name" />
      </Field>
      <Field label={t("guide.intro")} hint={t("guide.introHint")}>
        <textarea className="field resize-y leading-relaxed" rows={3} value={d.description} onChange={(e) => set("description", e.target.value)} placeholder={t("mateSettings.profDescriptionPh")} data-testid="mate-guide-description" />
      </Field>
      <Field label={t("mateSettings.profPersonality")}>
        <textarea className="field resize-y leading-relaxed" rows={2} value={d.personality} onChange={(e) => set("personality", e.target.value)} placeholder={t("mateSettings.profPersonalityPh")} data-testid="mate-guide-personality" />
      </Field>
      <Field label={t("profile.mateBirthday")} hint={t("profile.mateBirthdayHint", { name: mate.name })} as="div">
        <BirthdayPicker value={d.birthday} onChange={(v) => set("birthday", v)} testId="mate-guide-birthday" />
      </Field>
    </div>
  );
}

function StyleStep({ mate, prefs, d, set }: { mate: Mate; prefs: MatePrefs; d: StyleDraft; set: (p: Partial<StyleDraft>) => void }) {
  const t = useT();
  const korean = (mate.persona.language || "ko").toLowerCase().startsWith("ko");
  const own = prefs.defaults.address ? fillAddress(prefs.defaults.address, prefs.user_name, t("mateSettings.styleNamePh")) : "";
  return (
    <div className="space-y-3" data-testid="mate-guide-style">
      <Field label={t("mateSettings.profCallsYou")} hint={own ? t("mateSettings.styleCallsYouHint", { value: own }) : t("mateSettings.styleCallsYouNone")}>
        <input className="field" value={d.address} onChange={(e) => set({ address: e.target.value })} maxLength={80} placeholder={own || t("mateSettings.profCallsYouPh")} data-testid="mate-guide-address" />
      </Field>
      <div className="flex flex-wrap gap-1.5">
        {addressChips(prefs.user_name, korean).map((c) => (
          <button
            key={c}
            type="button"
            className={`rounded-full border px-2.5 py-0.5 text-[12px] ${d.address === c ? "border-accent bg-accent-soft text-content" : "border-border text-content-dim hover:bg-surface-3"}`}
            onClick={() => set({ address: d.address === c ? "" : c })}
          >
            {c}
          </button>
        ))}
      </div>
      <p className="text-[11.5px] font-medium text-content-dim">{t("mateSettings.styleTone")}</p>
      {TONE.map((o) => (
        <Field key={o.key} label={t(o.label)} as="div">
          <Segmented<ToneLevel>
            value={d[o.key]}
            onChange={(v) => set({ [o.key]: v })}
            options={[
              { id: "low", label: t(o.low) },
              { id: "auto", label: t("mateSettings.styleAsWritten") },
              { id: "high", label: t(o.high) },
            ]}
            testId={`mate-guide-${o.key}`}
          />
        </Field>
      ))}
      <p className="text-[11px] text-content-faint">{t("mateSettings.styleToneHint")}</p>
    </div>
  );
}

function AvatarStep({ mate, avatar, onToggle }: { mate: Mate; avatar: Mate["avatar"]; onToggle: (emotion: string, on: boolean) => void }) {
  const t = useT();
  const list = emotionList(avatar, mate.avatar);
  if (avatar.kind === "none")
    return (
      <div className="space-y-3 rounded-xl border border-border bg-surface/50 p-4 text-[12.5px] text-content-dim" data-testid="mate-guide-avatar-none">
        <p>{t("guide.avatarNone", { name: mate.name })}</p>
        <button type="button" className="btn-soft" onClick={() => useStudio.getState().openAvatar(mate.id)}>
          <Icon name="sparkles" size={13} /> {t("avatar.createWithAiBtn")}
        </button>
      </div>
    );
  if (!list) {
    // (a Live2D model: which expression goes with a feeling is its own editor's — shown here, changed there)
    const map = avatar.kind === "live2d" ? avatar.live2d.emotions ?? {} : {};
    return (
      <div className="space-y-2" data-testid="mate-guide-avatar-live2d">
        <p className="text-[12px] text-content-faint">{t("guide.avatarLive2d")}</p>
        <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {GUIDE_EMOTIONS.map((e) => (
            <li key={e} className="flex items-center justify-between gap-2 rounded-lg border border-border/70 px-2.5 py-1.5 text-[12px]">
              <span className="truncate text-content">{emotionLabel(t, e)}</span>
              <span className="truncate text-[11px] text-content-faint">{map[e] !== undefined ? String(map[e]) : t("guide.avatarAuto")}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="mate-guide-avatar">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {list.map((x) => (
          <button
            key={x.emotion}
            type="button"
            role="switch"
            aria-checked={x.on}
            disabled={!x.can}
            onClick={() => onToggle(x.emotion, !x.on)}
            title={x.can ? undefined : t("guide.avatarNoFace")}
            className={`flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
              x.on ? "border-accent/50 bg-accent-soft" : "border-border text-content-faint hover:bg-surface-3/50"
            }`}
            data-testid={`mate-guide-emotion-${x.emotion}`}
          >
            <span className="grid h-9 w-8 shrink-0 place-items-center overflow-hidden rounded-md border border-border/70 bg-surface-3">
              {x.picture ? <img src={x.picture} alt="" className={`h-full w-full object-cover object-top ${x.on ? "" : "opacity-40 grayscale"}`} draggable={false} /> : <Icon name="sparkles" size={12} className="text-content-faint" />}
            </span>
            <span className={`min-w-0 flex-1 truncate text-[12.5px] ${x.on ? "text-content" : ""}`}>{emotionLabel(t, x.emotion)}</span>
            <Icon name={x.on ? "check" : "eye-off"} size={12} className={`shrink-0 ${x.on ? "text-accent" : ""}`} />
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-content-faint">{t("guide.avatarMore")}</p>
    </div>
  );
}

function DeviceStep({ mate, d, set }: { mate: Mate; d: DeviceDraft; set: (p: Partial<DeviceDraft>) => void }) {
  const t = useT();
  const share = canShareScreen();
  return (
    <div className="space-y-3" data-testid="mate-guide-device">
      <div className="rounded-xl border border-border bg-surface/50 p-3">
        <Toggle on={d.proactive} onChange={(v) => set({ proactive: v })} label={t("settings.speakFirstOn")} hint={t("screen.fixedReachOutHint")} testId="mate-guide-proactive" />
      </div>
      <VolumeField value={d.volume} engine={mate.voice.tts.engine} onChange={(v) => set({ volume: v })} />
      {share ? (
        <div className="space-y-3 rounded-xl border border-border bg-surface/50 p-3">
          <p className="text-[12px] leading-relaxed text-content-faint">{t("screen.deviceIntro")}</p>
          <Field label={t("screen.approval")} as="div">
            <Segmented
              value={d.approval}
              onChange={(v) => set({ approval: v })}
              options={[
                { id: "ask", label: t("screen.ask") },
                { id: "allow", label: t("screen.allow") },
              ]}
              testId="mate-guide-approval"
            />
          </Field>
          <Field label={t("screen.imageSize")} hint={t("guide.sizeHint")} as="div">
            <Segmented
              value={String(d.max_edge)}
              onChange={(v) => set({ max_edge: Number(v) })}
              options={SIZES.map((x) => ({ id: String(x), label: x ? `${x} px` : t("mateSettings.screenSizeFull") }))}
              testId="mate-guide-size"
            />
          </Field>
        </div>
      ) : (
        <p className="text-[12px] text-content-faint" data-testid="mate-guide-no-share">
          {t("guide.noScreenShare")}
        </p>
      )}
      <p className="text-[11px] text-content-faint">{t("screen.savedLocally")}</p>
    </div>
  );
}
