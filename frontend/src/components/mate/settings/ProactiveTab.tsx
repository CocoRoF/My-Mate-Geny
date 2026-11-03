import TriggerRulesEditor from "./TriggerRulesEditor";
import {useDevicePreferences,patchDevicePreferences} from "../../../stores/devicePreferences";
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
  const device=useDevicePreferences();
  const stored = mate.prefs?.proactive || {
    enabled: false,
    interval: 180,
    guidance: "",
  };
  const p={...stored,enabled:device.screen.proactive_enabled ?? stored.enabled,interval:device.screen.proactive_enabled === null ? stored.interval : device.screen.proactive_interval};
  const supported = !!mate.prefs?.proactive && "preset" in mate.prefs.proactive;
  const [defaults, setDefaults] = useState<GenyTriggerPreset | null>(null);
  const [guidance, setGuidance] = useState(p.guidance);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<{
    screen_active: boolean;
    last_status: string;
  } | null>(null);
  useEffect(() => setGuidance(p.guidance), [p.guidance]);
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
        <p className="text-xs text-content-faint">{t("screen.deviceProactiveHint")}</p>
        <Toggle
          on={p.enabled}
          disabled={!supported}
          onChange={(enabled) => void patchDevicePreferences({screen:{proactive_enabled:enabled}})}
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
            onChange={(e) => void patchDevicePreferences({screen:{proactive_interval:Number(e.target.value),proactive_enabled:p.enabled}})}
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
      {(p.preset || defaults) && (
        <Section title={t("screen.genyTiming")} hint={t("screen.genySaved")}>
          <TriggerRulesEditor key={mate.id} initial={(p.preset || defaults)!} language={language}
            onSave={async preset=>{
              const updated=await useMateStore.getState().patch(mate.id,{prefs:{proactive:{preset}}});
              return updated.prefs!.proactive!.preset!;
            }}/>
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
