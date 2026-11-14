"""Higgsfield (docs/higgsfield.md): sign-in, tokens, the account API, and what a chat's agent gets.

Higgsfield itself is faked (FakeHiggsfield: its OAuth token endpoint and account gateway behind the service's
transport); nothing here talks to the network.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import stat
import tarfile
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.config import settings
from app.higgsfield import oauth
from app.higgsfield.agent import FILE_KEEP, HiggsfieldAgent, clean_settings, session_settings
from app.higgsfield.oauth import HiggsfieldError
from app.higgsfield.service import HiggsfieldService
from app.providers.base import ProviderEvent, TurnRequest
from app.providers.claude_code import ClaudeCodeProvider
from app.providers.codex import CodexProvider
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

API = settings.higgsfield_api_base
TOKEN_URL = settings.higgsfield_token_url


class FakeHiggsfield:
    """Higgsfield's token endpoint + account gateway. Refresh tokens rotate on every use (like Clerk's)."""

    def __init__(self, *, email: str = "me@example.com", credits: float = 120.5) -> None:
        self.email, self.credits = email, credits
        self.access: set[str] = set()
        self.refresh: set[str] = set()
        self.codes: dict[str, str] = {}  # code -> PKCE challenge
        self.token_calls = 0
        self.refresh_calls = 0
        self.calls: list[tuple[str, str, dict]] = []
        self.transactions: list[dict] = []
        self.refresh_delay = 0.0
        self.echo_secrets_in_errors = False
        self._n = 0
        self._lock = threading.Lock()

    def issue(self, *, lifetime: int = 86400) -> dict:
        with self._lock:
            self._n += 1
            n = self._n
        a, r = f"oat_ACCESS{n:04d}xxxxxxxxxxxxxxxxxxxxxx", f"REFRESH{n:04d}-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
        self.access.add(a)
        self.refresh.add(r)
        return {"access_token": a, "refresh_token": r, "expires_in": lifetime, "token_type": "bearer"}

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url, dict(headers)))
        if url == TOKEN_URL:
            return self._token(urllib.parse.parse_qs((body or b"").decode()))
        assert url.startswith(API), url
        path = urllib.parse.urlparse(url).path[len(urllib.parse.urlparse(API).path):]
        auth = headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or auth[7:] not in self.access:
            return 401, b'{"detail": "Not authenticated"}'
        if path == "/account/workspaces":
            return 200, json.dumps({"items": [
                {"id": "ws-team", "name": "Team", "type": "team"},
                {"id": "ws-me", "name": "Mine", "type": "private", "is_selected": True}]}).encode()
        if path == "/account/balance":
            return 200, json.dumps({"credits": self.credits, "email": self.email,
                                    "subscription_plan_type": "ultra"}).encode()
        if path == "/account/transactions":
            return 200, json.dumps({"cursor": None, "items": self.transactions}).encode()
        if path == "/job_types":
            return 200, json.dumps([{"job_type": "z_image", "display_name": "Z Image", "type": "image"},
                                    {"job_type": "seedance_2_5", "display_name": "Seedance 2.5", "type": "video"}]).encode()
        if path == "/jobs/bogus/cost":
            return 404, b'{"error_type": "unknown_job_type", "text": "no job_type \'bogus\'"}'
        if path.startswith("/jobs/") and path.endswith("/cost") and method == "POST":
            return 200, b'{"credits": 7}'
        return 404, b'{"detail": "no such path"}'

    def _token(self, form):
        grant = form.get("grant_type", [""])[0]
        assert form.get("client_id") == [oauth.CLIENT_ID]
        with self._lock:
            self.token_calls += 1
        if grant == "authorization_code":
            code, verifier = form["code"][0], form["code_verifier"][0]
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            if self.codes.pop(code, None) != challenge or form["redirect_uri"] != [oauth.REDIRECT_URI]:
                return 400, b'{"error": "invalid_grant", "error_description": "bad code"}'
            return 200, json.dumps(self.issue()).encode()
        if grant == "refresh_token":
            with self._lock:
                self.refresh_calls += 1
            time.sleep(self.refresh_delay)  # (a worker thread: lets a second caller pile up)
            r = form["refresh_token"][0]
            with self._lock:
                ok = r in self.refresh
                self.refresh.discard(r)  # rotated: the old one is dead now
            if not ok:
                said = f"refresh_token={r} is invalid" if self.echo_secrets_in_errors else "token is invalid"
                return 400, json.dumps({"error": "invalid_grant", "error_description": said}).encode()
            return 200, json.dumps(self.issue()).encode()
        return 400, b'{"error": "unsupported_grant_type"}'


@pytest.fixture
def fake():
    return FakeHiggsfield()


@pytest.fixture
def svc(db, fake):
    return HiggsfieldService(db, SecretVault(db), transport=fake)


async def _connect(svc: HiggsfieldService, fake: FakeHiggsfield) -> dict:
    start = svc.start_login()
    q = urllib.parse.parse_qs(urllib.parse.urlparse(start["authorize_url"]).query)
    fake.codes["the-code"] = q["code_challenge"][0]
    return await svc.complete_login(f"http://localhost:8765/callback?code=the-code&state={q['state'][0]}")


# ---- sign-in pieces ----


def test_pkce_link_is_the_cli_client_with_s256():
    svc_link = oauth.authorize_url("https://clerk.higgsfield.ai/oauth/authorize", "st4te", "ch4llenge")
    u = urllib.parse.urlparse(svc_link)
    q = urllib.parse.parse_qs(u.query)
    assert f"{u.scheme}://{u.netloc}{u.path}" == "https://clerk.higgsfield.ai/oauth/authorize"
    assert q == {"client_id": [oauth.CLIENT_ID], "code_challenge": ["ch4llenge"], "code_challenge_method": ["S256"],
                 "redirect_uri": ["http://localhost:8765/callback"], "response_type": ["code"],
                 "scope": ["email profile offline_access user:org:read"], "state": ["st4te"]}
    verifier, challenge = oauth.pkce()
    assert 43 <= len(verifier) <= 128
    assert challenge == base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def test_start_login_links_are_unique_and_expire(svc):
    a, b = svc.start_login(), svc.start_login()
    assert a["state"] != b["state"] and a["authorize_url"] != b["authorize_url"]
    assert a["redirect_uri"] == "http://localhost:8765/callback" and a["expires_in"] == 15 * 60


@pytest.mark.parametrize("pasted, expect", [
    ("http://localhost:8765/callback?code=abc123&state=xyz", ("abc123", "xyz")),
    ("  http://localhost:8765/callback?state=xyz&code=abc123  ", ("abc123", "xyz")),
    ("localhost:8765/callback?code=abc123&state=xyz", ("abc123", "xyz")),
    ("?code=abc123&state=xyz", ("abc123", "xyz")),
    ("code=abc123", ("abc123", None)),
    ("abc123", ("abc123", None)),
])
def test_parse_callback(pasted, expect):
    assert oauth.parse_callback(pasted) == expect


@pytest.mark.parametrize("pasted, code", [
    ("", "invalid_callback"),
    ("http://localhost:8765/callback?state=xyz", "invalid_callback"),
    ("https://higgsfield.ai/some/page", "invalid_callback"),
    ("two words", "invalid_callback"),
    ("http://localhost:8765/callback?error=access_denied&error_description=User+said+no", "oauth_denied"),
])
def test_parse_callback_rejects(pasted, code):
    with pytest.raises(HiggsfieldError) as e:
        oauth.parse_callback(pasted)
    assert e.value.code == code


def test_normalize_tokens_from_cli_credentials_and_token_answers():
    now = datetime(2026, 11, 2, tzinfo=timezone.utc)
    cli = {"auth_version": 2, "access_token": "oat_abc", "refresh_token": "ref", "expires_at": 1793600000,
           "token_type": "bearer", "scope": "email"}
    t = oauth.normalize_tokens(json.dumps(cli), now=now)
    assert t == {"access": "oat_abc", "refresh": "ref", "issued_at": now.isoformat(),
                 "expires_at": datetime.fromtimestamp(1793600000, timezone.utc).isoformat()}
    t = oauth.normalize_tokens({"access_token": "oat_x", "expires_in": 3600}, now=now)
    assert t["refresh"] is None and t["expires_at"] == (now + timedelta(hours=1)).isoformat()
    assert oauth.normalize_tokens("not json") is None
    assert oauth.normalize_tokens({"refresh_token": "only"}) is None


def test_needs_refresh_margins():
    issued = datetime(2026, 11, 2, tzinfo=timezone.utc)
    tokens = {"issued_at": issued.isoformat(), "expires_at": (issued + timedelta(hours=24)).isoformat()}
    assert not oauth.needs_refresh(tokens, issued + timedelta(hours=23))
    assert oauth.needs_refresh(tokens, issued + timedelta(hours=23, minutes=51))  # the last 10 minutes
    # a token handed to an agent keeps 45 minutes
    assert oauth.needs_refresh(tokens, issued + timedelta(hours=23, minutes=20), keep=FILE_KEEP)
    assert not oauth.needs_refresh(tokens, issued + timedelta(hours=23), keep=FILE_KEEP)
    assert not oauth.needs_refresh({"expires_at": None})


def test_redaction_hides_tokens_and_codes():
    text = ('Bearer oat_SECRETSECRET1234 failed; {"refresh_token": "R3fr3sh-very-secret"} '
            'at https://x/cb?code=abc&state=s with access_token=oat_more')
    out = oauth.redact(text, "R3fr3sh-very-secret")
    for secret in ("oat_SECRETSECRET1234", "R3fr3sh-very-secret", "code=abc", "oat_more"):
        assert secret not in out
    assert "\n" not in oauth.redact("a\nb")


# ---- the service ----


async def test_connect_flow_stores_sealed_tokens_and_shows_the_account(svc, fake, db):
    acc = await _connect(svc, fake)
    assert acc["email"] == "me@example.com" and acc["plan"] == "ultra" and acc["credits"] == 120.5
    assert acc["workspace_id"] == "ws-me"  # the selected one
    assert [w["id"] for w in acc["workspaces"]] == ["ws-team", "ws-me"]
    assert acc["is_default"] and acc["status"] == "ok" and acc["has_refresh_token"]
    assert "access" not in json.dumps(acc).replace("access_", "") and "oat_" not in json.dumps(acc)
    # sealed in the vault: the ciphertext carries no token
    row = db.query_one("SELECT ciphertext FROM secrets WHERE id = ?", (f"higgsfield:{acc['id']}",))
    assert row is not None and b"oat_" not in row["ciphertext"] and b"REFRESH" not in row["ciphertext"]
    assert svc.tokens_of(acc["id"])["access"].startswith("oat_ACCESS")
    # the workspace goes to the account gateway with every call
    assert fake.calls[-1][2].get("hf-workspace-id") == "ws-me"


async def test_login_callback_needs_its_own_state_and_expires(svc, fake):
    start = svc.start_login()
    q = urllib.parse.parse_qs(urllib.parse.urlparse(start["authorize_url"]).query)
    fake.codes["c"] = q["code_challenge"][0]
    with pytest.raises(HiggsfieldError) as e:
        await svc.complete_login("http://localhost:8765/callback?code=c&state=someone-elses")
    assert e.value.code == "login_expired"
    # the bare code works while exactly one login waits
    acc = await svc.complete_login("c")
    assert acc["email"] == "me@example.com"
    with pytest.raises(HiggsfieldError) as e:  # and only once
        await svc.complete_login(f"http://localhost:8765/callback?code=c&state={q['state'][0]}")
    assert e.value.code == "login_expired"


async def test_wrong_code_is_a_token_exchange_failure(svc, fake):
    start = svc.start_login()
    state = urllib.parse.parse_qs(urllib.parse.urlparse(start["authorize_url"]).query)["state"][0]
    with pytest.raises(HiggsfieldError) as e:
        await svc.complete_login(f"http://localhost:8765/callback?code=nope&state={state}")
    assert e.value.code == "token_exchange_failed" and svc.accounts() == []


async def test_import_credentials_json(svc, fake):
    t = fake.issue()
    cli = {"auth_version": 2, "access_token": t["access_token"], "refresh_token": t["refresh_token"],
           "expires_at": int(time.time()) + 3600, "token_type": "bearer", "scope": oauth.SCOPES}
    acc = await svc.import_credentials(json.dumps(cli))
    assert acc["source"] == "import" and acc["email"] == "me@example.com" and acc["has_refresh_token"]
    # the same account again (same email): signed in again, not a second account
    again = await svc.import_credentials(cli)
    assert again["id"] == acc["id"] and len(svc.accounts()) == 1


async def test_import_rejects_bad_or_signed_out_credentials(svc, fake):
    with pytest.raises(HiggsfieldError) as e:
        await svc.import_credentials("{not json")
    assert e.value.code == "import_failed"
    with pytest.raises(HiggsfieldError) as e:
        await svc.import_credentials({"access_token": "oat_revoked", "refresh_token": "x"})
    assert e.value.code == "import_failed"
    assert svc.accounts() == []  # nothing stored


async def test_two_concurrent_refreshes_make_one_call(svc, fake):
    acc = await _connect(svc, fake)
    aid = acc["id"]
    old = svc.tokens_of(aid)
    # make it due: 5 minutes left of a day
    svc._put_tokens(aid, {**old, "issued_at": (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(),
                          "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()})
    fake.refresh_delay = 0.3
    a, b = await asyncio.gather(svc.access_token(aid), svc.access_token(aid))
    assert fake.refresh_calls == 1
    assert a == b and a["access"] != old["access"]
    assert a["refresh"] != old["refresh"]  # rotated, and the new one is what is stored
    assert svc.tokens_of(aid)["refresh"] == a["refresh"] and a["refresh"] in fake.refresh


async def test_a_401_refreshes_once_even_with_two_callers(svc, fake):
    acc = await _connect(svc, fake)
    aid = acc["id"]
    stale = svc.tokens_of(aid)["access"]
    fake.access.clear()  # Higgsfield no longer takes the access token
    data = await svc.api(aid, "GET", "/account/balance")
    assert data["credits"] == 120.5 and fake.refresh_calls == 1
    # another call that failed with the same stale token gets the fresh one (no second rotation)
    fresh = await svc.access_token(aid, failed=stale)
    assert fake.refresh_calls == 1 and fresh["access"] != stale


async def test_dead_refresh_token_means_sign_in_again(svc, fake):
    fake.echo_secrets_in_errors = True
    acc = await _connect(svc, fake)
    aid = acc["id"]
    stolen = svc.tokens_of(aid)["refresh"]
    fake.refresh.clear()  # e.g. signed out on higgsfield.ai
    with pytest.raises(HiggsfieldError) as e:
        await svc.access_token(aid, force=True)
    assert e.value.code == "reauth_required"
    assert stolen not in e.value.message  # redacted
    assert svc.account(aid)["status"] == "reauth"


async def test_account_api_pieces(svc, fake):
    acc = await _connect(svc, fake)
    fake.transactions = [{"action": "spend", "created_at": "2026-11-02T01:45:51Z", "credits": -1.5,
                          "display_name": "Nano Banana 2"}]
    tx = await svc.transactions(acc["id"])
    assert tx["items"][0] == {"action": "spend", "created_at": "2026-11-02T01:45:51Z", "credits": -1.5,
                              "display_name": "Nano Banana 2"}
    jts = await svc.job_types(acc["id"])
    assert [j["type"] for j in jts] == ["image", "video"]
    assert (await svc.quote(acc["id"], "z_image", {"prompt": "x"}))["credits"] == 7
    with pytest.raises(HiggsfieldError) as e:
        await svc.quote(acc["id"], "bogus", {})
    assert e.value.code == "unknown_job_type" and e.value.status == 404
    with pytest.raises(HiggsfieldError):
        await svc.quote(acc["id"], "../purchase", {})
    # never a purchase endpoint
    assert not any("purchase" in url or "billing" in url for _, url, _ in fake.calls)
    ws = svc.set_workspace(acc["id"], "ws-team")
    assert ws["workspace_id"] == "ws-team"
    with pytest.raises(HiggsfieldError):
        svc.set_workspace(acc["id"], "ws-unknown")


async def test_default_account_and_disconnect(svc, fake):
    a = await _connect(svc, fake)
    fake.email = "other@example.com"
    b = await _connect(svc, fake)
    assert a["id"] != b["id"] and svc.default_id() == a["id"]
    svc.set_default(b["id"])
    assert svc.default_id() == b["id"]
    svc.disconnect(b["id"])
    assert svc.default_id() == a["id"] and svc.account(a["id"])["is_default"]
    assert svc.tokens_of(b["id"]) is None


# ---- what a chat's agent gets ----


@pytest.fixture
def cli(tmp_path, monkeypatch):
    """A stand-in `higgsfield` CLI (the real one isn't installed on every test machine)."""
    p = tmp_path / "hf-cli" / "higgsfield"
    p.parent.mkdir()
    p.write_text("#!/bin/sh\necho fake\n")
    p.chmod(0o755)
    monkeypatch.setattr(settings, "higgsfield_binary", str(p))
    return p


@pytest.fixture
def agent(svc, tmp_path, monkeypatch, cli):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))  # no host skills
    return HiggsfieldAgent(svc, root=tmp_path / "hf-root")


