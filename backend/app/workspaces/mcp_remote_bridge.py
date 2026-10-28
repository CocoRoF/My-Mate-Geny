#!/usr/bin/env python3
"""Remote SSH MCP bridge.

A stdio MCP server exposing tools that operate on a remote SSH host (2222 /
2224). Attached to the agent CLI via ``--mcp-config``, it lets the agent run
on the 2223 runtime while reading/writing/executing on the remote host — no
sshfs/fuse required (which is brittle inside containers).

Tools (all resolve relative paths against ``HRH_SSH_CWD``):
  * remote_bash(command)        — run a shell command, return stdout+stderr
  * remote_read(path)           — read a file's contents
  * remote_write(path, content) — create/overwrite a file
  * remote_list(path=".")       — list a directory (ls -la)

Transport: the system ``ssh`` binary with a key file (``HRH_SSH_KEY_FILE``).
JSON-RPC 2.0 over stdio per the MCP spec.

Env: HRH_SSH_HOST, HRH_SSH_PORT, HRH_SSH_USER, HRH_SSH_CWD, HRH_SSH_KEY_FILE
"""

from __future__ import annotations

import base64
import json
import os
import shlex
import subprocess
import sys

CWD = os.environ.get("HRH_SSH_CWD", ".")

TOOLS = [
    {
        "name": "remote_bash",
        "description": f"Run a shell command on the remote host (cwd {CWD}). Returns stdout/stderr.",
        "inputSchema": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    },
    {
        "name": "remote_read",
        "description": "Read a file on the remote host (path relative to the workspace).",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "remote_write",
        "description": "Create or overwrite a file on the remote host with the given content.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    {
        "name": "remote_list",
        "description": "List a directory on the remote host (ls -la).",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
        },
    },
]


def _ssh_prefix() -> list[str]:
    argv = [
        "ssh",
        "-p",
        os.environ.get("HRH_SSH_PORT", "22"),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
    ]
    key = os.environ.get("HRH_SSH_KEY_FILE", "")
    if key:
        argv += ["-i", key]
    argv.append(f"{os.environ.get('HRH_SSH_USER', '')}@{os.environ.get('HRH_SSH_HOST', '')}")
    return argv


def _run(remote_cmd: str, timeout: int = 300) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            [*_ssh_prefix(), remote_cmd], capture_output=True, text=True, timeout=timeout
        )
        out = proc.stdout + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
        return proc.returncode, out
    except Exception as exc:  # noqa: BLE001
        return 1, f"remote exec failed: {exc}"


def _in_cwd(cmd: str) -> str:
    return f"cd {shlex.quote(CWD)} 2>/dev/null; {cmd}"


def _resolve(path: str) -> str:
    return path if path.startswith("/") else f"{CWD.rstrip('/')}/{path}"


def _call(name: str, args: dict) -> dict:
    if name == "remote_bash":
        rc, out = _run(_in_cwd(args.get("command", "")))
        return {"content": [{"type": "text", "text": out or "(no output)"}], "isError": rc != 0}
    if name == "remote_read":
        rc, out = _run(f"cat {shlex.quote(_resolve(args.get('path', '')))}")
        return {"content": [{"type": "text", "text": out}], "isError": rc != 0}
    if name == "remote_write":
        # base64 the content so arbitrary bytes/quotes survive the shell.
        b64 = base64.b64encode(args.get("content", "").encode()).decode()
        target = shlex.quote(_resolve(args.get("path", "")))
        rc, out = _run(f"echo {b64} | base64 -d > {target} && echo WROTE {target}")
        return {"content": [{"type": "text", "text": out}], "isError": rc != 0}
    if name == "remote_list":
        rc, out = _run(f"ls -la {shlex.quote(_resolve(args.get('path', '.')))}")
        return {"content": [{"type": "text", "text": out}], "isError": rc != 0}
    return {"content": [{"type": "text", "text": f"unknown tool {name}"}], "isError": True}


def _reply(msg_id, result=None, error=None) -> None:
    resp = {"jsonrpc": "2.0", "id": msg_id}
    resp["error" if error is not None else "result"] = error if error is not None else result
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()


def main() -> None:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            continue
        method, msg_id = req.get("method"), req.get("id")
        if method == "initialize":
            _reply(
                msg_id,
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "hrh-remote", "version": "0.2.0"},
                },
            )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            _reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = req.get("params", {})
            _reply(msg_id, _call(params.get("name", ""), params.get("arguments", {})))
        elif msg_id is not None:
            _reply(msg_id, error={"code": -32601, "message": f"unknown method: {method}"})


if __name__ == "__main__":
    main()
