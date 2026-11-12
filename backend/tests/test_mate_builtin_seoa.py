"""서아 (Seoa), the bundled streamer: who she is, that she ships only with her whole pack, what her pack must hold, and how the
user's own 서아 becomes her (MateService._adopt_builtins) — once, only beyond doubt, keeping everything that is theirs."""

from __future__ import annotations

import json
import re
import shutil
from datetime import timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import affinity as A
from app.mate import files
from app.mate import state as S
from app.mate.service import MateService
from app.mate.store import MateStore
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

REAL = files.BUILTIN_DIR
HANGUL = re.compile(r"[가-힣]")
VOICE = {"engine": "elevenlabs", "voice": "v3EOFtkby3I668mHkwMa", "model": "eleven_v4_turbo"}

# ---- what her pack must hold (docs/mate.md "Seoa's pack"): the generation step makes exactly these ----

STILLS = ("neutral", "smile", "laugh", "shy", "surprised", "sad", "worried", "angry", "thinking", "sleepy", "blink", "mouth_half",
          "mouth_open", "mouth_o")
#: clip id -> (kind, emotion or what she is doing)
CLIPS = {"idle_a": ("idle", ""), "idle_b": ("idle", ""), "idle_c": ("idle", ""), "talk_a": ("talk", ""), "talk_b": ("talk", ""),
         "listen": ("listen", ""), "think": ("think", ""), "laugh": ("react", "joy"), "smile": ("react", "happy"),
         "shy": ("react", "shy"), "surprised": ("react", "surprise"), "sad": ("react", "sad"), "worried": ("react", "worried"),
         "angry": ("react", "angry"), "nod": ("react", "agree"), "wave": ("react", "greet"), "doze": ("away", "")}
#: what her body does in her day (an activity's ``body``) -> the life clip that shows it, in her default set
LIFE = ("stream", "work", "game", "eat", "drink", "walk", "workout", "sing")
#: per outfit folder: the life clips it has (each also has every clip of CLIPS and every still)
OUTFIT_LIFE = {"crop-top": LIFE, "stream-hoodie": ("stream", "work", "game", "eat", "drink"),
               "pajamas": ("sleep", "game", "eat", "drink")}
SLOTS = ("morning", "day", "evening", "night")
HAS_PACK = (REAL / "assets" / "seoa" / "rig.json").is_file()
needs_pack = pytest.mark.skipif(not HAS_PACK, reason="Seoa's pack is not in this checkout yet")


class _Logs:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, dict]] = []

    def record(self, level, source, message, **kw):
        self.rows.append((level, message, kw))


def _service(db, logs=None):
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    return MateService(svc, MateStore(db, vault), logs)


# ---- who she is ----

def test_she_is_a_bright_streamer_with_her_own_voice_and_day():
    b = files.builtin_bundle("seoa")
    assert b["names"] == {"en": "Seoa", "ko": "서아"} and b["language"] == "ko"
    assert set(b["greetings"]) == {"en", "ko"} and not HANGUL.search(b["greetings"]["en"]) and HANGUL.search(b["greetings"]["ko"])
    p = b["persona"]
    assert p["gender"] == "female" and p["birthday"] == "03-15"
    assert "streamer" in p["description"] and "Your relationship with the user:" in p["description"]
    assert "never tell the user to buy or sell" in p["instructions"]  # (her own trades only, never advice)
    for k in ("description", "personality", "instructions"):
        letters = [c for c in p[k] if c.isalpha()]
        assert len(HANGUL.findall(p[k])) / len(letters) < 0.25, k
    st = b["style"]
    assert files.style_defaults(b, "ko") == {"formality": "haeyo", "address": "{name} 님", "self_ref": ""}
    assert files.style_defaults(b, "en")["address"] == "{name}"
    text = st["speech_style"]
    assert "이건 추천 아니고 제 일기예요!" in text and "This is my diary, not advice!" in text and "Example exchanges:" in text
    for rule in ("반말", "존댓말", "-nim", "calls the user", "Call the user", "politely by name", "by their name"):
        assert rule not in text, rule  # (her speech level and address are data, never sentences)
    letters = [c for c in text if c.isalpha()]
    assert len(HANGUL.findall(text)) / len(letters) < 0.25
    # (the Korean greeting is the bundle's own line; her ElevenLabs voice comes with her)
    doc = files.builtin_doc("seoa")
    assert files.legacy_persona(doc)[1]["greeting"] == b["greetings"]["ko"]
    assert files.ailism_voice(doc, None, "m") == {"tts": {"voice": VOICE["voice"], "model": VOICE["model"]}}


