"""UI preferences (the account's language) and the login page's language."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.preferences import _from_accept_language, get_preferences, set_preferences


def test_store_round_trip(db):
    assert get_preferences(db) == {"language": None, "theme": None}
    assert set_preferences(db, {"language": "ko"}) == {"language": "ko", "theme": None}
    assert get_preferences(db) == {"language": "ko", "theme": None}
    # an unknown value never comes back out
    set_preferences(db, {"language": "xx"})
    assert get_preferences(db) == {"language": None, "theme": None}


def test_theme_round_trip(db):
    assert set_preferences(db, {"theme": "light"}) == {"language": None, "theme": "light"}
    # one key at a time: the language stays
    set_preferences(db, {"language": "ko"})
    assert get_preferences(db) == {"language": "ko", "theme": "light"}
    for mode in ("system", "dark"):
        assert set_preferences(db, {"theme": mode})["theme"] == mode
    set_preferences(db, {"theme": "sepia"})
    assert get_preferences(db)["theme"] is None


@pytest.mark.parametrize(
    "header,want",
    [
        ("", None),
        ("ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7", "ko"),
        ("en-US,en;q=0.9,ko;q=0.8", "en"),
        ("de-DE,de;q=0.9", None),
        ("de-DE,ko;q=0.5,en;q=0.4", "ko"),
        ("en;q=0.2,ko;q=0.9", "ko"),
        ("ko;q=0", None),
    ],
)
def test_accept_language(header, want):
    assert _from_accept_language(header) == want


@pytest.fixture
def client():
    from app.main import app

    with TestClient(app) as c:
        c.app.state.auth.clear_stored_credentials()
        set_preferences(c.app.state.db, {"language": None, "theme": None})
        yield c
        set_preferences(c.app.state.db, {"language": None, "theme": None})


def _login(c):
    r = c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"})
    assert r.status_code == 200


def test_api_requires_auth(client):
    assert client.get("/api/preferences").status_code == 401
    assert client.put("/api/preferences", json={"language": "ko"}).status_code == 401


def test_api_round_trip(client):
    _login(client)
    assert client.get("/api/preferences").json() == {"language": None, "theme": None}
    r = client.put("/api/preferences", json={"language": "ko"})
    assert r.status_code == 200 and r.json() == {"language": "ko", "theme": None}
    assert client.get("/api/preferences").json() == {"language": "ko", "theme": None}
    assert client.put("/api/preferences", json={"language": "fr"}).status_code == 422
    assert client.put("/api/preferences", json={"language": None}).json() == {"language": None, "theme": None}


def test_api_theme(client):
    _login(client)
    assert client.put("/api/preferences", json={"theme": "light"}).json() == {"language": None, "theme": "light"}
    # the language alone leaves the theme as it is
    assert client.put("/api/preferences", json={"language": "en"}).json() == {"language": "en", "theme": "light"}
    assert client.put("/api/preferences", json={"theme": "dim"}).status_code == 422
    assert client.put("/api/preferences", json={"theme": None}).json()["theme"] is None


def test_login_page_theme(client):
    import re

    def cls(page):
        return re.search(r'<html lang="\w+" class="(\w*)">', page).group(1)

    page = client.get("/login").text
    # nothing chosen: the browser's prefers-color-scheme decides (both sets are in the page)
    assert cls(page) == "" and "prefers-color-scheme: light" in page and "html.light" in page
    assert 'name="theme-color" content="#0a0c10"' in page
    # the account's choice, before anyone signs in on this device
    set_preferences(client.app.state.db, {"theme": "light"})
    page = client.get("/login").text
    assert cls(page) == "light" and 'name="theme-color" content="#f1f3f7"' in page
    # this browser's choice (the console's cookie) beats the account's
    client.cookies.set("hrh_theme", "dark")
    assert cls(client.get("/login").text) == "dark"
    client.cookies.set("hrh_theme", "system")
    assert cls(client.get("/login").text) == ""
    client.cookies.set("hrh_theme", "neon")
    assert cls(client.get("/login").text) == "light"
    client.cookies.clear()


def test_login_page_language(client):
    en = client.get("/login").text
    assert '<html lang="en"' in en and ">Sign in</button>" in en and "한국어" in en
    ko = client.get("/login", headers={"Accept-Language": "ko-KR,ko;q=0.9"}).text
    assert '<html lang="ko"' in ko and ">로그인</button>" in ko and "사용자 이름" in ko
    # the explicit choice beats the browser's language: ?lang=, then the cookie
    assert '<html lang="en"' in client.get("/login?lang=en", headers={"Accept-Language": "ko"}).text
    client.cookies.set("hrh_lang", "ko")
    assert '<html lang="ko"' in client.get("/login").text
    client.cookies.clear()
    # the account's stored choice, before anyone signs in on this device
    set_preferences(client.app.state.db, {"language": "ko"})
    assert '<html lang="ko"' in client.get("/login").text
    assert "다시 로그인해 주세요" in client.get("/login", params={"error": "expired"}).text


def test_login_errors_carry_a_code(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": "nope"})
    assert r.status_code == 401 and r.json()["code"] == "bad_credentials"
    client.app.state.auth.clear_failures("testclient")
