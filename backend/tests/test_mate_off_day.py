"""Her off day (app/mate/state.py ``off_day``) and who she is (``persona.gender``, app/mate/store.py): a woman's off day comes
as it comes — the first within 5 days of their first meeting, each next one 21–28 days after the last, 2 days long — with
angry and sleepy floors that ease slowly and never below 0.60, anything else she feels free over them, nothing in it at the
user; a man, or a mate nobody knows to be a woman, has none. Who she is is the character's data: bundled, written by the
studio, read once from an older mate's own text — never a setting."""

from __future__ import annotations

import json
import random
from datetime import UTC, datetime, timedelta
from itertools import pairwise

import pytest

from app.avatar import studio as ST
from app.mate import affinity as A
from app.mate import files
from app.mate import state as S
from app.mate.service import MateService
from app.mate.store import MateStore, infer_gender, normalize_persona
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

_REAL = S._off_day  # (conftest.py pins it off for every other test)
TZ = UTC
MET = datetime(2026, 9, 1, 12, tzinfo=TZ)
H = timedelta(hours=1)


@pytest.fixture(autouse=True)
def _her_own_days(monkeypatch, _whatever_time_it_really_is):  # (after conftest.py's pin)
    monkeypatch.setattr(S, "_off_day", _REAL)


def _her(seed="mate_0ff000000001", gender="female", met=MET):
    return S.who(gender=gender, met=met, seed=seed)


def _starts(w, days=400):
    """Every off day in the first ``days`` days, as an hourly look sees them."""
    out, t = [], MET
    while t < MET + timedelta(days=days):
        s = S._off_day(w, t)
        if s is not None and (not out or out[-1] != s):
            out.append(s)
        t += H
    return out


def _lv(w, at, doc=None):
    return S.levels(doc or S.new(), w, at, TZ)


# ---- when ----

@pytest.mark.parametrize("seed", [f"mate_{i:012x}" for i in range(8)])
def test_the_first_within_five_days_then_every_three_to_four_weeks_two_days_long(seed):
    w = _her(seed)
    starts = _starts(w)
    assert len(starts) >= 13
    assert MET <= starts[0] <= MET + timedelta(days=5)
    for a, b in pairwise(starts):
        assert timedelta(days=21) <= b - a <= timedelta(days=28)
    for s in starts:
        assert S._off_day(w, s) == s and S._off_day(w, s + timedelta(hours=47, minutes=59)) == s
        assert S._off_day(w, s - timedelta(seconds=1)) is None and S._off_day(w, s + timedelta(hours=48)) is None


def test_her_days_are_her_own_and_the_same_at_every_look():
    a, b = _starts(_her("mate_aaaaaaaaaaaa")), _starts(_her("mate_bbbbbbbbbbbb"))
    assert a == _starts(_her("mate_aaaaaaaaaaaa")) and a != b
    assert S._off_day(_her(), MET - H) is None  # (not before they met)


@pytest.mark.parametrize("gender", ["male", ""])
def test_a_man_or_a_mate_not_known_to_be_a_woman_has_none(gender):
    w = _her(gender=gender)
    assert _starts(w, 120) == []
    t = MET
    while t < MET + timedelta(days=60):
        assert all(x["why"].get("code") != "off_day" for x in _lv(w, t).values())
        t += timedelta(hours=6)
    assert _starts(S.who(gender="female", seed="mate_x"), 30) == []  # (and not without a first meeting)


# ---- how ----

def test_day_one_and_day_two_start_where_they_do_and_never_go_below_the_floor():
    w = _her()
    start = _starts(w)[0]
    first = _lv(w, start)
    assert first["angry"] == {"v": 0.9, "why": {"code": "off_day"}} and first["sleepy"] == {"v": 0.7, "why": {"code": "off_day"}}
    late = _lv(w, start + timedelta(hours=23, minutes=59))
    assert 0.6 < late["angry"]["v"] < 0.75 and 0.6 < late["sleepy"]["v"] < 0.7  # (easing off very slowly)
    second = _lv(w, start + timedelta(hours=24))
    assert second["angry"]["v"] == 0.7 and second["sleepy"]["v"] == 0.7
    t, angry, sleepy = start, [], []
    while t < start + timedelta(hours=48):
        lv = _lv(w, t)
        angry.append(lv["angry"]["v"])
        sleepy.append(lv["sleepy"]["v"])
        t += timedelta(minutes=30)
    assert min(angry) >= 0.6 and min(sleepy) >= 0.6 and max(angry) == 0.9
    assert all(a >= b for a, b in pairwise(angry[:48])) and all(a >= b for a, b in pairwise(angry[48:]))
    after = _lv(w, start + timedelta(hours=48))
    assert after["angry"]["v"] == 0.0 and after["sleepy"]["v"] == 0.0  # (over: back to how she usually is)