def test_she_feels_like_herself_not_like_chaerin():
    seoa, chaerin = S.who(builtin="seoa"), S.who(builtin="chaerin")
    at = S.A._t("2026-11-06T12:00:00+00:00")
    lv = lambda doc, w, t=at: {e: x["v"] for e, x in S.levels(doc, w, t, timezone.utc).items()}  # noqa: E731
    assert lv(S.new(), seoa)["happy"] > lv(S.new(), chaerin)["happy"] and lv(S.new(), seoa)["excited"] > 0
    # she lights up at what she loves
    a = S.new()
    S.hear(a, seoa, "오늘 방송 클립 떡상했던데?", "m", at, timezone.utc)
    assert S.levels(a, seoa, at, timezone.utc)["excited"]["why"] == {"code": "loves"}
    # she pouts as easily, and gets over it sooner
    for w in (seoa, chaerin):
        assert w["temperament"].get("settle", {}).get("angry", 1.0) <= 1.0
    s, c = S.new(), S.new()
    for doc in (s, c):
        doc["feelings"]["angry"] = {"v": 0.8, "at": "2026-11-06T12:00:00+00:00", "why": {"code": "rude"}}
    later = S.A._t("2026-11-06T13:00:00+00:00")
    assert lv(s, seoa, later)["angry"] < lv(c, chaerin, later)["angry"] - 0.1


# ---- her pack: nothing half-made ships ----

FRAME = {"face": [0.48, 0.32, 0.3], "outline": [0.49, 0.23, 0.22], "top": 0.04, "how": "face", "for": "neutral.webp"}


def _pack(folder, life=("stream",), stills=("neutral", "smile", "blink"), leave_out=()):
    """A small stand-in for a rig pack (tiny files): what the gate and the sync look at."""
    folder.mkdir(parents=True, exist_ok=True)
    clips = [("idle_a", "idle", {}), ("talk_a", "talk", {}), *((f"life_{b}", "life", {"doing": b}) for b in life)]
    rig = {"version": 1, "aspect": [900, 1296], "anchor": [0.5, 1.0], "home": "asset:seoa/neutral.webp", "portrait": "asset:seoa/portrait.webp",
           "stills": {s: f"asset:seoa/{s}.webp" for s in stills}, "clips": [], "packing": "stacked-alpha", "frame": FRAME}
    names = [f"{s}.webp" for s in stills] + ["portrait.webp"]
    for cid, kind, extra in clips:
        rig["clips"].append({"id": cid, "kind": kind, **extra, "src": f"asset:seoa/{cid}.lg.mp4", "small": f"asset:seoa/{cid}.sm.mp4",
                             "thumb": f"asset:seoa/{cid}.thumb.webp"})
        names += [f"{cid}.lg.mp4", f"{cid}.sm.mp4", f"{cid}.thumb.webp"]
    for n in names:
        if n not in leave_out:
            (folder / n).write_bytes(b"x")
    (folder / "rig.json").write_text(json.dumps(rig), encoding="utf-8")


def _complete(folder):
    _pack(folder)
    for item in json.loads((folder / "outfits.json").read_text(encoding="utf-8"))["items"]:
        _pack(folder / item["rig"].rsplit("/", 1)[0], life=("sleep",) if "pajamas" in item["rig"] else ("stream",))


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    """A built-in folder with Seoa's text and outfit list but no pack yet (her folder, as this step leaves it)."""
    root = tmp_path / "builtin"
    for sub in ("personas", "mates"):
        (root / sub).mkdir(parents=True)
        shutil.copy(REAL / sub / "seoa.json", root / sub / "seoa.json")
    (root / "assets" / "seoa").mkdir(parents=True)
    shutil.copy(REAL / "assets" / "seoa" / "outfits.json", root / "assets" / "seoa" / "outfits.json")
    monkeypatch.setattr(files, "BUILTIN_DIR", root)
    return root / "assets" / "seoa"


