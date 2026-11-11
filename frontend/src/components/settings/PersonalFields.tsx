/**
 * Two things every mate shares, set once (docs/settings.md): the name they know you by (Settings → 계정; a mate's
 * own way of calling you is in her 대화 방식) and the time zone their clock runs in (Settings → 언어).
 * Both are the mate settings' (`/api/mates/settings`).
 */
import { useEffect, useState, type FormEvent } from "react";
import { getVoiceSettings, putVoiceSettings } from "../../api/mates";
import { browserTimezone, useMateStore } from "../../stores/mateStore";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";

function useSetting(key: "user_name" | "timezone") {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"saving" | "saved" | { error: string } | null>(null);
  useEffect(() => {
    getVoiceSettings()
      .then((s) => {
        setSaved(s[key] ?? "");
        setDraft(s[key] ?? "");
      })
      .catch((e) => setState({ error: (e as Error).message }));
  }, [key]);
  const save = async (value: string) => {
    setState("saving");
    try {
      const s = await putVoiceSettings({ [key]: value.trim() });
      setSaved(s[key] ?? "");
      setDraft(s[key] ?? "");
      setState("saved");
      if (key === "user_name") void useMateStore.getState().load(); // (each mate's prefs carry it)
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };
  return { saved, draft, setDraft: (v: string) => (setDraft(v), setState(null)), state, save };
}

function Line({ state, ok }: { state: ReturnType<typeof useSetting>["state"]; ok: string }) {
  if (!state || state === "saving") return null;
  return state === "saved" ? (
    <p className="flex items-center gap-1.5 text-[12.5px] text-success" role="status">
      <Icon name="check" size={13} /> {ok}
    </p>
  ) : (
    <p className="text-[12.5px] text-danger" role="alert">
      {state.error}
    </p>
  );
}

/** the name every mate calls you by */
export function YourName() {
  const t = useT();
  const s = useSetting("user_name");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (s.saved !== null && s.draft.trim() !== s.saved) void s.save(s.draft);
  };
  return (
    <div className="space-y-2" data-testid="settings-your-name">
      <div>
        <h3 className="text-[13px] font-semibold text-content">{t("settings.yourName")}</h3>
        <p className="mt-0.5 text-[12px] text-content-faint">{t("settings.yourNameHint")}</p>
      </div>
      <form className="flex flex-wrap gap-2" onSubmit={submit}>
        <input
          className="field min-w-[10rem] flex-1"
          value={s.draft}
          maxLength={80}
          onChange={(e) => s.setDraft(e.target.value)}
          placeholder={t("settings.yourNamePh")}
          disabled={s.saved === null}
          aria-label={t("settings.yourName")}
          data-testid="settings-your-name-input"
        />
        <button className="btn-soft shrink-0" disabled={s.saved === null || s.draft.trim() === s.saved || s.state === "saving"} data-testid="settings-your-name-save">
          {s.state === "saving" && <Icon name="spinner" size={13} spin />} {t("common.save")}
        </button>
      </form>
      <Line state={s.state} ok={t("settings.yourNameSaved")} />
    </div>
  );
}

/** the mates' clock: the "Now" line, plan dates, relationship days */
export function TimeZone() {
  const t = useT();
  const s = useSetting("timezone");
  const here = browserTimezone();
  return (
    <div className="space-y-2" data-testid="mate-timezone">
      <div>
        <h3 className="text-[13px] font-semibold text-content">{t("mateSettings.defTimezone")}</h3>
        <p className="mt-0.5 text-[12px] text-content-faint">{t("mateSettings.defTimezoneHint")}</p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void s.save(s.draft);
        }}
      >
        <input className="field min-w-[12rem] flex-1" value={s.draft} onChange={(e) => s.setDraft(e.target.value)} placeholder={here || "Asia/Seoul"} disabled={s.saved === null} data-testid="mate-timezone-input" />
        <button className="btn-soft shrink-0" disabled={s.saved === null || s.draft.trim() === s.saved}>
          {t("common.save")}
        </button>
        {here && here !== s.saved && (
          <button type="button" className="btn-ghost shrink-0" onClick={() => void s.save(here)}>
            {t("mateSettings.defTimezoneUse", { tz: here })}
          </button>
        )}
      </form>
      <Line state={s.state} ok={t("mateSettings.defTimezoneSaved")} />
    </div>
  );
}