def test_anything_else_she_feels_rises_over_it_and_nothing_is_dulled_or_carried_over():
    w, man = _her(), _her(gender="")
    start = _starts(w)[0] + H
    doc, plain = S.new(), S.new()
    for d, who in ((doc, w), (plain, man)):
        S.hear(d, who, "사랑해, 보고 싶었어", "m1", start, TZ)
    # (angry, she'd find happiness landing less: her off day is no anger of theirs, so it lands in full)
    assert _lv(w, start, doc)["happy"] == _lv(man, start, plain)["happy"] and _lv(w, start, doc)["happy"]["v"] > 0.35
    assert doc["feelings"] == plain["feelings"]  # (nothing of the off day was written into how she feels)
    S.report(doc, w, "angry", "strong", "버그가 또 터져서", start + timedelta(hours=25), TZ)
    assert _lv(w, start + timedelta(hours=25), doc)["angry"] == {"v": 0.85, "why": {"text": "버그가 또 터져서"}}
    S.report(doc, w, "sleepy", "none", "커피 마셨어", start + timedelta(hours=26), TZ)
    assert _lv(w, start + timedelta(hours=26), doc)["sleepy"]["why"] == {"code": "off_day"}  # (the floor stays hers)


def test_it_is_not_at_them_she_is_only_out_of_sorts():
    w = _her()
    start = _starts(w)[0]
    doc = S.new()
    s = S.summary(doc, w, start, TZ)
    assert s["label"] == "angry" and s["blend"] == "angry_sleepy" and s["top"][0]["why"] == {"code": "off_day"}
    assert not S.furious(doc, w, start, TZ)  # (strong as it is: no refusing to answer)
    line = S.line(s)
    assert "for no reason you could name" in line and "isn't about them" in line and S.REFUSE not in line
    assert S.HURT_BY_THEM[1] not in line
    assert not any(word in line.lower() for word in ("period", "cycle", "month", "menstru"))
    S.hear(doc, w, "닥쳐", "m1", start + H, TZ)  # (a rude word: anger at them, from where her own feelings are)
    assert doc["feelings"]["angry"]["v"] == pytest.approx(0.3) and not S.furious(doc, w, start + H, TZ)
    assert S.summary(doc, w, start + H, TZ)["top"][0]["why"] == {"code": "off_day"}
    assert S.leaning(doc, w, None, start, TZ) == S.leaning(doc, _her(gender=""), None, start, TZ)  # (no reason to say no)


# ---- on a real mate ----

def _svc(db):
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    store = MateStore(db, vault)
    return store, MateService(svc, store)


def _met_so_that_her_first_began(store, mate_id, ago):
    """Their first meeting put where her first off day began ``ago`` before now."""
    draw = random.Random(f"off_day:{mate_id}").random()
    met = datetime.now(UTC) - ago - S.OFF_DAY_FIRST * draw
    doc = store.relation_doc(mate_id) or A.new()
    doc["started_at"] = A._iso(met)
    store.save_relation(mate_id, doc)


def test_a_woman_mate_shows_it_and_her_relationship_is_untouched(db):
    store, mates = _svc(db)
    her = store.create(name="Rin", persona={"description": "A quiet woman who loves games.", "gender": "female"})
    him = store.create(name="Jun", persona={"description": "x", "gender": "male"})
    for m in (her, him):
        mates.relation_view(m["id"])
        _met_so_that_her_first_began(store, m["id"], timedelta(hours=3))
    before = store.relation_doc(her["id"])["affinity"]
    got = store.get(her["id"])["state"]
    assert got["label"] == "angry" and got["top"][0]["why"] == {"code": "off_day"}
    assert {f["emotion"]: f["why"] for f in mates.state_view(her["id"])["feelings"]}["sleepy"] == {"code": "off_day"}
    assert store.get(him["id"])["state"]["label"] == S.CALM
    mates._relation_turn(her["id"], {"input": "안녕", "text": "[angry] ...안녕.", "meta": None})
    doc = store.relation_doc(her["id"])
    assert doc["affinity"] >= before + A.TALK and not [e for e in doc["log"] if e["d"] < 0]  # (a day's talk as ever; nothing taken off)


# ---- who she is ----

@pytest.mark.parametrize("text, gender", [
    ("A 26-year-old Korean woman. She always has her hood up.", "female"),
    ("그녀는 말수가 적은 QA 엔지니어다. 다정한 언니 같은 사람.", "female"),
    ("You are a cheerful girl who loves cats.", "female"),
    ("그는 조용한 남자다. 형 같은 사람.", "male"),
    ("He is a knight; his sword is old.", "male"),
    ("작고 마른 체형. 인형을 모은다. 유형은 INFP.", ""),  # (체형, 인형, 유형: no 형)
    ("{{user}}의 남자친구 이야기를 자주 듣는다.", ""),  # (whose friend?)
    ("She met him at the station.", ""),  # (neither outweighs the other)
    ("The user's personal secretary. You keep an eye on their chats.", ""),
])
def test_her_own_text_tells_or_nothing_is_guessed(text, gender):
    assert infer_gender({"description": text}) == gender


