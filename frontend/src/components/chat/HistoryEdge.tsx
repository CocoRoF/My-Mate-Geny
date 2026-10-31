import type { Paging } from "../../stores/chatStore";
import Icon from "../ui/Icon";

/** The top of a paged transcript: "loading earlier…" while there is more
 * (always the same height, so swapping it never moves the text below), a
 * retry when a page failed, the beginning marker once everything is in. */
export default function HistoryEdge({ paging, empty, onRetry }: { paging: Paging; empty: boolean; onRetry: () => void }) {
  if (!paging.paged || empty) return null;
  return (
    <div className="flex h-8 items-center justify-center gap-3 text-[11.5px] text-content-faint" aria-live="polite">
      {paging.hasMore ? (
        paging.error ? (
          <button onClick={onRetry} className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-warning hover:bg-surface-3">
            <Icon name="refresh" size={12} /> Couldn't load earlier messages — retry
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5" data-testid="history-loading">
            <Icon name="spinner" size={12} spin /> Loading earlier messages…
          </span>
        )
      ) : (
        <>
          <span className="h-px w-12 bg-border" />
          <span data-testid="history-start">Beginning of the conversation</span>
          <span className="h-px w-12 bg-border" />
        </>
      )}
    </div>
  );
}
