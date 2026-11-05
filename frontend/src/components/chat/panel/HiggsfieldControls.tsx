/**
 * The chat's Higgsfield (session panel; docs/higgsfield.md): on / off for this chat (on by default once an account
 * is connected; off takes the agent's credentials away at once), a credit limit above which the agent asks first,
 * and the account's balance.
 */
import { useEffect, useState } from "react";
import { useHiggsfieldStore } from "../../../stores/higgsfieldStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { openSettings } from "../../../stores/uiStore";
import type { Session } from "../../../types";
import { useT } from "../../../i18n";
import Icon from "../../ui/Icon";
import { fmtCredits } from "../../providers/higgsfieldText";

export function useHiggsfieldConnected(): boolean {
  const status = useHiggsfieldStore((s) => s.status);
  const load = useHiggsfieldStore((s) => s.load);
  useEffect(() => {
    if (status === null) void load();
  }, [status, load]);
  return !!status?.connected;
}

export default function HiggsfieldControls({ session }: { session: Session }) {
  const t = useT();
  const update = useSessionStore((s) => s.update);
  const account = useHiggsfieldStore((s) => s.account());
  const cliMissing = useHiggsfieldStore((s) => s.status?.cli.available === false);
  const cfg = session.higgsfield ?? { enabled: true, max_credits: null };
  const [limit, setLimit] = useState(cfg.max_credits == null ? "" : String(cfg.max_credits));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setLimit(cfg.max_credits == null ? "" : String(cfg.max_credits)), [cfg.max_credits]);

  const save = (patch: { enabled?: boolean; max_credits?: number | null }) =>
    update(session.id, { higgsfield: patch })
      .then(() => setError(null))
      .catch((e) => setError(String(e?.message || e)));

  const saveLimit = () => {
    const v = limit.trim();
    const n = v === "" ? null : Number(v);
    if (n !== null && (!Number.isFinite(n) || n < 0)) {
      setLimit(cfg.max_credits == null ? "" : String(cfg.max_credits));
      return;
    }
    if (n !== cfg.max_credits) void save({ max_credits: n });
  };

  return (
    <div className="space-y-2 text-[12px]" data-testid="higgsfield-session">
      <div className="flex items-center gap-2">
        <span className="text-content-dim">{t("higgsfield.useInChat")}</span>
        <button
          onClick={() => save({ enabled: !cfg.enabled })}
          aria-label={t("higgsfield.useInChat")}
          aria-pressed={cfg.enabled}
          data-testid="higgsfield-session-toggle"
          className={`relative ml-auto w-9 h-5 shrink-0 rounded-full transition ${cfg.enabled ? "bg-accent" : "bg-surface-3 light:bg-border-strong"}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white light:shadow transition-all ${cfg.enabled ? "left-[18px]" : "left-0.5"}`} />
        </button>
      </div>
      <p className="text-[11px] text-content-faint">{cfg.enabled ? t("higgsfield.onHint") : t("higgsfield.offHint")}</p>
      {cfg.enabled && (
        <>
          <label className="flex items-center gap-2">
            <span className="text-content-dim">{t("higgsfield.askAbove")}</span>
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              onBlur={saveLimit}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              inputMode="decimal"
              placeholder={t("higgsfield.noLimit")}
              className="field ml-auto w-20 py-0.5 px-1.5 text-right text-[11.5px]"
              data-testid="higgsfield-session-limit"
            />
            <span className="text-content-faint">{t("higgsfield.creditsUnit")}</span>
          </label>
          {account && (
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-content-faint">{account.email || account.label}</span>
              <span className="font-mono text-content-dim">
                {t("higgsfield.creditsLeft", { n: fmtCredits(account.credits) })}
              </span>
            </div>
          )}
          {account?.status === "reauth" && <p className="text-[11px] text-danger">{t("higgsfield.reauthHint")}</p>}
          {cliMissing && <p className="text-[11px] text-warning">{t("higgsfield.cliMissing")}</p>}
        </>
      )}
      {error && <p className="text-[11px] text-danger">{error}</p>}
      <button onClick={() => openSettings("media")} className="flex items-center gap-1 text-[11px] text-accent hover:underline">
        <Icon name="settings" size={11} /> {t("higgsfield.manage")}
      </button>
    </div>
  );
}
