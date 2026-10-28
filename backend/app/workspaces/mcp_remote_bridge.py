#!/usr/bin/env python3
"""Remote-bash MCP bridge (scaffold).

A minimal stdio MCP server that exposes a single ``remote_bash`` tool. When
attached to a provider CLI via ``--mcp-config``, the agent's shell commands are
executed on the remote SSH host (2222 / 2224) instead of the 2223 runtime — so
"operate the remote server" works even though the agent process lives on 2223.

Protocol: JSON-RPC 2.0 over stdio (MCP spec) — handles ``initialize``,
``tools/list``, ``tools/call``. This is a focused reimplementation of the
~130-line reference bridge shipped by Geny.

Runs as its own process (spawned by the provider CLI), configured via env:
  HRH_SSH_HOST, HRH_SSH_PORT, HRH_SSH_USER, HRH_SSH_CWD, HRH_SSH_KEY_FILE

STATUS: scaffold. The SSH exec path uses the system ``ssh`` binary for
simplicity; a follow-up can switch to asyncssh with pinned known_hosts.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

TOOL = {
    "name": "remote_bash",
    "description": "Run a shell command on the remote SSH host and return stdout/stderr.",
    "inputSchema": {
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"],
    },
}


def _ssh_argv() -> list[str]:
    host = os.environ.get("HRH_SSH_HOST", "")
    port = os.environ.get("HRH_SSH_PORT", "22")
    user = os.environ.get("HRH_SSH_USER", "")
    key_file = os.environ.get("HRH_SSH_KEY_FILE", "")
    argv = ["ssh", "-p", port, "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes"]
    if key_file:
        argv += ["-i", key_file]
    argv.append(f"{user}@{host}")
    return argv


def _run_remote(command: str) -> dict:
    cwd = os.environ.get("HRH_SSH_CWD", ".")
    wrapped = f"cd {json.dumps(cwd)} 2>/dev/null; {command}"
    try:
        proc = subprocess.run(
            [*_ssh_argv(), wrapped],
            capture_output=True,
            text=True,
            timeout=300,
        )
        out = proc.stdout + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
        return {"content": [{"type": "text", "text": out or "(no output)"}], "isError": proc.returncode != 0}
    except Exception as exc:  # noqa: BLE001
        return {"content": [{"type": "text", "text": f"remote exec failed: {exc}"}], "isError": True}


def _reply(msg_id, result=None, error=None) -> None:
    resp = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        resp["error"] = error
    else:
        resp["result"] = result
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
        method = req.get("method")
        msg_id = req.get("id")

        if method == "initialize":
            _reply(
                msg_id,
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "hrh-remote-bash", "version": "0.1.0"},
                },
            )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            _reply(msg_id, {"tools": [TOOL]})
        elif method == "tools/call":
            params = req.get("params", {})
            if params.get("name") == "remote_bash":
                cmd = params.get("arguments", {}).get("command", "")
                _reply(msg_id, _run_remote(cmd))
            else:
                _reply(msg_id, error={"code": -32601, "message": "unknown tool"})
        elif msg_id is not None:
            _reply(msg_id, error={"code": -32601, "message": f"unknown method: {method}"})


if __name__ == "__main__":
    main()
