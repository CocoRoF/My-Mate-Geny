/** "Higgsfield: 3 credits used this turn · 1,752.78 left" after a turn that ran the higgsfield CLI (the account's
 * own transactions since the turn began; the server's notice `higgsfield.spend`), with what they were for. */
import { useState } from "react";
import { useT } from "../../../i18n";
import Icon from "../../ui/Icon";
import { fmtCredits } from "../../providers/higgsfieldText";

interface Data {
  credits_used?: number;
  balance?: number | null;
  items?: { display_name: string; credits: number; action: string }[];
}

export default function HiggsfieldSpend({ data }: { data?: Record<string, any> }) {
  const t = useT();
  const d = (data || {}) as Data;
  const [open, setOpen] = useState(false);
  const items = d.items || [];
  return (
    <div className="rounded-lg bg-accent/8 px-3 py-2 text-[12.5px] text-content-dim" data-testid="higgsfield-spend">
      <button
        onClick={() => items.length && setOpen(!open)}
        className={`flex w-full items-center gap-2 text-left ${items.length ? "" : "cursor-default"}`}
        aria-expanded={items.length ? open : undefined}
      >
        <Icon name="sparkles" size={14} className="shrink-0 text-accent" />
        <span className="flex-1">
          {t("higgsfield.spentTurn", { n: fmtCredits(d.credits_used ?? 0) })}
          {d.balance != null && <span className="text-content-faint"> · {t("higgsfield.creditsLeft", { n: fmtCredits(d.balance) })}</span>}
        </span>
        {items.length > 0 && <Icon name={open ? "chevron-down" : "chevron"} size={12} className="text-content-faint" />}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-0.5 pl-6">
          {items.map((x, i) => (
            <li key={i} className="flex justify-between gap-3 text-[11.5px]">
              <span className="truncate">{x.display_name || x.action}</span>
              <span className="font-mono tabular-nums">{`${x.credits > 0 ? "+" : ""}${fmtCredits(x.credits)}`}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
