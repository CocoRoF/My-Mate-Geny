import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AUTH_CHANGED_EVENT, authStatus, changeCredentials, type AuthStatus } from "../../api/admin";
import Icon from "../ui/Icon";
import { absTime, relTime } from "./format";

/** Rough strength hint (the server only enforces the minimum length). */
function strength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (!pw) return { score: 0, label: "" };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 16 || (pw.length >= 12 && classes >= 3)) return { score: 3, label: "Strong" };
  if (pw.length >= 10 && classes >= 2) return { score: 2, label: "OK" };
  return { score: 1, label: "Weak" };
}

const BAR = ["bg-border", "bg-danger", "bg-warning", "bg-success"];

const SOURCE: Record<AuthStatus["source"], string> = {
  default: "Built-in default (admin / geny-admin)",
  env: "Server environment (AUTH_USERNAME / AUTH_PASSWORD)",
  db: "Set here",
};

export default function CredentialsCard() {
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
      setDone("Saved. Every other browser, desktop and mobile app was signed out — sign in there with the new credentials.");
      window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
    } catch (err: any) {
      setError(err?.message || "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card p-4 space-y-3" autoComplete="on">
      <div className="flex flex-wrap items-start gap-3">
        <Icon name="key" size={18} className="mt-0.5 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-content">Sign-in credentials</div>
          <div className="text-[12px] text-content-dim">
            Username <span className="font-mono text-content">{st.username}</span> · source:{" "}
            <span className={st.source === "default" ? "text-warning" : "text-content"}>{SOURCE[st.source]}</span>
            {st.updated_at && (
              <span title={absTime(st.updated_at)}> · changed {relTime(st.updated_at)}</span>
            )}
          </div>
        </div>
      </div>

      {st.default_password && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
          <span>
            <b>Default password in use.</b> It is public — anyone who can reach this server can sign in. Choose your own
            password below.
          </span>
        </div>
      )}
      {st.source === "env" && (
        <p className="text-[12px] text-content-faint">
          Saving here overrides the server's AUTH_PASSWORD (stored as a salted scrypt hash in the database).
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[11.5px] text-content-dim">
          Current password
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
          Username
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
          New password {needsPw ? "" : <span className="text-content-faint">(empty = keep)</span>}
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
          Confirm new password
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
          At least {min} characters; a passphrase of 3–4 random words (12+ characters) is best.
        </span>
      </div>
      {tooShort && <p className="text-[12px] text-danger">Too short — at least {min} characters.</p>}
      {mismatch && <p className="text-[12px] text-danger">The new passwords don't match.</p>}
      {error && <p className="text-[12px] text-danger">{error}</p>}
      {done && (
        <p className="flex items-center gap-1.5 text-[12px] text-success">
          <Icon name="check" size={13} /> {done}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={!canSubmit} className="btn-primary">
          {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="shield" size={14} />} Update credentials
        </button>
        <span className="text-[12px] text-content-faint">
          Signs out every other device and app; this browser stays signed in.
        </span>
      </div>
    </form>
  );
}
