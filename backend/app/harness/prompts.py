"""What the model is told before the conversation: how to work, where it is, and the project's own instructions.

The system prompt is built once per turn from things that rarely change (no clock time, no git status), so the
vendors' prompt caches keep hitting. The project's instruction files are read the way the CLIs read them: ``CLAUDE.md``
(Claude Code) and ``AGENTS.md`` (Codex) from the working directory up to the repository root, plus the user's own
``~/.claude/CLAUDE.md``. A remote workspace's guide reaches the model the same way (the scratch folder's CLAUDE.md /
AGENTS.md, ``workspaces/remote_ssh.py``).
"""

from __future__ import annotations

import os
import platform
from datetime import date
from typing import Any

from app.harness.vendors import VENDORS

MAX_MEMORY_CHARS = 40_000

CORE = """\
You are an autonomous agent working inside My Mate Geny, an app where the user works with AI agents on their own \
computers and servers. You run on {model} through the {vendor} API. You help with software engineering and any other \
task the user brings, using the tools you have: run commands, read and change files, search code and the web, keep a \
to-do list, hand self-contained work to subagents, and use the MCP tools this chat is connected to.

# How to work
- Understand the request and the code before changing anything: search (Grep, Glob) and read (Read) first; follow the \
project's existing conventions, libraries and style; never assume a library is available — check.
- Do what was asked, completely and carefully; don't add unrequested features, files or documentation. Prefer editing \
existing files to creating new ones.
- Verify your work the way the project does (its tests, type checks, build, linters) when you can, and say plainly \
what you verified and what you could not.
- For work with several steps, keep a to-do list (TodoWrite) and update it as you go.
- Independent tool calls go in the same answer — they run at the same time (e.g. several Reads or Greps at once). Use \
Task for broad searches or independent pieces of work that would fill this conversation.
- Use the dedicated tools for files (Read, Write, Edit) and search (Grep, Glob) rather than cat, sed, echo or find in \
Bash. Paths you pass to tools are absolute.
- Never commit, push or deploy unless asked; never discard the user's changes (git reset --hard, rm -rf, force \
pushes) without being asked. Don't print or log secrets.
- If something blocks you, try another approach; ask the user only when you really can't decide or proceed.

# How to answer
- Be concise and direct; write in the user's language. Use GitHub-flavored Markdown. No preamble or filler, and don't \
restate what a tool call already shows.
- Refer to code as `path:line` so the user can open it.
- When you finish, say what you did and what is left, briefly.
"""

WAIT = """\
# Waiting on long work
Start long-running work with Bash run_in_background (or a background Task) and end your turn, or do other useful work \
meanwhile: you are told when it finishes, even after your turn has ended. Don't wait with sleep commands or repeated \
status checks — every check is a full model call that re-reads the whole conversation. SSH remote_bash jobs are \
different: they have their own job ids; when a final result is needed, wait on the same id with \
remote_poll(wait_ms=30000) rather than starting it again.
"""

PLAN = """\
# Plan mode
You are in plan mode: change nothing. Don't edit files or run commands; investigate with the read-only tools, then \
reply with a concrete, step-by-step plan for the request and wait for the user's approval.
"""

SUBAGENT = """\
You are a subagent of an agent working inside My Mate Geny, running on {model} through the {vendor} API. You were \
given one task; you have the same tools as the agent that started you (except starting subagents) and none of its \
conversation. Work on the task on your own until it is done, then reply with one final report: what you found or did, \
with the specifics (paths as `path:line`, commands, results) the agent needs to continue. Your report goes to that \
agent, not to the user. Change files only if the task asks for it.
"""

COMPACT = """\
The conversation so far is about to be replaced by a summary, so that the work can go on in a fresh context. Write \
that summary now: it is all that will remain. Be thorough about everything needed to continue without asking again:

1. The user's requests and intent, in their own words where it matters, including every correction or preference \
they gave.
2. Key technical facts: the project, files and functions involved (with paths), decisions made and why.
3. What was done: changes made (files, what changed), commands run and their outcomes, errors hit and how they were \
fixed.
4. The current state: what works, what was verified, what is still broken or unverified.
5. What is left to do, and the immediate next step — exactly where the work stood.

Reply with the summary only (no tool calls).
"""


def environment(cwd: str, extra_dirs: list[str], model: str) -> str:
    lines = [
        "# Environment",
        f"- Working directory: {cwd}",
    ]
    if extra_dirs:
        lines.append("- Additional folders: " + ", ".join(extra_dirs))
    lines += [
        f"- Git repository: {'yes' if _git_root(cwd) else 'no'}",
        f"- Platform: {platform.system().lower()} ({platform.release()})",
        f"- Shell: {'bash' if os.name != 'nt' else 'bash (Git Bash) or PowerShell'}",
        f"- Today's date: {date.today().isoformat()}",
        f"- Model: {model}",
    ]
    return "\n".join(lines)


def _git_root(cwd: str) -> str | None:
    d = os.path.abspath(cwd)
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def memory_files(cwd: str) -> list[tuple[str, str]]:
    """(path, text) of the instruction files that apply here, the most general first."""
    found: list[str] = []
    user = os.path.expanduser("~/.claude/CLAUDE.md")
    if os.path.isfile(user):
        found.append(user)
    root = _git_root(cwd)
    chain = []
    d = os.path.abspath(cwd)
    home = os.path.expanduser("~")
    while True:
        chain.append(d)
        parent = os.path.dirname(d)
        if d == root or parent == d or d == home:
            break
        d = parent
    for d in reversed(chain):
        for name in ("CLAUDE.md", os.path.join(".claude", "CLAUDE.md"), "CLAUDE.local.md", "AGENTS.md"):
            p = os.path.join(d, name)
            if os.path.isfile(p) and p not in found:
                found.append(p)
    out: list[tuple[str, str]] = []
    total = 0
    for p in found:
        try:
            with open(p, encoding="utf-8", errors="replace") as fh:
                text = fh.read(MAX_MEMORY_CHARS)
        except OSError:
            continue
        total += len(text)
        if total > MAX_MEMORY_CHARS * 2:
            break
        out.append((p, text.strip()))
    return out


def system_prompt(*, provider: str, model: str, cwd: str, extra_dirs: list[str], mode: str, folders_note: str,
                  system_append: str, skills: dict[str, dict[str, str]], subagent: bool = False) -> str:
    vendor = VENDORS[provider].label
    parts = [(SUBAGENT if subagent else CORE).format(model=model, vendor=vendor)]
    if not subagent:
        parts.append(WAIT)
    if mode == "plan":
        parts.append(PLAN)
    parts.append(environment(cwd, extra_dirs, model))
    if folders_note:
        parts.append(folders_note)
    if skills:
        parts.append("# Skills\nOpen one with the Skill tool when the task matches it:\n" + "\n".join(
            f"- {s['name']}: {s['description']}" for s in skills.values()))
    mem = memory_files(cwd)
    if mem:
        parts.append("# Instructions from the user and the project\nFollow these; they override the defaults above.\n"
                     + "\n\n".join(f"<instructions path=\"{p}\">\n{t}\n</instructions>" for p, t in mem))
    if system_append:
        parts.append(system_append)
    return "\n\n".join(p.strip() for p in parts if p and p.strip())


def own_prompt(req: Any) -> str | None:
    """A chat that brings its own system prompt (a Mate, Avatar Create): that, instead of ours."""
    if req.system_prompt_file and os.path.isfile(req.system_prompt_file):
        with open(req.system_prompt_file, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    return req.system_prompt
