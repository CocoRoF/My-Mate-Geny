import type { ToolActivity } from "../../../stores/chatStore";
import Markdown from "../../ui/Markdown";
import DiffView from "./DiffView";
import TodoCard, { todosOf } from "./TodoCard";
import { relPath } from "./toolMeta";
import { tr, useT } from "../../../i18n";

const Pre = ({ children, tone = "" }: { children: string; tone?: string }) => (
  <pre
    className={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg/70 p-2.5 font-mono text-[11.5px] leading-relaxed ${
      tone || "text-content-dim"
    }`}
  >
    {children}
  </pre>
);

const clip = (s: string, n = 20000) => (s.length > n ? s.slice(0, n) + `\n… (${tr("turn.moreChars", { n: s.length - n })})` : s);

/** Rich, per-tool rendering of a call's input + result. */
export default function ToolDetail({ tool, root }: { tool: ToolActivity; root?: string | null }) {
  const t = useT();
  const name = tool.name.startsWith("mcp__remote__") ? tool.name.slice(13) : tool.name;
  const lower = name.toLowerCase();
  const i = (tool.input && typeof tool.input === "object" ? tool.input : {}) as Record<string, any>;
  const out = tool.output ?? "";
  const errTone = tool.isError ? "text-danger/90" : "";

  if (["bash", "shell", "remote_bash"].includes(lower)) {
    const cmd = typeof i.command === "string" ? i.command : JSON.stringify(i.command ?? tool.input);
    return (
      <div className="space-y-1.5">
        <Pre tone="text-content">{`$ ${cmd}`}</Pre>
        {i.description && <div className="text-[11px] text-content-faint">{String(i.description)}</div>}
        {out ? <Pre tone={errTone}>{clip(out)}</Pre> : tool.durationMs === undefined ? null : <div className="text-[11px] text-content-faint">({t("turn.noOutput")})</div>}
      </div>
    );
  }
  if (lower === "edit") {
    return (
      <div className="space-y-1.5">
        <DiffView path={relPath(i.file_path, root)} oldText={String(i.old_string ?? "")} newText={String(i.new_string ?? "")} />
        {tool.isError && <Pre tone={errTone}>{clip(out)}</Pre>}
      </div>
    );
  }
  if (lower === "multiedit" && Array.isArray(i.edits)) {
    return (
      <div className="space-y-1.5">
        {i.edits.map((e: any, k: number) => (
          <DiffView key={k} path={k === 0 ? relPath(i.file_path, root) : undefined} oldText={String(e.old_string ?? "")} newText={String(e.new_string ?? "")} />
        ))}
        {tool.isError && <Pre tone={errTone}>{clip(out)}</Pre>}
      </div>
    );
  }
  if (lower === "write" || lower === "remote_write") {
    return (
      <div className="space-y-1.5">
        <DiffView path={relPath(i.file_path || i.path, root)} oldText="" newText={String(i.content ?? "")} maxRows={200} />
        {tool.isError && <Pre tone={errTone}>{clip(out)}</Pre>}
      </div>
    );
  }
  if (lower === "apply_patch" && Array.isArray(i.changes)) {
    return (
      <div className="space-y-1">
        {i.changes.map((c: any, k: number) => (
          <div key={k} className="flex items-center gap-2 font-mono text-[11.5px]">
            <span className={c.kind === "delete" ? "text-danger" : c.kind === "add" ? "text-success" : "text-warning"}>
              {c.kind === "delete" ? t("turn.patchDelete") : c.kind === "add" ? t("turn.patchAdd") : c.kind && c.kind !== "update" ? c.kind : t("turn.patchUpdate")}
            </span>
            <span className="truncate text-content-dim">{relPath(c.path, root)}</span>
          </div>
        ))}
        {tool.isError && <Pre tone={errTone}>{clip(out)}</Pre>}
      </div>
    );
  }
  if (lower === "todowrite") return <TodoCard todos={todosOf(tool.input)} compact />;
  if (lower === "task" || lower === "agent") {
    return (
      <div className="space-y-2">
        <div className="text-[11.5px] text-content-faint">
          {i.subagent_type ? `${i.subagent_type} · ` : ""}
          {i.description}
        </div>
        {i.prompt && (
          <details>
            <summary className="cursor-pointer text-[11.5px] text-content-faint hover:text-content-dim">{t("turn.prompt")}</summary>
            <Pre>{clip(String(i.prompt), 8000)}</Pre>
          </details>
        )}
        {out && (
          <div className="rounded-lg border border-border bg-bg/50 p-3 text-[13px]">
            <Markdown>{clip(out, 30000)}</Markdown>
          </div>
        )}
      </div>
    );
  }
  if (["read", "remote_read"].includes(lower)) {
    return (
      <div className="space-y-1.5">
        <div className="font-mono text-[11px] text-content-faint">
          {relPath(i.file_path || i.path, root)}
          {i.offset ? ` · ${t("turn.fromLine", { n: String(i.offset) })}` : ""}
          {i.limit ? ` · ${t("turn.linesN", { count: Number(i.limit) || 0 })}` : ""}
        </div>
        {out && <Pre tone={errTone}>{clip(out, 12000)}</Pre>}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {tool.input !== undefined && <Pre>{clip(JSON.stringify(tool.input, null, 2), 8000)}</Pre>}
      {out && <Pre tone={errTone}>{clip(out)}</Pre>}
    </div>
  );
}
