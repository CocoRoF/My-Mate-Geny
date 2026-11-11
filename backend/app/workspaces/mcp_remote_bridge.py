#!/usr/bin/env python3
"""Remote SSH MCP bridge — the agent's hands on the chat's SSH hosts.

A stdio MCP server (attached to the agent CLI as the ``remote`` server) whose tools operate on
the remote hosts of a chat: its workspace's host and/or the hosts of folders attached from other
servers. The agent runs on the app's server; every call goes over the system ``ssh`` with the
connection's key — no sshfs/fuse (brittle inside containers).

Tools (``host`` picks the server — its name as listed, default = the workspace's host):
  * remote_bash(command, host?, cwd?)   — run a shell command (cwd: an attached folder)
  * remote_read(path, host?)            — read a file
  * remote_write(path, content, host?)  — create/overwrite a file (and the folders it needs)
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

import base64
import json
import os
import posixpath
import shlex
import subprocess
import sys
from pathlib import Path
try:
    from .remote_jobs import RemoteJobs, RemoteTransportError, TERMINAL, fingerprint, ssh_prefix
except ImportError:  # launched directly by an agent CLI
    from remote_jobs import RemoteJobs, RemoteTransportError, TERMINAL, fingerprint, ssh_prefix


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
        "(cwd; default: the host's main folder). Short commands return output directly. Long commands "
        "return a durable job_id: use remote_poll to await completion, never rerun a still-running command. "
        "A command stops at 24 hours, or 2 hours with run_in_background, unless timeout_ms says otherwise: pass it for "
        "work you expect to run longer. Do not add shell timeout wrappers just to fit a tool call. remote_stop cancels "
        "its process group: use it for a job you no longer need. "
        f"Hosts and folders: {_hosts_line()}",
        "inputSchema": {
            "type": "object",
            "properties": {"command": {"type": "string"}, "host": _HOST_PROP,
                           "cwd": {"type": "string", "description": "start directory (inside an attached folder)"},
                           "description": {"type": "string", "description": "brief task label, without secrets"},
                           "yield_time_ms": {"type": "integer", "minimum": 0, "maximum": 30000, "default": 10000},
                           "timeout_ms": {"type": "integer", "minimum": 0, "description": "the command's time limit, when the default doesn't fit"},
                           "run_in_background": {"type": "boolean", "default": False}},
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

TOOLS += [{"name": "remote_poll", "description": "Read/await the SAME remote job, including after SSH or CLI reconnect. "
          "Use next_offset to continue output; wait_ms up to 30000 avoids busy polling. Keep polling running work "
          "until complete unless the user requested background execution.",
          "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "host": _HOST_PROP,
                         "offset": {"type": "integer", "minimum": 0}, "wait_ms": {"type": "integer", "minimum": 0, "maximum": 30000}}, "required": ["job_id"]}},
         {"name": "remote_stop", "description": "Stop this conversation's remote job and its process group. A disconnected stop is retained and retried by the server.",
          "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "host": _HOST_PROP}, "required": ["job_id"]}}]


def jobs():
    return RemoteJobs(os.environ.get('HRH_REMOTE_JOBS_ROOT') or str(Path.home()/'.cache/my-mate-geny/remote-jobs-local'),
                      os.environ.get('HRH_REMOTE_SESSION_ID') or 'standalone', prefix=_ssh_prefix)


def job_result(result, *, plain=False):
    shown = RemoteJobs.display(result)
    error = shown.get('status') in TERMINAL and shown.get('exit_code', 1) != 0
    if plain and shown.get('status') in TERMINAL and not shown.get('has_more'):
        return _text(shown.get('output') or shown.get('error') or '(no output)', 1 if error else 0)
    return _text(json.dumps(shown, ensure_ascii=False), 1 if error else 0)


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


#: a picture bigger than this is not sent to the model
MAX_IMAGE_BYTES = 4 * 1024 * 1024


def _ssh_prefix(h: dict) -> list[str]:
    return ssh_prefix(h)


def _exec(h: dict, remote_cmd: str, timeout: int = 300, stdin: str | None = None) -> tuple[int, bytes, bytes]:
    proc = subprocess.run(
        [*_ssh_prefix(h), remote_cmd], capture_output=True, timeout=timeout,
        input=None if stdin is None else stdin.encode("utf-8", "surrogateescape"),
    )
    return proc.returncode, proc.stdout, proc.stderr


def _shown(out: bytes, err: bytes) -> str:
    def text(raw: bytes) -> str:
        return raw.decode("utf-8", "replace").replace("\r\n", "\n")

    return text(out) + (("\n[stderr]\n" + text(err)) if err else "")


def _run(h: dict, remote_cmd: str, timeout: int = 300, stdin: str | None = None) -> tuple[int, str]:
    try:
        rc, out, err = _exec(h, remote_cmd, timeout, stdin)
        return rc, _shown(out, err)
    except Exception as exc:  # noqa: BLE001
        return 1, f"remote exec failed: {exc}"


def _image_type(raw: bytes) -> str | None:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith(b"GIF8"):
        return "image/gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def _file_result(raw: bytes, path: str) -> dict:
    """What remote_read answers for a file: a picture as a picture, anything else that isn't text says so."""
    mime = _image_type(raw)
    if mime and len(raw) <= MAX_IMAGE_BYTES:
        return {"content": [{"type": "image", "data": base64.b64encode(raw).decode(), "mimeType": mime}], "isError": False}
    if mime or b"\0" in raw:
        return _text(f"{path} is not a text file ({len(raw)} bytes): nothing to show here, look at it with remote_bash", 1)
    return _text(raw.decode("utf-8", "replace"), 0)


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
        if name in ('remote_poll', 'remote_stop'):
            manager = jobs()
            manifest = manager.manifest(args.get('job_id'))
            if args.get('host') and fingerprint(manifest['host']) != fingerprint(pick_host(args['host'])):
                raise ToolError('job belongs to a different host')
            if name == 'remote_stop':
                result = manager.stop(manifest)
            else:
                result = manager.poll(manifest, offset=args.get('offset', 0), wait_ms=max(0,min(30000,int(args.get('wait_ms', 0)))))
            return job_result(result)
        if name not in ("remote_bash", "remote_read", "remote_write", "remote_list"):
            return _text(f"unknown tool {name}", 1)
        h = pick_host(args.get("host"))
        if name == "remote_bash":
            cwd = resolve(h, args.get("cwd") or h.get("cwd") or "~")
            manager = jobs()
            wait_ms = max(0,min(30000,int(args.get('yield_time_ms', 10000))))
            manifest = manager.prepare(h, args.get('command'), cwd, description=args.get('description') or '',
                                       timeout_ms=args.get('timeout_ms', 0), background=args.get('run_in_background', False))
            try:
                wait_ms = 0 if manifest['background'] else wait_ms
                return job_result(manager.start(manifest, wait_ms=wait_ms), plain=True)
            except RemoteTransportError as exc:
                return _text(json.dumps({'job_id':manifest['job_id'], 'status':'connection_lost', 'message':str(exc)}), 0)
        if name == "remote_read":
            p = resolve(h, args.get("path", ""))
            try:
                rc, raw, err = _exec(h, guard(h, "__f", p) + 'cat -- "$__f"')
            except Exception as exc:  # noqa: BLE001
                return _text(f"remote exec failed: {exc}", 1)
            return _file_result(raw, p) if rc == 0 and not err else _text(_shown(raw, err), rc)
        if name == "remote_write":
            # Content goes over stdin: any size, any bytes/quotes. A new folder is made for it, as the local Write does.
            p = resolve(h, args.get("path", ""))
            rc, out = _run(h, guard(h, "__f", p) + 'mkdir -p -- "$(dirname -- "$__f")" && cat > "$__f" && echo "WROTE $__f"',
                           stdin=args.get("content", ""))
            return _text(out, rc)
        p = resolve(h, args.get("path") or ".")
        rc, out = _run(h, guard(h, "__f", p) + 'ls -la -- "$__f"')
        return _text(out, rc)
    except RemoteTransportError as exc:
        return _text(json.dumps({'job_id':args.get('job_id'), 'status':'connection_lost', 'message':str(exc)}), 0)
    except (ToolError, ValueError) as exc:
        return _text(str(exc), 1)


def _reply(msg_id, result=None, error=None) -> None:
    resp = {"jsonrpc": "2.0", "id": msg_id}
    resp["error" if error is not None else "result"] = error if error is not None else result
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()


def main() -> None:
    # MCP over stdio is UTF-8. On Windows a pipe is the ANSI code page (cp949, cp1252…) instead, and -I ignores
    # PYTHONUTF8: a tool list or an answer with characters it lacks killed the bridge (no tools for the engine).
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
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
                    "serverInfo": {"name": "hrh-remote", "version": "0.4.0"},
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
