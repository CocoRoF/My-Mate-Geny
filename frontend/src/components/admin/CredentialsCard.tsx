import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AUTH_CHANGED_EVENT, authStatus, changeCredentials, type AuthStatus } from "../../api/admin";
import Icon from "../ui/Icon";
import { absTime, relTime } from "./format";
import { tr, useT, type MsgKey } from "../../i18n";

/** Rough strength hint (the server only enforces the minimum length). */
function strength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (!pw) return { score: 0, label: "" };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 16 || (pw.length >= 12 && classes >= 3)) return { score: 3, label: tr("admin.strengthStrong") };
  if (pw.length >= 10 && classes >= 2) return { score: 2, label: tr("admin.strengthOk") };
  return { score: 1, label: tr("admin.strengthWeak") };
}

const BAR = ["bg-border", "bg-danger", "bg-warning", "bg-success"];

const SOURCE: Record<AuthStatus["source"], MsgKey> = {
  default: "admin.sourceDefault",
  env: "admin.sourceEnv",
  db: "admin.sourceDb",
};

export default function CredentialsCard() {
  const t = useT();
  const [st, setSt] = useState<AuthStatus | null>(null);
  const [current, setCurrent] = useState("");
  const [username, setUsername] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(
    () =>
      authStatus()
        .then((s) => {
          setSt(s);
          setUsername(s.username);
        })
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  if (!st) return null;
  const min = st.min_password_length;
  const s = strength(pw);
  const mismatch = confirm !== "" && pw !== confirm;
  const tooShort = pw !== "" && pw.length < min;
  const userChanged = username.trim() !== st.username;
  const needsPw = st.default_password; // the default can't be kept
  const canSubmit =
    !busy &&
    current !== "" &&
    username.trim() !== "" &&
    (pw !== "" || (userChanged && !needsPw)) &&
    !tooShort &&
    pw === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      const r = await changeCredentials({ current_password: current, username: username.trim(), new_password: pw });
      setSt(r);
      setUsername(r.username);
      setCurrent("");
      setPw("");
      setConfirm("");
      setDone(t("admin.credSaved"));
      window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
    } catch (err: any) {
      setError(err?.message || t("common.couldNotSave"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card p-4 space-y-3" autoComplete="on">
      <div className="flex flex-wrap items-start gap-3">
        <Icon name="key" size={18} className="mt-0.5 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-content">{t("admin.credTitle")}</div>
          <div className="text-[12px] text-content-dim">
            {t("admin.credUsername")} <span className="font-mono text-content">{st.username}</span> · {t("admin.credSource")}{" "}
            <span className={st.source === "default" ? "text-warning" : "text-content"}>{t(SOURCE[st.source])}</span>
            {st.updated_at && (
              <span title={absTime(st.updated_at)}> · {t("admin.credChanged", { when: relTime(st.updated_at) })}</span>
            )}
          </div>
        </div>
      </div>

      {st.default_password && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
          <span>{t.rich("admin.credDefaultWarn", { b: (s) => <b>{s}</b> })}</span>
        </div>
      )}
      {st.source === "env" && (
        <p className="text-[12px] text-content-faint">
          {t("admin.credEnvNote")}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[11.5px] text-content-dim">
          {t("admin.currentPassword")}
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="field mt-1"
            required
          />
        </label>
        <label className="block text-[11.5px] text-content-dim">
          {t("admin.credUsername")}
          <input
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="field mt-1 font-mono"
            maxLength={64}
            required
          />
        </label>
        <label className="block text-[11.5px] text-content-dim">
          {t("admin.newPassword")} {needsPw ? "" : <span className="text-content-faint">{t("admin.emptyKeep")}</span>}
          <input
            type="password"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className="field mt-1"
            minLength={min}
          />
        </label>
        <label className="block text-[11.5px] text-content-dim">
          {t("admin.confirmNewPassword")}
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={`field mt-1 ${mismatch ? "border-danger/60" : ""}`}
          />
        </label>
      </div>

      <div className="flex items-center gap-2 text-[11.5px]">
        <div className="flex w-28 gap-1">
          {[1, 2, 3].map((i) => (
            <span key={i} className={`h-1 flex-1 rounded-full ${s.score >= i ? BAR[s.score] : "bg-border"}`} />
          ))}
        </div>
        <span className="text-content-faint">
          {s.label && <b className="mr-1 text-content-dim">{s.label}.</b>}
          {t("admin.pwHint", { min })}
        </span>
      </div>
      {tooShort && <p className="text-[12px] text-danger">{t("admin.pwTooShort", { min })}</p>}
      {mismatch && <p className="text-[12px] text-danger">{t("admin.pwMismatch")}</p>}
      {error && <p className="text-[12px] text-danger">{error}</p>}
      {done && (
        <p className="flex items-center gap-1.5 text-[12px] text-success">
          <Icon name="check" size={13} /> {done}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={!canSubmit} className="btn-primary">
          {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="shield" size={14} />} {t("admin.updateCredentials")}
        </button>
        <span className="text-[12px] text-content-faint">
          {t("admin.credSignsOut")}
        </span>
      </div>
    </form>
  );
}
