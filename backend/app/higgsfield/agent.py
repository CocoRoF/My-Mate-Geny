"""What a chat's agent gets from Higgsfield (docs/higgsfield.md, "How agents use it").

Every chat (Claude Code and Codex; local and remote workspaces) runs the official ``higgsfield`` CLI — the same tool
the Higgsfield skills drive — with credentials the server controls:

- ``<root>/bin/higgsfield`` links to the CLI found on this server, and that folder goes first on the agent's PATH (a
  container whose PATH lacks ~/.local/bin still finds it);
- ``<root>/sessions/<sid>/credentials.json`` holds the account's ACCESS token only (oauth.cli_credentials): no refresh
  token, so the CLI can never rotate it and sign the server out, and no expiry, so the CLI never tries to refresh or
  deletes the file. ``HIGGSFIELD_CREDENTIALS_PATH`` / ``HIGGSFIELD_CONFIG_PATH`` point the CLI there (never at the
  user's own ~/.config/higgsfield). The server rewrites the file before every turn and keeps it fresh while the
  chat's engine lives (:meth:`HiggsfieldAgent.keep_fresh`), refreshing the account token itself when less than
  :data:`FILE_KEEP` is left; it removes the file when the chat turns Higgsfield off or its engine is gone;
- the skills: the host's ``~/.claude/skills/higgsfield-*`` when installed there, else the copy "Install skills" puts
  under ``<root>/plugin`` (loaded with ``--plugin-dir``); Codex is pointed at the SKILL.md files;
- a few lines appended to the system prompt (Codex: once per thread, in the message) saying it is there.

After a turn that ran the CLI, the credits it spent are read from the account's transactions (a notice in the chat).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import shutil
import tarfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from app.config import settings
from app.higgsfield.oauth import HiggsfieldError, cli_credentials, parse_time, redact
from app.higgsfield.service import HiggsfieldService

#: A token handed to an agent has at least this long left (a `generate --wait` may poll for 20 minutes).
FILE_KEEP = timedelta(minutes=45)
#: How often live chats' credential files are checked (and their token refreshed when due).
KEEP_INTERVAL_S = 300
#: A chat without a live engine or turn loses its credentials file after this long.
IDLE_DROP_S = 15 * 60
#: The skills archive may be at most this large.
SKILLS_MAX_BYTES = 30 * 1024 * 1024
#: Session settings: Higgsfield on unless the chat turned it off; no credit limit by default.
DEFAULTS = {"enabled": True, "max_credits": None}


def session_settings(session: dict[str, Any]) -> dict[str, Any]:
    raw = session.get("higgsfield")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "{}")
        except ValueError:
            raw = {}
    raw = raw if isinstance(raw, dict) else {}
    out = dict(DEFAULTS)
    if isinstance(raw.get("enabled"), bool):
        out["enabled"] = raw["enabled"]
    mc = raw.get("max_credits")
    if isinstance(mc, (int, float)) and not isinstance(mc, bool) and mc >= 0:
        out["max_credits"] = mc
    return out


def clean_settings(value: dict[str, Any], current: dict[str, Any] | None = None) -> dict[str, Any]:
    """A PATCH of the session's Higgsfield settings, validated. Raises ValueError."""
    out = session_settings({"higgsfield": current or {}})
    if "enabled" in value:
        if not isinstance(value["enabled"], bool):
            raise ValueError("higgsfield.enabled must be true or false")
        out["enabled"] = value["enabled"]
    if "max_credits" in value:
        mc = value["max_credits"]
        if mc is not None and (not isinstance(mc, (int, float)) or isinstance(mc, bool) or mc < 0 or mc > 1_000_000):
            raise ValueError("higgsfield.max_credits must be a number of credits (0 – 1,000,000) or null")
        out["max_credits"] = mc
    unknown = set(value) - {"enabled", "max_credits"}
    if unknown:
        raise ValueError(f"unknown Higgsfield setting(s): {', '.join(sorted(unknown))}")
    return out


