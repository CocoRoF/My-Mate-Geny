/**
 * Settings (sidebar → Settings, `/?view=settings`): what used to be scattered, in one place —
 *   Updates        this web console's build (+ a check for a newer one on the server), the desktop app's in-app
 *                  updater (downloads/UpdateCard.tsx ↔ desktop/src/updater.js), the Android app's version → Download
 *   Account        the single admin account: username, password, sign out other devices (/api/auth/*)
 *   Language       English / 한국어, applied at once and saved for every device (i18n/, /api/preferences)
 *   Notifications  this browser's permission (the apps notify natively)
 *   Mate & voice   the default mate and reading aloud on this device (Mate's Global settings → Defaults)
 *   Desktop app    the mate on the desktop, quick-chat shortcut, start at login (Global settings → Desktop app)
 * Each section embeds the existing component where there is one, so the logic lives once.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AUTH_CHANGED_EVENT,
  authStatus,
  changeCredentials,
  revokeAllSessions,
  type AuthStatus,
} from "../../api/admin";
import { apiFetch } from "../../api/client";
import { compareVersions, getDownloads, type AppRelease } from "../../api/downloads";
import { LANGS, useLang, useT, type Lang, type MsgKey, type TFunction, type Vars } from "../../i18n";
import { relTime } from "../../i18n/format";
import { chooseLanguage } from "../../i18n/sync";
import { useConfigStore } from "../../stores/configStore";
import { useMateStore } from "../../stores/mateStore";
import { useUIStore } from "../../stores/uiStore";
import { APP_VERSION, BUILD_COMMIT, BUILD_TIME } from "../../version";
import { requestAdminTab } from "../admin/adminTab";
import UpdateCard, { useUpdateState } from "../downloads/UpdateCard";
import DefaultsPanel from "../mate/settings/global/DefaultsPanel";
import DesktopPanel from "../mate/settings/global/DesktopPanel";
import Icon, { type IconName } from "../ui/Icon";
import { checkConsoleUpdate, type ConsoleUpdate } from "./consoleUpdate";
import { useNativeVersion } from "../../lib/nativeVersion";
import { onSettingsSection, takeSettingsSection, type SettingsSection } from "./section";

const platform = () => window.hrhNative?.platform ?? "";
const isDesktopApp = () => /^desktop-/.test(platform());
const isAndroidApp = () => platform() === "android";

function Card({ id, icon, title, hint, children }: { id: SettingsSection; icon: IconName; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} data-testid={`settings-${id}`} className="card scroll-mt-4 p-4 sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Icon name={icon} size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-content">{title}</h2>
          {hint && <p className="mt-0.5 text-[12.5px] leading-relaxed text-content-dim">{hint}</p>}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Row({ label, children, right }: { label: ReactNode; children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface-2/50 px-3.5 py-3">
      <div className="min-w-0 flex-1 basis-[15rem]">
        <div className="text-[13px] font-medium text-content">{label}</div>
        {children && <div className="mt-0.5 text-[12px] text-content-faint">{children}</div>}
      </div>
      {right}
    </div>
  );
}

function Status({ tone, children, testId }: { tone: "ok" | "warn" | "error" | "info"; children: ReactNode; testId?: string }) {
  const cls = { ok: "text-success", warn: "text-warning", error: "text-danger", info: "text-content-dim" }[tone];
  const icon: IconName = { ok: "check", warn: "sparkles", error: "warning", info: "info" }[tone] as IconName;
  return (
    <p className={`flex items-start gap-1.5 text-[12.5px] ${cls}`} role={tone === "error" ? "alert" : "status"} data-testid={testId}>
      <Icon name={icon} size={13} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

// ---- Updates ---------------------------------------------------------------------------------------------------

function UpdatesSection() {
  const t = useT();
  const serverVersion = useConfigStore((s) => s.version);
  const [web, setWeb] = useState<ConsoleUpdate | "checking" | "error" | null>(null);
  const native = window.hrhNative;

  const check = async () => {
    setWeb("checking");
    try {
      setWeb(await checkConsoleUpdate());
    } catch {
      setWeb("error");
    }
  };

  const meta = [
    t("settings.webBuild", { version: APP_VERSION }),
    BUILD_COMMIT && t("settings.webCommit", { commit: BUILD_COMMIT }),
    BUILD_TIME && t("settings.webBuilt", { when: relTime(BUILD_TIME) }),
    serverVersion && t("settings.serverVersion", { version: serverVersion }),
  ].filter(Boolean);

  return (
    <Card id="updates" icon="download" title={t("settings.secUpdates")} hint={t("settings.updatesHint")}>
      <div className="space-y-2">
        <Row
          label={t("settings.webConsole")}
          right={
            <button className="btn-ghost border border-border !py-1.5 text-[12.5px]" onClick={check} disabled={web === "checking"} data-testid="settings-check-web">
              <Icon name="refresh" size={13} spin={web === "checking"} /> {web === "checking" ? t("settings.checking") : t("settings.checkUpdates")}
            </button>
          }
        >
          <span className="font-mono" data-testid="settings-web-version">{meta.join(" · ")}</span>
        </Row>
        {web === "latest" && <Status tone="ok" testId="settings-web-status">{t("settings.webLatest")}</Status>}
        {web === "unknown" && <Status tone="info" testId="settings-web-status">{t("settings.webUnknown")}</Status>}
        {web === "error" && <Status tone="error" testId="settings-web-status">{t("settings.webError")}</Status>}
        {web === "available" && (
          <div className="flex flex-wrap items-center gap-2" data-testid="settings-web-status">
            <Status tone="warn">{t("settings.webAvailable")}</Status>
            <button className="btn-primary !py-1.5 text-[12.5px]" onClick={() => window.location.reload()}>
              <Icon name="refresh" size={13} /> {t("settings.reloadToUpdate")}
            </button>
          </div>
        )}
      </div>
      {isDesktopApp() && <DesktopAppUpdates />}
      {isAndroidApp() && <AndroidAppUpdates />}
      {!native && (
        <Row
          label={t("settings.getApps")}
          right={
            <button className="btn-ghost border border-border !py-1.5 text-[12.5px]" onClick={() => useUIStore.getState().setView("downloads")}>
              <Icon name="download" size={13} /> {t("settings.openDownloads")}
            </button>
          }
        >
          {t("settings.getAppsHint")}
        </Row>
      )}
    </Card>
  );
}

/** the latest published app build (for the apps that can't update themselves here) */
function useRelease(): [AppRelease | null, boolean, () => void] {
  const [rel, setRel] = useState<AppRelease | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh = false) => {
    setBusy(true);
    getDownloads(refresh)
      .then(setRel)
      .catch(() => setRel({ available: false, reason: "error" }))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(), []);
  return [rel, busy, () => load(true)];
}

