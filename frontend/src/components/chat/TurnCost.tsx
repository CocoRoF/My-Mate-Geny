import { API_COST_HINT, fmtTokens, fmtUsd, tokenBreakdown } from "../../lib/usage";
import type { Turn } from "../../stores/chatStore";
import HoverPopover from "../ui/HoverPopover";

/** A reply's API-equivalent cost ("≈ $0.123"); hover / tap for the token
 * breakdown it comes from. Nothing when the engine reports no cost. */
export default function TurnCost({ turn }: { turn: Turn }) {
  if (turn.costUsd === undefined || !turn.complete) return null;
  const t = tokenBreakdown(turn.usage);
  if (!turn.costUsd && !t) return null; // e.g. a turn that never reached the model
  const rows: [string, number][] = t
    ? [["Input", t.input], ["Cache read", t.cacheRead], ["Cache write", t.cacheWrite], ["Output", t.output]]
    : [];
  return (
    <HoverPopover
      align="start"
      label="API-equivalent cost of this turn"
      triggerClassName="font-mono rounded px-1 -mx-1 hover:bg-surface-3 hover:text-content-dim transition"
      trigger={<>≈ {fmtUsd(turn.costUsd)}</>}
    >
      <div className="w-[260px] p-3 text-[12px]">
        <div className="font-medium text-content">≈ {fmtUsd(turn.costUsd)} API-equivalent</div>
        {rows.length > 0 && (
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-content-faint">{k}</dt>
                <dd className="text-right text-content-dim">{fmtTokens(v)}</dd>
              </div>
            ))}
            <dt className="text-content-faint">Total</dt>
            <dd className="text-right text-content">{fmtTokens(t!.total)}</dd>
          </dl>
        )}
        <p className="mt-2 text-[10.5px] text-content-faint">
          Tokens summed over every model call in this turn (tools, subagents). {API_COST_HINT}
        </p>
      </div>
    </HoverPopover>
  );
}
