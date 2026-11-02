/** Settings → Usage: the Higgsfield account's plan and credits, and its latest credit transactions. */
import { useEffect, useState } from "react";
import { higgsfieldUsage, type HiggsfieldAccount, type HiggsfieldTransaction } from "../../api/higgsfield";
import { useT } from "../../i18n";
import { fmtDateTime, relTime } from "../../i18n/format";
import Icon from "../ui/Icon";
import { fmtCredits } from "../providers/higgsfieldText";

export default function HiggsfieldUsage() {
  const t = useT();
  const [data, setData] = useState<{ account: HiggsfieldAccount | null; transactions: HiggsfieldTransaction[]; error: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    higgsfieldUsage()
      .then((d) => alive && setData(d.connected ? d : { account: null, transactions: [], error: null }))
      .catch(() => alive && setData({ account: null, transactions: [], error: null }));
    return () => {
      alive = false;
    };
  }, []);

  if (!data?.account) return null;
  const a = data.account;
  return (
    <div className="card p-5 mt-4" data-testid="higgsfield-usage">
      <div className="flex items-center gap-2 mb-3">
        <Icon name="sparkles" size={15} className="text-accent" />
        <span className="text-sm font-semibold text-content">Higgsfield</span>
        <span className="truncate text-[12px] text-content-faint">{a.email || a.label}</span>
        {a.plan && <span className="pill bg-surface-3 text-content-dim capitalize">{a.plan}</span>}
        {a.status !== "ok" && <span className="pill bg-danger/15 text-danger">{t("higgsfield.statusReauth")}</span>}
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-semibold tabular-nums text-content">{fmtCredits(a.credits)}</span>
        <span className="pb-1 text-[12px] text-content-faint">{t("higgsfield.creditsAvailable")}</span>
      </div>
      {a.refreshed_at && (
        <p className="mt-0.5 text-[11px] text-content-faint" title={fmtDateTime(a.refreshed_at)}>
          {t("higgsfield.asOf", { when: relTime(a.refreshed_at) })}
        </p>
      )}
      <div className="mt-4">
        <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-content-faint">{t("higgsfield.recent")}</div>
        {data.error && <p className="text-[11.5px] text-warning">{t("higgsfield.recentFailed")}</p>}
        {!data.error && data.transactions.length === 0 && <p className="text-[12px] text-content-faint">{t("higgsfield.recentNone")}</p>}
        <ul className="divide-y divide-border/60">
          {data.transactions.map((x, i) => (
            <li key={i} className="flex items-center gap-3 py-1.5 text-[12px]">
              <span className="min-w-0 flex-1 truncate text-content-dim">{x.display_name || x.action}</span>
              {x.created_at && (
                <span className="shrink-0 text-[11px] text-content-faint" title={fmtDateTime(x.created_at)}>
                  {relTime(x.created_at)}
                </span>
              )}
              <span className={`w-16 shrink-0 text-right font-mono tabular-nums ${(x.credits ?? 0) < 0 ? "text-content" : "text-success"}`}>
                {x.credits == null ? "—" : `${x.credits > 0 ? "+" : ""}${fmtCredits(x.credits)}`}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
