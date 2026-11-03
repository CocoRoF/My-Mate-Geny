"""Login sessions + plan-usage fetching (docs/providers.md → Login sessions,
Plan usage): 429 handling (Retry-After, backoff, last numbers served,
coalescing, persistence), credential parsing for each format (fixtures — no
real token anywhere), health classification, renewal the CLI's way (fake CLI,
fake token endpoint: rotation, atomic write, the CLI's locks, re-reads), the
balancer skipping logins that need the user, and what the badge looks at."""

from __future__ import annotations

import base64
import email.message
import io
import json
import os
import stat
import sys
import textwrap
import threading
import time
import urllib.error
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app.providers import accounts as acc_mod
from app.providers import login_session as ls
from app.providers import session_renew as sr
from app.providers import subscription as sub
from app.providers.accounts import AccountPool, AccountSnapshot, AccountStore, choose, ineligible_reason
from app.providers.accounts import BalancerState
from app.providers.plan_fetch import PlanFetcher
from app.vault import SecretVault

FAKE_ACCESS = "sk-ant-oat01-FAKE-ACCESS-" + "a" * 40
FAKE_REFRESH = "sk-ant-ort01-FAKE-REFRESH-" + "r" * 40
NOW = 1_800_000_000.0


def claude_creds(path, *, expires_in=3600.0, refresh=FAKE_REFRESH, access=FAKE_ACCESS, now=None, extra=None,
                 top=None, mode=0o600):
    now = time.time() if now is None else now
    oauth = {"accessToken": access, "expiresAt": int((now + expires_in) * 1000),
             "scopes": ["user:inference", "user:profile"], "subscriptionType": "max",
             "rateLimitTier": "default_claude_max_20x"}
    if refresh is not None:
        oauth["refreshToken"] = refresh
    oauth.update(extra or {})
    os.makedirs(path, exist_ok=True)
    f = os.path.join(path, ".credentials.json")
    with open(f, "w") as fh:
        json.dump({"claudeAiOauth": oauth, **(top or {})}, fh)
    os.chmod(f, mode)
    return f


def _b64(o):
    return base64.urlsafe_b64encode(json.dumps(o).encode()).rstrip(b"=").decode()


def jwt(payload):
    return f"{_b64({'alg': 'none'})}.{_b64(payload)}.sig"


def codex_auth(path, *, exp_in=86400.0, refresh="rt_FAKE", now=None, mode="chatgpt", last_refresh=None):
    now = time.time() if now is None else now
    claims = {"chatgpt_plan_type": "pro", "chatgpt_account_id": "acc-1"}
    doc = {"auth_mode": mode, "OPENAI_API_KEY": None if mode == "chatgpt" else "sk-FAKE-KEY",
           "last_refresh": last_refresh or "2026-10-25T04:16:24.448534128Z"}
    if mode == "chatgpt":
        doc["tokens"] = {
            "id_token": jwt({"email": "dev@example.com", "exp": int(now + 3600), "https://api.openai.com/auth": claims}),
            "access_token": jwt({"exp": int(now + exp_in), "scp": ["openid", "profile", "email", "offline_access"],
                                 "https://api.openai.com/auth": claims}),
            "refresh_token": refresh,
            "account_id": "acc-1",
        }
    os.makedirs(path, exist_ok=True)
    f = os.path.join(path, "auth.json")
    with open(f, "w") as fh:
        json.dump(doc, fh)
    os.chmod(f, 0o600)
    return f


def http_error(code, headers=None, body=b""):
    msg = email.message.Message()
    for k, v in (headers or {}).items():
        msg[k] = v
    return urllib.error.HTTPError("https://x", code, "err", msg, io.BytesIO(body))


# ---------------------------------------------------------------- 429: Retry-After