def _session(sid="sess_1", **kw):
    return {"id": sid, "connection_id": None, "kind": "chat", "higgsfield": None, **kw}


async def test_not_connected_changes_nothing(agent):
    assert await agent.launch("sess_1", _session(), provider="claude") is None


async def test_enabled_chat_gets_cli_and_an_access_only_credentials_file(agent, svc, fake, cli):
    acc = await _connect(svc, fake)
    launch = await agent.launch("sess_1", _session(), provider="claude")
    assert launch.enabled and launch.account_id == acc["id"]
    env = launch.env
    bin_dir = env["PATH"].split(os.pathsep)[0]
    assert os.path.realpath(os.path.join(bin_dir, "higgsfield")) == os.path.realpath(cli)
    creds = Path(env["HIGGSFIELD_CREDENTIALS_PATH"])
    data = json.loads(creds.read_text())
    assert set(data) == {"auth_version", "access_token", "token_type", "scope"}  # no refresh token, no expiry
    assert data["access_token"] == svc.tokens_of(acc["id"])["access"]
    assert stat.S_IMODE(creds.stat().st_mode) == 0o600
    assert stat.S_IMODE(creds.parent.stat().st_mode) == 0o700
    assert json.loads(Path(env["HIGGSFIELD_CONFIG_PATH"]).read_text()) == {"workspace_id": "ws-me"}
    assert env["HIGGSFIELD_NO_UPDATE_CHECK"] == "1"
    assert not str(creds).startswith(os.path.expanduser("~/.config"))
    assert "Higgsfield" in launch.prompt and "never run `higgsfield auth login" in launch.prompt
    assert "me@example.com" in launch.prompt


