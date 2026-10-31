import type { ToolActivity, Turn } from "../../../stores/chatStore";
import { isRunning } from "../../../stores/taskStore";
import type { TaskInfo } from "../../../types";
import { toolMeta } from "./toolMeta";

// What a subagent (Agent / Task tool call) is up to, derived from its call,
// the steps it streamed and — for background ones — the engine's task state.

export type AgentStatus = "running" | "done" | "failed" | "stopped";

export const isAgentTool = (t: ToolActivity) => ["task", "agent"].includes(t.name.toLowerCase());

const STOPPED = /doesn't want to proceed|tool use was rejected|interrupted to apply/i;

/** The live task for a call: the engine's latest word (task store) over what the turn recorded. */
export function taskFor(tool: ToolActivity, tasks?: TaskInfo[]): TaskInfo | undefined {
  const live = tasks?.find((t) => (tool.task && t.task_id === tool.task.task_id) || t.tool_use_id === tool.id);
  return live ? { ...(tool.task || {}), ...live } : tool.task;
}

export const isBackground = (tool: ToolActivity, task?: TaskInfo) =>
  !!((tool.input as any)?.run_in_background || task?.is_backgrounded || tool.agent?.is_async);

export function agentStatus(tool: ToolActivity, task?: TaskInfo): AgentStatus {
  if (isBackground(tool, task)) {
    // The call itself returns at once ("launched"); the task says how it went.
    if (tool.isError) return STOPPED.test(tool.output || "") ? "stopped" : "failed";
    if (!task) return tool.durationMs === undefined ? "running" : "done";
    if (isRunning(task)) return "running";
    if (task.status === "completed") return "done";
    if (task.status === "failed") return "failed";
    return "stopped"; // stopped | killed | lost
  }
  if (tool.durationMs === undefined) return "running";
  if (tool.isError) return STOPPED.test(tool.output || "") ? "stopped" : "failed";
  return "done";
}

/** The final report without the hand-back framing the CLI wraps it in for the model. */
export function cleanReport(output: string): string {
  let body = output;
  const m = body.match(/The report follows:\n([\s\S]*)$/);
  if (m) body = m[1];
  body = body.replace(/\n+agentId: [^\n]*(\n<usage>[\s\S]*?<\/usage>)?\s*$/, "");
  const lines = body.split("\n");
  if (m && lines.every((l) => !l.trim() || l.startsWith("  "))) body = lines.map((l) => l.slice(2)).join("\n");
  return body.trim();
}

/** First line of some markdown, as plain text (for one-line summaries). */
const firstLine = (s: string) =>
  (s.split("\n").find((l) => l.trim()) || "")
    .replace(/^\s*(#+|[-*>]|\d+\.)\s+/, "")
    .replace(/`+|\*\*/g, "")
    .trim();

export interface AgentView {
  tool: ToolActivity;
  task?: TaskInfo;
  status: AgentStatus;
  background: boolean;
  title: string;
  type: string;
  prompt: string;
  startedAt: number;
  elapsedMs: number;
  toolCount: number;
  children: ToolActivity[]; // its own calls, settled once it stopped
  activity: string; // one line: what it is doing / how it ended
  result: string; // final report ("" until there is one)
}

export function agentView(tool: ToolActivity, allTools: ToolActivity[], task: TaskInfo | undefined, now: number): AgentView {
  const i = (tool.input || {}) as Record<string, any>;
  const status = agentStatus(tool, task);
  const background = isBackground(tool, task);
  const running = status === "running";

  // Timing: a background subagent runs on after its (instant) call returned.
  let startedAt = tool.startedAt;
  let end = running ? now : tool.startedAt + (tool.durationMs || 0);
  if (background) {
    if (task?.started_at) startedAt = Math.min(startedAt, task.started_at * 1000);
    end = running ? now : task?.ended_at ? task.ended_at * 1000 : Math.max(end, tool.lastAt || 0);
  }

  const kids = allTools.filter((t) => t.parent === tool.id);
  // Calls still open when the subagent stopped won't report any more.
  const children = running
    ? kids
    : kids.map((c) => (c.durationMs === undefined ? { ...c, durationMs: Math.max(0, end - c.startedAt) } : c));

  const sub = tool.sub || [];
  const texts = sub.filter((s) => s.kind === "text") as Array<{ kind: "text"; text: string }>;
  let result = tool.agent?.result || "";
  if (!result && !running) {
    if (background) result = texts[texts.length - 1]?.text || task?.summary || "";
    else if (status === "done" && tool.output) result = cleanReport(tool.output);
  }

  let activity = "";
  if (running) {
    const last = sub[sub.length - 1];
    if (last?.kind === "tool") {
      // a call still running (parallel calls finish out of order) says the most
      const open = [...kids].reverse().find((k) => k.durationMs === undefined);
      const c = open || kids.find((k) => k.id === last.toolId);
      if (c) {
        const m = toolMeta(c.name, c.input);
        activity = c.durationMs === undefined ? m.running : [m.label, m.target].filter(Boolean).join(" · ");
      }
    } else if (last?.kind === "text") activity = firstLine(last.text);
    else if (last?.kind === "thinking") activity = "Thinking…";
    activity = activity || task?.activity || "Starting…";
  } else if (status === "failed" || status === "stopped") {
    activity = firstLine(tool.isError ? tool.output || "" : "") || (status === "stopped" ? "Stopped" : "Failed");
  } else {
    activity = firstLine(result) || "Done";
  }

  return {
    tool,
    task,
    status,
    background,
    title: String(i.description || task?.description || i.subagent_type || "Subagent"),
    type: String(i.subagent_type || task?.subagent_type || tool.agent?.agent_type || ""),
    prompt: String(i.prompt || ""),
    startedAt,
    elapsedMs: Math.max(0, end - startedAt),
    toolCount: Math.max(kids.length, task?.tool_uses || 0, tool.agent?.tool_uses || 0),
    children,
    activity,
    result,
  };
}

/** Every subagent call in the chat, latest first, with its turn. */
export function allAgents(turns: Turn[]): Array<{ tool: ToolActivity; turn: Turn }> {
  const out: Array<{ tool: ToolActivity; turn: Turn }> = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    for (let k = t.tools.length - 1; k >= 0; k--) if (isAgentTool(t.tools[k])) out.push({ tool: t.tools[k], turn: t });
  }
  return out;
}