def test_retry_after_parses_seconds_and_http_dates():
    assert sub.parse_retry_after("3600") == 3600.0
    assert sub.parse_retry_after(" 0 ") == 0.0
    when = datetime.fromtimestamp(NOW + 120, tz=timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")
    assert abs(sub.parse_retry_after(when, now=NOW) - 120.0) < 1.0
    assert sub.parse_retry_after(None) is None
    assert sub.parse_retry_after("soon") is None


def test_http_errors_carry_what_to_do():
    e = sub._http_error(http_error(429, {"Retry-After": "3600"}))
    assert (e.kind, e.status, e.retry_after) == ("rate_limited", 429, 3600.0) and "(429)" in str(e)
    assert sub._http_error(http_error(429)).retry_after is None
    assert sub._http_error(http_error(401)).kind == "auth"
    assert sub._http_error(http_error(403)).kind == "http"  # claude: 403 isn't "signed out"
    assert sub._http_error(http_error(403), auth_codes=(401, 403)).kind == "auth"  # codex
    assert sub._http_error(http_error(503)).kind == "http"


def test_claude_usage_reports_429_with_retry_after(monkeypatch, tmp_path):
    claude_creds(str(tmp_path))
    seen = []

    def fake_get(url, headers):
        seen.append(url)
        raise http_error(429, {"Retry-After": "3600"})

    monkeypatch.setattr(sub, "_get_json", fake_get)
    with pytest.raises(sub.UsageError) as exc:
        sub.claude_subscription(str(tmp_path), with_profile=False)
    assert exc.value.kind == "rate_limited" and exc.value.retry_after == 3600.0
    assert len(seen) == 1  # no profile call after a failure

    def ok_get(url, headers):
        seen.append(url)
        return {"five_hour": {"utilization": 10}, "seven_day": {"utilization": 20}}

    seen.clear()
    monkeypatch.setattr(sub, "_get_json", ok_get)
    sub.claude_subscription(str(tmp_path), with_profile=False)
    assert seen == ["https://api.anthropic.com/api/oauth/usage"]  # the balancer: one call, no profile


class Clock:
    def __init__(self, t=NOW):
        self.t = t

    def __call__(self):
        return self.t


def _ok(pct=10.0):
    return {"windows": [{"label": "5h", "percent": pct, "resets_at": None, "kind": "five_hour"},
                        {"label": "7d", "percent": pct, "resets_at": None, "kind": "seven_day"}],
            "model_windows": []}


def test_fetcher_respects_retry_after_and_serves_the_last_numbers():
    clock = Clock()
    f = PlanFetcher(clock=clock, jitter=lambda: 0.0)
    calls = []
    good = f.get("a", lambda wp: calls.append(1) or _ok(42.0))
    assert good["windows"][0]["percent"] == 42.0 and good["stale_reason"] is None and "error" not in good

    def throttled(wp):
        calls.append(1)
        raise sub.UsageError("usage request failed (429)", kind="rate_limited", status=429, retry_after=3600)

    clock.t += f.ttl_s
    v = f.get("a", throttled)
    # the last good numbers, when they were fetched, why they're old, when we'll ask again
    assert v["windows"][0]["percent"] == 42.0 and v["fetched_at"] == good["fetched_at"]
    assert v["stale_reason"] == "rate_limited" and "429" in v["error"]
    assert v["retry_at"] == datetime.fromtimestamp(clock.t + 3600, tz=timezone.utc).isoformat()
    for step in (60, 600, 2000):  # never inside the server's hour, even forced
        clock.t += step
        f.get("a", throttled)
        f.get("a", throttled, force=True)
    assert len(calls) == 2
    clock.t += 1000  # 3660 s later
    f.get("a", throttled)
    assert len(calls) == 3
    # it keeps refusing: our own backoff grows past what it asks for
    assert f.backoff("rate_limited", 4, 60) == f.rate_base_s * 8


def test_fetcher_backs_off_exponentially_without_retry_after():
    f = PlanFetcher(jitter=lambda: 0.0)
    assert [f.backoff("rate_limited", n, None) for n in (1, 2, 3, 4)] == [120.0, 240.0, 480.0, 960.0]
    assert f.backoff("rate_limited", 30, None) == f.rate_max_s
    assert [f.backoff("network", n, None) for n in (1, 2)] == [60.0, 120.0]
    assert f.backoff("network", 30, None) == f.error_max_s
    assert f.backoff("rate_limited", 1, 5) == f.retry_after_min_s  # clamped
    assert f.backoff("rate_limited", 1, 10 ** 9) == f.retry_after_max_s


def test_fetcher_min_interval_and_manual_refresh():
    clock = Clock()
    f = PlanFetcher(clock=clock)
    calls = []
    fetch = lambda wp: calls.append(1) or _ok()  # noqa: E731
    f.get("a", fetch)
    clock.t += 10
    f.get("a", fetch)
    f.get("a", fetch, force=True)  # too soon even for a manual refresh
    assert len(calls) == 1
    clock.t += f.force_min_s
    f.get("a", fetch, force=True)
    assert len(calls) == 2
    clock.t += f.ttl_s
    f.get("a", fetch)
    assert len(calls) == 3


def test_fetcher_never_asks_again_with_a_refused_token_until_it_changes():
    clock = Clock()
    f = PlanFetcher(clock=clock)
    calls = []

    def refused(wp):
        calls.append(1)
        raise sub.UsageError("token expired — re-authenticate this account", kind="auth", status=401)

    f.get("a", refused, cred_sig="v1")
    clock.t += f.ttl_s * 5
    f.get("a", refused, cred_sig="v1")
    assert len(calls) == 1
    f.get("a", lambda wp: calls.append(1) or _ok(), cred_sig="v2")  # renewed: asks right away
    assert len(calls) == 2


def test_fetcher_sends_nothing_while_blocked_locally():
    clock = Clock()
    f = PlanFetcher(clock=clock)
    calls = []
    fetch = lambda wp: calls.append(1) or _ok(7.0)  # noqa: E731
    f.get("a", fetch, cred_sig="v1")
    clock.t += f.ttl_s
    v = f.get("a", fetch, cred_sig="v1", local_block=("token_expired", "access token expired"))
    assert len(calls) == 1 and v["stale_reason"] == "token_expired" and v["windows"][0]["percent"] == 7.0
    v = f.get("a", fetch, cred_sig="v2")  # the CLI renewed it
    assert len(calls) == 2 and v["stale_reason"] is None


def test_fetcher_coalesces_concurrent_callers():
    f = PlanFetcher()
    started, release = threading.Event(), threading.Event()
    calls = []

    def slow(wp):
        calls.append(1)
        started.set()
        release.wait(5)
        return _ok(33.0)

    results = []
    first = threading.Thread(target=lambda: results.append(f.get("a", slow)))
    first.start()
    started.wait(5)
    # no numbers yet: the others wait for the running request instead of sending their own
    others = [threading.Thread(target=lambda: results.append(f.get("a", slow))) for _ in range(4)]
    for t in others:
        t.start()
    time.sleep(0.2)
    release.set()
    for t in [first, *others]:
        t.join(5)
    assert len(calls) == 1 and len(results) == 5 and all(r["windows"][0]["percent"] == 33.0 for r in results)

    # with numbers known, a caller doesn't even wait: it gets them right away
    f._entries["a"].next_at = 0.0
    started.clear()
    release.clear()
    bg = threading.Thread(target=lambda: f.get("a", slow))
    bg.start()
    started.wait(5)
    t0 = time.monotonic()
    quick = f.get("a", slow)
    assert time.monotonic() - t0 < 0.5 and quick["windows"][0]["percent"] == 33.0
    release.set()
    bg.join(5)
    assert len(calls) == 2


def test_fetcher_state_survives_a_restart(db):
    store = AccountStore(db, SecretVault(db))
    clock = Clock()
    f = PlanFetcher(clock=clock, persist=store, jitter=lambda: 0.0)
    f.get("a", lambda wp: _ok(55.0))
    clock.t += f.ttl_s

    def throttled(wp):
        raise sub.UsageError("usage request failed (429)", kind="rate_limited", retry_after=3600)

    f.get("a", throttled)
    again = PlanFetcher(clock=clock, persist=store)  # a restart
    calls = []
    v = again.get("a", lambda wp: calls.append(1) or _ok())
    assert calls == [] and v["windows"][0]["percent"] == 55.0 and v["stale_reason"] == "rate_limited"
    blob = json.dumps(store.load_plan_entries())
    assert "FAKE" not in blob  # windows / timestamps / error text only


def test_profile_is_fetched_once_a_day():
    clock = Clock()
    f = PlanFetcher(clock=clock)
    asked = []

    def fetch(with_profile):
        asked.append(with_profile)
        return {**_ok(), "account": {"email": "me@example.com"} if with_profile else {}}

    f.get("a", fetch, want_profile=True)
    clock.t += f.ttl_s
    v = f.get("a", fetch, want_profile=True)
    clock.t += f.ttl_s
    f.get("a", fetch)  # the balancer never asks for it
    assert asked == [True, False, False] and v["account"]["email"] == "me@example.com"


# ---------------------------------------------------------------- credentials


def _no_secrets(obj):
    blob = json.dumps(obj)
    for secret in (FAKE_ACCESS, FAKE_REFRESH, "rt_FAKE", "sk-FAKE-KEY", "eyJ"):
        assert secret not in blob, f"{secret[:12]}… leaked"


def test_claude_full_credentials(tmp_path):
    cfg = tmp_path / ".claude"
    claude_creds(str(cfg), expires_in=7200, now=NOW, extra={
        "refreshTokenExpiresAt": int((NOW + 30 * 86400) * 1000),
        "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"]})
    ident = tmp_path / ".claude.json"
    ident.write_text(json.dumps({"oauthAccount": {"emailAddress": "me@example.com", "organizationName": "Acme"}}))
    facts = ls.claude_facts(str(cfg), identity_file=str(ident))
    out = ls.public(facts, now=NOW)
    assert out["method"] == "oauth" and out["health"] == "valid" and not out["actionable"]
    assert out["email"] == "me@example.com" and out["organization"] == "Acme" and out["plan"] == "Claude Max"
    assert out["has_refresh_token"] and out["expires_in_s"] == 7200 and out["renewable"]
    assert out["refresh_expires_at"].startswith(datetime.fromtimestamp(NOW + 30 * 86400, tz=timezone.utc).date().isoformat())
    assert "user:sessions:claude_code" in out["scopes"] and out["rate_limit_tier"] == "default_claude_max_20x"
    _no_secrets(out)


