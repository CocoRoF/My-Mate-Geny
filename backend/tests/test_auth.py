import os

from app.auth import AuthManager


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
    assert origin_allowed(None, "agent.hrletsgo.me")
    assert origin_allowed("https://agent.hrletsgo.me", "agent.hrletsgo.me")
    assert not origin_allowed("https://evil.hrletsgo.me", "agent.hrletsgo.me")
    assert not origin_allowed("null", "agent.hrletsgo.me")