def test_chaerin_ships_whole():
    assert files.builtin_missing("chaerin") == []
    assert "chaerin" in files.builtin_keys()


def test_she_waits_for_her_whole_pack(db, bundle):
    logs = _Logs()
    mates = _service(db, logs)
    assert files.builtin_keys() == [] and files.builtin_waiting() == {"seoa": ["rig.json"]}
    assert mates.store.by_builtin("seoa") is None and mates.store.list() == []
    assert logs.rows == []  # (no pack at all: a character still to come, nothing wrong)
    # her body, but a clip short: still waiting, and the log says what is missing
    _pack(bundle, leave_out=("life_stream.sm.mp4",))
    missing = files.builtin_missing("seoa")
    assert missing[0] == "life_stream.sm.mp4" and "outfits/crop-top/rig.json" in missing and "seoa" not in files.builtin_keys()
    mates.sync_builtins()
    assert mates.store.by_builtin("seoa") is None
    assert [m for lv, m, kw in logs.rows if kw.get("code") == "mate.builtin_waiting" and lv == "warning" and "life_stream.sm.mp4" in m]
    # her outfits, one of them a still short
    _complete(bundle)
    (bundle / "outfits" / "pajamas" / "blink.webp").unlink()
    assert files.builtin_missing("seoa") == ["outfits/pajamas/blink.webp"]
    (bundle / "outfits" / "pajamas" / "blink.webp").write_bytes(b"x")
    assert files.builtin_missing("seoa") == [] and files.builtin_keys() == ["seoa"]
    mates.sync_builtins()
    seoa = mates.store.by_builtin("seoa")
    assert seoa["name"] == "서아" and seoa["avatar"]["rig"]["home"].startswith("/api/mates/builtin/seoa/")
    assert {o["id"] for o in seoa["outfits"]["items"]} >= {"builtin-crop-top", "builtin-stream-hoodie", "builtin-pajamas"}
    assert seoa["voice"]["tts"]["voice"] == VOICE["voice"] and seoa["voice"]["tts"]["model"] == VOICE["model"]


def test_the_list_of_built_ins_says_who_ships():
    with TestClient(app) as client:
        assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        shipped = client.get("/api/mates/builtin").json()
    assert [b["key"] for b in shipped] == files.builtin_keys()
    assert shipped[0] == {"key": "chaerin", "names": {"en": "Han Chaerin", "ko": "한채린"}}
    assert ("seoa" in [b["key"] for b in shipped]) == HAS_PACK


# ---- the user's own 서아 becomes her ----

OLD_RIG = {"aspect": [900, 1296], "home": "/api/mates/{id}/assets/pack-b34e0de3e433/neutral.webp",
           "stills": {"neutral": "/api/mates/{id}/assets/pack-b34e0de3e433/neutral.webp"},
           "clips": [{"id": "idle_a", "kind": "idle", "src": "/api/mates/{id}/assets/pack-b34e0de3e433/idle_a.lg.mp4"}],
           "packing": "stacked-alpha", "frame": FRAME}


def _own_seoa(mates, name="서아", gender="female"):
    """The user's 서아 as she is on the owner's install: made by hand, a template persona, her voice and their style."""
    store = mates.store
    m = store.create(name=name, persona={"description": "You are Harin, a bright, warm young woman...", "personality": "Cheerful",
                                         "greeting": "안녕하세요! 오늘도 저랑 같이 힘내봐요~", "language": "ko", "gender": gender,
                                         "birthday": "03-15"},
                     voice={"tts": VOICE}, prefs={"address": "오빠", "formality": "haeyo",
                                                  "speech_style": "Light, bouncy rhythm with soft exclamations like '좋아요!' and '와~'."})
    rig = json.loads(json.dumps(OLD_RIG).replace("{id}", m["id"]))
    store.update(m["id"], {"avatar": {"kind": "video", "rig": rig}})
    return m["id"]


