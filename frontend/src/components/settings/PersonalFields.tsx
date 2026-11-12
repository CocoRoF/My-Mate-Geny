/**
 * What every mate shares, set once (docs/settings.md): the name they know you by (Settings → 계정; a mate's own way
 * of calling you is in her 대화 방식), the time zone their clock runs in and where you are — her weather, your public
 * holidays (Settings → 언어).
 * Both are the mate settings' (`/api/mates/settings`).
 */
import { useEffect, useState, type FormEvent } from "react";
import { getVoiceSettings, putVoiceSettings, type UserLocation } from "../../api/mates";
import { AUTH_CHANGED_EVENT } from "../../api/admin";
import { browserTimezone, locateByConnection, useMateStore } from "../../stores/mateStore";
import { useLang, useT } from "../../i18n";
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
      if (key === "user_name") {
        void useMateStore.getState().load(); // (each mate's prefs carry it)
        window.dispatchEvent(new Event(AUTH_CHANGED_EVENT)); // (Local execution: the sidebar shows it as the account)
      }
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

type Place = { lat: number; lon: number; city: string; country: string; label: string };

/** where the user is: her weather and their public holidays (life/world.py) — from this connection, or a city picked */
export function Location() {
  const t = useT();
  const lang = useLang();
  const [loc, setLoc] = useState<UserLocation | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState<"locate" | "search" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getVoiceSettings()
      .then((s) => setLoc(s.location ?? null))
      .catch((e) => setErr((e as Error).message));
  }, []);
  const save = async (next: Omit<UserLocation, "at">) => {
    setErr(null);
    try {
      const s = await putVoiceSettings({ location: next });
      setLoc(s.location ?? null);
      setFound(null);
      setQuery("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const locate = async () => {
    setBusy("locate");
    try {
      const here = await locateByConnection();
      if (here) await save(here);
      else setErr(t("settings.locationNotFound"));
    } finally {
      setBusy(null);
    }
  };
  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy("search");
    setErr(null);
    try {
      // (OpenStreetMap's open search, Nominatim: no key, cities only, names in the UI's language — "서울", "부산" find them)
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&featureType=settlement&accept-language=${lang}&q=${encodeURIComponent(query.trim())}`,
        { credentials: "omit" },
      );
      const d = await r.json();
      setFound(
        (Array.isArray(d) ? d : []).map((x: any) => ({
          lat: Number(x.lat),
          lon: Number(x.lon),
          city: x.name || x.display_name.split(",")[0],
          country: String(x.address?.country_code || "").toUpperCase(),
          label: x.display_name,
        })),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-2" data-testid="settings-location">
      <div>
        <h3 className="text-[13px] font-semibold text-content">{t("settings.location")}</h3>
        <p className="mt-0.5 text-[12px] text-content-faint">{t("settings.locationHint")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[13px] text-content" data-testid="settings-location-now">
          {loc === undefined ? "…" : loc ? `${loc.city || `${loc.lat}, ${loc.lon}`}${loc.country ? ` (${loc.country})` : ""} · ${t(loc.source === "manual" ? "settings.locationPicked" : "settings.locationFound")}` : t("settings.locationNone")}
        </span>
        <button type="button" className="btn-ghost border border-border shrink-0" onClick={() => void locate()} disabled={busy !== null} data-testid="settings-location-locate">
          {busy === "locate" ? <Icon name="spinner" size={13} spin /> : <Icon name="crosshair" size={13} />} {t("settings.locationLocate")}
        </button>
      </div>
      <form className="flex flex-wrap gap-2" onSubmit={search}>
        <input className="field min-w-[10rem] flex-1" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("settings.locationSearchPh")} data-testid="settings-location-search" />
        <button className="btn-soft shrink-0" disabled={busy !== null || !query.trim()}>
          {busy === "search" ? <Icon name="spinner" size={13} spin /> : <Icon name="search" size={13} />} {t("common.search")}
        </button>
      </form>
      {found && (
        <ul className="divide-y divide-border/60 rounded-lg border border-border text-[13px]" data-testid="settings-location-results">
          {found.length === 0 && <li className="px-3 py-2 text-content-faint">{t("settings.locationNoResults")}</li>}
          {found.map((p) => (
            <li key={`${p.lat},${p.lon}`}>
              <button type="button" className="w-full px-3 py-2 text-left hover:bg-surface-3" onClick={() => void save({ lat: p.lat, lon: p.lon, city: p.city, country: p.country, source: "manual" })}>
                {p.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {err && <p className="text-[12.5px] text-danger" role="alert">{err}</p>}
    </div>
  );
}
