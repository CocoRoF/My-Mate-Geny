#!/usr/bin/env python3
"""Remote SSH MCP bridge — the agent's hands on the chat's SSH hosts.

A stdio MCP server (attached to the agent CLI as the ``remote`` server) whose tools operate on
the remote hosts of a chat: its workspace's host and/or the hosts of folders attached from other
servers. The agent runs on the app's server; every call goes over the system ``ssh`` with the
connection's key — no sshfs/fuse (brittle inside containers).

Tools (``host`` picks the server — its name as listed, default = the workspace's host):
  * remote_bash(command, host?, cwd?)   — run a shell command (cwd: an attached folder)
  * remote_read(path, host?)            — read a file
  * remote_write(path, content, host?)  — create/overwrite a file
  * remote_list(path?, host?)           — list a directory (ls -la)

Allow-list: only the hosts given to this bridge, and on each host only paths inside its roots
(the folders the user attached there + the workspace + the chat's uploads), checked on the host
after resolving symlinks (``realpath -m``). ``remote_bash`` starts inside a root; what a shell
command then does is up to the command, as with the agent's own Bash tool.

Config: ``HRH_REMOTE_HOSTS`` = JSON list of
``{"name", "aliases": [..], "host", "port", "user", "key_file", "known_hosts", "cwd", "roots": [..], "default"}``.
Legacy (one host, no confinement): ``HRH_SSH_HOST/PORT/USER/CWD/KEY_FILE/KNOWN_HOSTS``.
JSON-RPC 2.0 over stdio per the MCP spec.
"""

from __future__ import annotations

import json
import os
import posixpath
import shlex
import subprocess
import sys


def _load_hosts() -> list[dict]:
    raw = os.environ.get("HRH_REMOTE_HOSTS", "")
    if raw:
        try:
            hosts = json.loads(raw)
            return [h for h in hosts if isinstance(h, dict) and h.get("host") and h.get("name")]
        except ValueError:
            return []
    if os.environ.get("HRH_SSH_HOST"):  # a launch from before multi-host folders
        cwd = os.environ.get("HRH_SSH_CWD", ".")
        return [{
            "name": "workspace", "aliases": [], "host": os.environ["HRH_SSH_HOST"],
            "port": os.environ.get("HRH_SSH_PORT", "22"), "user": os.environ.get("HRH_SSH_USER", ""),
            "key_file": os.environ.get("HRH_SSH_KEY_FILE", ""), "known_hosts": os.environ.get("HRH_SSH_KNOWN_HOSTS", ""),
            "cwd": cwd, "roots": ["/"], "default": True,
        }]
    return []


HOSTS = _load_hosts()
DEFAULT = next((h for h in HOSTS if h.get("default")), HOSTS[0] if len(HOSTS) == 1 else None)


def _hosts_line() -> str:
    parts = []
    for h in HOSTS:
        roots = ", ".join(h.get("roots") or [])
        parts.append(f'"{h["name"]}"{" (default)" if h is DEFAULT else ""}: {roots}')
    return "; ".join(parts)


_HOST_PROP = {
    "type": "string",
    "description": "Which server: " + ", ".join(f'"{h["name"]}"' for h in HOSTS)
    + (f' (default "{DEFAULT["name"]}")' if DEFAULT else " (required)"),
}
_REQ_HOST = [] if DEFAULT else ["host"]

TOOLS = [
    {
        "name": "remote_bash",
        "description": "Run a shell command on a remote server, starting in an attached folder there "
        f"(cwd; default: the host's main folder). Returns stdout/stderr. Hosts and folders: {_hosts_line()}",
        "inputSchema": {
            "type": "object",
            "properties": {"command": {"type": "string"}, "host": _HOST_PROP,
                           "cwd": {"type": "string", "description": "start directory (inside an attached folder)"}},
            "required": ["command", *_REQ_HOST],
        },
    },
    {
        "name": "remote_read",
        "description": "Read a file on a remote server (absolute, or relative to the host's main folder).",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "host": _HOST_PROP},
            "required": ["path", *_REQ_HOST],
        },
    },
    {
        "name": "remote_write",
        "description": "Create or overwrite a file on a remote server with the given content.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}, "host": _HOST_PROP},
            "required": ["path", "content", *_REQ_HOST],
        },
    },
    {
        "name": "remote_list",
        "description": "List a directory on a remote server (ls -la).",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "host": _HOST_PROP},
            "required": [*_REQ_HOST],
        },
    },
]


class ToolError(Exception):
    pass


def pick_host(name: str | None) -> dict:
    if not name:
        if DEFAULT is None:
            raise ToolError("say which server: host = " + " | ".join(h["name"] for h in HOSTS))
        return DEFAULT
    n = name.strip().lower()
    for h in HOSTS:
        if n == h["name"].lower() or n in [a.lower() for a in h.get("aliases") or []]:
            return h
    raise ToolError(f"unknown host {name!r} — this chat's servers: " + ", ".join(h["name"] for h in HOSTS))


