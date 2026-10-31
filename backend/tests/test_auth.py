import os
import time

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_mod
from app.auth import (
    DEFAULT_PASSWORD,
    AuthManager,
    hash_password,
    password_problem,
    safe_next,
    verify_password,
)
from app.config import settings


def test_token_round_trip(db):
    auth = AuthManager(db)
    tok = auth.issue_token("admin")
    assert auth.verify_token(tok)
    assert not auth.verify_token("garbage")
    assert not auth.verify_token(None)


def test_token_tamper_rejected(db):
    auth = AuthManager(db)
    tok = auth.issue_token("admin")
    payload, _sig = tok.rsplit(".", 1)
    assert not auth.verify_token(payload + ".deadbeef")


def test_credentials(db):
    auth = AuthManager(db)
    # AUTH_PASSWORD is set to "test-pass" in conftest.
    assert os.environ["AUTH_PASSWORD"] == "test-pass"
    assert auth.check_credentials("admin", "test-pass")
    assert not auth.check_credentials("admin", "nope")
    assert not auth.check_credentials("root", "test-pass")


def test_ip_ban_after_three_failures(db):
    auth = AuthManager(db)
    ip = "203.0.113.7"
    assert not auth.is_banned(ip)
    assert auth.record_failure(ip) is False  # 1
    assert auth.record_failure(ip) is False  # 2
    assert auth.record_failure(ip) is True  # 3 -> banned
    assert auth.is_banned(ip)
    # a successful login clears the record
    auth.clear_failures(ip)
    assert not auth.is_banned(ip)


def test_non_ascii_password_is_a_normal_failure(db):
    auth = AuthManager(db)
    assert not auth.check_credentials("admin", "비밀번호")  # used to raise TypeError -> 500
    auth.set_credentials("admin", "long-enough-pw")
    assert not auth.check_credentials("admin", "비밀번호")
    assert not auth.check_credentials("관리자", "long-enough-pw")


def test_ipv6_is_banned_per_64(db):
    auth = AuthManager(db)
    for i in range(3):
        auth.record_failure(f"2001:db8:1:2::{i + 1}")  # rotating within one /64
    assert auth.is_banned("2001:db8:1:2::ffff")
    assert not auth.is_banned("2001:db8:1:3::1")


def test_revoke_all_invalidates_existing_tokens(db):
    auth = AuthManager(db)
    tok = auth.issue_token("admin")
    assert auth.verify_token(tok)
    auth.revoke_all()
    assert not auth.verify_token(tok)
    assert auth.verify_token(auth.issue_token("admin"))


def test_forwarded_ip_only_trusted_from_private_peer():
    class R:
        def __init__(self, peer, headers):
            self.client = type("C", (), {"host": peer})()
            self.headers = headers
    assert AuthManager.client_ip(R("172.18.0.3", {"cf-connecting-ip": "203.0.113.9"})) == "203.0.113.9"
    assert AuthManager.client_ip(R("8.8.8.8", {"cf-connecting-ip": "203.0.113.9"})) == "8.8.8.8"


def test_origin_check():
    from app.auth import origin_allowed
    assert origin_allowed(None, "example.com")
    assert origin_allowed("https://example.com", "example.com")
    assert not origin_allowed("https://evil.example.com", "example.com")
    assert not origin_allowed("null", "example.com")


# ---- password hashing ---------------------------------------------------------


def test_password_hash_is_salted_and_verifies():
    h1, h2 = hash_password("correct horse"), hash_password("correct horse")
    assert h1 != h2 and h1.startswith("scrypt$")  # fresh salt every time
    assert "correct horse" not in h1
    assert verify_password("correct horse", h1) and verify_password("correct horse", h2)
    assert not verify_password("correct hors", h1)
    assert not verify_password("correct horse", "scrypt$broken")
    assert not verify_password("x", "md5$abc")