function AppRow({ label, version, rel, busy, onCheck }: { label: string; version: string; rel: AppRelease | null; busy: boolean; onCheck: () => void }) {
  const t = useT();
  // (version "" while the app has not said it yet: nothing to compare)
  const newer = !!version && !!rel?.version && compareVersions(rel.version, version) > 0;
  const open = () => useUIStore.getState().setView("downloads");
  return (
    <div className="space-y-2" data-testid="settings-app-update">
      <Row
        label={label}
        right={
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost border border-border !py-1.5 text-[12.5px]" onClick={onCheck} disabled={busy}>
              <Icon name="refresh" size={13} spin={busy} /> {busy ? t("settings.checking") : t("settings.checkUpdates")}
            </button>
            <button className={`${newer ? "btn-primary" : "btn-ghost border border-border"} !py-1.5 text-[12.5px]`} onClick={open} data-testid="settings-open-downloads">
              <Icon name="download" size={13} /> {newer ? t("settings.updateOnDownload") : t("settings.openDownloads")}
            </button>
          </div>
        }
      >
        <span className="font-mono" data-testid="settings-app-version">{t("settings.appVersion", { version: version || "…" })}</span>
      </Row>
      {rel && !busy && version && (newer ? <Status tone="warn">{t("settings.appAvailable", { version: rel.version! })}</Status> : rel.version ? <Status tone="ok">{t("settings.appLatest")}</Status> : <Status tone="info">{t("settings.appNoRelease")}</Status>)}
    </div>
  );
}

function DesktopAppUpdates() {
  const t = useT();
  const upd = useUpdateState(); // the app's own updater: check, download with progress, restart & install
  const [rel, busy, recheck] = useRelease();
  const version = useNativeVersion();
  if (upd) {
    return (
      <div data-testid="settings-desktop-update">
        <div className="text-[13px] font-medium text-content">{t("settings.desktopApp")}</div>
        <UpdateCard s={upd} />
      </div>
    );
  }
  // an app without the in-app updater (older builds): its version and the Download page
  return <AppRow label={t("settings.desktopApp")} version={version} rel={rel} busy={busy} onCheck={recheck} />;
}

