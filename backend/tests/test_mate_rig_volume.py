"""Per-mate voice volume (0.0 – 3.0) and the editable avatar rig: clip
validation, ``disabled`` clips, the ``emotions`` / ``emotion_stills`` maps,
and putting a built-in's bundled avatar back (POST /avatar/reset)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import files
from app.mate.store import MateError, normalize_avatar, normalize_voice


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c


# ---- volume ----

def test_voice_volume_defaults_clamps_and_merges():
    assert normalize_voice(None)["volume"] == 1.0
    assert normalize_voice({"volume": 2.5})["volume"] == 2.5
    assert normalize_voice({"volume": 9})["volume"] == 3.0
    assert normalize_voice({"volume": -1})["volume"] == 0.0
    assert normalize_voice({"volume": "1.5"})["volume"] == 1.5
    assert normalize_voice({"volume": "loud"})["volume"] == 1.0
    assert normalize_voice({"volume": float("nan")})["volume"] == 1.0
    with pytest.raises(MateError):
        normalize_voice({"volume": True})
    with pytest.raises(MateError):
        normalize_voice({"volume": [1]})
    # a partial patch keeps the volume; a volume patch keeps the rest
    base = normalize_voice({"volume": 2.0, "tts": {"engine": "openai"}})
    assert normalize_voice({"auto_read": False}, base)["volume"] == 2.0
    after = normalize_voice({"volume": 0.5}, base)
    assert after["volume"] == 0.5 and after["tts"]["engine"] == "openai"
    # an old document without the field reads as 100 %
    assert normalize_voice(None, {"tts": {"engine": "browser"}})["volume"] == 1.0


def test_voice_volume_over_the_api(client):
    m = client.post("/api/mates", json={"name": "Loud"}).json()
    assert m["voice"]["volume"] == 1.0
    r = client.patch(f"/api/mates/{m['id']}", json={"voice": {"volume": 3}})
    assert r.status_code == 200 and r.json()["voice"]["volume"] == 3.0
    assert client.get(f"/api/mates/{m['id']}").json()["voice"]["volume"] == 3.0
    assert client.patch(f"/api/mates/{m['id']}", json={"voice": {"volume": "x"}}).json()["voice"]["volume"] == 1.0
    assert client.patch(f"/api/mates/{m['id']}", json={"voice": {"volume": False}}).status_code == 400


# ---- rig ----

def _rig(**kw):
    rig = {
        "aspect": [3, 4], "home": "/h.webp", "packing": "stacked-alpha",
        "stills": {"neutral": "/n.webp", "smile": "/s.webp", "laugh": "/l.webp", "blink": "/b.webp"},
        "clips": [
            {"id": "idle_a", "kind": "idle", "src": "/i.mp4"},
            {"id": "talk_a", "kind": "talk", "src": "/t1.mp4"},
            {"id": "talk_b", "kind": "talk", "src": "/t2.mp4", "disabled": True},
            {"id": "laugh", "kind": "react", "src": "/l.mp4", "emotion": "joy", "loop": False},
            {"id": "smile", "kind": "react", "src": "/s.mp4", "emotion": "happy", "disabled": False},
        ],
        "emotions": {"joy": ["laugh", "smile", "laugh", "gone"], "Happy": ["smile"], "pout": ["pout"], "sad": []},
        "emotion_stills": {"joy": "laugh", "sad": "", "blink": "blink", "angry": "nope", "smile": "smile"},
    }
    rig.update(kw)
    return {"kind": "video", "rig": rig}


def test_rig_keeps_disabled_and_validated_maps():
    rig = normalize_avatar(_rig())["rig"]
    by = {c["id"]: c for c in rig["clips"]}
    assert by["talk_b"]["disabled"] is True
    assert "disabled" not in by["smile"] and "loop" not in by["laugh"]  # flags only when on
    # ids that aren't clips are dropped, duplicates too; a key whose ids are all gone goes;
    # an empty list (the user's "nothing for this emotion") stays; keys are lower-case
    assert rig["emotions"] == {"joy": ["laugh", "smile"], "happy": ["smile"], "sad": []}
    # emotion -> still: a known, non-mechanic still or "" (none)
    assert rig["emotion_stills"] == {"joy": "laugh", "sad": "", "smile": "smile"}
    assert rig["packing"] == "stacked-alpha" and rig["aspect"] == [3, 4]


@pytest.mark.parametrize("clips, msg", [
    ([{"id": "a", "kind": "dance", "src": "/a.mp4"}], "unknown kind"),
    ([{"id": "", "kind": "idle", "src": "/a.mp4"}], "clip id"),
    ([{"kind": "idle", "src": "/a.mp4"}], "clip id"),
    (["a"], "object"),
    ([{"id": "a", "kind": "idle", "src": "/a"}, {"id": "a", "kind": "talk", "src": "/b"}], "unique"),
])
def test_rig_rejects_bad_clips(clips, msg):
    with pytest.raises(MateError, match=msg):
        normalize_avatar(_rig(clips=clips, emotions={}))


def test_rig_rejects_bad_maps():
    with pytest.raises(MateError):
        normalize_avatar(_rig(emotions=["laugh"]))
    with pytest.raises(MateError):
        normalize_avatar(_rig(emotions={"joy": 3}))
    with pytest.raises(MateError):
        normalize_avatar(_rig(emotion_stills="laugh"))
    # a photo rig has no clips and so no clip map; its still map stays
    photo = normalize_avatar({"kind": "photo", "rig": _rig()["rig"]})["rig"]
    assert photo["clips"] == [] and "emotions" not in photo and photo["emotion_stills"]["joy"] == "laugh"


def test_rig_import_keeps_disabled(tmp_path):
    (tmp_path / "a.mp4").write_bytes(b"x")
    (tmp_path / "b.mp4").write_bytes(b"x")
    (tmp_path / "n.webp").write_bytes(b"x")
    av = files.rig_avatar({
        "stills": {"neutral": "n.webp"},
        "clips": [{"id": "a", "kind": "idle", "src": "a.mp4"}, {"id": "b", "kind": "talk", "src": "b.mp4", "disabled": True}],
        "emotion_stills": {"joy": "neutral", "sad": "missing"},
    }, tmp_path, lambda rel: f"/x/{rel}")
    assert [c.get("disabled", False) for c in av["rig"]["clips"]] == [False, True]
    assert av["rig"]["emotion_stills"] == {"joy": "neutral"}


def test_a_clip_that_starts_on_its_own_face_keeps_saying_so(tmp_path):
    """서아's pout starts on the pout (Kling can't draw it from words): `fade_in` tells the stage to dissolve into it."""
    from app.mate.store import normalize_clip

    (tmp_path / "p.mp4").write_bytes(b"x")
    (tmp_path / "n.webp").write_bytes(b"x")
    av = files.rig_avatar({"stills": {"neutral": "n.webp"}, "clips": [{"id": "angry", "kind": "react", "src": "p.mp4", "fade_in": True}]},
                          tmp_path, lambda rel: f"/x/{rel}")
    assert av["rig"]["clips"][0]["fade_in"] is True
    assert "fade_in" not in normalize_clip({"id": "a", "kind": "idle", "src": "/a.mp4", "fade_in": False})
    assert normalize_clip({"id": "a", "kind": "react", "src": "/a.mp4", "fade_in": 1})["fade_in"] is True


# ---- built-ins: edit, then back to the bundled version ----

def _service(db):
    from app.mate.service import MateService
    from app.mate.store import MateStore
    from app.services.connection_service import ConnectionService
    from app.services.provider_service import ProviderService
    from app.services.session_service import SessionService
    from app.services.workspace_service import WorkspaceService
    from app.vault import SecretVault

    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    return MateService(svc, MateStore(db, vault))


def _edited(rig):
    return {**rig, "clips": [{**c, "disabled": True} if c["id"] == "talk_a" else c for c in rig["clips"]],
            "emotions": {**rig.get("emotions", {}), "joy": ["smile"]}}


def test_edit_builtin_clips_then_reset_to_bundled(db):
    mates = _service(db)
    cha = mates.store.by_builtin("chaerin")
    bundled = cha["avatar"]
    assert not cha["customized"] and "talk_a" in [c["id"] for c in bundled["rig"]["clips"]]
    m = mates.update(cha["id"], {"avatar": {"kind": "video", "rig": _edited(bundled["rig"])}})
    assert m["customized"]
    assert next(c for c in m["avatar"]["rig"]["clips"] if c["id"] == "talk_a")["disabled"] is True
    assert m["avatar"]["rig"]["emotions"]["joy"] == ["smile"]
    # a newer bundle no longer overwrites the user's version
    mates.store.mark_builtin(cha["id"], "chaerin", "old-version")
    mates.sync_builtins()
    assert mates.get(cha["id"])["avatar"]["rig"]["emotions"]["joy"] == ["smile"]

    # back to the bundled avatar; persona untouched -> counts as unedited again (and is current)
    m = mates.reset_builtin_avatar(cha["id"])
    assert m["avatar"] == bundled and not m["customized"]
    assert mates.store.by_builtin("chaerin")["builtin_hash"] == files.builtin_hash("chaerin")

    # with an edited persona the avatar still goes back, but the mate stays "edited"
    mates.update(cha["id"], {"persona": {"greeting": "mine"},
                             "avatar": {"kind": "video", "rig": _edited(bundled["rig"])}})
    m = mates.reset_builtin_avatar(cha["id"])
    assert m["avatar"] == bundled and m["customized"] and m["persona"]["greeting"] == "mine"


def test_reset_endpoint(client):
    cha = next(m for m in client.get("/api/mates").json() if m["builtin"] == "chaerin")
    r = client.post(f"/api/mates/{cha['id']}/avatar/reset")
    assert r.status_code == 200, r.text
    assert r.json()["avatar"]["kind"] == "video" and r.json()["avatar"]["rig"]["clips"]
    # not a built-in: 400; unknown: 404
    own = client.post("/api/mates", json={"name": "Own"}).json()
    assert client.post(f"/api/mates/{own['id']}/avatar/reset").status_code == 400
    assert client.post("/api/mates/mate_nobody/avatar/reset").status_code == 404
