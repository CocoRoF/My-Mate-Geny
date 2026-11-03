import { useState, useEffect } from "react";
import type { Mate } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import { useT } from "../../../i18n";
import { Section, Toggle, Field } from "./ui";
export default function ProactiveTab({ mate }: { mate: Mate }) {
  const t = useT();
  const supported = !!mate.prefs?.proactive;
  const p = mate.prefs?.proactive || {
    enabled: false,
    interval: 180,
    guidance: "",
  };
  const [guidance, setGuidance] = useState(p.guidance);
  const [error, setError] = useState("");
  useEffect(() => setGuidance(p.guidance), [p.guidance]);
  const patch = (v: Partial<typeof p>) =>
    useMateStore
      .getState()
      .patch(mate.id, { prefs: { proactive: v } })
      .then(
        () => setError(""),
        (e) => setError(String(e.message)),
      );
  return (
    <Section
      title={t("screen.proactiveTitle")}
      hint={t("screen.proactiveHint")}
      testId="mate-proactive"
    >
      <Toggle
        disabled={!supported}
        on={p.enabled}
        onChange={(enabled) => void patch({ enabled })}
        label={t("screen.proactiveEnabled")}
        testId="proactive-enabled"
      />
      {!supported && <p role="status" className="text-xs text-warning">{t("screen.proactiveUnavailable")}</p>}
      <p className="text-xs text-warning">{t("screen.proactiveCost")}</p>
      <Field label={t("screen.interval")}>
        <select
          disabled={!supported}
          value={p.interval}
          onChange={(e) => void patch({ interval: Number(e.target.value) })}
          className="field"
          data-testid="proactive-interval"
        >
          {[60, 180, 300, 600].map((n) => (
            <option key={n} value={n}>
              {t("screen.seconds", { count: n })}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label={t("screen.proactiveGuidance")}
        hint={t("screen.proactiveExamples")}
      >
        <textarea
          className="field min-h-24 w-full"
          disabled={!supported}
          maxLength={1000}
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          onBlur={() => {
            if (guidance !== p.guidance) void patch({ guidance });
          }}
          data-testid="proactive-guidance"
        />
      </Field>
      <p className="text-xs text-content-faint">
        {t("screen.proactiveSafety")}
      </p>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </Section>
  );
}