def _atomic_write(path: Path, text: str, mode: int = 0o600) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def find_cli() -> str | None:
    """The `higgsfield` executable: HIGGSFIELD_BINARY, else PATH, ~/.local/bin, the npm global prefixes. The npm
    package's native binary (vendor/hf) is preferred over its node wrapper (no node needed to run it)."""
    candidates: list[str] = []
    # first: the copy Settings → Providers → CLI versions shows and upgrades (its app-owned copy after an upgrade)
    try:
        from app.services.cli_tools.tools import effective_binary

        chosen = effective_binary("higgsfield")
        candidates.append(chosen if os.sep in chosen else (shutil.which(chosen) or ""))
    except Exception:  # noqa: BLE001 - the CLI-versions module is optional here
        pass
    if settings.higgsfield_binary:
        candidates.append(os.path.expanduser(settings.higgsfield_binary))
    found = shutil.which("higgsfield")
    if found:
        candidates.append(found)
    home = os.path.expanduser("~")
    candidates += [
        os.path.join(home, ".local/bin/higgsfield"),
        os.path.join(home, ".npm-global/bin/higgsfield"),
        "/usr/local/bin/higgsfield", "/usr/bin/higgsfield",
    ]
    for c in candidates:
        if not c or not os.path.exists(c):
            continue
        real = os.path.realpath(c)
        # …/@higgsfield/cli/bin/higgsfield.js → …/@higgsfield/cli/vendor/hf
        if real.endswith(".js"):
            native = os.path.join(os.path.dirname(os.path.dirname(real)), "vendor", "hf")
            if os.path.isfile(native) and os.access(native, os.X_OK):
                return native
        if os.access(real, os.X_OK):
            return real
    for prefix in (os.path.join(home, ".local/lib"), "/usr/local/lib", "/usr/lib"):
        native = os.path.join(prefix, "node_modules/@higgsfield/cli/vendor/hf")
        if os.path.isfile(native) and os.access(native, os.X_OK):
            return native
    return None


@dataclass
class Launch:
    """What a turn's engine gets. ``env`` goes to the CLI process (and so to the agent's tools)."""

    account_id: str | None
    enabled: bool
    env: dict[str, str] = field(default_factory=dict)
    prompt: str = ""
    plugin_dirs: list[str] = field(default_factory=list)
    notices: list[dict[str, Any]] = field(default_factory=list)
    started_at: str = ""