function AndroidAppUpdates() {
  const t = useT();
  const [rel, busy, recheck] = useRelease();
  const version = useNativeVersion(); // (the bridge may learn it after the first render)
  // (the APK download with progress and the installer live on the Download page)
  return <AppRow label={t("settings.androidApp")} version={version} rel={rel} busy={busy} onCheck={recheck} />;
}

// ---- Account ---------------------------------------------------------------------------------------------------

/** a result line; a message by key re-renders in the language of the moment (raw: the server's own words) */
type Msg = { ok: boolean; key?: MsgKey; vars?: Vars; raw?: string } | null;

/** the server's validation messages (app/auth.py, routers/auth.py) in the UI's language; anything else as sent */
function serverError(msg: string, min: number): Msg {
  const known: [RegExp, MsgKey][] = [
    [/current password is incorrect/i, "settings.errWrongCurrent"],
    [/too many wrong passwords/i, "settings.errTooMany"],
    [/at least \d+ characters/i, "settings.errPwShort"],
    [/password is too long/i, "settings.errPwLong"],
    [/public default password/i, "settings.errPwDefault"],
    [/differ from the username/i, "settings.errPwSameAsUser"],
    [/username must be 1-64/i, "settings.errUserLength"],
    [/spaces or control characters/i, "settings.errUserChars"],
    [/set a new password/i, "settings.errNeedNewPw"],
  ];
  const hit = known.find(([re]) => re.test(msg));
  return hit ? { ok: false, key: hit[1], vars: { min } } : msg ? { ok: false, raw: msg } : { ok: false, key: "common.couldNotSave" };
}

function strength(t: TFunction, pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (!pw) return { score: 0, label: "" };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 16 || (pw.length >= 12 && classes >= 3)) return { score: 3, label: t("settings.pwStrong") };
  if (pw.length >= 10 && classes >= 2) return { score: 2, label: t("settings.pwOk") };
  return { score: 1, label: t("settings.pwWeak") };
}
const BAR = ["bg-border", "bg-danger", "bg-warning", "bg-success"];

function PasswordInput({ label, value, onChange, autoComplete, invalid, testId }: { label: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean; testId?: string }) {
  return (
    <label className="block text-[12px] text-content-dim">
      {label}
      <input
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`field mt-1 ${invalid ? "border-danger/60" : ""}`}
        data-testid={testId}
      />
    </label>
  );
}

