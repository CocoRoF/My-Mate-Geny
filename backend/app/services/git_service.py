"""GitHub / GitLab integration — connect an account, list repos, clone to a
local workspace the agent can work in (and push back, auth via the token)."""

from __future__ import annotations

import json
import os
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


def git_info(run) -> dict[str, Any]:
    """Compute a workspace's git context using a ``run(args) -> (rc, stdout)``.

    Works for local (subprocess) or remote (ssh) by swapping ``run``.
    """
    rc, out = run(["rev-parse", "--is-inside-work-tree"])
    if rc != 0 or out.strip() != "true":
        return {"is_repo": False}
    _, remote = run(["remote", "get-url", "origin"])
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
    h = {"User-Agent": "hr-harnessor", "Accept": "application/json"}
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

    def _token(self, aid: str) -> tuple[dict, str]:
        r = self._db.query_one("SELECT * FROM git_accounts WHERE id = ?", (aid,))
        if r is None:
            raise GitError("git account not found")
        return dict(r), self._vault.read(r["token_ref"])

    # ---- repos ----

    def repos(self, aid: str, query: str = "") -> list[dict]:
        acc, token = self._token(aid)
        provider, host = acc["provider"], acc["host"]
        base = _api_base(provider, host)
        try:
            if provider == "github":
                url = f"{base}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member"
                data = _req(url, token, provider)
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

    def _tokenized_url(self, clone_url: str, provider: str, username: str, token: str) -> str:
        p = urllib.parse.urlsplit(clone_url)
        if provider == "github":
            userinfo = f"x-access-token:{token}"
        else:
            userinfo = f"oauth2:{token}"
        return urllib.parse.urlunsplit((p.scheme, f"{userinfo}@{p.netloc}", p.path, p.query, p.fragment))

    def clone(self, aid: str, full_name: str, clone_url: str) -> dict:
        acc, token = self._token(aid)
        dest = settings.repos_root_path / acc["provider"] / full_name
        if (dest / ".git").exists():
            return {"path": str(dest), "cloned": False}
        dest.parent.mkdir(parents=True, exist_ok=True)
        auth_url = self._tokenized_url(clone_url, acc["provider"], acc["username"] or "", token)
        try:
            proc = subprocess.run(
                ["git", "clone", auth_url, str(dest)],
                capture_output=True, text=True, timeout=300,
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            )
        except FileNotFoundError as exc:
            raise GitError("git not installed on the runtime") from exc
        except subprocess.TimeoutExpired as exc:
            raise GitError("clone timed out") from exc
        if proc.returncode != 0:
            raise GitError(f"clone failed: {proc.stderr.strip()[:300]}")
        # Identify the agent as the user for commits.
        try:
            subprocess.run(["git", "-C", str(dest), "config", "user.name", acc["username"] or "hr-harnessor"], check=False)
            subprocess.run(["git", "-C", str(dest), "config", "user.email", f"{acc['username']}@users.noreply.{acc['provider']}.com"], check=False)
        except Exception:  # noqa: BLE001
            pass
        return {"path": str(dest), "cloned": True}