class HiggsfieldAgent:
    def __init__(self, service: HiggsfieldService, root: Path | None = None,
                 is_live: Callable[[str], bool] | None = None,
                 session_exists: Callable[[str], bool] | None = None) -> None:
        self.service = service
        self.root = Path(root or settings.higgsfield_root_path)
        self.is_live = is_live or (lambda sid: False)
        self.session_exists = session_exists or (lambda sid: True)
        self._cli: tuple[float, str | None] | None = None
        self._told: set[tuple[str, str]] = set()  # (sid, notice code) already shown this server run
        self._skills_lock = asyncio.Lock()
        service.on_tokens.append(self._tokens_changed)

    # ---- the CLI ----

    def cli_path(self, *, refresh: bool = False) -> str | None:
        if refresh or self._cli is None or time.monotonic() - self._cli[0] > 60:
            self._cli = (time.monotonic(), find_cli())
        return self._cli[1]

    def bin_dir(self) -> Path | None:
        """``<root>/bin`` with `higgsfield` (+ `higgs`) linked to the CLI; None when there is no CLI."""
        target = self.cli_path()
        if target is None:
            return None
        d = self.root / "bin"
        d.mkdir(parents=True, exist_ok=True)
        for name in ("higgsfield", "higgs"):
            link = d / name
            try:
                if link.is_symlink() and os.readlink(link) == target:
                    continue
                if link.exists() or link.is_symlink():
                    link.unlink()
                link.symlink_to(target)
            except OSError:
                pass
        return d

    def cli_version(self) -> str | None:
        path = self.cli_path()
        if path is None:
            return None
        import subprocess

        try:
            r = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10,
                               env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""),
                                    "HIGGSFIELD_NO_UPDATE_CHECK": "1"})
        except (OSError, subprocess.SubprocessError):
            return None
        line = (r.stdout or r.stderr or "").strip().splitlines()
        return line[0][:120] if line else None

    # ---- skills ----

    @staticmethod
    def host_skills() -> list[str]:
        """higgsfield-* skills installed for Claude Code on this server (~/.claude/skills; the pooled accounts'
        config dirs link that folder)."""
        base = Path(os.path.expanduser("~/.claude/skills"))
        try:
            return sorted(p.name for p in base.iterdir()
                          if p.name.startswith("higgsfield-") and (p / "SKILL.md").is_file())
        except OSError:
            return []

    @property
    def plugin_dir(self) -> Path:
        return self.root / "plugin"

    def bundled_skills(self) -> list[str]:
        base = self.plugin_dir / "skills"
        try:
            return sorted(p.name for p in base.iterdir() if (p / "SKILL.md").is_file())
        except OSError:
            return []

    def skills_dir(self) -> Path | None:
        """Where the SKILL.md files are (for Codex): the host's skills, else the installed copy."""
        if self.host_skills():
            return Path(os.path.expanduser("~/.claude/skills"))
        if self.bundled_skills():
            return self.plugin_dir / "skills"
        return None

    def skills_state(self) -> dict[str, Any]:
        meta = {}
        try:
            meta = json.loads((self.plugin_dir / ".installed.json").read_text())
        except (OSError, ValueError):
            pass
        return {"host": self.host_skills(), "bundled": self.bundled_skills(),
                "installed_at": meta.get("installed_at"), "source": settings.higgsfield_skills_url}

    async def install_skills(self) -> dict[str, Any]:
        """Download the official skills (github.com/higgsfield-ai/skills) into ``<root>/plugin`` — a Claude Code
        plugin the chats load when the host has no higgsfield-* skills of its own. The archive is untrusted: only
        regular files under ``<top>/higgsfield-*/`` are taken, no links, no absolute or ``..`` paths."""
        async with self._skills_lock:
            status, raw = await self.service._request("GET", settings.higgsfield_skills_url,
                                                      headers={"Accept": "application/octet-stream"})
            if status >= 400 or not raw:
                raise HiggsfieldError("skills_failed", f"download → HTTP {status}")
            if len(raw) > SKILLS_MAX_BYTES:
                raise HiggsfieldError("skills_failed", "the skills archive is too large")
            names = await asyncio.to_thread(self._unpack_skills, raw)
            if not names:
                raise HiggsfieldError("skills_failed", "no higgsfield-* skills in the archive")
            return self.skills_state()

    def _unpack_skills(self, raw: bytes) -> list[str]:
        stage = self.root / "plugin.new"
        shutil.rmtree(stage, ignore_errors=True)
        (stage / "skills").mkdir(parents=True)
        (stage / ".claude-plugin").mkdir()
        names: set[str] = set()
        total = 0
        try:
            with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
                for m in tar.getmembers():
                    parts = m.name.replace("\\", "/").split("/")
                    if len(parts) < 3 or not m.isfile() or m.name.startswith("/") or ".." in parts:
                        continue
                    skill, rel = parts[1], parts[2:]
                    if not skill.startswith("higgsfield-") or any(p in ("", ".") for p in rel):
                        continue
                    total += m.size
                    if total > SKILLS_MAX_BYTES * 3:
                        raise HiggsfieldError("skills_failed", "the skills archive unpacks too large")
                    dest = stage / "skills" / skill / Path(*rel)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    src = tar.extractfile(m)
                    if src is None:
                        continue
                    with open(dest, "wb") as fh:
                        shutil.copyfileobj(src, fh)
                    os.chmod(dest, 0o755 if m.mode & 0o111 else 0o644)
                    names.add(skill)
        except tarfile.TarError as exc:
            shutil.rmtree(stage, ignore_errors=True)
            raise HiggsfieldError("skills_failed", f"not a .tar.gz archive ({type(exc).__name__})") from None
        names = {n for n in names if (stage / "skills" / n / "SKILL.md").is_file()}
        if not names:
            shutil.rmtree(stage, ignore_errors=True)
            return []
        (stage / ".claude-plugin" / "plugin.json").write_text(json.dumps({
            "name": "higgsfield", "description": "Higgsfield skills (github.com/higgsfield-ai/skills), "
            "installed by My Mate Geny", "version": datetime.now(timezone.utc).strftime("%Y.%m.%d"),
        }, indent=2))
        (stage / ".installed.json").write_text(json.dumps({
            "installed_at": datetime.now(timezone.utc).isoformat(), "skills": sorted(names)}))
        old = self.root / "plugin.old"
        shutil.rmtree(old, ignore_errors=True)
        if self.plugin_dir.exists():
            self.plugin_dir.rename(old)
        stage.rename(self.plugin_dir)
        shutil.rmtree(old, ignore_errors=True)
        return sorted(names)

    def remove_skills(self) -> dict[str, Any]:
        shutil.rmtree(self.plugin_dir, ignore_errors=True)
        return self.skills_state()

    # ---- per-chat files ----

    def session_dir(self, sid: str) -> Path:
        safe = "".join(c for c in sid if c.isalnum() or c in "_-")[:80] or "x"
        return self.root / "sessions" / safe

    def _write_files(self, sid: str, aid: str, access: str) -> Path:
        d = self.session_dir(sid)
        d.mkdir(parents=True, exist_ok=True)
        os.chmod(d, 0o700)
        creds = d / "credentials.json"
        text = json.dumps(cli_credentials(access))
        try:
            same = creds.read_text() == text
        except OSError:
            same = False
        if not same:
            _atomic_write(creds, text)
        workspace = (self.service._row(aid).get("info") or {}).get("workspace_id")
        cfg = json.dumps({"workspace_id": workspace} if workspace else {})
        try:
            same = (d / "config.json").read_text() == cfg
        except OSError:
            same = False
        if not same:
            _atomic_write(d / "config.json", cfg)
        _atomic_write(d / "account", aid)
        return d

    def revoke(self, sid: str) -> None:
        """The chat loses Higgsfield now: its credentials file goes (a live engine's next CLI call is signed out)."""
        d = self.session_dir(sid)
        for name in ("credentials.json", "account"):
            try:
                (d / name).unlink()
            except OSError:
                pass

    def forget(self, sid: str) -> None:
        shutil.rmtree(self.session_dir(sid), ignore_errors=True)

    def _tokens_changed(self, aid: str) -> None:
        """An account's tokens (or workspace) changed: rewrite the files of the chats using it — or, when the
        account is gone, remove them."""
        base = self.root / "sessions"
        try:
            dirs = [d for d in base.iterdir() if d.is_dir()]
        except OSError:
            return
        tokens = self.service.tokens_of(aid)
        for d in dirs:
            try:
                if (d / "account").read_text().strip() != aid:
                    continue
            except OSError:
                continue
            if tokens is None:
                self.revoke(d.name)
            else:
                try:
                    self._write_files(d.name, aid, tokens["access"])
                except (OSError, HiggsfieldError):
                    pass

    async def keep_fresh(self) -> None:
        """One round of the keeper: live chats keep a token with at least FILE_KEEP left (refreshed by the
        server, once per account); idle chats lose their file; deleted chats lose their folder."""
        base = self.root / "sessions"
        try:
            dirs = [d for d in base.iterdir() if d.is_dir()]
        except OSError:
            return
        now = time.time()
        for d in dirs:
            sid = d.name
            if not self.session_exists(sid):
                self.forget(sid)
                continue
            try:
                aid = (d / "account").read_text().strip()
            except OSError:
                continue
            if not self.is_live(sid):
                try:
                    age = now - (d / "account").stat().st_mtime
                except OSError:
                    age = IDLE_DROP_S + 1
                if age > IDLE_DROP_S:
                    self.revoke(sid)
                continue
            try:
                tokens = await self.service.access_token(aid, keep=FILE_KEEP)
                self._write_files(sid, aid, tokens["access"])
            except HiggsfieldError:
                self.revoke(sid)

    async def run_keeper(self) -> None:
        while True:
            await asyncio.sleep(KEEP_INTERVAL_S)
            try:
                await self.keep_fresh()
            except Exception:  # noqa: BLE001 - never stops the loop
                pass

    # ---- a turn ----

    def _once(self, sid: str, code: str) -> bool:
        key = (sid, code)
        if key in self._told:
            return False
        self._told.add(key)
        return True

    async def launch(self, sid: str, session: dict[str, Any], *, provider: str) -> Launch | None:
        """Higgsfield for this turn. None when no account is connected (nothing changes for the chat)."""
        aid = self.service.default_id()
        if aid is None:
            return None
        cfg = session_settings(session)
        remote = bool(session.get("connection_id"))
        off_env = {
            # never the user's own ~/.config/higgsfield login (its refresh token would rotate under the server)
            "HIGGSFIELD_CREDENTIALS_PATH": str(self.session_dir(sid) / "off" / "credentials.json"),
            "HIGGSFIELD_CONFIG_PATH": str(self.session_dir(sid) / "off" / "config.json"),
            "HIGGSFIELD_NO_UPDATE_CHECK": "1",
        }
        off_prompt = ("Higgsfield is switched off for this chat: do not use, sign in to or install the "
                      "`higgsfield` CLI here.")
        if not cfg["enabled"]:
            self.revoke(sid)
            return Launch(account_id=aid, enabled=False, env=off_env, prompt=off_prompt)
        bin_dir = self.bin_dir()
        notices: list[dict[str, Any]] = []
        if bin_dir is None:
            self.revoke(sid)
            if self._once(sid, "higgsfield.no_cli"):
                notices.append({"level": "warning", "code": "higgsfield.no_cli",
                                "message": "Higgsfield is connected, but the higgsfield CLI isn't installed on this "
                                           "server (npm i -g @higgsfield/cli), so this chat can't use it."})
            return Launch(account_id=aid, enabled=False, env=off_env, notices=notices)
        try:
            tokens = await self.service.access_token(aid, keep=FILE_KEEP)
        except HiggsfieldError as exc:
            self.revoke(sid)
            if self._once(sid, "higgsfield.signed_out"):
                notices.append({"level": "warning", "code": "higgsfield.signed_out",
                                "message": "Higgsfield needs a new sign-in (Settings → Providers → Higgsfield): "
                                           + redact(exc.text())})
            return Launch(account_id=aid, enabled=False, env=off_env, notices=notices)
        d = await asyncio.to_thread(self._write_files, sid, aid, tokens["access"])
        env = {
            "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HIGGSFIELD_CREDENTIALS_PATH": str(d / "credentials.json"),
            "HIGGSFIELD_CONFIG_PATH": str(d / "config.json"),
            "HIGGSFIELD_NO_UPDATE_CHECK": "1",
        }
        host = self.host_skills()
        plugin_dirs = [] if host or provider != "claude" or not self.bundled_skills() else [str(self.plugin_dir)]
        email = self.service._row(aid).get("email")
        prompt = self.prompt(provider=provider, remote=remote, email=email, max_credits=cfg["max_credits"],
                             has_skills=bool(host or self.bundled_skills()))
        return Launch(account_id=aid, enabled=True, env=env, prompt=prompt, plugin_dirs=plugin_dirs,
                      notices=notices, started_at=datetime.now(timezone.utc).isoformat())

    def prompt(self, *, provider: str, remote: bool, email: str | None, max_credits: float | None,
               has_skills: bool) -> str:
        """The note the agent gets. Stable for a chat (no balances in it): a persistent engine restarts only when
        it really changes."""
        who = f" (the user's account {email})" if email else " (the user's account)"
        lines = [
            f"Higgsfield (AI image, video, audio and 3D generation) is connected for this chat{who}. The `higgsfield` "
            "CLI is on PATH and already signed in: never run `higgsfield auth login/logout`, never install or "
            "update it, never buy credits or change the plan."
        ]
        sd = self.skills_dir()
        if has_skills and provider == "claude":
            lines.append("Use the higgsfield-* skills for generation work.")
        elif has_skills and sd is not None:
            lines.append(f"Before the first generation read {sd}/higgsfield-generate/SKILL.md (other guides: "
                         f"{sd}/higgsfield-*/SKILL.md) and follow it.")
        else:
            lines.append("Discover models with `higgsfield model list` and `higgsfield model get <job_type>`.")
        if max_credits is not None:
            lines.append(f"Generating spends the user's credits: before any job estimated above {max_credits:g} "
                         "credits, quote it (`higgsfield generate cost …`) and ask the user first.")
        else:
            lines.append("Generating spends the user's credits; `higgsfield generate cost …` quotes a job for free.")
        if remote:
            lines.append("The CLI runs on this server (call it with your own Bash tool, not remote_bash). Put each "
                         "result into the remote workspace with remote_bash `curl -fsSL -o <path> '<result url>'`, "
                         "then show it in your reply as a markdown image or link to that path.")
        else:
            lines.append("Save each result in the workspace (`curl -fsSL -o <file> '<result url>'`) and show it in "
                         "your reply as a markdown image or link to that file.")
        return " ".join(lines)

    # ---- what a turn spent ----

    @staticmethod
    def ran_cli(tool_input: Any) -> bool:
        try:
            text = tool_input if isinstance(tool_input, str) else json.dumps(tool_input)
        except (TypeError, ValueError):
            return False
        return "higgsfield" in text or "higgs " in text

    async def spent_since(self, aid: str, since_iso: str) -> dict[str, Any] | None:
        """Credits the account's transactions show since ``since_iso`` (spends minus refunds), and the balance now.
        None when nothing could be read."""
        since = parse_time(since_iso)
        if since is None:
            return None
        try:
            page = await self.service.transactions(aid, size=50)
        except HiggsfieldError:
            return None
        items = []
        for t in page["items"]:
            at = parse_time(t.get("created_at"))
            if at is None or at < since - timedelta(seconds=5) or t.get("credits") is None:
                continue
            if t["action"] not in ("spend", "refund"):
                continue
            items.append({"display_name": t["display_name"], "credits": t["credits"], "action": t["action"]})
        acc = None
        try:
            acc = await self.service.refresh_profile(aid)
        except HiggsfieldError:
            pass
        used = round(-sum(t["credits"] for t in items), 4)
        return {"credits_used": used, "items": items[:20], "balance": acc.get("credits") if acc else None}

    @staticmethod
    def fingerprint(launch: Launch | None) -> str:
        if launch is None:
            return ""
        key = json.dumps({"env": launch.env, "prompt": launch.prompt, "plugins": launch.plugin_dirs}, sort_keys=True)
        return hashlib.sha256(key.encode()).hexdigest()[:16]
