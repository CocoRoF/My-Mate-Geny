import { fmtCtx } from "../../lib/context";
import Icon from "../ui/Icon";

/** Where the CLI summarised the conversation: what came before is now only a
 * summary in the agent's context (it stays visible here). */
export default function CompactionDivider({ data, message }: { data?: Record<string, any>; message?: string }) {
  const pre = typeof data?.pre_tokens === "number" ? data.pre_tokens : null;
  const post = typeof data?.post_tokens === "number" ? data.post_tokens : null;
  const trigger = data?.trigger === "auto" ? "auto" : data?.trigger === "manual" ? "manual" : null;
  return (
    <div
      className="flex items-center gap-3 py-1.5 text-[11.5px] text-content-faint animate-fade-in"
      title={
        "Earlier messages were summarised to free up context. They stay visible here, but the agent now only has the summary." +
        (message ? `\n${message}` : "")
      }
    >
      <span className="h-px flex-1 border-t border-dashed border-accent/40" />
      <span className="inline-flex items-center gap-1.5 text-content-dim">
        <Icon name="file-text" size={12} className="text-accent" />
        <span>Context compacted</span>
        {trigger && <span className="pill bg-accent-soft text-accent">{trigger}</span>}
        {pre !== null && post !== null && (
          <span className="font-mono text-content-faint">
            {fmtCtx(pre)} → {fmtCtx(post)}
          </span>
        )}
      </span>
      <span className="h-px flex-1 border-t border-dashed border-accent/40" />
    </div>
  );
}