def test_claude_minimal_and_odd_credentials(tmp_path):
    # what this app's own sign-in writes: two scopes, no refresh-token expiry, no plan
    claude_creds(str(tmp_path / "a"), now=NOW, extra={"subscriptionType": ""})
    out = ls.public(ls.claude_facts(str(tmp_path / "a")), now=NOW)
    assert out["health"] == "valid" and out["refresh_expires_at"] is None and out["plan"] == ""
    # a long-lived token written as credentials (no refresh token, no expiry)
    os.makedirs(tmp_path / "b")
    (tmp_path / "b" / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {"accessToken": FAKE_ACCESS}}))
    out = ls.public(ls.claude_facts(str(tmp_path / "b")), now=NOW)
    assert out["method"] == "setup_token" and out["health"] == "valid" and not out["renewable"]
    # missing / corrupt file
    assert ls.public(ls.claude_facts(str(tmp_path / "none")), now=NOW)["health"] == "no_credentials"
    os.makedirs(tmp_path / "c")
    (tmp_path / "c" / ".credentials.json").write_text("{not json")
    assert ls.public(ls.claude_facts(str(tmp_path / "c")), now=NOW)["health"] == "no_credentials"


def test_codex_credentials(tmp_path):
    codex_auth(str(tmp_path / "c"), exp_in=5 * 86400, now=NOW)
    facts = ls.codex_facts(str(tmp_path / "c"))
    out = ls.public(facts, now=NOW)
    assert out["method"] == "chatgpt" and out["health"] == "valid" and out["email"] == "dev@example.com"
    assert out["plan"] == "ChatGPT Pro" and out["has_refresh_token"] and "offline_access" in out["scopes"]
    assert out["updated_at"].startswith("2026-10-25T04:16:24.448534")  # codex's nanoseconds
    _no_secrets(out)
    codex_auth(str(tmp_path / "k"), mode="apikey")
    out = ls.public(ls.codex_facts(str(tmp_path / "k")), now=NOW)
    assert out["method"] == "api_key" and out["health"] == "valid" and not out["renewable"]
    _no_secrets(out)
    codex_auth(str(tmp_path / "x"), exp_in=-60, refresh="", now=NOW)
    assert ls.public(ls.codex_facts(str(tmp_path / "x")), now=NOW)["health"] == "needs_login"