async def test_disabled_chat_gets_no_credentials(agent, svc, fake):
    await _connect(svc, fake)
    await agent.launch("sess_1", _session(), provider="claude")
    launch = await agent.launch("sess_1", _session(higgsfield={"enabled": False}), provider="claude")
    assert not launch.enabled
    assert not os.path.exists(launch.env["HIGGSFIELD_CREDENTIALS_PATH"])
    assert not (agent.session_dir("sess_1") / "credentials.json").exists()  # the earlier file is gone too
    assert "PATH" not in launch.env and "switched off" in launch.prompt


async def test_signed_out_account_is_a_notice_not_a_failure(agent, svc, fake):
    acc = await _connect(svc, fake)
    svc._vault.delete(svc._secret_ref(acc["id"]))
    launch = await agent.launch("sess_1", _session(), provider="claude")
    assert not launch.enabled and launch.notices[0]["code"] == "higgsfield.signed_out"
    again = await agent.launch("sess_1", _session(), provider="claude")
    assert again.notices == []  # told once


async def test_token_refresh_rewrites_live_chats_files(agent, svc, fake):
    acc = await _connect(svc, fake)
    launch = await agent.launch("sess_1", _session(), provider="claude")
    creds = Path(launch.env["HIGGSFIELD_CREDENTIALS_PATH"])
    before = json.loads(creds.read_text())["access_token"]
    await svc.access_token(acc["id"], force=True)
    after = json.loads(creds.read_text())["access_token"]
    assert after != before and after == svc.tokens_of(acc["id"])["access"]
    svc.disconnect(acc["id"])
    assert not creds.exists()


