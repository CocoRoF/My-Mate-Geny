import Icon from "../../ui/Icon";
import { useT } from "../../../i18n";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  activeForm?: string;
}

export function todosOf(input: unknown): Todo[] {
  const t = (input as any)?.todos;
  return Array.isArray(t) ? t.filter((x) => x && typeof x.content === "string") : [];
}

/** Claude-Code-style task checklist (TodoWrite / Codex todo_list). */
export default function TodoCard({ todos, compact = false }: { todos: Todo[]; compact?: boolean }) {
  const tt = useT();
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className={compact ? "" : "rounded-xl border border-border bg-surface/60 px-3 py-2.5"}>
      {!compact && (
        <div className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-content-dim">
          <Icon name="check" size={13} className="text-accent" /> {tt("turn.toolTasks")}
          <span className="font-mono text-[11px] text-content-faint">
            {done}/{todos.length}
          </span>
          <span className="ml-1 h-1 flex-1 max-w-[120px] rounded-full bg-surface-3 overflow-hidden">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${(done / todos.length) * 100}%` }} />
          </span>
        </div>
      )}
      <ul className="space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px] leading-snug">
            <span className="mt-[3px] shrink-0">
              {t.status === "completed" ? (
                <span className="grid place-items-center w-3.5 h-3.5 rounded-[4px] bg-success/80 text-bg">
                  <Icon name="check" size={10} />
                </span>
              ) : t.status === "in_progress" ? (
                <span className="block w-3.5 h-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              ) : (
                <span className="block w-3.5 h-3.5 rounded-[4px] border border-border-strong" />
              )}
            </span>
            <span
              className={
                t.status === "completed"
                  ? "text-content-faint line-through"
                  : t.status === "in_progress"
                    ? "font-medium text-content"
                    : "text-content-dim"
              }
            >
              {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
