/**
 * Settings (sidebar → Settings): a tab list (left on a wide screen; on a phone a list that opens one tab) and only
 * the chosen tab. Every tab is its own address and history entry, `/?view=settings&tab=<tab>` (lib/navUrl.ts).
 *   General
 *     Updates & Download  this web console's build (+ a check for a newer one on the server), the desktop app's
 *                         in-app updater (downloads/UpdateCard.tsx ↔ desktop/src/updater.js), the Android app's
 *                         version, then the apps to download (downloads/DownloadsView.tsx; `/?view=downloads`)
 *     Account             the single admin account: username, password, sign out other devices (/api/auth/*)
 *     Language            English / 한국어, applied at once and saved for every device (i18n/, /api/preferences)
 *     Notifications       this browser's permission (the apps notify natively)
 *     Mate & voice        the default mate and reading aloud on this device (Mate's Global settings → Defaults)
 *     Desktop app         (in the desktop app) the mate on the desktop, quick-chat shortcut, start at login
 *   Agents & system
 *     Providers · Connections · Usage · Admin — what used to be sidebar screens (`/?view=usage` … open these)
 * Each tab embeds the existing component, so the logic lives once.
 */
import { providersNeedAttention } from "../../lib/attention";
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
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
import { useProviderStore } from "../../stores/providerStore";
import { openSettings, useUIStore, type SettingsTab } from "../../stores/uiStore";
import { APP_VERSION, BUILD_COMMIT, BUILD_TIME } from "../../version";
import { requestAdminTab } from "../admin/adminTab";
import UpdateCard, { useUpdateState } from "../downloads/UpdateCard";
import DefaultsPanel from "../mate/settings/global/DefaultsPanel";
import DesktopPanel from "../mate/settings/global/DesktopPanel";
import Icon, { type IconName } from "../ui/Icon";
import PageLoading from "../ui/Loading";
import MobileTopBar from "../layout/MobileTopBar";
import { checkConsoleUpdate, type ConsoleUpdate } from "./consoleUpdate";
import { useNativeVersion } from "../../lib/nativeVersion";
import { cameFrom, goBack } from "../../lib/nav";
import { settingsUrl } from "../../lib/navUrl";
import { GROUPS, isAndroidApp, isDesktopApp, visibleTabs, type TabMeta } from "./tabs";

// the tabs that were screens of their own: loaded with their tab
const DownloadsView = lazy(() => import("../downloads/DownloadsView"));
const ProvidersView = lazy(() => import("../providers/ProvidersView"));
const ConnectionsView = lazy(() => import("../connections/ConnectionsView"));
const UsageView = lazy(() => import("../usage/UsageView"));
const AdminView = lazy(() => import("../admin/AdminView"));

/** a tab's card (the tab's title is the page's — SettingsView) */
function Card({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} data-testid={`settings-${id}`} className="card scroll-mt-4 space-y-4 p-4 sm:p-5">
      {children}
    </section>
  );
}

/** "Open Download" from the Updates card: the Download part below it, in the same tab */
const openDownloads = () => openSettings("updates", "downloads");

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
    <Card id="updates">
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
            <button className="btn-ghost border border-border !py-1.5 text-[12.5px]" onClick={openDownloads}>
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
  const open = openDownloads;
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

  if (!st) return <Card id="account"><Icon name="spinner" size={16} spin className="text-content-faint" /></Card>;

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
    <Card id="account">
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
              openSettings("admin");
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
    <Card id="language">
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
    <Card id="notifications">
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
    <Card id="mate">
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
  return (
    <Card id="desktop">
      <div className="space-y-3">
        <DesktopPanel />
      </div>
    </Card>
  );
}

// ---- the view ----------------------------------------------------------------------------------------------------

const WIDE = "(min-width: 768px)"; // Tailwind's md: the sidebar is on screen, so is the tab list

function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window === "undefined" || window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

function TabContent({ id }: { id: SettingsTab }) {
  switch (id) {
    case "updates":
      return (
        <div className="space-y-4">
          <UpdatesSection />
          <DownloadsView />
        </div>
      );
    case "account":
      return <AccountSection />;
    case "language":
      return <LanguageSection />;
    case "notifications":
      return <NotificationsSection />;
    case "mate":
      return <MateSection />;
    case "desktop":
      return <DesktopSection />;
    case "providers":
      return <ProvidersView />;
    case "connections":
      return <ConnectionsView />;
    case "usage":
      return <UsageView />;
    case "admin":
      return <AdminView />;
  }
}