def test_pbkdf2_hashes_also_verify():
    import base64
    import hashlib

    salt = b"0123456789abcdef"
    dk = hashlib.pbkdf2_hmac("sha256", b"pw-123456", salt, 1000)
    b = lambda r: base64.urlsafe_b64encode(r).decode().rstrip("=")  # noqa: E731
    enc = f"pbkdf2_sha256$1000${b(salt)}${b(dk)}"
    assert verify_password("pw-123456", enc) and not verify_password("pw-1234567", enc)


def test_password_rules():
    assert password_problem("short")
    assert password_problem(DEFAULT_PASSWORD)
    assert password_problem("SameAsUser", "sameasuser")
    assert password_problem("x" * 2000)
    assert password_problem("a-good-passphrase", "admin") is None


# ---- precedence: DB > env > default -------------------------------------------


def test_precedence_default_env_db(db, monkeypatch):
    monkeypatch.setattr(settings, "auth_password", "")
    monkeypatch.setattr(settings, "auth_username", "admin")
    auth = AuthManager(db)
    assert auth.source == "default" and auth.using_default_password
    assert auth.check_credentials("admin", "geny-admin")
    assert auth.credentials_info()["default_password"] is True

    monkeypatch.setattr(settings, "auth_password", "env-secret")
    monkeypatch.setattr(settings, "auth_username", "owner")
    auth = AuthManager(db)
    assert auth.source == "env" and not auth.using_default_password
    assert auth.check_credentials("owner", "env-secret")
    assert not auth.check_credentials("admin", "geny-admin")

    auth.set_credentials("me", "db-secret-123")
    assert auth.source == "db" and auth.username == "me"
    assert auth.check_credentials("me", "db-secret-123")
    assert not auth.check_credentials("owner", "env-secret")
    # survives a restart (new manager on the same DB), only the hash is stored
    again = AuthManager(db)
    assert again.source == "db" and again.check_credentials("me", "db-secret-123")
    raw = db.query_one("SELECT value FROM app_kv WHERE key = 'auth_credentials'")["value"]
    assert "db-secret-123" not in raw and "scrypt$" in raw

    again.clear_stored_credentials()  # recovery: back to env
    assert again.source == "env" and again.check_credentials("owner", "env-secret")


def test_explicit_env_default_password_still_warns(db, monkeypatch):
    monkeypatch.setattr(settings, "auth_password", DEFAULT_PASSWORD)
    assert AuthManager(db).using_default_password


def test_env_sessions_survive_upgrade(db):
    """Tokens signed with the pre-DB-credentials formula keep working."""
    import hashlib
    import hmac as _hmac

    auth = AuthManager(db)
    pw = hashlib.sha256(settings.auth_password.encode()).hexdigest()
    legacy = _hmac.new(auth._base_secret, f"gen:{auth._generation()}:pw:{pw}".encode(), hashlib.sha256).digest()
    assert auth._secret == legacy


def test_set_credentials_ends_sessions(db):
    auth = AuthManager(db)
    old = auth.issue_token("admin")
    auth.set_credentials("admin", "new-password-1")
    assert not auth.verify_token(old)
    t2 = auth.issue_token("admin")
    auth.set_credentials("admin", "new-password-1")  # same password, new salt
    assert not auth.verify_token(t2)


# ---- exchange codes -------------------------------------------------------------


def test_exchange_code_single_use_and_expiry(db):
    auth = AuthManager(db)
    tok = auth.issue_token("admin")
    code = auth.create_exchange_code(tok)
    assert auth.consume_exchange_code(code) == tok
    assert auth.consume_exchange_code(code) is None  # single use
    assert auth.consume_exchange_code(None) is None
    assert auth.consume_exchange_code("nope") is None

    code = auth.create_exchange_code(tok)
    auth._exchange[code] = (time.monotonic() - 1, tok)  # past its 60 s
    assert auth.consume_exchange_code(code) is None

    code = auth.create_exchange_code(tok)
    auth.revoke_all()  # credentials/sessions changed in between -> worthless
    assert auth.consume_exchange_code(code) is None