async def test_keeper_refreshes_due_tokens_and_drops_idle_chats(agent, svc, fake):
    acc = await _connect(svc, fake)
    live = {"sess_live"}
    agent.is_live = lambda sid: sid in live
    l1 = await agent.launch("sess_live", _session("sess_live"), provider="claude")
    l2 = await agent.launch("sess_idle", _session("sess_idle"), provider="codex")
    old = svc.tokens_of(acc["id"])
    svc._put_tokens(acc["id"], {**old, "issued_at": (datetime.now(timezone.utc) - timedelta(hours=23, minutes=30)).isoformat(),
                                "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()})
    idle_account = agent.session_dir("sess_idle") / "account"
    os.utime(idle_account, (time.time() - 3600, time.time() - 3600))
    calls = fake.refresh_calls
    await agent.keep_fresh()
    assert fake.refresh_calls == calls + 1  # less than 45 minutes left: refreshed once
    assert json.loads(Path(l1.env["HIGGSFIELD_CREDENTIALS_PATH"]).read_text())["access_token"] == svc.tokens_of(acc["id"])["access"]
    assert not Path(l2.env["HIGGSFIELD_CREDENTIALS_PATH"]).exists()  # idle: no token left on disk
    agent.session_exists = lambda sid: sid != "sess_live"
    await agent.keep_fresh()
    assert not agent.session_dir("sess_live").exists()  # deleted chat: folder gone


async def test_a_live_chats_refresh_never_keeps_an_idle_chat_of_the_same_account(agent, svc, fake, monkeypatch):
    """The keeper visits the live chat first (the folder order the CI runner had): its refresh rewrites every chat of that account,
    and that must not reset the idle chat's clock."""
    acc = await _connect(svc, fake)
    agent.is_live = lambda sid: sid == "sess_live"
    await agent.launch("sess_live", _session("sess_live"), provider="claude")
    idle = await agent.launch("sess_idle", _session("sess_idle"), provider="codex")
    old = svc.tokens_of(acc["id"])
    svc._put_tokens(acc["id"], {**old, "issued_at": (datetime.now(timezone.utc) - timedelta(hours=23, minutes=30)).isoformat(),
                                "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()})
    os.utime(agent.session_dir("sess_idle") / "account", (time.time() - 3600, time.time() - 3600))
    real = Path.iterdir
    monkeypatch.setattr(Path, "iterdir", lambda self: iter(sorted(real(self), key=lambda d: d.name != "sess_live")))
    await agent.keep_fresh()
    assert not Path(idle.env["HIGGSFIELD_CREDENTIALS_PATH"]).exists()


async def test_prompt_variants(agent, svc, fake):
    await _connect(svc, fake)
    remote = await agent.launch("s", _session(connection_id="conn_1", higgsfield={"max_credits": 25}), provider="claude")
    assert "remote_bash" in remote.prompt and "above 25 credits" in remote.prompt
    assert len(remote.prompt) < 1100  # a few lines, no bloat
    codex = await agent.launch("s2", _session(), provider="codex")
    assert "SKILL.md" not in codex.prompt and "higgsfield model list" in codex.prompt  # no skills installed


def test_session_settings_are_validated():
    assert session_settings({}) == {"enabled": True, "max_credits": None}
    assert session_settings({"higgsfield": '{"enabled": false, "max_credits": 10}'}) == {"enabled": False, "max_credits": 10}
    assert clean_settings({"max_credits": 5}, {"enabled": False}) == {"enabled": False, "max_credits": 5}
    for bad in ({"enabled": "yes"}, {"max_credits": -1}, {"max_credits": True}, {"sneaky": 1}):
        with pytest.raises(ValueError):
            clean_settings(bad)


def _skills_tar(files: dict[str, str | bytes], *, link: bool = False) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode() if isinstance(content, str) else content
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        if link:
            info = tarfile.TarInfo("skills-main/higgsfield-evil/SKILL.md")
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            tar.addfile(info)
    return buf.getvalue()


async def test_install_skills_takes_only_higgsfield_skills(agent, svc, fake, monkeypatch, tmp_path):
    archive = _skills_tar({
        "skills-main/README.md": "x",
        "skills-main/higgsfield-generate/SKILL.md": "---\nname: higgsfield-generate\n---\n",
        "skills-main/higgsfield-generate/references/models.md": "m",
        "skills-main/other-skill/SKILL.md": "no",
        "skills-main/higgsfield-x/../../escape.txt": "no",
    }, link=True)

    def transport(method, url, headers, body, timeout):
        assert url == settings.higgsfield_skills_url and method == "GET"
        return 200, archive

    svc.transport = transport
    state = await agent.install_skills()
    assert state["bundled"] == ["higgsfield-generate"]
    plugin = agent.plugin_dir
    assert (plugin / ".claude-plugin" / "plugin.json").is_file()
    assert (plugin / "skills/higgsfield-generate/references/models.md").read_text() == "m"
    assert not (plugin / "skills/other-skill").exists() and not (plugin / "skills/higgsfield-evil").exists()
    assert not list(tmp_path.rglob("escape.txt"))
    # a Claude chat now loads it as a plugin; Codex is pointed at the files
    svc.transport = fake
    await _connect(svc, fake)
    claude = await agent.launch("s", _session(), provider="claude")
    assert claude.plugin_dirs == [str(plugin)] and "higgsfield-* skills" in claude.prompt
    codex = await agent.launch("s2", _session(), provider="codex")
    assert codex.plugin_dirs == [] and f"{plugin}/skills/higgsfield-generate/SKILL.md" in codex.prompt
    assert agent.remove_skills()["bundled"] == []


# ---- the engines' launch ----


def test_claude_argv_env_and_fingerprint_carry_higgsfield(tmp_path):
    p = ClaudeCodeProvider(binary="claude")
    base = TurnRequest(messages=[], model="opus", cwd=str(tmp_path))
    hf = TurnRequest(messages=[], model="opus", cwd=str(tmp_path), tool_env={"HIGGSFIELD_CREDENTIALS_PATH": "/x/c.json",
                     "PATH": "/hf/bin:/usr/bin"}, system_append="Higgsfield is connected.", plugin_dirs=["/hf/plugin"])
    argv = p.engine_argv(hf)
    appended = argv[argv.index("--append-system-prompt") + 1]
    assert appended.endswith("\n\nHiggsfield is connected.")
    assert argv[argv.index("--plugin-dir") + 1] == "/hf/plugin"
    assert "--plugin-dir" not in p.engine_argv(base)
    assert p.engine_env(hf)["HIGGSFIELD_CREDENTIALS_PATH"] == "/x/c.json"
    assert p.engine_fingerprint(hf) != p.engine_fingerprint(base)
    # turning it off changes the engine (it restarts with the new prompt and env)
    off = TurnRequest(messages=[], model="opus", cwd=str(tmp_path), tool_env={"HIGGSFIELD_CREDENTIALS_PATH": "/x/off"},
                      system_append="off")
    assert p.engine_fingerprint(off) != p.engine_fingerprint(hf)


def test_codex_gets_the_note_once_and_the_env(tmp_path):
    p = CodexProvider(binary="codex")
    req = TurnRequest(messages=[{"role": "user", "content": "draw a cat"}], model="", cwd=str(tmp_path),
                      system_append="Higgsfield is connected.", note_in_prompt=True)
    assert p._build_prompt(req).decode().startswith("<environment_note>\nHiggsfield is connected.\n</environment_note>")
    req.note_in_prompt = False
    assert p._build_prompt(req).decode() == "draw a cat"


# ---- the session wiring ----


class CaptureProvider:
    """A one-shot provider that records what it was given and runs one higgsfield command."""

    name = "claude"
    seen: list[TurnRequest] = []

    async def run_turn_stream(self, req):
        CaptureProvider.seen.append(req)
        yield ProviderEvent(type="session.start", data={"model": "fake"})
        yield ProviderEvent(type="tool.use", data={"id": "t1", "name": "Bash",
                                                   "input": {"command": "higgsfield generate create z_image --wait"}})
        yield ProviderEvent(type="tool.result", data={"id": "t1", "output": "ok", "is_error": False})
        yield ProviderEvent(type="turn.complete", data={"text": "done", "cli_session_id": "c1"})


async def test_session_turns_get_higgsfield_only_when_connected_and_enabled(db, svc, fake, agent, tmp_path, monkeypatch):
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: CaptureProvider())
    CaptureProvider.seen = []
    vault = SecretVault(db)
    sessions = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    sessions.higgsfield = agent
    agent.is_live, agent.session_exists = sessions.is_live, sessions.exists
    s = sessions.create(provider="claude", workspace_path=str(tmp_path))

    async def turn(text):
        return [e async for e in sessions.run_turn(s["id"], text)]

    await turn("before connecting")
    assert CaptureProvider.seen[-1].tool_env == {} and CaptureProvider.seen[-1].system_append == ""

    acc = await _connect(svc, fake)
    fake.transactions = [{"action": "spend", "created_at": datetime.now(timezone.utc).isoformat(), "credits": -1.5,
                          "display_name": "Z Image"}]
    events = await turn("make a picture")
    req = CaptureProvider.seen[-1]
    creds = req.tool_env["HIGGSFIELD_CREDENTIALS_PATH"]
    assert json.loads(open(creds).read())["access_token"] == svc.tokens_of(acc["id"])["access"]
    assert "Higgsfield" in req.system_append
    spend = [e for e in events if e.type == "notice" and e.data.get("code") == "higgsfield.spend"]
    assert len(spend) == 1 and spend[0].data["credits_used"] == 1.5 and spend[0].data["balance"] == 120.5
    assert [e.type for e in events][-2:] == ["notice", "turn.complete"]  # before the answer closes the turn
    assert sessions.get(s["id"])["higgsfield"] == {"enabled": True, "max_credits": None}

    sessions.update(s["id"], higgsfield={"enabled": False})
    assert not os.path.exists(creds)  # taken away at once
    await turn("again")
    off = CaptureProvider.seen[-1]
    assert "PATH" not in off.tool_env and not os.path.exists(off.tool_env["HIGGSFIELD_CREDENTIALS_PATH"])
    assert "switched off" in off.system_append

    with pytest.raises(ValueError):
        sessions.update(s["id"], higgsfield={"max_credits": "lots"})
    sessions.delete(s["id"])
    assert not agent.session_dir(s["id"]).exists()


# ---- a real engine process (the fake Claude CLI) ----

FAKE_CLAUDE = Path(__file__).resolve().parents[2] / "desktop" / "test" / "e2e" / "fake-claude.py"


@pytest.mark.skipif(not os.access(FAKE_CLAUDE, os.X_OK), reason="needs desktop/test/e2e/fake-claude.py")
async def test_engine_process_gets_higgsfield_only_when_enabled(db, svc, fake, tmp_path, monkeypatch):
    """A persistent Claude engine (the fake CLI) runs `higgsfield auth token` the way an agent's Bash tool would:
    with Higgsfield on it finds the CLI on PATH and the server's access-only credentials; off, neither."""
    cli = tmp_path / "bin" / "higgsfield"
    cli.parent.mkdir()
    cli.write_text("#!/usr/bin/env -S python3 -P\nimport json, os, sys\n"
                   "if sys.argv[1:3] != ['auth', 'token']:\n    sys.exit(2)\n"
                   "print(json.load(open(os.environ['HIGGSFIELD_CREDENTIALS_PATH']))['access_token'])\n")
    cli.chmod(0o755)
    monkeypatch.setattr(settings, "higgsfield_binary", str(cli))
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", "/usr/local/bin:/usr/bin:/bin")  # (no real higgsfield CLI from ~/.local/bin)
    agent = HiggsfieldAgent(svc, root=tmp_path / "hf-root")
    provider = ClaudeCodeProvider(binary=str(FAKE_CLAUDE))
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: provider)
    vault = SecretVault(db)
    sessions = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    sessions.higgsfield = agent
    ws = tmp_path / "ws"
    ws.mkdir()
    s = sessions.create(provider="claude", workspace_path=str(ws))

    async def answer(text):
        events = [e async for e in sessions.run_turn(s["id"], text)]
        done = [e for e in events if e.type == "turn.complete"]
        assert done, [e.to_dict() for e in events]
        return done[-1].data["text"], events

    try:
        acc = await _connect(svc, fake)
        text, events = await answer("hfcheck")
        token = hashlib.sha256(svc.tokens_of(acc["id"])["access"].encode()).hexdigest()[:12]
        assert f"cli=yes creds=yes keys=access_token,auth_version,scope,token_type token={token}" in text
        assert "user_file=untouched" in text and "note=yes" in text
        assert any(e.type == "notice" and e.data.get("code") == "higgsfield.spend" for e in events)
        dump, _ = await answer("hfdump")
        launch = json.loads(dump.removeprefix("HFDUMP "))
        assert launch["env"]["PATH"].split(os.pathsep)[0] == str(tmp_path / "hf-root" / "bin")
        assert launch["env"]["HIGGSFIELD_CREDENTIALS_PATH"].startswith(str(tmp_path / "hf-root" / "sessions"))
        assert launch["mcp"] is None  # (a local chat: no MCP bridge; Higgsfield comes as the CLI)

        sessions.update(s["id"], higgsfield={"enabled": False})
        text, _ = await answer("hfcheck")  # the engine restarts: new prompt and environment
        assert "cli=no creds=no" in text and "note=off" in text and token not in text
    finally:
        await sessions.shutdown()