function Badge({ on, title }: { on: boolean; title: string }) {
  return on ? (
    <span className="pill ml-auto bg-warning/15 text-warning" title={title} aria-label={title} data-testid="settings-tab-badge">
      !
    </span>
  ) : null;
}

function TabButton({ tab, selected, list, onPick }: { tab: TabMeta; selected: boolean; list: boolean; onPick: () => void }) {
  const t = useT();
  // Providers: only when none is connected (lib/attention.ts; the sidebar's Settings item shows it too)
  const needsProvider = useProviderStore((s) => providersNeedAttention(s.providers));
  const badge = tab.id === "providers" && needsProvider;
  return (
    <button
      id={`settings-tab-${tab.id}`}
      data-testid={`settings-tab-${tab.id}`}
      data-active={selected}
      {...(list ? {} : { role: "tab", "aria-selected": selected, "aria-controls": "settings-panel", tabIndex: selected ? 0 : -1 })}
      onClick={onPick}
      className={`group flex w-full items-center gap-3 rounded-lg px-3 text-left font-medium text-content-dim transition hover:bg-surface-2 hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70 data-[active=true]:bg-surface-3 data-[active=true]:text-content ${
        list ? "py-3 text-[14px]" : "py-2 text-[13px]"
      }`}
    >
      <Icon name={tab.icon} size={16} className="shrink-0 text-content-faint group-hover:text-content-dim group-data-[active=true]:text-accent" />
      <span className="min-w-0 flex-1 truncate">{t(tab.label)}</span>
      <Badge on={badge} title={t("nav.providersNone")} />
      {list && <Icon name="chevron" size={14} className="shrink-0 text-content-faint" />}
    </button>
  );
}

