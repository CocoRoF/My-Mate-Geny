/**
 * Settings → Providers → Higgsfield (docs/higgsfield.md): the connected account(s) with plan, credits and
 * workspace; connect / sign in again / refresh / disconnect; what the chats get (the CLI, the skills).
 * Tokens never reach the console: the server signs in, refreshes and hands the chats an access token only.
 */
import { useEffect, useState } from "react";
import {
  disconnectHiggsfieldAccount,
  higgsfieldJobTypes,
  higgsfieldQuote,
  installHiggsfieldSkills,
  refreshHiggsfieldAccount,
  removeHiggsfieldSkills,
  updateHiggsfieldAccount,
  type HiggsfieldAccount,
  type HiggsfieldJobType,
} from "../../api/higgsfield";
import { useHiggsfieldStore } from "../../stores/higgsfieldStore";
import { useT, type MsgKey } from "../../i18n";
import { fmtDateTime, relTime } from "../../i18n/format";
import Icon from "../ui/Icon";
import HiggsfieldConnectDialog from "./HiggsfieldConnectDialog";
import { fmtCredits, hfErrorText } from "./higgsfieldText";

/** the Providers tab id (not an agent engine: it isn't in the engine catalog) */
export const HIGGSFIELD = "higgsfield";

/** Providers' tab button, styled like the engine tabs beside it */
export function HiggsfieldTab({ selected, onPick }: { selected: boolean; onPick: () => void }) {
  const connected = useHiggsfieldStore((s) => s.status?.connected);
  const load = useHiggsfieldStore((s) => s.load);
  const known = useHiggsfieldStore((s) => s.status !== null);
  useEffect(() => {
    if (!known) void load();
  }, [known, load]);
  return (
    <button
      onClick={onPick}
      data-testid="providers-tab-higgsfield"
      className={`relative px-4 py-2 text-sm font-medium transition -mb-px border-b-2 ${
        selected ? "border-accent text-content" : "border-transparent text-content-dim hover:text-content"
      }`}
    >
      <span className="inline-flex items-center gap-2">
        Higgsfield
        <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-success" : "bg-content-faint/50"}`} />
      </span>
    </button>
  );
}

