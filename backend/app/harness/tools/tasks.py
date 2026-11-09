"""TodoWrite, Task (subagents) and Skill.

TodoWrite keeps the to-do list the chat shows (TodoCard, the side panel). Task hands a self-contained piece of work to
a subagent with its own context — in the foreground, or in the background with a place in the task list. Skill opens
an installed skill (a SKILL.md with instructions and files) for the model to follow.
"""

from __future__ import annotations

import os
import re
from typing import Any

from app.harness.tools.base import Tool, ToolContext, ToolOutput, obj

_STATUSES = ("pending", "in_progress", "completed")


class TodoWrite(Tool):
    name = "TodoWrite"
    description = (
        "Keep a to-do list for the current work, shown to the user. Use it for tasks of three or more steps: write the "
        "whole list each time, with exactly one item in_progress while you work, and mark items completed as soon as "
        "they are done (not in batches). Each item: `content` (imperative, \"Run the tests\"), `activeForm` (\"Running "
        "the tests\") and `status` (pending, in_progress, completed). Skip it for a single quick task."
    )
    schema = obj({"todos": {"type": "array", "items": obj({
        "content": {"type": "string"},
        "activeForm": {"type": "string"},
        "status": {"type": "string", "enum": list(_STATUSES)},
    }, ["content", "status"])}}, ["todos"])
    read_only = True

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        todos = args.get("todos")
        if not isinstance(todos, list):
            return ToolOutput.error("todos must be a list.")
        clean = []
        for t in todos:
            if not isinstance(t, dict) or not str(t.get("content") or "").strip():
                return ToolOutput.error("Every item needs content.")
            status = t.get("status") if t.get("status") in _STATUSES else "pending"
            clean.append({"content": str(t["content"]), "activeForm": str(t.get("activeForm") or t["content"]),
                          "status": status})
        ctx.runtime.todos = clean
        return ToolOutput("Todos have been modified successfully. Keep using the list to track your progress, and "
                          "carry on with the current task.")


class Task(Tool):
    name = "Task"
    description = (
        "Hand a self-contained task to a subagent: it works on its own, with the same tools (but no Task), its own "
        "context and none of this conversation, and returns one final report. Good for broad searches across a "
        "codebase, research, or independent pieces of work you'd otherwise do one after another — several Task calls "
        "in one answer run at the same time. The `prompt` must say everything the subagent needs to know and what to "
        "report back. `run_in_background` returns at once; you are told when it finishes. Its report isn't shown to "
        "the user: tell them what matters."
    )
    schema = obj({
        "description": {"type": "string", "description": "The task, in 3-5 words"},
        "prompt": {"type": "string", "description": "Everything the subagent needs, and what to report"},
        "subagent_type": {"type": "string", "description": "What kind of agent (default general-purpose)"},
        "run_in_background": {"type": "boolean", "description": "Return at once and get told when it is done"},
    }, ["description", "prompt"])
    parallel = True

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        if ctx.parent is not None or ctx.run_agent is None:
            return ToolOutput.error("A subagent can't start subagents of its own.")
        prompt = str(args.get("prompt") or "").strip()
        if not prompt:
            return ToolOutput.error("The subagent needs a prompt.")
        return await ctx.run_agent(
            description=str(args.get("description") or "Task")[:120], prompt=prompt,
            subagent_type=str(args.get("subagent_type") or "general-purpose"),
            background=bool(args.get("run_in_background")), tool_use_id=ctx.tool_use_id)


# ---- skills ----

_FRONT = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def _frontmatter(text: str) -> dict[str, str]:
    m = _FRONT.match(text)
    out: dict[str, str] = {}
    if m:
        for line in m.group(1).splitlines():
            k, _, v = line.partition(":")
            if k.strip() and v.strip():
                out[k.strip()] = v.strip().strip("\"'")
    return out


def find_skills(plugin_dirs: list[str], cwd: str) -> dict[str, dict[str, str]]:
    """Installed skills: a session's plugins (e.g. Higgsfield), the project's and the user's ``.claude/skills``."""
    roots = [os.path.join(d, "skills") for d in plugin_dirs]
    roots += [os.path.join(cwd, ".claude", "skills"), os.path.expanduser("~/.claude/skills")]
    found: dict[str, dict[str, str]] = {}
    for root in roots:
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            path = os.path.join(root, name, "SKILL.md")
            if not os.path.isfile(path):
                continue
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    head = fh.read(4000)
            except OSError:
                continue
            meta = _frontmatter(head)
            key = meta.get("name") or name
            found.setdefault(key, {"name": key, "description": meta.get("description", ""), "path": path})
    return found


class Skill(Tool):
    name = "Skill"
    description = ("Open an installed skill by name and follow its instructions. The skills available are listed in "
                   "the system prompt; use one when the task matches its description.")
    schema = obj({"skill": {"type": "string", "description": "The skill's name"}}, ["skill"])
    read_only = True

    def __init__(self, skills: dict[str, dict[str, str]]) -> None:
        self.skills = skills

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        name = str(args.get("skill") or "").strip()
        skill = self.skills.get(name)
        if skill is None:
            return ToolOutput.error(f"No skill named {name!r}. Available: {', '.join(self.skills) or 'none'}.")
        try:
            with open(skill["path"], encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError as exc:
            return ToolOutput.error(f"Could not open the skill: {exc}")
        base = os.path.dirname(skill["path"])
        return ToolOutput(f"Base directory for this skill: {base}\n\n{_FRONT.sub('', text, count=1)}")
