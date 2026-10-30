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


def _api_base(provider: str, host: str | None) -> str:
    if provider == "github":
        return "https://api.github.com"
    h = (host or "gitlab.com").replace("https://", "").replace("http://", "").strip("/")
    return f"https://{h}/api/v4"


def _req(url: str, token: str, provider: str) -> Any:
    headers = {"User-Agent": "hr-harnessor", "Accept": "application/json"}
    if provider == "github":
        headers["Authorization"] = f"Bearer {token}"
        headers["Accept"] = "application/vnd.github+json"
    else:
        headers["PRIVATE-TOKEN"] = token
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


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
            me = _req(f"{base}/user", token, provider)
        except urllib.error.HTTPError as exc:
            raise GitError(f"token rejected ({exc.code}) — check scopes (repo/read_api)") from exc
        except Exception as exc:  # noqa: BLE001
            raise GitError(f"could not reach {provider}: {exc}") from exc
        username = me.get("login") or me.get("username") or ""
        aid = new_id(f"git_{provider}_")
        ref = self._vault.put("git", f"{aid}.token", token)
        self._db.execute(
            "INSERT INTO git_accounts (id, provider, label, host, username, token_ref, created_at) VALUES (?,?,?,?,?,?,?)",
            (aid, provider, label or username or provider, host, username, ref, now_iso()),
        )
        return self.get(aid)  # type: ignore[return-value]

    def _row(self, r) -> dict:
        return {
            "id": r["id"],
            "provider": r["provider"],
            "label": r["label"],
            "host": r["host"],
            "username": r["username"],
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
