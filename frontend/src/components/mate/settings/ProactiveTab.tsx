import { useEffect, useState, useSyncExternalStore } from "react";
import type { Mate, GenyTriggerPreset } from "../../../api/mates";
import { apiFetch } from "../../../api/client";
import { subscribeSharing, sharingSnapshot } from "../../../mate/localScreen";
import { deviceId } from "../../../mate/voiceOwner";
import { useMateStore } from "../../../stores/mateStore";
import { useT, type MsgKey } from "../../../i18n";
import { Section, Toggle, Field } from "./ui";
export default function ProactiveTab({ mate }: { mate: Mate }) {
  const t = useT();
  const localShare = useSyncExternalStore(subscribeSharing, sharingSnapshot);
  const p = mate.prefs?.proactive || {
    enabled: false,
    interval: 180,
    guidance: "",
  };
  const supported = !!mate.prefs?.proactive && "preset" in mate.prefs.proactive;
  const [defaults, setDefaults] = useState<GenyTriggerPreset | null>(null);
  const [draft, setDraft] = useState<GenyTriggerPreset | null>(
    p.preset || null,
  );
  const [guidance, setGuidance] = useState(p.guidance);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<{
    screen_active: boolean;
    last_status: string;
  } | null>(null);
  useEffect(() => setGuidance(p.guidance), [p.guidance]);
  useEffect(() => {
    if (p.preset) setDraft(p.preset);
    else if (defaults) setDraft(defaults);
  }, [p.preset, defaults]);
  useEffect(() => {
    let alive = true;
    void apiFetch<GenyTriggerPreset>("/api/sessions/screen/geny-preset").then(
      (v) => {
        if (alive) setDefaults(v);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!mate.session_id || !supported) return;
    let alive = true;
    const load = () =>
      void apiFetch<{ screen_active: boolean; last_status: string }>(
        `/api/sessions/${mate.session_id}/screen/status`,
      ).then(
        (v) => {
          if (alive) setStatus(v);
        },
        () => {},
      );
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [mate.session_id, supported]);
  const patch = (v: Partial<NonNullable<Mate["prefs"]>["proactive"]>) =>
    useMateStore
      .getState()
      .patch(mate.id, { prefs: { proactive: v } })
      .then(
        () => setError(""),
        (e) => setError(String(e.message)),
      );
  const savePreset = (v: GenyTriggerPreset) => {
    setDraft(v);
    void patch({ preset: v });
  };
  const category = (id: string, v: Record<string, unknown>) => {
    if (draft)
      savePreset({
        ...draft,
        categories: draft.categories.map((c) =>
          c.id === id ? { ...c, ...v } : c,
        ),
      });
  };
  const timing = (key: keyof GenyTriggerPreset["timing"], value: number) => {
    if (draft)
      savePreset({ ...draft, timing: { ...draft.timing, [key]: value } });
  };
  const language = mate.persona.language || "en";
  const statusKeys: Record<string, MsgKey> = {
    waiting: "screen.proactiveStatus_waiting",
    idle_wait: "screen.proactiveStatus_idle_wait",
    unchanged: "screen.proactiveStatus_unchanged",
    sent: "screen.proactiveStatus_sent",
    busy: "screen.proactiveStatus_busy",
    cached: "screen.proactiveStatus_cached",
    disabled: "screen.proactiveStatus_disabled",
    offline: "screen.proactiveStatus_offline",
    no_category: "screen.proactiveStatus_no_category",
    not_shared: "screen.proactiveStatus_not_shared",
    error: "screen.proactiveStatus_error",
    silent: "screen.proactiveStatus_silent",
  };
  return (
    <>
      <Section
        title={t("screen.genyTitle")}
        hint={t("screen.genyHint")}
        testId="mate-proactive"
      >
        <Toggle
          on={p.enabled}
          disabled={!supported}
          onChange={(enabled) => void patch({ enabled })}
          label={t("screen.proactiveTitle")}
          testId="proactive-enabled"
        />
        {!supported && (
          <p role="status" className="text-xs text-warning">
            {t("screen.proactiveUnavailable")}
          </p>
        )}
        <Field label={t("screen.scope")}>
          <select
            className="field"
            value={p.scope || "all"}
            disabled={!supported}
            onChange={(e) =>
              void patch({ scope: e.target.value as "all" | "screen" })
            }
            data-testid="proactive-scope"
          >
            <option value="all">{t("screen.scopeAll")}</option>
            <option value="screen">{t("screen.scopeScreen")}</option>
          </select>
        </Field>
        <Field label={t("screen.captureInterval")}>
          <select
            className="field"
            value={p.interval}
            disabled={!supported}
            onChange={(e) => void patch({ interval: Number(e.target.value) })}
            data-testid="proactive-interval"
          >
            {[60, 180, 300, 600].map((n) => (
              <option key={n} value={n}>
                {t("screen.seconds", { count: n })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("screen.proactiveGuidance")}>
          <textarea
            className="field min-h-24 w-full"
            value={guidance}
            maxLength={1000}
            disabled={!supported}
            onChange={(e) => setGuidance(e.target.value)}
            onBlur={() => {
              if (guidance !== p.guidance) void patch({ guidance });
            }}
            data-testid="proactive-guidance"
          />
        </Field>
        <p className="text-xs text-warning">{t("screen.proactiveCost")}</p>
        <p className="text-xs text-content-faint">
          {t("screen.genySilentHint")}
        </p>
        {status && (
          <p className="text-xs" data-testid="proactive-status">
            {t("screen.genyStatus")}:{" "}
            {t(
              statusKeys[status.last_status] ||
                "screen.proactiveStatus_waiting",
            )}
          </p>
        )}
        <button
          className="btn-ghost"
          disabled={
            !supported ||
            !p.enabled ||
            !status?.screen_active ||
            localShare?.sid !== mate.session_id
          }
          onClick={() => {
            void apiFetch(`/api/sessions/${mate.session_id}/screen/observe`, {
              method: "POST",
              body: JSON.stringify({ device: deviceId, force: true }),
            }).catch((e) => setError(String(e.message)));
          }}
          data-testid="proactive-now"
        >
          {t("screen.showNow")}
        </button>
        <p className="text-xs text-content-faint">
          {t("screen.genyStatusHint")}
        </p>
      </Section>
      {draft && (
        <Section title={t("screen.genyTiming")} hint={t("screen.genySaved")}>
          <Field label={t("screen.baseIdle")}>
            <input
              className="field"
              type="number"
              min={5}
              defaultValue={draft.timing.base_idle_seconds}
              key={"base" + draft.timing.base_idle_seconds}
              onBlur={(e) =>
                timing("base_idle_seconds", Number(e.target.value))
              }
            />
          </Field>
          <Field label={t("screen.maxIdle")}>
            <input
              className="field"
              type="number"
              min={5}
              defaultValue={draft.timing.max_idle_seconds}
              key={"max" + draft.timing.max_idle_seconds}
              onBlur={(e) => timing("max_idle_seconds", Number(e.target.value))}
            />
          </Field>
          <Field label={t("screen.adaptiveScale")}>
            <input
              className="field"
              type="number"
              min={1}
              defaultValue={draft.timing.adaptive_scale_triggers}
              key={"scale" + draft.timing.adaptive_scale_triggers}
              onBlur={(e) =>
                timing("adaptive_scale_triggers", Number(e.target.value))
              }
            />
          </Field>
          {draft.categories.map((c) => (
            <details
              className="rounded-xl border border-border p-3 text-xs"
              key={c.id}
            >
              <summary className="cursor-pointer font-medium">
                {c.label}
              </summary>
              <div className="mt-3 space-y-3">
                <Field label={t("screen.weight")}>
                  <input
                    type="number"
                    min={0}
                    className="field"
                    defaultValue={c.weight}
                    key={c.weight}
                    onBlur={(e) =>
                      category(c.id, { weight: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field label={t("screen.cooldown")}>
                  <input
                    type="number"
                    min={0}
                    className="field"
                    defaultValue={c.cooldown_seconds}
                    key={c.cooldown_seconds}
                    onBlur={(e) =>
                      category(c.id, {
                        cooldown_seconds: Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <p>{t("screen.genyPrompts")}</p>
                {c.prompt_refs.map((ref) => {
                  const prompt = draft.prompts.find(
                    (x) => x.id === ref.prompt_id,
                  );
                  return prompt ? (
                    <textarea
                      key={prompt.id}
                      className="field min-h-28 w-full"
                      defaultValue={
                        prompt.content[language] || prompt.content.en || ""
                      }
                      onBlur={(e) =>
                        savePreset({
                          ...draft,
                          prompts: draft.prompts.map((x) =>
                            x.id === prompt.id
                              ? {
                                  ...x,
                                  content: {
                                    ...x.content,
                                    [language]: e.target.value,
                                  },
                                }
                              : x,
                          ),
                        })
                      }
                    />
                  ) : null;
                })}
              </div>
            </details>
          ))}
          <button
            className="btn-ghost"
            onClick={() => {
              if (defaults) setDraft(defaults);
              void patch({ preset: null });
            }}
          >
            {t("screen.resetGeny")}
          </button>
        </Section>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </>
  );
}
