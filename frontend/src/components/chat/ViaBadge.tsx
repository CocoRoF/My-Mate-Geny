import type { MessageMeta } from "../../stores/chatStore";
import Icon from "../ui/Icon";

/** "via Estelle": a message a mate sent into this chat on the user's behalf. */
export default function ViaBadge({ meta }: { meta?: MessageMeta | null }) {
  const via = meta?.via;
  if (!via || via.kind !== "mate") return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-violet/30 bg-violet/10 px-2 py-0.5 text-[10.5px] font-medium text-violet"
      title={`Sent by your mate ${via.name || ""}`.trim()}
      data-testid="via-badge"
    >
      <Icon name="sparkles" size={10} /> via {via.name || "mate"}
    </span>
  );
}
