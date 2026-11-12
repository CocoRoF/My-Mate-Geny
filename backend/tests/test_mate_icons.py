"""Profile pictures (the crop dialog, frontend/src/components/ui/IconCropDialog.tsx): a mate's own (``icon``: a
square of her avatar's picture or of one the user picked, among her assets, gone with her) and the user's (one for
the app, Settings → Account: ``user_icon``). Whatever comes in is checked and written again as a small square;
anything that isn't a picture is refused. Birthdays go through the same settings (``user_birthday``,
``persona.birthday``)."""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.mate import files
from app.mate.store import MateError


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c


def _png(w: int, h: int, color=(200, 80, 120, 255)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def _new(client, name="Icon"):
    r = client.post("/api/mates", json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()


def test_make_icon_is_a_small_square_written_again():
    data, ext = files.make_icon(_png(1600, 900))
    assert ext in ("webp", "png")
    with Image.open(io.BytesIO(data)) as im:
        assert im.size == (files.ICON_EDGE, files.ICON_EDGE), "the middle of a wide picture, at most ICON_EDGE"
    small, _ = files.make_icon(_png(96, 96))
    with Image.open(io.BytesIO(small)) as im:
        assert im.size == (96, 96), "a small one stays as big as it is"
    for bad in (b"", b"<svg xmlns='http://www.w3.org/2000/svg'/>", b"\x89PNG\r\n\x1a\nnot really"):
        with pytest.raises(MateError):
            files.make_icon(bad)


def test_her_icon_is_saved_served_replaced_and_cleared(client):
    m = _new(client)
    assert m["icon"] == "", "none yet: her avatar's face"
    r = client.post(f"/api/mates/{m['id']}/icon", files={"file": ("icon.png", _png(300, 300), "image/png")})
    assert r.status_code == 200, r.text
    url = r.json()["icon"]
    assert url.startswith(f"/api/mates/{m['id']}/assets/profile/icon-") and "?v=" in url
    g = client.get(url)
    assert g.status_code == 200 and g.headers["content-type"] in ("image/webp", "image/png")
    assert "immutable" in g.headers["cache-control"]
    assert client.get(f"/api/mates/{m['id']}").json()["icon"] == url, "on the mate document"
    # another picture: another URL, and the one before it goes
    r2 = client.post(f"/api/mates/{m['id']}/icon", files={"file": ("x.png", _png(300, 300, (10, 200, 30, 255)), "image/png")})
    url2 = r2.json()["icon"]
    assert url2 != url and client.get(url).status_code == 404 and client.get(url2).status_code == 200
    # not a picture: refused, and hers stays
    bad = client.post(f"/api/mates/{m['id']}/icon", files={"file": ("x.png", b"<script>", "image/png")})
    assert bad.status_code == 400
    assert client.get(f"/api/mates/{m['id']}").json()["icon"] == url2
    # back to her face
    d = client.delete(f"/api/mates/{m['id']}/icon")
    assert d.status_code == 200 and d.json()["icon"] == "" and client.get(url2).status_code == 404
    assert client.post("/api/mates/mate_0000000000000000/icon", files={"file": ("x.png", _png(8, 8), "image/png")}).status_code == 404


def test_her_icon_goes_with_her(client):
    m = _new(client, "Gone")
    url = client.post(f"/api/mates/{m['id']}/icon", files={"file": ("i.png", _png(64, 64), "image/png")}).json()["icon"]
    folder = files.assets_dir(m["id"]) / "profile"
    assert any(folder.glob("icon-*"))
    assert client.delete(f"/api/mates/{m['id']}").status_code == 200
    assert not folder.exists() and client.get(url).status_code == 404


def test_the_icon_field_takes_only_her_own_pictures(db):
    from app.mate.store import MateStore
    from app.vault import SecretVault

    store = MateStore(db, SecretVault(db))
    m = store.create(name="A")
    other = store.create(name="B")
    for bad in ("https://example.com/x.png", f"/api/mates/{other['id']}/assets/profile/icon-1.webp",
                f"/api/mates/{m['id']}/assets/stills/neutral.png"):
        with pytest.raises(MateError):
            store.set_icon(m["id"], bad)
    ok = f"/api/mates/{m['id']}/assets/profile/icon-abc.webp?v=abc"
    assert store.set_icon(m["id"], ok)["icon"] == ok
    assert store.get(other["id"])["icon"] == ""


def test_the_users_icon_is_one_for_the_app(client):
    assert client.get("/api/mates/settings").json()["user_icon"] == ""
    r = client.post("/api/mates/settings/user-icon", files={"file": ("me.jpg", _png(800, 1200), "image/png")})
    assert r.status_code == 200, r.text
    url = r.json()["user_icon"]
    assert url.startswith("/api/mates/settings/user-icon/user-icon-")
    g = client.get(url)
    assert g.status_code == 200 and g.headers["x-content-type-options"] == "nosniff"
    with Image.open(io.BytesIO(g.content)) as im:
        assert im.size[0] == im.size[1] == files.ICON_EDGE
    assert client.get("/api/mates/settings").json()["user_icon"] == url
    for bad in ("../app.db", "user-icon-zz.webp", "x.png"):
        assert client.get(f"/api/mates/settings/user-icon/{bad}").status_code == 404, bad
    assert client.post("/api/mates/settings/user-icon", files={"file": ("x.txt", b"hello", "text/plain")}).status_code == 400
    d = client.delete("/api/mates/settings/user-icon")
    assert d.status_code == 200 and d.json()["user_icon"] == "" and client.get(url).status_code == 404


def test_birthdays_are_month_and_day(client):
    assert client.put("/api/mates/settings", json={"user_birthday": "02-29"}).json()["user_birthday"] == "02-29"
    assert client.put("/api/mates/settings", json={"user_birthday": "13-01"}).status_code == 400
    assert client.put("/api/mates/settings", json={"user_birthday": ""}).json()["user_birthday"] == ""
    m = _new(client, "Born")
    r = client.patch(f"/api/mates/{m['id']}", json={"persona": {"birthday": "06-21"}})
    assert r.status_code == 200 and r.json()["persona"]["birthday"] == "06-21"
    assert client.patch(f"/api/mates/{m['id']}", json={"persona": {"birthday": "6/21"}}).status_code == 400