def test_it_is_part_of_the_persona_and_only_ever_one_of_two_or_unknown():
    assert normalize_persona({"gender": "Female"})["gender"] == "female"
    assert normalize_persona({"gender": "robot"})["gender"] == ""
    assert normalize_persona(None, {"gender": "whatever"})["gender"] == ""
    assert normalize_persona({})["gender"] == ""


def test_new_mates_older_mates_and_the_api(db):
    store, _ = _svc(db)
    told = store.create(name="A", persona={"description": "A shy girl.", "gender": "male"})
    assert told["persona"]["gender"] == "male"  # (said: kept as said)
    read = store.create(name="B", persona={"description": "A shy girl who reads."})
    assert read["persona"]["gender"] == "female"  # (an import, an older client: her own text)
    for mid, persona in (("mate_01d000000001", {"description": "그녀는 화가다."}), ("mate_01d000000002", {"description": "x"}),
                         ("mate_01d000000003", {"description": "He paints.", "gender": "female"})):
        db.execute("INSERT INTO mates (id, name, is_default, persona, avatar, llm, voice, prefs, created_at, updated_at) "
                   "VALUES (?, 'Old', 0, ?, '{}', '{}', '{}', '{}', '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00')",
                   (mid, json.dumps(persona, ensure_ascii=False)))
    done = {r["id"]: r["gender"] for r in store.migrate_gender()}
    assert done == {"mate_01d000000001": "female", "mate_01d000000002": ""}  # (one that has it: left alone)
    assert store.get("mate_01d000000003")["persona"]["gender"] == "female"
    assert store.migrate_gender() == []  # (once)
    assert "gender" in json.loads(db.query_one("SELECT persona FROM mates WHERE id = 'mate_01d000000002'")["persona"])


def test_a_bundled_woman_is_one_and_the_sync_keeps_what_the_user_changed(db):
    store, mates = _svc(db)
    cha = store.by_builtin("chaerin")
    assert cha["persona"]["gender"] == "female" and files.builtin_bundle("chaerin")["persona"]["gender"] == "female"
    assert files.BUILTIN_GENDERS["mao"] == "female"  # (her files aren't in the repository: said here)
    # one from before: no gender in her persona or the snapshot she was synced from
    raw = json.loads(db.query_one("SELECT persona FROM mates WHERE id = ?", (cha["id"],))["persona"])
    raw.pop("gender")
    snap = cha["builtin_snapshot"]
    snap["persona"].pop("gender")
    db.execute("UPDATE mates SET persona = ?, builtin_snapshot = ?, builtin_hash = 'old' WHERE id = ?",
               (json.dumps(raw, ensure_ascii=False), json.dumps(snap, ensure_ascii=False), cha["id"]))
    assert store.migrate_gender() == []  # (a bundled mate: her bundle says)
    mates.sync_builtins()
    assert store.get(cha["id"])["persona"]["gender"] == "female"
    store.update(cha["id"], {"persona": {"gender": "male"}})  # (only an API client could: nothing in the app does)
    db.execute("UPDATE mates SET builtin_hash = 'old' WHERE id = ?", (cha["id"],))
    mates.sync_builtins()
    assert store.get(cha["id"])["persona"]["gender"] == "male"


def test_the_studio_writes_it_and_nothing_on_the_right_shows_it():
    patch, _ = ST.agent_patch({"fields": {"name": "린", "gender": "female", "persona": {"description": "You are Rin."}}})
    assert patch["persona"] == {"description": "You are Rin.", "gender": "female"}
    assert ST.paths_of(patch, {}) == ["name", "persona.description", "gender"]
    with pytest.raises(ST.StudioError, match="fields.gender"):
        ST.agent_patch({"fields": {"persona": {"gender": "female"}}})
    with pytest.raises(ST.StudioError, match="female or male"):
        ST.agent_patch({"fields": {"gender": "robot"}})
    mate = {"name": "린", "persona": {"description": "You are Rin.", "gender": "female"}}
    assert ST.snapshot(mate, {})["gender"] == "female" and ST.compact(mate, {})["gender"] == "female"
    before = {k: v for k, v in ST.snapshot(mate, {}).items() if k != "gender"}  # (a project from before it existed)
    assert ST.update_note(before, ST.snapshot(mate, {})) == ""  # (not on the right: nothing the user changed)
    assert "gender" in ST.HIDDEN