def _hers(mates, mid):
    """Everything of hers that must come through: conversation, memories, relationship, how she feels, her day."""
    db = mates.store._db
    sid = mates.store.get(mid)["session_id"]
    return {"sid": sid, "messages": db.query_one("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?", (sid,))["n"],
            "memories": [m["text"] for m in mates.store.memories(mid)], "relation": mates.store.relation_doc(mid),
            "state": db.query_one("SELECT doc FROM mate_state WHERE mate_id = ?", (mid,))["doc"],
            "life": db.query_one("SELECT doc FROM mate_life WHERE mate_id = ?", (mid,))["doc"]}


def _record(mates):
    return json.loads(mates.store._setting("builtin.adopted:seoa") or "null")


def test_the_users_own_seoa_becomes_the_built_in_keeping_all_that_is_theirs(db, bundle):
    logs = _Logs()
    mates = _service(db, logs)  # (no pack yet: nothing happens to her)
    mid = _own_seoa(mates)
    sid = mates.conversation(mid)["session_id"]
    mates._svc.seed_message(sid, "user", "서아야 오늘 방송 재밌었어", provider="claude")
    mates.store.add_memory(mid, "오빠는 매운 걸 못 먹는다", kind="fact")
    rel = {**A.new(), "affinity": 7.0}
    mates.store.save_relation(mid, rel)
    mates.store.save_state(mid, {**S.new(), "feelings": {"happy": {"v": 0.6, "at": "2026-11-12T12:00:00+00:00", "why": {"code": "warm"}}}})
    mates.store.save_life(mid, {"seed": mid, "at": "2026-11-12T12:00:00+00:00"})
    mates.sync_builtins()
    assert mates.get(mid)["builtin"] is None and _record(mates) is None  # (still waiting for her pack)
    before, kept = mates.get(mid), _hers(mates, mid)

    _complete(bundle)
    mates.sync_builtins()
    seoa = mates.get(mid)
    bundle_now = files.builtin_bundle("seoa")
    # she is the built-in now: the same mate, nobody new
    assert seoa["builtin"] == "seoa" and not seoa["customized"] and len(mates.store.list()) == 1
    assert mates.store.by_builtin("seoa")["builtin_hash"] == files.builtin_hash("seoa")
    assert seoa["name"] == "서아" and seoa["is_default"] == before["is_default"]
    for k in files.BUNDLE_FIELDS:
        assert seoa["persona"][k] == bundle_now["persona"][k], k
    assert seoa["persona"]["greeting"] == bundle_now["greetings"]["ko"] and seoa["persona"]["language"] == "ko"
    assert "Harin" not in seoa["persona"]["description"]
    # how she talks is the bundle's; what the user set stays theirs
    assert seoa["prefs"]["speech_style"] == bundle_now["style"]["speech_style"]
    assert seoa["prefs"]["defaults"] == {"formality": "haeyo", "address": "{name} 님", "self_ref": ""}
    assert seoa["prefs"]["address"] == "오빠" and seoa["prefs"]["formality"] == "haeyo"
    assert seoa["voice"] == before["voice"] and seoa["llm"] == before["llm"]
    assert _hers(mates, mid) == kept
    # her body is the bundle's, and the one she had stays in her wardrobe
    assert seoa["avatar"]["rig"]["home"].startswith("/api/mates/builtin/seoa/")
    items = {o["name"]: o for o in mates.store._wardrobe(mid)["items"]}
    assert items["예전 모습"]["avatar"] == before["avatar"]
    assert {"builtin-crop-top", "builtin-stream-hoodie", "builtin-pajamas"} <= {o["id"] for o in items.values()}
    # the record of it, and the log
    record = _record(mates)
    assert record["mate_id"] == mid and record["status"] == "done" and record["kept"] == items["예전 모습"]["id"]
    assert record["before"]["persona"]["description"].startswith("You are Harin")
    assert record["before"]["speech_style"].startswith("Light, bouncy")
    assert any(kw.get("code") == "mate.builtin_adopted" and kw["detail"]["mate_id"] == mid for _l, _m, kw in logs.rows)
    # once: a restart changes nothing
    again = _service(db)
    same = ("name", "builtin", "persona", "prefs", "avatar", "voice", "llm", "session_id")
    assert {k: again.get(mid)[k] for k in same} == {k: seoa[k] for k in same}
    assert again.store._wardrobe(mid)["items"] == mates.store._wardrobe(mid)["items"]
    assert len(again.store.list()) == 1 and _record(again) == record