def _ssh_prefix(h: dict) -> list[str]:
    argv = ["ssh", "-p", str(h.get("port") or 22), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
            "-o", "StrictHostKeyChecking=accept-new"]
    if h.get("known_hosts"):  # host key pinned on first use (see RemoteSshConnector)
        argv += ["-o", f"UserKnownHostsFile={h['known_hosts']}"]
    if h.get("key_file"):
        argv += ["-i", h["key_file"]]
    argv.append(f"{h.get('user', '')}@{h['host']}")
    return argv


def _run(h: dict, remote_cmd: str, timeout: int = 300, stdin: str | None = None) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            [*_ssh_prefix(h), remote_cmd], capture_output=True, text=True, timeout=timeout, input=stdin,
        )
        out = proc.stdout + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
        return proc.returncode, out
    except Exception as exc:  # noqa: BLE001
        return 1, f"remote exec failed: {exc}"


def q(path: str) -> str:
    """Shell-quote a remote path, keeping a leading ~ expandable."""
    if path == "~":
        return '"$HOME"'
    if path.startswith("~/"):
        return '"$HOME"/' + shlex.quote(path[2:])
    return shlex.quote(path)


def resolve(h: dict, path: str) -> str:
    """Absolute (or ~) form of ``path`` on host ``h``, ``..`` folded lexically."""
    path = (path or "").strip() or "."
    if not (path.startswith("/") or path == "~" or path.startswith("~/")):
        base = h.get("cwd") or "~"
        path = f"{base.rstrip('/')}/{path}"
    if path.startswith("/"):
        return posixpath.normpath(path)
    rest = posixpath.normpath(path[2:]) if path.startswith("~/") else "."
    if rest.startswith(".."):
        return "~/" + rest  # still checked (and refused) on the host
    return "~" if rest == "." else f"~/{rest}"


def guard(h: dict, var: str, path: str) -> str:
    """Shell snippet: resolve ``path`` into ``$var`` and refuse (exit 96) unless it is inside a root."""
    roots = h.get("roots") or []
    rq = " ".join(q(r) for r in roots) or "''"
    return (
        f"__p={q(path)}\n"
        f'{var}=$(realpath -m -- "$__p" 2>/dev/null || printf %s "$__p")\n'
        "__ok=\n"
        f"for __root in {rq}; do\n"
        '  __rr=$(realpath -m -- "$__root" 2>/dev/null || printf %s "$__root")\n'
        f'  case "${var}/" in "${{__rr%/}}"/*) __ok=1;; esac\n'
        "done\n"
        "[ -n \"$__ok\" ] || { printf 'refused: %s is outside the folders attached on this server (%s)\\n' "
        f'"$__p" {shlex.quote(", ".join(roots))} >&2; exit 96; }}\n'
    )


def _text(out: str, rc: int) -> dict:
    return {"content": [{"type": "text", "text": out or "(no output)"}], "isError": rc != 0}


def call(name: str, args: dict) -> dict:
    try:
        if name not in ("remote_bash", "remote_read", "remote_write", "remote_list"):
            return _text(f"unknown tool {name}", 1)
        h = pick_host(args.get("host"))
        if name == "remote_bash":
            cwd = resolve(h, args.get("cwd") or h.get("cwd") or "~")
            script = guard(h, "__d", cwd) + (
                'cd -- "$__d" || { echo "remote_bash: cannot enter $__d" >&2; exit 97; }\n'
                + (args.get("command") or "")
            )
            rc, out = _run(h, script)
            return _text(out, rc)
        if name == "remote_read":
            p = resolve(h, args.get("path", ""))
            rc, out = _run(h, guard(h, "__f", p) + 'cat -- "$__f"')
            return _text(out, rc)
        if name == "remote_write":
            # Content goes over stdin: any size, any bytes/quotes.
            p = resolve(h, args.get("path", ""))
            rc, out = _run(h, guard(h, "__f", p) + 'cat > "$__f" && echo "WROTE $__f"', stdin=args.get("content", ""))
            return _text(out, rc)
        p = resolve(h, args.get("path") or ".")
        rc, out = _run(h, guard(h, "__f", p) + 'ls -la -- "$__f"')
        return _text(out, rc)
    except ToolError as exc:
        return _text(str(exc), 1)


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
                    "serverInfo": {"name": "hrh-remote", "version": "0.3.0"},
                },
            )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            _reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = req.get("params", {})
            _reply(msg_id, call(params.get("name", ""), params.get("arguments", {}) or {}))
        elif msg_id is not None:
            _reply(msg_id, error={"code": -32601, "message": f"unknown method: {method}"})


if __name__ == "__main__":
    main()