def test_health_classification():
    def c(**kw):
        base = dict(now=NOW, present=True, method="oauth", expires_at=NOW + 7200, has_refresh=True)
        return ls.classify(**{**base, **kw})

    assert c() == ("valid", "")
    assert c(expires_at=NOW + 600) == ("expiring", "renews_on_use")
    assert c(expires_at=NOW + 600, has_refresh=False) == ("expiring", "no_refresh_token")
    assert c(refresh_expires_at=NOW + 86400) == ("expiring", "refresh_token_expiring")
    assert c(refresh_expires_at=NOW - 1) == ("expiring", "refresh_token_expired")
    # access token over, refresh token fine: the CLI renews it on the next use — not a problem
    assert c(expires_at=NOW - 60) == ("expired", "renews_on_use")
    assert c(expires_at=NOW - 60, has_refresh=False) == ("needs_login", "no_refresh_token")
    assert c(expires_at=NOW - 60, refresh_expires_at=NOW - 1) == ("needs_login", "refresh_token_expired")
    assert c(expires_at=NOW - 60, renew_failure={"code": "network"}) == ("refresh_failed", "network")
    assert c(renew_failure={"code": "network"}) == ("valid", "")  # still valid: only a warning
    assert c(renew_failure={"code": "invalid_grant", "definitive": True}) == ("needs_login", "invalid_grant")
    assert c(rejected=True) == ("needs_login", "rejected")
    assert c(present=False) == ("no_credentials", "not_signed_in")
    assert c(method="api_key", expires_at=None, has_refresh=False) == ("valid", "api_key")
    for health in ("valid", "expiring", "expired", "no_credentials"):
        assert health not in ls.ACTIONABLE
    assert set(ls.ACTIONABLE) == {"needs_login", "refresh_failed"}


def test_a_renewal_failure_counts_only_for_the_file_it_tried(tmp_path):
    claude_creds(str(tmp_path), expires_in=-60, now=NOW)
    facts = ls.claude_facts(str(tmp_path))
    fail = {"ok": False, "code": "network", "sig": facts["sig"]}
    assert ls.public(facts, now=NOW, renew=fail)["health"] == "refresh_failed"
    assert ls.public(facts, now=NOW, renew={**fail, "sig": "older"})["health"] == "expired"