@pytest.mark.parametrize("raw,want", [
    (None, "/"), ("", "/"), ("/", "/"), ("/?view=mate", "/?view=mate"), ("/a/b#c", "/a/b#c"),
    ("//evil.example", "/"), ("/\\evil.example", "/"), ("https://evil.example/", "/"),
    ("javascript:alert(1)", "/"), ("evil", "/"), ("/\nx", "/"), (" //evil.example", "/"),
])
def test_safe_next(raw, want):
    assert safe_next(raw) == want


# ---- HTTP: the app ----------------------------------------------------------------


@pytest.fixture
def client(monkeypatch):
    """App client with env credentials (admin / test-pass) and no stored ones."""
    from app.main import app

    with TestClient(app) as c:
        c.app.state.auth.clear_stored_credentials()
        yield c
        c.app.state.auth.clear_stored_credentials()  # other tests log in with test-pass


@pytest.fixture
def default_client(monkeypatch):
    """App client running on the built-in defaults (no AUTH_PASSWORD)."""
    from app.main import app

    monkeypatch.setattr(settings, "auth_password", "")
    with TestClient(app) as c:
        c.app.state.auth.clear_stored_credentials()
        yield c
        c.app.state.auth.clear_stored_credentials()


def _login(c, username="admin", password="test-pass", **extra):
    return c.post("/api/auth/login", json={"username": username, "password": password, **extra})


def test_defaults_login_and_warnings(default_client):
    c = default_client
    page = c.get("/login").text
    assert "Default password" in page and "Admin &rarr; Security" in page
    r = _login(c, "admin", "geny-admin")
    assert r.status_code == 200 and r.json()["default_password"] is True
    st = c.get("/api/auth/status").json()
    assert st == {**st, "username": "admin", "source": "default", "default_password": True}


def test_env_credentials_no_warning(client):
    assert "Default password" not in client.get("/login").text
    assert _login(client, "admin", "geny-admin").status_code == 401
    r = _login(client)
    assert r.status_code == 200 and r.json()["default_password"] is False
    assert client.get("/api/auth/status").json()["source"] == "env"


def test_status_requires_auth(client):
    assert client.get("/api/auth/status").status_code == 401
    assert client.post("/api/auth/credentials", json={"current_password": "test-pass",
                                                       "username": "x", "new_password": "y" * 10}).status_code == 401


def test_change_credentials_flow(client):
    c = client
    other = _login(c).json()["token"]  # "another device"
    assert _login(c).status_code == 200  # this browser (cookie)

    bad = c.post("/api/auth/credentials", json={"current_password": "wrong", "username": "owner",
                                                "new_password": "brand-new-pass"})
    assert bad.status_code == 400 and "incorrect" in bad.json()["detail"]
    weak = c.post("/api/auth/credentials", json={"current_password": "test-pass", "username": "owner",
                                                 "new_password": "short"})
    assert weak.status_code == 400
    assert c.app.state.auth.source == "env"  # nothing changed yet

    r = c.post("/api/auth/credentials", json={"current_password": "test-pass", "username": "owner",
                                              "new_password": "brand-new-pass"})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "db" and r.json()["username"] == "owner"

    # this browser stays signed in with the fresh cookie ...
    assert c.get("/api/auth/status").json()["username"] == "owner"
    # ... the other device is signed out
    jar = dict(c.cookies)
    c.cookies.clear()
    assert c.get("/api/auth/status", headers={"Authorization": f"Bearer {other}"}).status_code == 401
    # old credentials are gone, new ones work
    assert _login(c, "admin", "test-pass").status_code == 401
    assert _login(c, "owner", "brand-new-pass").status_code == 200
    c.cookies.update(jar)

    logs = c.get("/api/admin/logs", params={"source": "auth"}).json()["items"]
    changed = [i for i in logs if i["code"] == "auth.credentials_changed"]
    assert changed and changed[0]["detail"]["new_username"] == "owner"
    assert "brand-new-pass" not in str(logs)
    c.app.state.auth.clear_failures("testclient")


