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
