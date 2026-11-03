"""GitHub / GitLab integration — connect an account, list repos, clone to a
local workspace the agent can work in (and push back, auth via the token)."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from app.config import settings
from app.db import Database
from app.services._ids import new_id, now_iso
from app.vault import SecretVault


class GitError(RuntimeError):
    pass


def _owner_repo(remote: str) -> str:
    """owner/repo from an https or ssh git remote URL."""
    r = remote.strip()
    if not r:
        return ""
    if r.endswith(".git"):
        r = r[:-4]
    if r.startswith("git@"):  # git@host:owner/repo
        r = r.split(":", 1)[-1]
    elif "://" in r:  # https://host/owner/repo (strip userinfo + host)
        r = r.split("://", 1)[1]
        r = r.split("/", 1)[1] if "/" in r else r
    parts = [p for p in r.split("/") if p]
    return "/".join(parts[-2:]) if len(parts) >= 2 else r


_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def strip_userinfo(url: str) -> str:
    """Never show credentials embedded in a remote URL (https://user:pass@host/...)."""
    return re.sub(r"^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@]*@", r"\1", url.strip())


def git_info(run) -> dict[str, Any]:
    """Compute a workspace's git context using a ``run(args) -> (rc, stdout)``.

    Works for local (subprocess) or remote (ssh) by swapping ``run``.
    """
    rc, out = run(["rev-parse", "--is-inside-work-tree"])
    if rc != 0 or out.strip() != "true":
        return {"is_repo": False}
    _, remote = run(["remote", "get-url", "origin"])
    remote = strip_userinfo(remote)
    _, branch = run(["branch", "--show-current"])
    branch = branch.strip()
    if not branch:
        _, sha = run(["rev-parse", "--short", "HEAD"])
        branch = sha.strip()
    _, status = run(["status", "--porcelain"])
    changes = len([ln for ln in status.splitlines() if ln.strip()])
    behind = ahead = 0
    _, ab = run(["rev-list", "--count", "--left-right", "@{u}...HEAD"])
    ab = ab.strip()
    if "\t" in ab:
        try:
            b, a = ab.split("\t")
            behind, ahead = int(b), int(a)
        except ValueError:
            pass
    return {
        "is_repo": True,
        "remote": remote.strip(),
        "repo": _owner_repo(remote),
        "branch": branch,
        "changes": changes,
        "ahead": ahead,
        "behind": behind,
    }


def _api_base(provider: str, host: str | None) -> str:
    if provider == "github":
        return "https://api.github.com"
    h = (host or "gitlab.com").replace("https://", "").replace("http://", "").strip("/")
    return f"https://{h}/api/v4"


def _headers(token: str, provider: str) -> dict[str, str]:
    h = {"User-Agent": "my-mate-geny", "Accept": "application/json"}
    if provider == "github":
        h["Authorization"] = f"Bearer {token}"
        h["Accept"] = "application/vnd.github+json"
    else:
        h["PRIVATE-TOKEN"] = token
    return h


def _req(url: str, token: str, provider: str) -> Any:
    req = urllib.request.Request(url, headers=_headers(token, provider), method="GET")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def _req_full(url: str, token: str, provider: str) -> tuple[Any, dict[str, str]]:
    req = urllib.request.Request(url, headers=_headers(token, provider), method="GET")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode()), {k.lower(): v for k, v in r.headers.items()}


def _github_scopes(headers: dict[str, str]) -> list[str]:
    raw = headers.get("x-oauth-scopes", "")
    return [s.strip() for s in raw.split(",") if s.strip()]