export default function HiggsfieldPanel() {
  const t = useT();
  const status = useHiggsfieldStore((s) => s.status);
  const load = useHiggsfieldStore((s) => s.load);
  const put = useHiggsfieldStore((s) => s.put);
  const [connectFor, setConnectFor] = useState<{ accountId?: string } | null>(null);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const accounts = status?.accounts ?? [];
  const skills = status?.skills;
  const skillCount = (skills?.host.length || 0) + (skills?.bundled.length || 0);

  const install = async () => {
    setSkillsBusy(true);
    setSkillsError(null);
    try {
      await installHiggsfieldSkills();
      await load();
    } catch (e) {
      setSkillsError(hfErrorText(e).text);
    } finally {
      setSkillsBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="higgsfield-panel">
      {/* accounts */}
      <div className="card p-4">
        <div className="flex items-start gap-3 mb-3">
          <div className="grid place-items-center w-9 h-9 rounded-lg bg-accent-soft shrink-0">
            <Icon name="sparkles" size={17} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium">{t("higgsfield.accounts")}</div>
              <button onClick={() => setConnectFor({})} className="btn-soft py-1.5" data-testid="higgsfield-add">
                <Icon name="plus" size={14} /> {accounts.length ? t("higgsfield.addAccount") : t("higgsfield.connect")}
              </button>
            </div>
            <p className="text-xs text-content-faint mt-0.5">{t("higgsfield.intro")}</p>
          </div>
        </div>

        <div className="space-y-2">
          {status === null && (
            <div className="flex items-center gap-2 py-2 text-sm text-content-faint">
              <Icon name="spinner" size={14} spin /> {t("higgsfield.loading")}
            </div>
          )}
          {status && accounts.length === 0 && (
            <p className="text-sm text-content-faint py-2" data-testid="higgsfield-empty">{t("higgsfield.noAccounts")}</p>
          )}
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              many={accounts.length > 1}
              onChange={put}
              onReload={() => load()}
              onSignIn={() => setConnectFor({ accountId: a.id })}
            />
          ))}
        </div>
      </div>

      {/* what the chats get */}
      <div className="card p-4">
        <div className="flex items-start gap-3">
          <div className="grid place-items-center w-9 h-9 rounded-lg bg-accent-soft shrink-0">
            <Icon name="terminal" size={17} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0 space-y-2.5">
            <div>
              <div className="font-medium">{t("higgsfield.agentsTitle")}</div>
              <p className="text-xs text-content-faint mt-0.5">{t("higgsfield.agentsHint")}</p>
            </div>
            <div className="flex items-center gap-2 text-[12px]" data-testid="higgsfield-cli">
              <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${status?.cli.available ? "bg-success" : "bg-warning"}`} />
              <span className={`text-content-dim ${status?.cli.available ? "shrink-0 whitespace-nowrap" : ""}`}>
                {status?.cli.available ? t("higgsfield.cliFound") : t("higgsfield.cliMissing")}
              </span>
              {status?.cli.path && <code className="min-w-0 truncate font-mono text-[11px] text-content-faint">{status.cli.path}</code>}
              <button onClick={() => load(true)} className="btn-ghost ml-auto py-0.5 text-[11px]" title={t("higgsfield.recheck")} aria-label={t("higgsfield.recheck")}>
                <Icon name="refresh" size={12} />
              </button>
            </div>
            {status && !status.cli.available && (
              <p className="text-[11.5px] text-content-faint">
                {t.rich("higgsfield.cliInstall", { code: (x) => <code className="font-mono text-content-dim">{x}</code> })}
              </p>
            )}
            <div className="flex items-center gap-2 text-[12px] flex-wrap" data-testid="higgsfield-skills">
              <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${skillCount ? "bg-success" : "bg-content-faint/50"}`} />
              <span className="text-content-dim">
                {skills?.host.length
                  ? t("higgsfield.skillsHost", { count: skills.host.length })
                  : skills?.bundled.length
                    ? t("higgsfield.skillsBundled", { count: skills.bundled.length })
                    : t("higgsfield.skillsNone")}
              </span>
              {!skills?.host.length && (
                <span className="ml-auto flex items-center gap-1.5">
                  <button onClick={install} disabled={skillsBusy} className="btn-soft py-1 text-[11.5px]" data-testid="higgsfield-skills-install">
                    {skillsBusy ? <Icon name="spinner" size={12} spin /> : <Icon name="download" size={12} />}
                    {skills?.bundled.length ? t("higgsfield.skillsUpdate") : t("higgsfield.skillsInstall")}
                  </button>
                  {!!skills?.bundled.length && (
                    <button
                      onClick={() => removeHiggsfieldSkills().then(() => load())}
                      className="btn-ghost py-1 text-danger hover:text-danger"
                      title={t("higgsfield.skillsRemove")}
                      aria-label={t("higgsfield.skillsRemove")}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </span>
              )}
            </div>
            {skills && !skills.host.length && (
              <p className="text-[11px] text-content-faint">{t("higgsfield.skillsHint")}</p>
            )}
            {skillsError && <p className="text-[11.5px] text-danger">{skillsError}</p>}
          </div>
        </div>
      </div>

      {accounts.some((a) => a.is_default && a.status === "ok") && <QuoteCard />}

      {connectFor && (
        <HiggsfieldConnectDialog
          accountId={connectFor.accountId}
          onClose={() => setConnectFor(null)}
          onConnected={() => load()}
        />
      )}
    </div>
  );
}

const TYPE_LABEL: Record<string, MsgKey> = {
  image: "higgsfield.typeImage",
  video: "higgsfield.typeVideo",
  audio: "higgsfield.typeAudio",
  "3d": "higgsfield.type3d",
  text: "higgsfield.typeText",
  data: "higgsfield.typeData",
  other: "higgsfield.typeOther",
};

