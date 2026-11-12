import { useChatStore, type Turn } from "../../stores/chatStore";
import { useHistoryScroll } from "../../hooks/useHistoryScroll";
import MessageItem from "./MessageItem";
import HistoryEdge from "./HistoryEdge";
import Icon from "../ui/Icon";
import { useT } from "../../i18n";
import { SubagentLayer, SubagentPill } from "./turn/SubagentModal";
import SubagentCard from "./turn/SubagentCard";
import ToolGroup from "./turn/ToolGroup";
import { isAgentTool } from "./turn/subagent";

/** Background work launched in a turn that isn't loaded yet (scrolled out of
 * the loaded range) and still running: shown here until its turn is. */
function Detached({ turn }: { turn: Turn }) {
  const t = useT();
  const top = turn.tools.filter((x) => !x.parent);
  if (!top.length) return null;
  const agents = top.filter(isAgentTool);
  const others = top.filter((x) => !isAgentTool(x));
  return (
    <div className="space-y-2 rounded-xl border border-dashed border-border/80 p-2.5" data-testid="detached-work">
      <div className="flex items-center gap-1.5 px-1 text-[11.5px] text-content-faint">
        <Icon name="activity" size={12} /> {t("chat.startedEarlier")}
      </div>
      {agents.map((x) => (
        <SubagentCard key={x.id} tool={x} allTools={turn.tools} />
      ))}
      {others.length > 0 && <ToolGroup tools={others} allTools={turn.tools} />}
    </div>
  );
}

export default function MessageList() {
  const t = useT();
  const turns = useChatStore((s) => s.turns);
  const detached = useChatStore((s) => s.detached);
  const connection = useChatStore((s) => s.connection);
  const { ref, onScroll, showJump, jump, paging, loadOlder } = useHistoryScroll(useChatStore);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={ref} onScroll={onScroll} className="scrollbar-stable h-full overflow-y-auto" data-testid="message-scroll">
        <div className="mx-auto max-w-3xl px-4 sm:px-5 py-6 space-y-6">
          <HistoryEdge paging={paging} empty={turns.length === 0} onRetry={loadOlder} />
          {turns.length === 0 && (
            <div className="grid place-items-center pt-24 text-center">
              <div className="grid place-items-center w-12 h-12 rounded-xl bg-surface-2 border border-border mb-3">
                <Icon name="chat" size={22} className="text-content-faint" />
              </div>
              <p className="text-sm text-content-dim">
                {connection === "open" ? t("chat.emptyStart") : t("common.loading")}
              </p>
            </div>
          )}
          {turns.map((x) => (
            <MessageItem key={x.key} turn={x} />
          ))}
          {detached && <Detached turn={detached} />}
        </div>
      </div>
      {connection === "reconnecting" && (
        <div className="absolute left-1/2 top-3 -translate-x-1/2 inline-flex items-center gap-2 rounded-full border border-warning/30 bg-surface-2 px-3 py-1 text-[11.5px] text-warning shadow-float">
          <Icon name="spinner" size={12} spin /> {t("chat.reconnecting")}
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-2 px-3">
        <SubagentPill />
        {showJump && (
          <button
            onClick={jump}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1.5 touch:h-10 touch:px-4 text-[12px] text-content-dim shadow-float hover:text-content transition animate-fade-in"
          >
            <Icon name="arrow-up" size={13} className="rotate-180" /> {t("chat.latest")}
          </button>
        )}
      </div>
      <SubagentLayer />
    </div>
  );
}