class GitService:
    def __init__(self, db: Database, vault: SecretVault) -> None:
        self._db = db
        self._vault = vault

    # ---- accounts ----

    def connect(self, provider: str, token: str, *, host: str | None = None, label: str | None = None) -> dict:
        if provider not in ("github", "gitlab"):
            raise GitError("provider must be github or gitlab")
        base = _api_base(provider, host)
        try:
            me, headers = _req_full(f"{base}/user", token, provider)
        except urllib.error.HTTPError as exc:
            raise GitError(f"token rejected ({exc.code}) — check scopes (repo/read_api)") from exc
        except Exception as exc:  # noqa: BLE001
            raise GitError(f"could not reach {provider}: {exc}") from exc
        username = me.get("login") or me.get("username") or ""

        # Capture the token's granted scopes so the UI can reflect its powers.
        scopes: list[str] = []
        if provider == "github":
            scopes = _github_scopes(headers)
            # Classic PATs report scopes; fine-grained PATs don't — assume push.
            can_push = (not scopes) or any(s in scopes for s in ("repo", "public_repo"))
        else:
            try:
                tok_info = _req(f"{base}/personal_access_tokens/self", token, provider)
                scopes = tok_info.get("scopes", []) or []
            except Exception:  # noqa: BLE001
                scopes = []
            can_push = (not scopes) or any(s in scopes for s in ("api", "write_repository"))

        aid = new_id(f"git_{provider}_")
        ref = self._vault.put("git", f"{aid}.token", token)
        self._db.execute(
            """INSERT INTO git_accounts (id, provider, label, host, username, token_ref, scopes, can_push, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (aid, provider, label or username or provider, host, username, ref,
             ",".join(scopes), 1 if can_push else 0, now_iso()),
        )
        return self.get(aid)  # type: ignore[return-value]

    def _row(self, r) -> dict:
        keys = r.keys()
        return {
            "id": r["id"],
            "provider": r["provider"],
            "label": r["label"],
            "host": r["host"],
            "username": r["username"],
            "scopes": (r["scopes"].split(",") if ("scopes" in keys and r["scopes"]) else []),
            "can_push": bool(r["can_push"]) if "can_push" in keys else True,
            "created_at": r["created_at"],
        }

    def list(self) -> list[dict]:
        return [self._row(r) for r in self._db.query("SELECT * FROM git_accounts ORDER BY created_at")]

    def get(self, aid: str) -> dict | None:
        r = self._db.query_one("SELECT * FROM git_accounts WHERE id = ?", (aid,))
        return self._row(r) if r else None

    def delete(self, aid: str) -> None:
        r = self._db.query_one("SELECT token_ref FROM git_accounts WHERE id = ?", (aid,))
        if r and r["token_ref"]:
            self._vault.delete(r["token_ref"])
        self._db.execute("DELETE FROM git_accounts WHERE id = ?", (aid,))
        try:
            self._credentials_path(aid).unlink()
        except FileNotFoundError:
            pass

    def _token(self, aid: str) -> tuple[dict, str]:
        r = self._db.query_one("SELECT * FROM git_accounts WHERE id = ?", (aid,))
        if r is None:
            raise GitError("git account not found")
        return dict(r), self._vault.read(r["token_ref"])

    def account_token(self, aid: str) -> tuple[dict, str]:
        """(account row, token) — server side only (a clone on another host; never returned by the API)."""
        return self._token(aid)

    def git_host(self, acc: dict) -> str:
        return self._git_host(acc)

    # ---- repos ----

    def repos(self, aid: str, query: str = "") -> list[dict]:
        acc, token = self._token(aid)
        provider, host = acc["provider"], acc["host"]
        base = _api_base(provider, host)
        try:
            if provider == "github":
                data = []
                for page in range(1, 6):  # up to 500 repos, newest activity first
                    url = (f"{base}/user/repos?per_page=100&page={page}&sort=updated"
                           "&affiliation=owner,collaborator,organization_member")
                    batch = _req(url, token, provider)
                    data += batch
                    if len(batch) < 100:
                        break
                repos = [
                    {
                        "full_name": x["full_name"],
                        "name": x["name"],
                        "clone_url": x["clone_url"],
                        "private": x["private"],
                        "description": x.get("description") or "",
                        "default_branch": x.get("default_branch") or "main",
                        "updated_at": x.get("updated_at"),
                    }
                    for x in data
                ]
            else:
                q = urllib.parse.quote(query)
                url = f"{base}/projects?membership=true&per_page=100&order_by=last_activity_at&search={q}"
                data = _req(url, token, provider)
                repos = [
                    {
                        "full_name": x["path_with_namespace"],
                        "name": x["name"],
                        "clone_url": x["http_url_to_repo"],
                        "private": x.get("visibility") != "public",
                        "description": x.get("description") or "",
                        "default_branch": x.get("default_branch") or "main",
                        "updated_at": x.get("last_activity_at"),
                    }
                    for x in data
                ]
        except urllib.error.HTTPError as exc:
            raise GitError(f"repo list failed ({exc.code})") from exc
        if query and provider == "github":
            repos = [r for r in repos if query.lower() in r["full_name"].lower()]
        return repos

    # ---- clone ----

    def _git_host(self, acc: dict) -> str:
        if acc["provider"] == "github":
            return "github.com"
        host = acc.get("host") or "gitlab.com"
        return urllib.parse.urlsplit(host if "://" in host else f"https://{host}").hostname or host

    def _credentials_path(self, aid: str):
        return settings.home_dir / "git-credentials" / aid

    def _write_credentials(self, acc: dict, token: str) -> str:
        """Token for git over HTTPS, in a 0600 file OUTSIDE the repo; the repo's
        origin stays a clean URL (never shown in the UI/API with a token)."""
        path = self._credentials_path(acc["id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        user = "x-access-token" if acc["provider"] == "github" else "oauth2"
        line = f"https://{urllib.parse.quote(user, safe='')}:{urllib.parse.quote(token, safe='')}@{self._git_host(acc)}\n"
        tmp = path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(line)
        os.replace(tmp, path)
        return str(path)

    def clone(self, aid: str, full_name: str, clone_url: str) -> dict:
        acc, token = self._token(aid)
        parts = full_name.strip("/").split("/")
        if not 2 <= len(parts) <= 8 or any(not _SEGMENT.match(p) or p in (".", "..") for p in parts):
            raise GitError("invalid repository name")
        u = urllib.parse.urlsplit(clone_url)
        if u.scheme != "https" or u.username or u.password or (u.hostname or "").lower() != self._git_host(acc).lower():
            raise GitError("clone URL must be https on this account's host")
        root = (settings.repos_root_path / acc["provider"]).resolve()
        dest = (root / "/".join(parts)).resolve()
        if root not in dest.parents:
            raise GitError("invalid repository name")
        if (dest / ".git").exists():
            return {"path": str(dest), "cloned": False}
        dest.parent.mkdir(parents=True, exist_ok=True)
        helper = f"store --file={self._write_credentials(acc, token)}"
        clean_url = urllib.parse.urlunsplit(("https", u.hostname, u.path, "", ""))
        existed = dest.exists()
        try:
            proc = subprocess.run(
                # empty helper first: ignore any global helper, use only ours
                ["git", "-c", "credential.helper=", "-c", f"credential.helper={helper}", "clone", clean_url, str(dest)],
                capture_output=True, text=True, timeout=600,
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            )
        except FileNotFoundError as exc:
            raise GitError("git not installed on the runtime") from exc
        except subprocess.TimeoutExpired as exc:
            if not existed:
                shutil.rmtree(dest, ignore_errors=True)  # no half-cloned leftovers
            raise GitError("clone timed out") from exc
        if proc.returncode != 0:
            if not existed:
                shutil.rmtree(dest, ignore_errors=True)
            raise GitError(f"clone failed: {proc.stderr.strip()[:300]}")
        # Pushes by the agent authenticate through the same out-of-repo file.
        for args in (
            ["config", "--local", "--replace-all", "credential.helper", ""],
            ["config", "--local", "--add", "credential.helper", helper],
            ["config", "user.name", acc["username"] or "My Mate Geny"],
            ["config", "user.email", f"{acc['username']}@users.noreply.{acc['provider']}.com"],
        ):
            subprocess.run(["git", "-C", str(dest), *args], check=False, capture_output=True)
        return {"path": str(dest), "cloned": True}