/** What a job costs on this account — Higgsfield's own estimate (nothing is created or spent). */
function QuoteCard() {
  const t = useT();
  const [types, setTypes] = useState<HiggsfieldJobType[] | null>(null);
  const [jobType, setJobType] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ jobType: string; credits: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTypes = () => {
    setError(null);
    higgsfieldJobTypes()
      .then((d) => {
        setTypes(d.job_types);
        if (!jobType && d.job_types.length) setJobType(d.job_types.find((x) => x.type === "image")?.job_type || d.job_types[0].job_type);
      })
      .catch((e) => setError(hfErrorText(e).text));
  };

  const quote = async () => {
    if (!jobType) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const q = await higgsfieldQuote(jobType, prompt.trim() ? { prompt: prompt.trim() } : {});
      setResult({ jobType, credits: q.credits });
    } catch (e) {
      const { text, detail } = hfErrorText(e);
      setError(detail ? `${text} (${detail})` : text);
    } finally {
      setBusy(false);
    }
  };

  const groups = (types || []).reduce<Record<string, HiggsfieldJobType[]>>((acc, x) => {
    (acc[x.type || "other"] ||= []).push(x);
    return acc;
  }, {});

  return (
    <div className="card p-4" data-testid="higgsfield-quote">
      <div className="flex items-start gap-3">
        <div className="grid place-items-center w-9 h-9 rounded-lg bg-accent-soft shrink-0">
          <Icon name="search" size={17} className="text-accent" />
        </div>
        <div className="flex-1 min-w-0 space-y-2.5">
          <div>
            <div className="font-medium">{t("higgsfield.quoteTitle")}</div>
            <p className="text-xs text-content-faint mt-0.5">{t("higgsfield.quoteHint")}</p>
          </div>
          {types === null ? (
            <button onClick={loadTypes} className="btn-soft py-1.5 text-[12px]" data-testid="higgsfield-quote-load">
              {t("higgsfield.quoteLoad")}
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={jobType}
                onChange={(e) => setJobType(e.target.value)}
                className="field py-1 text-xs w-52"
                aria-label={t("higgsfield.quoteModel")}
                data-testid="higgsfield-quote-model"
              >
                {Object.entries(groups).map(([g, list]) => (
                  <optgroup key={g} label={TYPE_LABEL[g] ? t(TYPE_LABEL[g]) : g}>
                    {list.map((x) => (
                      <option key={x.job_type} value={x.job_type}>
                        {x.display_name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && quote()}
                placeholder={t("higgsfield.quotePrompt")}
                className="field flex-1 min-w-[8rem] py-1 text-xs"
              />
              <button onClick={quote} disabled={busy || !jobType} className="btn-soft py-1.5 text-[12px]" data-testid="higgsfield-quote-go">
                {busy ? <Icon name="spinner" size={12} spin /> : t("higgsfield.quoteGo")}
              </button>
            </div>
          )}
          {result && (
            <p className="text-[12.5px] text-content" data-testid="higgsfield-quote-result">
              {t("higgsfield.quoteResult", { n: fmtCredits(result.credits) })}
            </p>
          )}
          {error && <p className="text-[11.5px] text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  ok: "bg-success/15 text-success",
  reauth: "bg-danger/15 text-danger",
  error: "bg-warning/15 text-warning",
};

function AccountRow({
  account: a,
  many,
  onChange,
  onReload,
  onSignIn,
}: {
  account: HiggsfieldAccount;
  many: boolean;
  onChange: (a: HiggsfieldAccount) => void;
  onReload: () => void;
  onSignIn: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const run = async (fn: () => Promise<HiggsfieldAccount | void>) => {
    setBusy(true);
    setError(null);
    try {
      const acc = await fn();
      if (acc) onChange(acc);
    } catch (e) {
      const { text, detail } = hfErrorText(e);
      setError(detail ? `${text} (${detail})` : text);
      onReload();
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = a.status === "ok" ? t("higgsfield.statusOk") : a.status === "reauth" ? t("higgsfield.statusReauth") : t("higgsfield.statusError");

  return (
    <div className="rounded-lg border border-border bg-surface/50 p-3" data-testid="higgsfield-account">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`pill ${STATUS_STYLE[a.status] || STATUS_STYLE.error}`}>{statusLabel}</span>
        <span className="text-sm font-medium truncate">{a.email || a.label}</span>
        {a.plan && <span className="pill bg-surface-3 text-content-dim capitalize">{a.plan}</span>}
        {a.is_default && many && <span className="pill bg-accent-soft text-accent">{t("higgsfield.default")}</span>}
        <span className="ml-auto text-right">
          <span className="block text-sm font-semibold tabular-nums text-content" data-testid="higgsfield-credits">
            {fmtCredits(a.credits)}
          </span>
          <span className="block text-[10.5px] text-content-faint">{t("higgsfield.credits")}</span>
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[11.5px]">
        {a.workspaces.length > 0 && (
          <>
            <dt className="text-content-faint self-center">{t("higgsfield.workspace")}</dt>
            <dd>
              {a.workspaces.length > 1 ? (
                <select
                  value={a.workspace_id || ""}
                  onChange={(e) => run(() => updateHiggsfieldAccount(a.id, { workspace_id: e.target.value }))}
                  className="field py-0.5 text-[11.5px] w-56 max-w-full"
                  aria-label={t("higgsfield.workspace")}
                >
                  {a.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name || w.id}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-content-dim">{a.workspaces[0].name || a.workspaces[0].id}</span>
              )}
            </dd>
          </>
        )}
        <dt className="text-content-faint">{t("higgsfield.signedInWith")}</dt>
        <dd className="text-content-dim">{a.source === "import" ? t("higgsfield.viaFile") : t("higgsfield.viaLink")}</dd>
        {a.refreshed_at && (
          <>
            <dt className="text-content-faint">{t("higgsfield.checked")}</dt>
            <dd className="text-content-dim" title={fmtDateTime(a.refreshed_at)}>{relTime(a.refreshed_at)}</dd>
          </>
        )}
      </dl>

      {a.status === "reauth" && <p className="mt-2 text-[11.5px] text-danger">{t("higgsfield.reauthHint")}</p>}
      {a.status === "error" && a.error && <p className="mt-2 text-[11px] font-mono text-warning truncate">{a.error}</p>}
      {!a.has_refresh_token && a.status === "ok" && <p className="mt-2 text-[11px] text-warning">{t("higgsfield.noRefresh")}</p>}
      {error && <p className="mt-2 text-[11.5px] text-danger" role="alert">{error}</p>}

      <div className="flex items-center gap-2 mt-2.5 flex-wrap text-[12px]">
        <button onClick={() => run(() => refreshHiggsfieldAccount(a.id))} disabled={busy} className="btn-ghost py-1" data-testid="higgsfield-refresh">
          {busy ? <Icon name="spinner" size={13} spin /> : <Icon name="refresh" size={13} />} {t("higgsfield.refresh")}
        </button>
        {(a.status !== "ok" || !a.has_refresh_token) && (
          <button onClick={onSignIn} className="btn-soft py-1">
            <Icon name="key" size={13} /> {t("higgsfield.signInAgain")}
          </button>
        )}
        {many && !a.is_default && (
          <button onClick={() => run(() => updateHiggsfieldAccount(a.id, { is_default: true }).then((x) => (onReload(), x)))} className="btn-ghost py-1">
            {t("higgsfield.makeDefault")}
          </button>
        )}
        {confirm ? (
          <span className="ml-auto flex items-center gap-1.5">
            <span className="text-[11.5px] text-content-dim">{t("higgsfield.disconnectConfirm")}</span>
            <button
              onClick={() => run(() => disconnectHiggsfieldAccount(a.id).then(() => onReload()))}
              className="btn-ghost py-1 text-danger hover:text-danger"
              data-testid="higgsfield-disconnect-yes"
            >
              {t("higgsfield.disconnect")}
            </button>
            <button onClick={() => setConfirm(false)} className="btn-ghost py-1">
              {t("common.cancel")}
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirm(true)}
            className="btn-ghost py-1 text-danger hover:text-danger ml-auto"
            title={t("higgsfield.disconnect")}
            aria-label={t("higgsfield.disconnect")}
            data-testid="higgsfield-disconnect"
          >
            <Icon name="trash" size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