function AccountSection() {
  const t = useT();
  const [st, setSt] = useState<AuthStatus | null>(null);
  const load = () =>
    authStatus()
      .then(setSt)
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  // username
  const [name, setName] = useState("");
  const [namePw, setNamePw] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMsg, setNameMsg] = useState<Msg>(null);
  useEffect(() => {
    if (st) setName(st.username);
  }, [st?.username]); // eslint-disable-line react-hooks/exhaustive-deps

  // password
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<Msg>(null);

  // devices
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeMsg, setRevokeMsg] = useState<Msg>(null);

  if (!st) return <Card id="account" icon="user" title={t("settings.secAccount")}><Icon name="spinner" size={16} spin className="text-content-faint" /></Card>;

  const min = st.min_password_length;
  const source = { default: t("settings.sourceDefault"), env: t("settings.sourceEnv"), db: t("settings.sourceDb") }[st.source];
  const s = strength(t, pw);
  const mismatch = pw2 !== "" && pw !== pw2;
  const tooShort = pw !== "" && pw.length < min;
  const nameChanged = name.trim() !== "" && name.trim() !== st.username;

  const saved = (r: AuthStatus) => {
    setSt(r);
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT)); // the sidebar's name, the default-password banner
  };

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (!nameChanged || !namePw || nameBusy) return;
    setNameBusy(true);
    setNameMsg(null);
    try {
      saved(await changeCredentials({ current_password: namePw, username: name.trim(), new_password: "" }));
      setNamePw("");
      setNameMsg({ ok: true, key: "settings.usernameSaved" });
    } catch (err) {
      setNameMsg(serverError((err as Error).message, min));
    } finally {
      setNameBusy(false);
    }
  };

  const savePw = async (e: FormEvent) => {
    e.preventDefault();
    if (!cur || !pw || tooShort || pw !== pw2 || pwBusy) return;
    setPwBusy(true);
    setPwMsg(null);
    try {
      saved(await changeCredentials({ current_password: cur, username: st.username, new_password: pw }));
      setCur("");
      setPw("");
      setPw2("");
      setPwMsg({ ok: true, key: "settings.passwordSaved" });
    } catch (err) {
      setPwMsg(serverError((err as Error).message, min));
    } finally {
      setPwBusy(false);
    }
  };

  const revokeOthers = async () => {
    if (!window.confirm(t("settings.signOutOthersConfirm"))) return;
    setRevokeBusy(true);
    setRevokeMsg(null);
    try {
      await revokeAllSessions();
      setRevokeMsg({ ok: true, key: "settings.signedOutOthers" });
    } catch (err) {
      setRevokeMsg((err as Error).message ? { ok: false, raw: (err as Error).message } : { ok: false, key: "common.somethingWrong" });
    } finally {
      setRevokeBusy(false);
    }
  };

  const signOutHere = async () => {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  };

  const msg = (m: Msg, testId: string) =>
    m && <Status tone={m.ok ? "ok" : "error"} testId={testId}>{m.key ? t(m.key, m.vars) : m.raw}</Status>;

  return (
    <Card id="account" icon="user" title={t("settings.secAccount")} hint={t("settings.accountHint")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border bg-surface-2/50 px-3.5 py-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-3 text-[14px] font-semibold text-content-dim">
          {(st.username || "?").slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-[8rem] flex-1">
          <div className="text-[11.5px] text-content-faint">{t("settings.signedInAs")}</div>
          <div className="truncate font-mono text-[14px] text-content" data-testid="settings-username">{st.username}</div>
        </div>
        <div className="w-full pl-12 text-[11.5px] text-content-faint sm:w-auto sm:pl-0 sm:text-right">
          <div className={st.source === "default" ? "text-warning" : ""}>{source}</div>
          {st.updated_at && <div>{t("settings.changedAgo", { when: relTime(st.updated_at) })}</div>}
        </div>
      </div>

      {st.default_password && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning" role="alert">
          <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
          <span>{t.rich("settings.defaultPwWarn", { b: (x) => <b>{x}</b> })}</span>
        </div>
      )}
      {st.source === "env" && <p className="text-[12px] text-content-faint">{t("settings.envOverride")}</p>}

      <form onSubmit={saveName} className="space-y-3" data-testid="settings-username-form">
        <h3 className="text-[13px] font-semibold text-content">{t("settings.changeUsername")}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[12px] text-content-dim">
            {t("settings.newUsername")}
            <input
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              className="field mt-1 font-mono"
              disabled={st.default_password}
              data-testid="settings-new-username"
            />
          </label>
          <PasswordInput label={t("settings.currentPassword")} value={namePw} onChange={setNamePw} autoComplete="current-password" testId="settings-username-current" />
        </div>
        {st.default_password && <p className="text-[12px] text-content-faint">{t("settings.usernameNeedsPw")}</p>}
        {msg(nameMsg, "settings-username-msg")}
        <button type="submit" className="btn-soft" disabled={!nameChanged || !namePw || nameBusy || st.default_password} data-testid="settings-username-save">
          {nameBusy ? <Icon name="spinner" size={14} spin /> : <Icon name="pencil" size={14} />} {t("settings.changeUsername")}
        </button>
      </form>

      <div className="border-t border-border/60" />

      <form onSubmit={savePw} className="space-y-3" data-testid="settings-password-form">
        <h3 className="text-[13px] font-semibold text-content">{t("settings.changePassword")}</h3>
        {/* (for the browser's password manager: which account this is) */}
        <input type="text" autoComplete="username" value={st.username} readOnly hidden />
        <div className="grid gap-3 sm:grid-cols-3">
          <PasswordInput label={t("settings.currentPassword")} value={cur} onChange={setCur} autoComplete="current-password" testId="settings-pw-current" />
          <PasswordInput label={t("settings.newPassword")} value={pw} onChange={setPw} autoComplete="new-password" invalid={tooShort} testId="settings-pw-new" />
          <PasswordInput label={t("settings.confirmPassword")} value={pw2} onChange={setPw2} autoComplete="new-password" invalid={mismatch} testId="settings-pw-confirm" />
        </div>
        <div className="flex items-center gap-2 text-[11.5px]">
          <div className="flex w-24 shrink-0 gap-1">
            {[1, 2, 3].map((i) => (
              <span key={i} className={`h-1 flex-1 rounded-full ${s.score >= i ? BAR[s.score] : "bg-border"}`} />
            ))}
          </div>
          <span className="text-content-faint">
            {s.label && <b className="mr-1 text-content-dim">{s.label}.</b>}
            {t("settings.pwRule", { min })}
          </span>
        </div>
        {tooShort && <p className="text-[12px] text-danger">{t("settings.pwTooShort", { min })}</p>}
        {mismatch && <p className="text-[12px] text-danger">{t("settings.pwMismatch")}</p>}
        {msg(pwMsg, "settings-password-msg")}
        <button type="submit" className="btn-primary" disabled={!cur || !pw || tooShort || pw !== pw2 || pwBusy} data-testid="settings-password-save">
          {pwBusy ? <Icon name="spinner" size={14} spin /> : <Icon name="key" size={14} />} {t("settings.changePassword")}
        </button>
      </form>

      <div className="border-t border-border/60" />

      <div className="space-y-3">
        <div>
          <h3 className="text-[13px] font-semibold text-content">{t("settings.sessions")}</h3>
          <p className="mt-0.5 text-[12px] text-content-faint">{t("settings.sessionsHint")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost border border-border text-danger hover:text-danger" onClick={revokeOthers} disabled={revokeBusy} data-testid="settings-revoke">
            {revokeBusy ? <Icon name="spinner" size={14} spin /> : <Icon name="shield" size={14} />} {t("settings.signOutOthers")}
          </button>
          <button className="btn-ghost border border-border" onClick={signOutHere} data-testid="settings-signout">
            <Icon name="logout" size={14} /> {t("settings.signOutHere")}
          </button>
          <button
            className="btn-ghost text-content-faint"
            onClick={() => {
              requestAdminTab("security");
              useUIStore.getState().setView("admin");
            }}
          >
            <Icon name="external" size={13} /> {t("settings.moreSecurity")}
          </button>
        </div>
        {msg(revokeMsg, "settings-revoke-msg")}
      </div>
    </Card>
  );
}

// ---- Language --------------------------------------------------------------------------------------------------

function LanguageSection() {
  const t = useT();
  const lang = useLang();
  const [state, setState] = useState<"saving" | "saved" | "local" | null>(null);
  const pick = async (l: Lang) => {
    setState("saving");
    setState((await chooseLanguage(l)) ? "saved" : "local");
  };
  return (
    <Card id="language" icon="languages" title={t("settings.secLanguage")} hint={t("settings.languageHint")}>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("settings.secLanguage")}>
        {LANGS.map((l) => (
          <button
            key={l.id}
            role="radio"
            aria-checked={lang === l.id}
            data-active={lang === l.id}
            onClick={() => lang !== l.id && pick(l.id)}
            data-testid={`settings-lang-${l.id}`}
            lang={l.id}
            className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/50 px-4 py-3 text-left transition hover:border-border-strong data-[active=true]:border-accent/60 data-[active=true]:bg-accent-soft"
          >
            <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${lang === l.id ? "border-accent" : "border-border-strong"}`}>
              {lang === l.id && <span className="h-2 w-2 rounded-full bg-accent" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-content">{l.label}</span>
              {l.label !== l.english && <span className="block text-[11.5px] text-content-faint">{l.english}</span>}
            </span>
          </button>
        ))}
      </div>
      {state === "saving" && <Status tone="info">{t("settings.langSaving")}</Status>}
      {state === "saved" && <Status tone="ok" testId="settings-lang-msg">{t("settings.langSaved")}</Status>}
      {state === "local" && <Status tone="error" testId="settings-lang-msg">{t("settings.langLocal")}</Status>}
      <p className="text-[12px] text-content-faint">{t("settings.mateLangNote")}</p>
    </Card>
  );
}

// ---- Notifications ---------------------------------------------------------------------------------------------

function NotificationsSection() {
  const t = useT();
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(supported ? Notification.permission : "unsupported");
  const app = !!window.hrhNative?.notify;

  const ask = async () => {
    try {
      setPerm(await Notification.requestPermission());
    } catch {
      setPerm(Notification.permission);
    }
  };
  const test = () => {
    if (app) return window.hrhNative!.notify!(t("settings.testTitle"), t("settings.testBody"));
    try {
      new Notification(t("settings.testTitle"), { body: t("settings.testBody"), icon: "/favicon.svg", tag: "hrh-test" });
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  };

  let body: ReactNode;
  if (app) body = <Status tone="ok">{t("settings.notifApp")}</Status>;
  else if (perm === "granted") body = <Status tone="ok">{t("settings.notifOn")}</Status>;
  else if (perm === "denied") body = <Status tone="error">{t("settings.notifDenied")}</Status>;
  else if (perm === "unsupported") body = <Status tone="info">{t("settings.notifUnsupported")}</Status>;
  else body = <Status tone="info">{t("settings.notifAsk")}</Status>;

  return (
    <Card id="notifications" icon="bell" title={t("settings.secNotifications")} hint={t("settings.notifHint")}>
      <div data-testid="settings-notif-state" data-permission={app ? "app" : perm}>{body}</div>
      <div className="flex flex-wrap gap-2">
        {!app && perm === "default" && (
          <button className="btn-primary !py-1.5 text-[12.5px]" onClick={ask} data-testid="settings-notif-allow">
            <Icon name="bell" size={13} /> {t("settings.allowNotif")}
          </button>
        )}
        {(app || perm === "granted") && (
          <button className="btn-ghost border border-border !py-1.5 text-[12.5px]" onClick={test} data-testid="settings-notif-test">
            <Icon name="send" size={13} /> {t("settings.testNotif")}
          </button>
        )}
      </div>
    </Card>
  );
}

// ---- Mate & voice, Desktop app (the existing Global-settings panels) -------------------------------------------

function MateSection() {
  const t = useT();
  useEffect(() => {
    const st = useMateStore.getState();
    if (!st.loaded) void st.load().catch(() => {});
  }, []);
  const openGlobal = () => {
    useMateStore.getState().openGlobal("voice");
    useUIStore.getState().setView("mate");
  };
  return (
    <Card id="mate" icon="volume" title={t("settings.secMate")} hint={t("settings.mateHint")}>
      <div className="space-y-3">
        <DefaultsPanel />
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost border border-border !py-1.5 text-[12.5px]" onClick={openGlobal} data-testid="settings-open-mate-global">
          <Icon name="sliders" size={13} /> {t("settings.openMateGlobal")}
        </button>
        <button className="btn-ghost !py-1.5 text-[12.5px]" onClick={() => useUIStore.getState().setView("mate")}>
          <Icon name="sparkles" size={13} /> {t("settings.openMate")}
        </button>
      </div>
    </Card>
  );
}

function DesktopSection() {
  const t = useT();
  return (
    <Card id="desktop" icon="monitor" title={t("settings.secDesktop")} hint={t("settings.desktopHint")}>
      <div className="space-y-3">
        <DesktopPanel />
      </div>
    </Card>
  );
}

// ---- the view ----------------------------------------------------------------------------------------------------

export default function SettingsView() {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const android = isAndroidApp();
  const sections: { id: SettingsSection; label: MsgKey }[] = [
    { id: "updates", label: "settings.secUpdates" },
    { id: "account", label: "settings.secAccount" },
    { id: "language", label: "settings.secLanguage" },
    { id: "notifications", label: "settings.secNotifications" },
    { id: "mate", label: "settings.secMate" },
    ...(android ? [] : [{ id: "desktop" as const, label: "settings.secDesktop" as const }]),
  ];
  const jump = (id: SettingsSection, smooth = true) => {
    const el = document.getElementById(`settings-${id}`);
    if (el) el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  };
  // a deep link (the default-password banner → Account): once the view is drawn
  useEffect(() => {
    const first = takeSettingsSection();
    if (first) requestAnimationFrame(() => jump(first, false));
    return onSettingsSection((s) => jump(s));
  }, []);

  return (
    <div ref={scroller} className="h-full overflow-y-auto" data-testid="settings-view">
      <div className="mx-auto max-w-3xl px-3 sm:px-6 py-5 sm:py-8 pb-safe">
        <div className="mb-1 flex items-center gap-2.5">
          <Icon name="settings" size={20} className="text-accent" />
          <h1 className="text-lg font-semibold">{t("settings.title")}</h1>
        </div>
        <p className="mb-4 text-sm text-content-dim">{t("settings.subtitle")}</p>
        <nav className="no-scrollbar -mx-3 mb-4 flex gap-1.5 overflow-x-auto px-3 sm:mx-0 sm:px-0" aria-label={t("settings.title")}>
          {sections.map((s) => (
            <button key={s.id} onClick={() => jump(s.id)} className="pill shrink-0 whitespace-nowrap border border-border bg-surface-2/60 px-3 py-1.5 text-[12.5px] text-content-dim transition hover:text-content hover:border-border-strong">
              {t(s.label)}
            </button>
          ))}
        </nav>
        <div className="space-y-4">
          <UpdatesSection />
          <AccountSection />
          <LanguageSection />
          <NotificationsSection />
          <MateSection />
          {!android && <DesktopSection />}
        </div>
      </div>
    </div>
  );
}