/** the tabs, by group: a vertical tab list beside the tab (wide), or the list a phone opens a tab from */
function TabList({ tabs, selected, list }: { tabs: TabMeta[]; selected: SettingsTab | null; list: boolean }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // arrows / Home / End move between the tabs; Enter or Space opens one (each tab is a history entry)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (list || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length;
    e.preventDefault();
    btns[next]?.focus();
  };
  const pres = list ? {} : { role: "presentation" };
  return (
    <div
      ref={ref}
      {...(list ? {} : { role: "tablist", "aria-orientation": "vertical" as const })}
      aria-label={t("settings.title")}
      onKeyDown={onKeyDown}
      className="space-y-4"
      data-testid="settings-tabs"
    >
      {GROUPS.map((g) => {
        const mine = tabs.filter((x) => x.group === g.id);
        if (!mine.length) return null;
        return (
          <div key={g.id} {...pres}>
            <div className="px-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-content-faint" {...pres}>
              {t(g.label)}
            </div>
            <div className={list ? "card divide-y divide-border/60 overflow-hidden p-1" : "space-y-0.5"} {...pres}>
              {mine.map((x) => (
                <TabButton key={x.id} tab={x} selected={selected === x.id} list={list} onPick={() => openSettings(x.id)} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function SettingsView() {
  const t = useT();
  const wide = useWide();
  const asked = useUIStore((s) => s.settingsTab);
  const anchor = useUIStore((s) => s.settingsAnchor);
  const tabs = visibleTabs();
  // no tab (or one not offered here, e.g. Desktop app in a browser): the list on a phone, the first tab beside it
  const known = asked && tabs.some((x) => x.id === asked) ? asked : null;
  const shown: SettingsTab | null = known ?? (wide ? tabs[0].id : null);
  const meta = tabs.find((x) => x.id === shown);

  // a part of the tab to show (`/?view=downloads` → Updates & Download, at Download): once it is drawn
  useEffect(() => {
    if (!anchor || !shown) return;
    let n = 0;
    let raf = 0;
    let stop = () => {};
    const find = () => {
      const el = document.getElementById(`settings-${anchor}`);
      if (!el) {
        if (n++ < 180) raf = requestAnimationFrame(find); // (a lazy tab still loading: ~3 s)
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      const done = () => useUIStore.setState({ settingsAnchor: null });
      // what is above it may still be loading (versions, the release): keep it in place for a moment, until the
      // user scrolls themselves
      const panel = el.closest("#settings-panel");
      const body = panel?.firstElementChild;
      if (!panel || !body || typeof ResizeObserver === "undefined") return done();
      const ro = new ResizeObserver(() => el.scrollIntoView({ block: "start" }));
      ro.observe(body);
      const quit = () => {
        stop();
        done();
      };
      const timer = setTimeout(quit, 2500);
      for (const ev of ["wheel", "touchstart", "keydown", "pointerdown"]) panel.addEventListener(ev, quit, { once: true, passive: true });
      stop = () => {
        ro.disconnect();
        clearTimeout(timer);
        for (const ev of ["wheel", "touchstart", "keydown", "pointerdown"]) panel.removeEventListener(ev, quit);
      };
    };
    raf = requestAnimationFrame(find);
    return () => {
      cancelAnimationFrame(raf);
      stop();
    };
  }, [anchor, shown]);

  // a phone's tab: back to the list (the entry it came from, when it came from there)
  const backToList = () => (cameFrom(settingsUrl(null)) ? goBack() : openSettings(null));

  return (
    <div className="flex h-full flex-col" data-testid="settings-view" data-tab={shown ?? ""}>
      {/* phone: the app's top bar over the list, a back bar over a tab */}
      {!wide &&
        (shown && meta ? (
          <div className="pt-safe shrink-0 border-b border-border/70 bg-surface/80 backdrop-blur-xl">
            <div className="flex h-12 items-center gap-1 px-2">
              <button
                onClick={backToList}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-content-dim hover:bg-surface-3 hover:text-content"
                aria-label={t("settings.backToList")}
                title={t("settings.backToList")}
                data-testid="settings-back"
              >
                <Icon name="chevron-left" size={20} />
              </button>
              <Icon name={meta.icon} size={16} className="shrink-0 text-accent" />
              <h1 className="ml-1 truncate text-[15px] font-semibold">{t(meta.label)}</h1>
            </div>
          </div>
        ) : (
          <MobileTopBar title={t("nav.settings")} />
        ))}

      <div className="flex min-h-0 flex-1">
        {(wide || !shown) && (
          <nav
            className={wide ? "w-60 shrink-0 overflow-y-auto border-r border-border/70 px-2 py-5" : "flex-1 overflow-y-auto px-3 py-4 pb-safe"}
            aria-label={t("settings.title")}
          >
            {wide && (
              <div className="mb-4 flex items-center gap-2.5 px-3">
                <Icon name="settings" size={18} className="text-accent" />
                <h1 className="text-base font-semibold">{t("settings.title")}</h1>
              </div>
            )}
            {!wide && <p className="mb-4 px-1 text-[13px] text-content-dim">{t("settings.subtitle")}</p>}
            <TabList tabs={tabs} selected={shown} list={!wide} />
          </nav>
        )}

        {shown && meta && (
          <div
            key={shown}
            id="settings-panel"
            role={wide ? "tabpanel" : "region"}
            aria-labelledby={wide ? `settings-tab-${shown}` : undefined}
            aria-label={wide ? undefined : t(meta.label)}
            className="min-w-0 flex-1 overflow-y-auto animate-fade-in"
            data-testid={`settings-panel-${shown}`}
          >
            <div className={`mx-auto ${meta.wide ? "max-w-6xl" : "max-w-3xl"} px-3 py-5 pb-safe sm:px-6 sm:py-8`}>
              {wide && (
                <div className="mb-5">
                  <div className="flex items-center gap-2.5">
                    <Icon name={meta.icon} size={20} className="text-accent" />
                    <h2 className="text-lg font-semibold">{t(meta.label)}</h2>
                  </div>
                  {meta.hint && <p className="mt-1 text-sm text-content-dim">{t(meta.hint)}</p>}
                </div>
              )}
              {!wide && meta.hint && <p className="mb-4 text-[13px] text-content-dim">{t(meta.hint)}</p>}
              <Suspense fallback={<PageLoading />}>
                <TabContent id={shown} />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