def test_username_only_change_keeps_password(client):
    _login(client)
    r = client.post("/api/auth/credentials", json={"current_password": "test-pass", "username": "boss"})
    assert r.status_code == 200
    client.cookies.clear()
    assert _login(client, "boss", "test-pass").status_code == 200


def test_default_password_must_be_replaced(default_client):
    c = default_client
    _login(c, "admin", "geny-admin")
    r = c.post("/api/auth/credentials", json={"current_password": "geny-admin", "username": "admin2"})
    assert r.status_code == 400
    r = c.post("/api/auth/credentials", json={"current_password": "geny-admin", "username": "admin",
                                              "new_password": "geny-admin"})
    assert r.status_code == 400
    r = c.post("/api/auth/credentials", json={"current_password": "geny-admin", "username": "admin",
                                              "new_password": "my-own-password"})
    assert r.status_code == 200 and r.json()["default_password"] is False
    assert "Default password" not in c.get("/login").text


def test_change_is_throttled(client, monkeypatch):
    from app.routers import auth as auth_router

    monkeypatch.setattr(auth_router, "_CHANGE_FAIL_DELAY_S", 0)
    _login(client)
    for _ in range(auth_mod._CHANGE_FAILS):
        assert client.post("/api/auth/credentials", json={"current_password": "x", "username": "a"}).status_code == 400
    r = client.post("/api/auth/credentials", json={"current_password": "test-pass", "username": "a",
                                                   "new_password": "whatever-123"})
    assert r.status_code == 429
    client.app.state.auth._change_fails.clear()