# ---------------------------------------------------------------- renewal: claude


class TokenEndpoint:
    """A fake platform.claude.com/v1/oauth/token."""

    def __init__(self, *, status=200, body=None, on_request=None):
        self.requests: list[dict] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append(data)
                if on_request:
                    on_request(data)
                payload = json.dumps(body if body is not None else {
                    "access_token": "sk-ant-oat01-FAKE-NEW-" + "n" * 30, "refresh_token": "sk-ant-ort01-FAKE-ROT-" + "m" * 30,
                    "expires_in": 28800, "refresh_token_expires_in": 30 * 86400,
                    "scope": "user:inference user:profile"}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1/oauth/token"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


@pytest.fixture
def endpoint(monkeypatch):
    made = []

    def make(**kw):
        ep = TokenEndpoint(**kw)
        made.append(ep)
        monkeypatch.setattr(sr, "CLAUDE_TOKEN_URL", ep.url)
        return ep

    yield make
    for ep in made:
        ep.close()


def fake_cli(tmp_path, body):
    """A fake `claude` / `codex` executable (python)."""
    p = tmp_path / f"fake-cli-{len(list(tmp_path.glob('fake-cli-*')))}"
    p.write_text(f"#!{sys.executable}\n" + textwrap.dedent(body))
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


# The CLI's own renewal: rewrites .credentials.json in CLAUDE_CONFIG_DIR, like Claude Code does.
CLI_RENEWS = """
import json, os, sys, time
assert sys.argv[1:] == ["auth", "status", "--json"], sys.argv
p = os.path.join(os.environ["CLAUDE_CONFIG_DIR"], ".credentials.json")
d = json.load(open(p))
d["claudeAiOauth"]["accessToken"] = "sk-ant-oat01-FAKE-BY-CLI"
d["claudeAiOauth"]["expiresAt"] = int((time.time() + 28800) * 1000)
json.dump(d, open(p, "w"))
print(json.dumps({"loggedIn": True}))
"""
CLI_NOOP = """
import json
print(json.dumps({"loggedIn": True}))
"""


def _locks_gone(cfg):
    new, legacy = sr.claude_lock_paths(str(cfg))
    assert not os.path.exists(new) and not os.path.exists(legacy)


def test_due_token_is_renewed_by_the_cli_itself(tmp_path, endpoint):
    ep = endpoint()
    cfg = tmp_path / "acct" / ".claude"
    claude_creds(str(cfg), expires_in=-120)
    res = sr.renew_claude(str(cfg), env={**os.environ, "CLAUDE_CONFIG_DIR": str(cfg)}, binary=fake_cli(tmp_path, CLI_RENEWS))
    assert res["ok"] and res["method"] == "cli" and res["expires_at"] > time.time()
    assert ep.requests == []  # the app sent nothing itself
    _locks_gone(cfg)


def test_cli_that_does_not_renew_falls_back_to_the_token_endpoint_with_rotation(tmp_path, endpoint):
    ep = endpoint()
    cfg = tmp_path / "acct" / ".claude"
    f = claude_creds(str(cfg), expires_in=-120, top={"otherTopLevel": {"keep": True}})
    res = sr.renew_claude(str(cfg), env=dict(os.environ), binary=fake_cli(tmp_path, CLI_NOOP))
    assert res["ok"] and res["method"] == "direct"
    (req,) = ep.requests
    assert req["grant_type"] == "refresh_token" and req["refresh_token"] == FAKE_REFRESH
    assert req["scope"] == "user:inference user:profile" and req["client_id"] == sr._CLAUDE_CLIENT_ID
    doc = json.load(open(f))
    o = doc["claudeAiOauth"]
    assert o["accessToken"].startswith("sk-ant-oat01-FAKE-NEW") and o["refreshToken"].startswith("sk-ant-ort01-FAKE-ROT")
    assert o["expiresAt"] > time.time() * 1000 and o["refreshTokenExpiresAt"] > time.time() * 1000
    assert o["rateLimitTier"] == "default_claude_max_20x" and o["subscriptionType"] == "max"  # the CLI's fields kept
    assert doc["otherTopLevel"] == {"keep": True}
    assert stat.S_IMODE(os.stat(f).st_mode) == 0o600
    assert [p.name for p in cfg.iterdir() if p.name.endswith(".tmp")] == []  # atomic: no leftovers
    _locks_gone(cfg)
    _no_secrets(res)


def test_not_yet_due_renews_directly_under_the_cli_locks(tmp_path, endpoint):
    cfg = tmp_path / ".claude"
    claude_creds(str(cfg), expires_in=3 * 3600)
    held = {}

    def check_locks(_data):
        new, legacy = sr.claude_lock_paths(str(cfg))
        held["new"], held["legacy"] = os.path.isdir(new), os.path.isdir(legacy)

    ep = endpoint(on_request=check_locks)
    cli = fake_cli(tmp_path, "raise SystemExit('the CLI must not run for a token that is not due')")
    res = sr.renew_claude(str(cfg), env=dict(os.environ), binary=cli)
    assert res["ok"] and res["method"] == "direct" and len(ep.requests) == 1
    assert held == {"new": True, "legacy": True}  # both of Claude Code's locks while asking
    _locks_gone(cfg)


def test_revoked_refresh_token_needs_a_sign_in(tmp_path, endpoint):
    endpoint(status=400, body={"error": "invalid_grant", "error_description": "refresh token revoked"})
    cfg = tmp_path / ".claude"
    f = claude_creds(str(cfg), expires_in=3600)
    before = open(f).read()
    res = sr.renew_claude(str(cfg), env=dict(os.environ), binary="/nonexistent")
    assert not res["ok"] and res["code"] == "invalid_grant" and res["definitive"]
    assert open(f).read() == before  # nothing written
    out = ls.public(ls.claude_facts(str(cfg)), renew={**res, "sig": ls.file_signature(f)})
    assert out["health"] == "needs_login" and out["actionable"]


def test_transient_failure_is_not_definitive(tmp_path, endpoint):
    endpoint(status=503, body={"error": "unavailable"})
    cfg = tmp_path / ".claude"
    claude_creds(str(cfg), expires_in=3600)
    res = sr.renew_claude(str(cfg), env=dict(os.environ), binary="/nonexistent")
    assert not res["ok"] and res["code"] == "http_503" and not res["definitive"]


def test_no_refresh_token_is_refused_without_a_request(tmp_path, endpoint):
    ep = endpoint()
    cfg = tmp_path / ".claude"
    claude_creds(str(cfg), refresh=None)
    res = sr.renew_claude(str(cfg), env=dict(os.environ), binary="/nonexistent")
    assert res["code"] == "no_refresh_token" and res["definitive"] and ep.requests == []


def test_waits_for_a_cli_holding_the_lock_and_rereads(tmp_path, endpoint):
    ep = endpoint()
    cfg = tmp_path / ".claude"
    f = claude_creds(str(cfg), expires_in=3600)
    new, _legacy = sr.claude_lock_paths(str(cfg))
    os.mkdir(new)  # Claude Code is renewing right now

    def cli_finishes():
        time.sleep(0.8)
        d = json.load(open(f))
        d["claudeAiOauth"]["accessToken"] = "sk-ant-oat01-FAKE-CLI-WROTE"
        json.dump(d, open(f, "w"))
        os.rmdir(new)

    t = threading.Thread(target=cli_finishes)
    t.start()
    res = sr.renew_claude(str(cfg), env=dict(os.environ), binary="/nonexistent", lock_wait_s=5)
    t.join()
    assert res["ok"] and res["method"] == "already" and ep.requests == []  # re-read: nothing sent
    _locks_gone(cfg)


def test_busy_lock_gives_up_and_a_stale_one_is_taken_over(tmp_path, endpoint):
    ep = endpoint()
    cfg = tmp_path / ".claude"
    claude_creds(str(cfg), expires_in=3600)
    new, legacy = sr.claude_lock_paths(str(cfg))
    os.mkdir(legacy)  # fresh: someone holds it
    res = sr.renew_claude(str(cfg), env=dict(os.environ), binary="/nonexistent", lock_wait_s=0.6)
    assert not res["ok"] and res["code"] == "lock_busy" and ep.requests == []
    assert os.path.isdir(legacy) and not os.path.exists(new)  # theirs left alone, ours released
    old = time.time() - sr.LOCK_STALE_S - 5
    os.utime(legacy, (old, old))  # its holder died
    res = sr.renew_claude(str(cfg), env=dict(os.environ), binary="/nonexistent", lock_wait_s=0.6)
    assert res["ok"] and len(ep.requests) == 1
    _locks_gone(cfg)


def test_someone_writing_without_the_lock_wins(tmp_path, endpoint):
    cfg = tmp_path / ".claude"
    f = claude_creds(str(cfg), expires_in=3600)

    def other_writer(_data):  # e.g. an old CLI that doesn't lock, mid-request
        d = json.load(open(f))
        d["claudeAiOauth"]["accessToken"] = "sk-ant-oat01-FAKE-OTHER"
        d["claudeAiOauth"]["refreshToken"] = "sk-ant-ort01-FAKE-OTHER"
        json.dump(d, open(f, "w"))

    endpoint(on_request=other_writer)
    res = sr.renew_claude(str(cfg), env=dict(os.environ), binary="/nonexistent")
    assert res["ok"] and res["method"] == "already"
    assert json.load(open(f))["claudeAiOauth"]["refreshToken"] == "sk-ant-ort01-FAKE-OTHER"  # not overwritten


# ---------------------------------------------------------------- renewal: codex

CODEX_APP_SERVER = """
import json, os, sys
assert sys.argv[1:] == ["app-server"], sys.argv
home = os.environ["CODEX_HOME"]
mode = open(os.path.join(home, "mode")).read().strip()
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"id": msg["id"], "result": {"userAgent": "fake"}}), flush=True)
    elif msg.get("method") == "account/read":
        assert msg["params"] == {"refreshToken": True}
        if mode == "dead":
            sys.stderr.write("ERROR codex_login::auth::manager: Failed to refresh token: Your refresh token has expired. Please log out and sign in again.\\n")
            sys.stderr.flush()
            print(json.dumps({"id": msg["id"], "error": {"code": -32603, "message": "refresh failed"}}), flush=True)
        else:
            p = os.path.join(home, "auth.json")
            d = json.load(open(p))
            d["tokens"]["access_token"] = d["tokens"]["access_token"] + "x"
            d["last_refresh"] = "2026-11-03T00:00:00Z"
            json.dump(d, open(p, "w"))
            print(json.dumps({"id": msg["id"], "result": {"account": {"type": "chatgpt", "email": "dev@example.com", "planType": "pro"}}}), flush=True)
"""


def test_codex_renewal_runs_the_cli(tmp_path):
    home = tmp_path / ".codex"
    codex_auth(str(home), exp_in=-60)
    (home / "mode").write_text("ok")
    res = sr.renew_codex(str(home), env={**os.environ, "CODEX_HOME": str(home)}, binary=fake_cli(tmp_path, CODEX_APP_SERVER))
    assert res["ok"] and res["method"] == "cli"
    assert json.load(open(home / "auth.json"))["last_refresh"] == "2026-11-03T00:00:00Z"
    (home / "mode").write_text("dead")
    res = sr.renew_codex(str(home), env={**os.environ, "CODEX_HOME": str(home)}, binary=fake_cli(tmp_path, CODEX_APP_SERVER))
    assert not res["ok"] and res["definitive"] and res["code"] == "invalid_grant"
    codex_auth(str(tmp_path / "k"), mode="apikey")
    assert sr.renew_codex(str(tmp_path / "k"), env=dict(os.environ), binary="/nonexistent")["code"] == "api_key"


# ---------------------------------------------------------------- the pool: balancer, badge, renew


def test_balancer_skips_logins_that_need_the_user():
    good = AccountSnapshot(id="a")
    bad = AccountSnapshot(id="b", session_ok=False)
    assert ineligible_reason(bad, now=0) == "session_expired" and ineligible_reason(good, now=0) is None
    st = BalancerState()
    for _ in range(4):
        assert choose([good, bad], strategy="round_robin", now=0, state=st).id == "a"
    assert choose([bad], strategy="round_robin", now=0, state=st) is None


@pytest.fixture
def home_pool(db, tmp_path, monkeypatch):
    """A pool whose host login and pooled accounts live under tmp_path."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.setattr(acc_mod.settings.__class__, "home_dir", property(lambda self: tmp_path / "hrh"))
    store = AccountStore(db, SecretVault(db))
    pool = AccountPool(store, fetch_plans=False)
    store.set_pool("claude", enabled=True, strategy="round_robin", primary_mode="off")
    return pool, store, home


def test_pool_skips_an_unrenewable_account_and_the_badge_sees_only_that(home_pool):
    pool, store, home = home_pool
    claude_creds(str(home / ".claude"), expires_in=3600)  # the host login: fine
    ok = store.create("claude", label="ok")
    idle = store.create("claude", label="idle")
    dead = store.create("claude", label="dead")
    claude_creds(str(acc_mod.account_config_dir("claude", ok["id"])), expires_in=3600)
    claude_creds(str(acc_mod.account_config_dir("claude", idle["id"])), expires_in=-600)  # renews on next use
    claude_creds(str(acc_mod.account_config_dir("claude", dead["id"])), expires_in=-600, refresh=None)
    picks = set()
    for _ in range(6):
        lease = pool.select("claude")
        picks.add(lease.account_id)
        pool.release(lease)
    assert picks == {ok["id"], idle["id"]}  # an expired-but-renewable login still works (the CLI renews it)
    by = {a["label"]: a for a in pool.public_accounts("claude")}
    assert by["idle"]["session"]["health"] == "expired" and not by["idle"]["session"]["actionable"]
    assert by["dead"]["session"]["health"] == "needs_login" and by["dead"]["ineligible_reason"] == "session_expired"
    attention = [a for a in pool.public_session_list("claude") if a["actionable"]]
    assert [a["label"] for a in attention] == ["dead"]
    assert [a["label"] for a in pool.check_sessions(("claude",))] == ["dead"]
    store.update(ok["id"], enabled=False)  # a disabled account never lights the badge
    claude_creds(str(acc_mod.account_config_dir("claude", ok["id"])), expires_in=-60, refresh=None)
    assert [a["label"] for a in pool.check_sessions(("claude",))] == ["dead"]
    _no_secrets(pool.public_accounts("claude"))


def test_pool_does_not_ask_for_usage_with_an_expired_token(home_pool, monkeypatch):
    pool, store, home = home_pool
    pool._plans.enabled = True
    calls = []
    monkeypatch.setattr(sub, "subscription_usage", lambda p, c, **kw: calls.append(c) or _ok(20.0))
    acc = store.create("claude", label="idle")
    cfg = acc_mod.account_config_dir("claude", acc["id"])
    claude_creds(str(cfg), expires_in=-600)
    plan = pool.plan_usage("claude", acc["id"], account=store.get(acc["id"]))
    assert calls == [] and plan["stale_reason"] == "token_expired"
    claude_creds(str(cfg), expires_in=3600)  # renewed (by the CLI on its next use, or "Renew")
    plan = pool.plan_usage("claude", acc["id"], account=store.get(acc["id"]))
    assert len(calls) == 1 and plan["stale_reason"] is None and plan["windows"][0]["percent"] == 20.0


def test_pool_renew_uses_the_accounts_config_dir_and_records_the_result(home_pool, monkeypatch, tmp_path, endpoint):
    pool, store, home = home_pool
    acc = store.create("claude", label="idle")
    cfg = acc_mod.account_config_dir("claude", acc["id"])
    claude_creds(str(cfg), expires_in=-600)
    from app.services.cli_tools import tools as cli_tools_mod

    monkeypatch.setattr(cli_tools_mod, "effective_binary", lambda tool: fake_cli(tmp_path, CLI_RENEWS))
    res = pool.renew_session("claude", acc["id"])
    assert res["ok"] and res["method"] == "cli" and res["session"]["health"] == "valid"
    assert json.load(open(cfg / ".credentials.json"))["claudeAiOauth"]["accessToken"] == "sk-ant-oat01-FAKE-BY-CLI"
    _no_secrets({k: v for k, v in res.items()})

    # a refusal: the card says "sign in again", the balancer skips it, the badge lights
    endpoint(status=400, body={"error": "invalid_grant"})
    monkeypatch.setattr(cli_tools_mod, "effective_binary", lambda tool: fake_cli(tmp_path, CLI_NOOP))
    claude_creds(str(cfg), expires_in=-600)
    res = pool.renew_session("claude", acc["id"])
    assert not res["ok"] and res["code"] == "invalid_grant" and res["session"]["health"] == "needs_login"
    assert pool.public_accounts("claude")[-1]["ineligible_reason"] == "session_expired"
    assert [a["label"] for a in pool.check_sessions(("claude",))] == ["idle"]
    # signed in again: a new file — the old failure no longer counts
    claude_creds(str(cfg), expires_in=3600)
    pool.note_signed_in(acc["id"])
    assert pool.session_info("claude", acc["id"])["health"] == "valid"


def test_primary_renew_runs_the_cli_with_the_hosts_own_config(home_pool, monkeypatch, tmp_path):
    pool, store, home = home_pool
    claude_creds(str(home / ".claude"), expires_in=-60)
    seen = tmp_path / "env.json"
    from app.services.cli_tools import tools as cli_tools_mod

    monkeypatch.setattr(cli_tools_mod, "effective_binary", lambda tool: fake_cli(tmp_path, f"""
        import json, os, time
        json.dump({{"cfg": os.environ.get("CLAUDE_CONFIG_DIR"), "home": os.environ.get("HOME")}}, open({str(seen)!r}, "w"))
        p = os.path.join(os.environ["HOME"], ".claude", ".credentials.json")
        d = json.load(open(p)); d["claudeAiOauth"]["accessToken"] = "sk-ant-oat01-FAKE-HOST"
        d["claudeAiOauth"]["expiresAt"] = int((time.time() + 3600) * 1000); json.dump(d, open(p, "w"))
    """))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/somewhere/else")
    res = pool.renew_session("claude", "__primary__claude")
    assert res["ok"] and res["method"] == "cli"
    env = json.load(open(seen))
    assert env == {"cfg": None, "home": str(home)}  # the host login: Claude Code's default ~/.claude