def test_it_happens_once_whatever_comes_after(db, bundle):
    _complete(bundle)
    mates = _service(db)
    assert mates.store.by_builtin("seoa") is not None and _record(mates)["why"] == "no mate goes by her name"
    # deleted, another 서아 of their own, the built-ins restored: hers stays hers, Seoa comes back on her own
    mates.delete(mates.store.by_builtin("seoa")["id"])
    mid = _own_seoa(mates)
    mates.sync_builtins()
    assert mates.get(mid)["builtin"] is None and mates.store.by_builtin("seoa") is None
    mates.restore_builtins()
    assert mates.get(mid)["builtin"] is None and mates.get(mid)["persona"]["description"].startswith("You are Harin")
    assert mates.store.by_builtin("seoa")["id"] != mid


@pytest.mark.parametrize("doubt", ["two", "male", "draft", "deleted", "none"])
def test_in_doubt_nobody_becomes_her(db, bundle, doubt):
    mates = _service(db)
    mid = None
    if doubt == "two":
        mid, other = _own_seoa(mates), _own_seoa(mates, name="Seoa")
    elif doubt == "male":
        mid = _own_seoa(mates, gender="male")
    elif doubt == "draft":
        draft = mates.store.create(name="서아", persona={"gender": "female"}, draft=True)
        mid = draft["id"]
    elif doubt == "deleted":
        mid = _own_seoa(mates)
        db.execute("INSERT INTO mate_builtin_removed (key, removed_at) VALUES ('seoa', '2026-11-01T00:00:00+00:00')")
    _complete(bundle)
    mates.sync_builtins()
    record = _record(mates)
    assert record["mate_id"] is None and record["why"]
    if mid:
        assert mates.get(mid)["builtin"] is None and mates.get(mid)["persona"]["description"] != files.builtin_bundle("seoa")["persona"]["description"]
    if doubt == "two":
        assert mates.get(other)["builtin"] is None and record["why"] == "2 mates go by her name"
    # the built-in comes on her own, unless the user deleted her
    assert (mates.store.by_builtin("seoa") is None) == (doubt == "deleted")


def test_an_adoption_that_stopped_half_way_finishes(db, bundle):
    mates = _service(db)
    mid = _own_seoa(mates)
    _complete(bundle)
    old = mates.store.base_avatar(mid)
    oid = mates.store.add_outfit(mid, "예전 모습")  # (it got this far, then the app stopped)
    mates.store._put_setting("builtin.adopted:seoa", json.dumps(
        {"at": "2026-11-12T00:00:00+00:00", "mate_id": mid, "name": "서아", "status": "adopting", "kept": oid,
         "before": {"name": "서아", "persona": mates.get(mid)["persona"], "speech_style": "", "defaults": {}, "avatar": old}}))
    mates.sync_builtins()
    seoa = mates.get(mid)
    assert seoa["builtin"] == "seoa" and _record(mates)["status"] == "done"
    olds = [o for o in mates.store._wardrobe(mid)["items"] if o["name"] == "예전 모습"]
    assert len(olds) == 1 and olds[0]["avatar"] == old