def test_change_requires_same_origin(client):
    _login(client)
    r = client.post("/api/auth/credentials", json={"current_password": "test-pass", "username": "x",
                                                   "new_password": "whatever-123"},
                    headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_exchange_flow_over_http(client):
    r = _login(client, exchange=True)
    body = r.json()
    assert body["expires_in"] == 60 and body["exchange_code"]
    client.cookies.clear()  # the connect page's origin never got the cookie

    res = client.get("/auth/exchange", params={"code": body["exchange_code"], "next": "/?view=mate"},
                     follow_redirects=False)
    assert res.status_code == 302 and res.headers["location"] == "/?view=mate"
    sc = res.headers["set-cookie"]
    assert "hrh_session=" in sc and "samesite=lax" in sc.lower() and "httponly" in sc.lower()
    assert "secure" not in sc.lower()  # plain http, COOKIE_SECURE=false
    assert client.get("/api/auth/status").status_code == 200  # landed logged in

    client.cookies.clear()
    again = client.get("/auth/exchange", params={"code": body["exchange_code"]}, follow_redirects=False)
    assert again.status_code == 302 and again.headers["location"] == "/login?error=expired"
    assert "expired" in client.get("/login", params={"error": "expired"}).text


def test_exchange_sanitizes_next_and_sets_secure_behind_https(client):
    code = _login(client, exchange=True).json()["exchange_code"]
    client.cookies.clear()
    res = client.get("/auth/exchange", params={"code": code, "next": "//evil.example/x"},
                     headers={"X-Forwarded-Proto": "https"}, follow_redirects=False)
    assert res.headers["location"] == "/"
    assert "secure" in res.headers["set-cookie"].lower()
    code = _login(client, exchange=True).json()["exchange_code"]
    res = client.get("/auth/exchange", params={"code": code}, headers={"CF-Visitor": '{"scheme":"https"}'},
                     follow_redirects=False)
    assert res.headers["location"] == "/" and "secure" in res.headers["set-cookie"].lower()


def test_no_exchange_code_unless_asked(client):
    body = _login(client).json()
    assert body["ok"] and body["token"] and "exchange_code" not in body


# ---- CORS ------------------------------------------------------------------------


@pytest.mark.parametrize("origin", ["null", "capacitor://localhost", "https://localhost", "https://other.example"])
def test_login_cors_preflight_any_origin(client, origin):
    r = client.options("/api/auth/login", headers={
        "Origin": origin, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"})
    assert r.status_code in (200, 204)
    assert r.headers["access-control-allow-origin"] == "*"
    assert "POST" in r.headers["access-control-allow-methods"]
    assert "content-type" in r.headers["access-control-allow-headers"].lower()
    assert "access-control-allow-credentials" not in r.headers


def test_login_cors_preflight_private_network(client):
    r = client.options("/api/auth/login", headers={
        "Origin": "https://localhost", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Private-Network": "true"})
    assert r.headers["access-control-allow-private-network"] == "true"


def test_login_cors_response_without_credentials(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": "test-pass", "exchange": True},
                    headers={"Origin": "null"})
    assert r.status_code == 200 and r.json()["exchange_code"]
    assert r.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in r.headers
    # even an origin from CORS_ORIGINS gets '*' without credentials here
    r = client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"},
                    headers={"Origin": "http://localhost:5173"})
    assert r.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in r.headers


def test_health_identity_and_cors(client):
    r = client.get("/health", headers={"Origin": "null"})
    assert r.json() == {**r.json(), "status": "ok", "service": "my-mate-geny", "product": "My Mate Geny"}
    assert r.json()["version"]
    assert r.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in r.headers
    pre = client.options("/health", headers={"Origin": "null", "Access-Control-Request-Method": "GET"})
    assert pre.headers["access-control-allow-origin"] == "*"


def test_other_endpoints_keep_strict_cors(client):
    _login(client)
    r = client.get("/api/auth/status", headers={"Origin": "https://other.example"})
    assert "access-control-allow-origin" not in r.headers
    pre = client.options("/api/auth/status", headers={"Origin": "https://other.example",
                                                      "Access-Control-Request-Method": "GET"})
    assert pre.headers.get("access-control-allow-origin") != "*"
    pre = client.options("/api/auth/credentials", headers={"Origin": "null",
                                                           "Access-Control-Request-Method": "POST"})
    assert pre.headers.get("access-control-allow-origin") not in ("*", "null")
    # configured dev origin: credentialed, echoed (never '*')
    r = client.get("/api/auth/status", headers={"Origin": "http://localhost:5173"})
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"
    r = client.get("/auth/exchange", headers={"Origin": "null"}, follow_redirects=False)
    assert "access-control-allow-origin" not in r.headers


def test_cors_login_failures_count_toward_ban(client):
    ip = {"CF-Connecting-IP": "203.0.113.77"}  # trusted: the test peer counts as our proxy
    auth = client.app.state.auth
    auth.clear_failures("203.0.113.77")
    try:
        for i in range(2):
            r = client.post("/api/auth/login", json={"username": "admin", "password": f"bad{i}"},
                            headers={"Origin": "null", **ip})
            assert r.status_code == 401 and r.headers["access-control-allow-origin"] == "*"
        r = client.post("/api/auth/login", json={"username": "admin", "password": "bad3"},
                        headers={"Origin": "capacitor://localhost", **ip})
        assert r.status_code == 403 and r.headers["access-control-allow-origin"] == "*"
        assert auth.is_banned("203.0.113.77")
        # banned: even the right password is refused, and the page can read why
        r = client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"},
                        headers={"Origin": "null", **ip})
        assert r.status_code == 403 and r.headers["access-control-allow-origin"] == "*"
        assert client.get("/health", headers=ip).status_code == 403
    finally:
        auth.clear_failures("203.0.113.77")


def test_login_page_assets_are_public(client):
    page = client.get("/login").text
    assert 'src="/logo.png"' in page and 'href="/favicon.ico"' in page
    for path in ("/logo.png", "/favicon.ico", "/favicon-32.png", "/apple-touch-icon.png",
                 "/icon-192.png", "/manifest.webmanifest"):
        assert client.get(path).status_code != 401, path  # 404 here: no STATIC_DIR in tests
