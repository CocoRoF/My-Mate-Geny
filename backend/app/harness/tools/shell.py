"""Bash, and the background shells it can leave running (BashOutput, KillShell).

Each command runs in a fresh shell in its own process group, so a timeout or Stop ends everything it started. The
working directory carries over from one command to the next (``cd`` sticks); nothing else does. A background command
writes to a file, shows in the chat's task list, and the model hears when it ends — in the turn it's in, or the next.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import secrets
import shutil
import time
from typing import Any

from app.harness.runtime import Shell, kill_process, kill_shell
from app.harness.tools.base import Tool, ToolContext, ToolOutput, obj, truncate_middle

DEFAULT_TIMEOUT_MS = 120_000
MAX_TIMEOUT_MS = 600_000
MAX_OUTPUT = 30_000
_KEEP = 2_000_000  # bytes of output kept while a command runs (head + tail beyond that)


def _shell_argv(script: str) -> list[str]:
    bash = shutil.which("bash")
    if bash:
        return [bash, "-c", script]
    if os.name == "nt":
        return [shutil.which("powershell") or "powershell", "-NoProfile", "-NonInteractive", "-Command", script]
    return ["/bin/sh", "-c", script]


def _script(command: str, pwd_file: str) -> str:
    if not shutil.which("bash") and os.name == "nt":
        return command
    return (f"trap 'pwd -P > \"{pwd_file}\" 2>/dev/null' EXIT\n"
            "cd -- \"$HRH_CWD\" 2>/dev/null || true\n"
            f"{command}")


def _spawn_kwargs() -> dict[str, Any]:
    if os.name == "nt":
        from app.portability import subprocess_flags

        return subprocess_flags()
    return {"start_new_session": True}


async def _start(command: str, ctx: ToolContext, stdout: Any) -> tuple[asyncio.subprocess.Process, str]:
    rt = ctx.runtime
    pwd_file = os.path.join(rt.dir, f"pwd-{secrets.token_hex(4)}")
    cwd = rt.cwd if rt.cwd and os.path.isdir(rt.cwd) else ctx.cwd
    env = {**ctx.env, "HRH_CWD": cwd}
    proc = await asyncio.create_subprocess_exec(
        *_shell_argv(_script(command, pwd_file)), cwd=cwd, env=env, stdin=asyncio.subprocess.DEVNULL,
        stdout=stdout, stderr=asyncio.subprocess.STDOUT, **_spawn_kwargs())
    return proc, pwd_file


def _take_cwd(ctx: ToolContext, pwd_file: str) -> None:
    with contextlib.suppress(OSError):
        with open(pwd_file, encoding="utf-8", errors="replace") as fh:
            p = fh.read().strip()
        os.unlink(pwd_file)
        if p and os.path.isdir(p):
            ctx.runtime.cwd = p


class Bash(Tool):
    name = "Bash"
    description = (
        "Run a shell command (bash) and return its output (stdout and stderr together). The working directory carries "
        "over between commands; shell variables and other state do not. Quote paths with spaces. Prefer the dedicated "
        "tools for files and search (Read, Edit, Write, Glob, Grep) over cat/sed/find/grep. Commands time out after "
        "2 minutes unless `timeout` (ms, at most 600000) says otherwise; output beyond 30000 characters is cut in the "
        "middle. For long-running work (servers, builds, watchers) set `run_in_background`: you get an id at once, "
        "read its output later with BashOutput, stop it with KillShell, and you are told when it finishes — don't "
        "wait for it with sleep loops. Give a short `description` of what the command does."
    )
    schema = obj({
        "command": {"type": "string", "description": "The command to run"},
        "description": {"type": "string", "description": "What it does, in 5-10 words"},
        "timeout": {"type": "number", "description": "Timeout in milliseconds (max 600000)"},
        "run_in_background": {"type": "boolean", "description": "Run it in the background and return at once"},
    }, ["command"])

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        command = str(args.get("command") or "").strip()
        if not command:
            return ToolOutput.error("No command given.")
        if args.get("run_in_background"):
            return await self._background(command, str(args.get("description") or ""), ctx)
        try:
            timeout_ms = min(float(args.get("timeout") or DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
        except (TypeError, ValueError):
            timeout_ms = DEFAULT_TIMEOUT_MS
        proc, pwd_file = await _start(command, ctx, asyncio.subprocess.PIPE)
        head = bytearray()
        tail = bytearray()
        dropped = 0
        timed_out = False

        async def pump() -> None:
            nonlocal dropped
            assert proc.stdout is not None
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                if len(head) < _KEEP // 2:
                    take = _KEEP // 2 - len(head)
                    head.extend(chunk[:take])
                    chunk = chunk[take:]
                if chunk:
                    tail.extend(chunk)
                    if len(tail) > _KEEP // 2:
                        dropped += len(tail) - _KEEP // 2
                        del tail[: len(tail) - _KEEP // 2]

        try:
            try:
                await asyncio.wait_for(pump(), timeout_ms / 1000)
            except TimeoutError:
                timed_out = True
                kill_process(proc)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(proc.wait(), 10)
        finally:
            if proc.returncode is None:  # (stopped: everything it started goes too)
                kill_process(proc)
            _take_cwd(ctx, pwd_file)
        text = head.decode("utf-8", errors="replace")
        if dropped:
            text += f"\n\n... [{dropped} bytes of output dropped] ...\n\n"
        text += tail.decode("utf-8", errors="replace")
        text = truncate_middle(text.rstrip("\n"), MAX_OUTPUT)
        rc = proc.returncode
        if timed_out:
            return ToolOutput(f"{text}\n\nCommand timed out after {timeout_ms / 1000:.0f}s".strip(), is_error=True)
        if rc:
            return ToolOutput(f"{text}\n\nExit code {rc}".strip(), is_error=True)
        return ToolOutput(text)

    async def _background(self, command: str, description: str, ctx: ToolContext) -> ToolOutput:
        rt = ctx.runtime
        sid = f"bash_{secrets.token_hex(3)}"
        out_path = os.path.join(rt.dir, f"{sid}.out")
        fh = open(out_path, "wb")  # noqa: SIM115 - the child writes to it
        try:
            proc, pwd_file = await _start(command, ctx, fh)
        finally:
            fh.close()
        shell = Shell(sid, command, description or command[:80], proc, out_path, time.time(), tool_use_id=ctx.tool_use_id)
        rt.shells[sid] = shell
        ctx.emit(task_event(shell))

        async def wait() -> None:
            rc = await proc.wait()
            with contextlib.suppress(OSError):
                os.unlink(pwd_file)
            if shell.exit_code is None:
                shell.exit_code = rc
            shell.ended_at = shell.ended_at or time.time()
            rt.emit(task_event(shell))
            if not shell.killed:
                rt.notify(f"<task-notification>Background command {sid} ({shell.description}) finished with exit code "
                          f"{rc}. Read its output with BashOutput (bash_id: {sid}).</task-notification>")

        shell.waiter = asyncio.create_task(wait())
        return ToolOutput(f"Command running in background with ID: {sid}. Read its output with BashOutput "
                          f"(bash_id: {sid}); you will be told when it finishes.")


def task_event(shell: Shell) -> Any:
    from app.providers.base import ProviderEvent

    data: dict[str, Any] = {
        "task_id": shell.id, "tool_use_id": shell.tool_use_id, "status": shell.status(), "started_at": shell.started_at,
        "description": shell.description, "task_type": "local_bash", "is_backgrounded": True,
        "output_file": shell.output_path,
    }
    if shell.ended_at:
        data["ended_at"] = shell.ended_at
    if shell.exit_code is not None:
        data["summary"] = f"Exit {shell.exit_code}"
    return ProviderEvent(type="task.update", data=data)


class BashOutput(Tool):
    name = "BashOutput"
    description = ("Read what a background command (Bash with run_in_background) printed since you last looked, and "
                   "whether it is still running. `filter` keeps only the lines that match a regular expression.")
    schema = obj({
        "bash_id": {"type": "string", "description": "The id Bash returned"},
        "filter": {"type": "string", "description": "Only lines matching this regular expression"},
    }, ["bash_id"])
    read_only = True
    parallel = True

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        shell = ctx.runtime.shells.get(str(args.get("bash_id") or "").strip())
        if shell is None:
            known = ", ".join(ctx.runtime.shells) or "none"
            return ToolOutput.error(f"No background command with that id (known: {known}).")
        new = shell.read_new()
        pat = args.get("filter")
        if pat:
            try:
                rx = re.compile(pat)
            except re.error as exc:
                return ToolOutput.error(f"Invalid filter: {exc}")
            new = "\n".join(line for line in new.splitlines() if rx.search(line))
        state = shell.status() + (f" (exit code {shell.exit_code})" if shell.exit_code is not None else "")
        body = truncate_middle(new.rstrip("\n"), MAX_OUTPUT) or "(no new output)"
        return ToolOutput(f"<status>{state}</status>\n<output>\n{body}\n</output>")


class KillShell(Tool):
    name = "KillShell"
    description = "Stop a background command started with Bash run_in_background (and everything it started)."
    schema = obj({"shell_id": {"type": "string", "description": "The id Bash returned"}}, ["shell_id"])

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        shell = ctx.runtime.shells.get(str(args.get("shell_id") or "").strip())
        if shell is None:
            return ToolOutput.error("No background command with that id.")
        if not shell.running:
            return ToolOutput(f"{shell.id} already ended ({shell.status()}).")
        await kill_shell(shell)
        ctx.emit(task_event(shell))
        return ToolOutput(f"Stopped {shell.id}.")