def test_a_half_done_adoption_of_a_mate_since_deleted_is_dropped(db, bundle):
    mates = _service(db)
    _complete(bundle)
    mates.store._put_setting("builtin.adopted:seoa", json.dumps(
        {"at": "2026-11-12T00:00:00+00:00", "mate_id": "mate_gone", "name": "서아", "status": "adopting", "before": {}}))
    mates.sync_builtins()
    assert _record(mates)["status"] == "dropped" and _record(mates)["why"] == "she was deleted before it was done"
    assert mates.store.by_builtin("seoa") is not None  # (Seoa herself comes as on any install)


def test_the_seoa_once_retired_ships_again(db, bundle):
    """An install that still has the Seoa bundled before (retired 2026-11-06): with her new pack she is simply updated."""
    _complete(bundle)
    store = MateStore(db, SecretVault(db))
    url = "/api/mates/builtin/seoa/neutral.webp"
    avatar = {"kind": "video", "rig": {"aspect": [3, 4], "home": url, "stills": {"neutral": url},
                                       "clips": [{"id": "idle", "kind": "idle", "src": "/api/mates/builtin/seoa/idle.mp4"}]}}
    persona = {"greeting": "안녕! 나 서아야.", "description": "A trader-and-streamer friend.", "personality": "Bright."}
    m = store.create(name="서아", persona=persona, avatar=avatar)
    store.mark_builtin(m["id"], "seoa", "old", {"names": {"ko": "서아"}, "greetings": {"ko": persona["greeting"]},
                                                 "persona": {k: m["persona"].get(k, "") for k in files.BUNDLE_FIELDS},
                                                 "style": {"speech_style": "", "address": ""}, "avatar": m["avatar"]})
    mates = _service(db)
    seoa = mates.get(m["id"])
    assert seoa["builtin"] == "seoa" and len(mates.store.list()) == 1
    assert seoa["persona"]["description"] == files.builtin_bundle("seoa")["persona"]["description"]
    assert seoa["avatar"]["rig"]["home"].startswith("/api/mates/builtin/seoa/neutral.webp")
    assert _record(mates)["why"] == "she is here already"


# ---- her pack, as the generation step leaves it ----

def test_her_world_asks_only_for_what_her_pack_will_have():
    from app.mate.life import profile as P

    world = P.load("seoa")
    outfits = {o["id"]: o["rig"].split("/")[1] for o in json.loads((REAL / "assets" / "seoa" / "outfits.json").read_text("utf-8"))["items"]}
    assert set(OUTFIT_LIFE) == set(outfits.values())
    for key, act in world["activities"].items():
        body = act.get("body")
        assert body is None or body in (*LIFE, "sleep"), key
        if act.get("wear"):
            assert act["wear"] in outfits, key
            assert body in OUTFIT_LIFE[outfits[act["wear"]]], key  # (what she does in it has its clip in that set)
    assert world["art"] == "/api/mates/builtin/seoa/places" and world["map"] == "/api/mates/builtin/seoa/places/map.webp"


@needs_pack
def test_her_pack_holds_all_she_needs():
    folder = REAL / "assets" / "seoa"
    assert files.builtin_missing("seoa") == []
    assert (folder / "cover.webp").is_file() and (folder / "portrait.webp").is_file()

    def check(rig, life):
        clips = {c["id"]: c for c in rig["clips"]}
        assert set(STILLS) <= set(rig["stills"])
        for cid, (kind, what) in CLIPS.items():
            assert clips[cid]["kind"] == kind and (clips[cid].get("emotion") or "") == what, cid
        for body in life:
            assert clips[f"life_{body}"]["kind"] == "life" and clips[f"life_{body}"]["doing"] == body, body
        assert rig["emotions"].get("angry") == ["angry"] and rig["emotions"].get("pout") == ["angry"]
        assert rig.get("frame")

    check(json.loads((folder / "rig.json").read_text("utf-8")), LIFE)
    for name, life in OUTFIT_LIFE.items():
        check(json.loads((folder / "outfits" / name / "rig.json").read_text("utf-8")), life)
    from app.mate.life import profile as P

    world = P.load("seoa")
    for place in world["places"]:
        for slot in SLOTS:
            assert (folder / "places" / f"{place}-{slot}.webp").is_file(), (place, slot)
    assert (folder / "places" / "map.webp").is_file()
