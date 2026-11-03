#!/usr/bin/env -S python3 -P
# Seeds a THROWAWAY backend's HOME + database with fake accounts for desktop/test/e2e/login-sessions-browser.js
# (Settings → Providers → login sessions + plan numbers' freshness). Every token here is fake. Run it before the
# backend starts, with the backend's own environment:
#
#   HOME=$T/home DB_PATH=$T/db.sqlite PYTHONPATH=backend python3 -P desktop/test/e2e/login-sessions-seed.py $T/seed.json
#
# Accounts (Claude): the host login ("Primary · this machine") valid, its usage endpoint answered 429 with
# Retry-After 25 min ago — its last numbers are kept; "work" valid and fresh; "idle" whose access token ran out
# (renews on use — "Renew session" lets fake-claude's `auth status` renew it); "flaky" ran out and its refresh token
# is refused by the CLI, so the backend asks the token endpoint itself — the backend runs with a dead HTTPS proxy,
# so that fails (nothing leaves the machine): "renewal failed"; "dead" ran out with no refresh token: "sign in
# again". Codex: the host login (ChatGPT, JWTs with fake payloads).
import base64
import json
import os
import sys
import time
from datetime import datetime, timezone

from app.db import Database
from app.providers.accounts import AccountStore, account_config_dir, ensure_account_dirs
from app.providers.plan_fetch import PlanEntry
from app.vault import SecretVault

out_path = sys.argv[1]
now = time.time()
home = os.path.expanduser("~")
FULL_SCOPES = ["user:file_upload", "user:inference", "user:mcp_servers", "user:plugins", "user:profile",
               "user:sessions:claude_code"]


def write(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
        json.dump(doc, fh)


def creds(cfg, *, expires_in, refresh="fake-refresh-token", scopes=FULL_SCOPES, sub="max", tier="default_claude_max_20x",
          refresh_days=25):
    o = {"accessToken": f"fake-access-{os.path.basename(os.path.dirname(cfg))}", "expiresAt": int((now + expires_in) * 1000),
         "scopes": scopes, "subscriptionType": sub, "rateLimitTier": tier}
    if refresh:
        o["refreshToken"] = refresh
        if refresh_days:
            o["refreshTokenExpiresAt"] = int((now + refresh_days * 86400) * 1000)
    write(os.path.join(cfg, ".credentials.json"), {"claudeAiOauth": o})


def ident(path, email, org):
    write(path, {"oauthAccount": {"emailAddress": email, "organizationName": org}})


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def windows(five, seven):
    return [{"label": "Session (5hr)", "percent": five, "resets_at": iso(now + 2 * 3600), "kind": "five_hour"},
            {"label": "Weekly (7 day)", "percent": seven, "resets_at": iso(now + 3 * 86400), "kind": "seven_day"}]


db = Database()
db.bootstrap()
store = AccountStore(db, SecretVault(db))

# the host login: valid, but its usage endpoint said 429 / Retry-After 3600 twenty-five minutes ago
creds(os.path.join(home, ".claude"), expires_in=3 * 3600)
ident(os.path.join(home, ".claude.json"), "me@example.com", "Example Org")
store.save_plan_entry("__primary__claude", PlanEntry(
    windows=windows(37, 62), fetched_at=now - 25 * 60, checked_at=now - 25 * 60, next_at=now + 35 * 60, failures=1,
    reason="rate_limited", error="usage request failed (429)").to_json())

ids = {}
for label in ("work", "idle", "flaky", "dead"):
    acc = store.create("claude", label=label)
    ids[label] = acc["id"]
    ensure_account_dirs("claude", acc["id"])
    store.update(acc["id"], status="ready")
store.set_pool("claude", enabled=True, strategy="most_remaining")

cfg = str(account_config_dir("claude", ids["work"]))
creds(cfg, expires_in=6 * 3600 + 120)
ident(os.path.join(cfg, ".claude.json"), "work@example.com", "Work Team")
store.save_plan_entry(ids["work"], PlanEntry(windows=windows(12, 30), fetched_at=now - 60, checked_at=now - 60,
                                             next_at=now + 60).to_json())

cfg = str(account_config_dir("claude", ids["idle"]))
creds(cfg, expires_in=-2 * 3600, scopes=["user:inference", "user:profile"], sub="", tier="", refresh_days=0)
store.save_plan_entry(ids["idle"], PlanEntry(windows=windows(4, 51), fetched_at=now - 3 * 3600,
                                             checked_at=now - 3 * 3600, next_at=now - 3 * 3600 + 120).to_json())

cfg = str(account_config_dir("claude", ids["flaky"]))
creds(cfg, expires_in=-3600, refresh="fake-REVOKED-refresh-token")

cfg = str(account_config_dir("claude", ids["dead"]))
creds(cfg, expires_in=-1800, refresh=None)


def b64(o):
    return base64.urlsafe_b64encode(json.dumps(o).encode()).rstrip(b"=").decode()


def jwt(p):
    return f"{b64({'alg': 'none'})}.{b64(p)}.fake"


claims = {"chatgpt_plan_type": "pro", "chatgpt_account_id": "acc-fake"}
write(os.path.join(home, ".codex", "auth.json"), {
    "auth_mode": "chatgpt", "OPENAI_API_KEY": None,
    "tokens": {"id_token": jwt({"email": "me@example.com", "exp": int(now + 3600), "https://api.openai.com/auth": claims}),
               "access_token": jwt({"exp": int(now + 8 * 86400), "scp": ["openid", "profile", "email", "offline_access"],
                                    "https://api.openai.com/auth": claims}),
               "refresh_token": "fake-codex-refresh", "account_id": "acc-fake"},
    "last_refresh": iso(now - 2 * 86400).replace("+00:00", "Z"),
})

with open(out_path, "w") as fh:
    json.dump({"ids": ids, "home": home}, fh)
print(json.dumps(ids))
