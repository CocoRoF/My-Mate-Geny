import { useState } from "react";
import { renewSession, type Account, type LoginSession, type RenewResult } from "../../api/accounts";
import { useT } from "../../i18n";
import { fmtDateTime, fmtDuration, fmtTime, relTime } from "../../i18n/format";
import { detailKey, HEALTH_KEY, HEALTH_TONE, METHOD_KEY, planStale, renewResultKey, sessionActions } from "../../lib/loginSession";
import Icon from "../ui/Icon";

const at = (iso: string | null | undefined) => (iso ? fmtDateTime(iso, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "");

/** "Last checked 5m ago · the usage server asked to wait — checking again at 14:20" under an account's plan bars. */
export function PlanStaleNote({ account }: { account: Account }) {
  const t = useT();
  const note = planStale(account);
  if (!note) return null;
  const when = note.retryAt ? t("providers.planWhenAt", { time: fmtTime(note.retryAt) }) : t("providers.planWhenSoon");
  const checked = note.fetchedAt ? t("providers.planLastChecked", { ago: relTime(note.fetchedAt) }) : t("providers.planNeverChecked");
  return (
    <p className="mt-1 truncate text-[11px] text-content-faint" title={note.error} data-testid="plan-stale">
      <Icon name="clock" size={11} className="mr-1 inline -mt-px" />
      {checked} · <span className="text-warning/90 light:text-warning">{t(note.key, { when })}</span>
    </p>
  );
}

/**
 * The account card's "Login session" row: health, when the access token runs out, renew / sign in again, and a
 * details expander (method, who, plan, expiry, refresh token, scopes). Read from the CLI's credentials file — the
 * browser never gets a token.
 */
export default function AccountSession({
  provider,
  account,
  onChanged,
  onRelogin,
}: {
  provider: string;
  account: Account;
  onChanged: () => void;
  onRelogin: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RenewResult | { ok: false; code: string; error: string; method?: null; session: null } | null>(null);
  const s: LoginSession | null | undefined = account.session;
  if (!s) return null;
  const acts = sessionActions(s);

  const renew = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await renewSession(provider, account.id);
      setResult(r);
      onChanged();
    } catch (e) {
      setResult({ ok: false, code: "request", error: String((e as Error)?.message || e), session: null });
    } finally {
      setBusy(false);
    }
  };

  const exp = s.expires_at ? Date.parse(s.expires_at) : null;
  const line =
    exp === null
      ? s.method === "api_key" || s.method === "setup_token"
        ? t("providers.sessNoExpiry")
        : ""
      : exp > Date.now()
        ? t("providers.sessExpiresIn", { in: fmtDuration((exp - Date.now()) / 1000), at: at(s.expires_at) })
        : t("providers.sessExpiredAgo", { ago: relTime(exp) });
  const dk = detailKey(s);
  const after = result?.session || s;
  const resultText = result
    ? t(renewResultKey(result.ok, result.method, result.code), { at: at(after.expires_at) || "—", error: result.error || result.code })
    : "";

  return (
    <div className="mt-2.5 rounded-md border border-border/70 bg-surface-2/40 light:bg-surface-2/60 px-2.5 py-2" data-testid={`session-${account.id}`}>
      <div className="flex items-center gap-2 flex-wrap text-[11.5px]">
        <Icon name="key" size={12} className="text-content-faint" />
        <span className="text-content-dim">{t("providers.sessionTitle")}</span>
        <span className={`pill ${HEALTH_TONE[s.health]}`} data-testid="session-health" data-health={s.health}>
          {t(HEALTH_KEY[s.health])}
        </span>
        {line && <span className="text-content-faint tabular-nums">{line}</span>}
        <span className="ml-auto flex items-center gap-1">
          {acts.relogin && acts.reloginFirst && (
            <button onClick={onRelogin} className="btn-soft py-0.5 px-2 text-[11px]" data-testid="session-relogin">
              <Icon name="key" size={12} /> {t("providers.relogin")}
            </button>
          )}
          {acts.renew && (
            <button onClick={renew} disabled={busy} className="btn-ghost py-0.5 px-2 text-[11px]" data-testid="session-renew">
              <Icon name={busy ? "spinner" : "refresh"} size={12} spin={busy} /> {busy ? t("providers.renewing") : t("providers.renew")}
            </button>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            className="btn-ghost py-0.5 px-1.5 text-[11px]"
            aria-expanded={open}
            data-testid="session-details-toggle"
          >
            <Icon name={open ? "chevron-up" : "chevron-down"} size={12} /> {open ? t("providers.hideDetails") : t("providers.details")}
          </button>
        </span>
      </div>
      {dk && <p className={`mt-1 text-[11px] ${s.actionable ? "text-danger light:text-danger" : "text-content-faint"}`}>{t(dk)}</p>}
      {result && (
        <p
          className={`mt-1 text-[11px] ${result.ok ? "text-success" : "text-danger"}`}
          title={result.error || undefined}
          role="status"
          data-testid="session-result"
        >
          {resultText}
        </p>
      )}
      {open && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]" data-testid="session-details">
          <dt className="text-content-faint">{t("providers.sessMethod")}</dt>
          <dd className="text-content-dim">{t(METHOD_KEY[s.method] || "providers.methodNone")}</dd>
          {(s.email || s.organization) && (
            <>
              <dt className="text-content-faint">{t("providers.sessWho")}</dt>
              <dd className="text-content-dim break-all">{[s.email, s.organization].filter(Boolean).join(" · ")}</dd>
            </>
          )}
          {(s.plan || s.rate_limit_tier) && (
            <>
              <dt className="text-content-faint">{t("providers.sessPlan")}</dt>
              <dd className="text-content-dim">{[s.plan, s.rate_limit_tier].filter(Boolean).join(" · ")}</dd>
            </>
          )}
          <dt className="text-content-faint">{t("providers.sessAccessExpires")}</dt>
          <dd className="text-content-dim tabular-nums">{s.expires_at ? `${at(s.expires_at)} · ${line}` : t("providers.sessNoExpiry")}</dd>
          <dt className="text-content-faint">{t("providers.sessRefreshToken")}</dt>
          <dd className="text-content-dim">
            {s.has_refresh_token
              ? s.refresh_expires_at
                ? t("providers.sessRefreshYesUntil", { at: at(s.refresh_expires_at) })
                : t("providers.sessRefreshYes")
              : t("providers.sessRefreshNo")}
          </dd>
          {s.updated_at && (
            <>
              <dt className="text-content-faint">{t("providers.sessUpdated")}</dt>
              <dd className="text-content-dim">{`${relTime(s.updated_at)} (${at(s.updated_at)})`}</dd>
            </>
          )}
          {s.last_renew && (
            <>
              <dt className="text-content-faint">{t("providers.sessLastRenew")}</dt>
              <dd className={s.last_renew.ok ? "text-content-dim" : "text-danger"} title={s.last_renew.error || undefined}>
                {`${s.last_renew.at ? relTime(s.last_renew.at) : ""} · ${s.last_renew.ok ? t("providers.sessRenewOk") : t("providers.sessRenewFailedShort")}`}
                {s.last_renew.code ? ` (${s.last_renew.code})` : ""}
              </dd>
            </>
          )}
          <dt className="text-content-faint">{t("providers.sessScopes")}</dt>
          <dd className="flex flex-wrap gap-1">
            {s.scopes.length ? (
              s.scopes.map((sc) => (
                <span key={sc} className="pill bg-surface-3 text-content-faint font-mono text-[10px]">
                  {sc}
                </span>
              ))
            ) : (
              <span className="text-content-faint">{t("providers.sessNoScopes")}</span>
            )}
          </dd>
          {acts.relogin && !acts.reloginFirst && (
            <dd className="col-span-2 mt-1 flex items-center gap-2 flex-wrap">
              <button onClick={onRelogin} className="btn-ghost py-0.5 px-2 text-[11px]" data-testid="session-relogin-details">
                <Icon name="key" size={12} /> {t("providers.relogin")}
              </button>
              {account.primary && <span className="text-content-faint">{t("providers.primaryReloginHint")}</span>}
            </dd>
          )}
          {acts.relogin && acts.reloginFirst && account.primary && (
            <dd className="col-span-2 text-content-faint">{t("providers.primaryReloginHint")}</dd>
          )}
        </dl>
      )}
    </div>
  );
}
