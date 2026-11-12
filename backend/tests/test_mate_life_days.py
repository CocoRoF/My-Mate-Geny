"""The days of her year (docs/mate-life.md): Labor Day and the observances where the user lives, birthdays, the week and the sky on
how she feels, what she comes to like with them, what she gives them and the moments they share."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.mate.life import days as D
from app.mate.life import profile as P
from app.mate.life import sim

KST = timezone(timedelta(hours=9))


@pytest.fixture
def world():
    return P.load("chaerin")


@pytest.fixture
def korea():
    """The user lives in Korea (life/world.py would say so from their location or time zone)."""
    was = dict(sim.REAL)
    sim.REAL.update(country="KR", holidays=set(), holiday_names={}, skies={})
    yield sim.REAL
    sim.REAL.clear()
    sim.REAL.update(was)


def _doc(world, at, **kw):
    doc = sim.new(world, at, KST, kw.pop("seed", "m"))
    doc.update(kw)
    return doc


def test_the_calendar_is_sound_and_has_room_for_other_countries():
    assert set(D.CALENDAR) == {"KR"}
    ids = {d["id"] for d in D.CALENDAR["KR"]}
    assert {"labor_day", "armed_forces_day", "liberation_day", "hangul_day", "gaecheonjeol", "samiljeol", "childrens_day", "parents_day",
            "teachers_day", "christmas", "pepero_day", "valentines", "white_day", "new_year", "seollal", "chuseok"} <= ids
    with pytest.raises(ValueError):
        D.check({"KR": [{"id": "x", "names": {"ko": "a", "en": "a"}, "about": "a", "tone": "festive", "date": "13-01"}]})
    with pytest.raises(ValueError):
        D.check({"Korea": []})
    assert D.on(datetime(2026, 11, 11, 12, tzinfo=KST), "JP") == []  # (a country without a list: nothing yet)


def test_labor_day_is_a_day_off_in_korea_only(world, korea):
    may_day = datetime(2026, 5, 1, 12, tzinfo=KST)  # (a Friday)
    doc = _doc(world, may_day - timedelta(days=1))
    assert sim.off_day(may_day)
    assert "work" not in {b["activity"] for b in sim._blocks(doc, world, may_day)}
    assert "Labor Day (노동절)" in sim.line(doc, world, may_day, KST) and "a day off for you" in sim.line(doc, world, may_day, KST)
    korea["country"] = "US"
    assert not sim.off_day(may_day)
    assert "work" in {b["activity"] for b in sim._blocks(doc, world, may_day)}
    korea["country"] = ""
    assert not sim.off_day(may_day)  # (nowhere known: weekends and the holidays found only)


def test_she_knows_what_today_is_and_greets_lightly(world, korea):
    pepero = datetime(2026, 11, 11, 20, tzinfo=KST)
    doc = _doc(world, pepero - timedelta(hours=1))
    text = sim.line(doc, world, pepero, KST)
    assert "Today is Pepero Day (빼빼로데이)" in text and "greet them with it" in text
    s = sim.summary(doc, world, pepero, KST)
    assert s["observance"] == {"id": "pepero_day", "name": {"ko": "빼빼로데이", "en": "Pepero Day"}, "tone": "festive"}
    assert not s["holiday"]
    memorial = datetime(2026, 6, 6, 12, tzinfo=KST)
    assert "no cheerful greeting" in sim.line(doc, world, memorial, KST)


def test_a_holiday_by_its_name_is_what_the_day_is(world, korea):
    chuseok = datetime(2026, 9, 25, 12, tzinfo=KST)
    korea["holidays"] = {"2026-09-25", "2026-12-28"}
    korea["holiday_names"] = {"2026-09-25": [{"en": "Chuseok", "local": "추석"}], "2026-12-28": [{"en": "Election Day", "local": "선거일"}]}
    doc = _doc(world, chuseok - timedelta(hours=1))
    assert sim.summary(doc, world, chuseok, KST)["observance"]["id"] == "chuseok"
    assert "Today is Chuseok (추석)" in sim.line(doc, world, chuseok, KST)
    other = datetime(2026, 12, 28, 12, tzinfo=KST)  # (a holiday the calendar doesn't know: by the name the holidays gave it)
    assert sim.summary(doc, world, other, KST)["observance"] == {"id": "holiday", "name": {"en": "Election Day", "ko": "선거일"}, "tone": "plain"}
    assert "public holiday (Election Day)" in sim.line(doc, world, other, KST)


def test_what_counts_most_comes_first_and_a_gloomy_good_day_is_both(world, korea):
    xmas = datetime(2026, 12, 25, 11, tzinfo=KST)
    korea["holidays"] = {"2026-12-25"}
    korea["holiday_names"] = {"2026-12-25": [{"en": "Christmas Day", "local": "기독탄신일"}]}
    korea["skies"] = {"2026-12-25": {"sky": "rain", "temp": 3, "low": 1, "high": 5, "city": "Seoul"}}
    doc = _doc(world, xmas - timedelta(hours=1), birthdays={"her": "12-25", "user": ""})
    text = sim.line(doc, world, xmas, KST)
    order = [text.index(s) for s in ("Today is your birthday", "Today is Christmas", "a day off for you", "it is 3°C and raining")]
    assert order == sorted(order), "her birthday, then the day she knows, then the holiday, then the sky"
    assert "public holiday (Christmas Day)" not in text  # (the day she knows names it already)
    assert "A good day and a gloomy one at once (it is raining" in text and "cheer you put on" in text
    korea["skies"] = {"2026-12-25": {"sky": "clear", "temp": 3, "city": "Seoul"}}
    assert "gloomy" not in sim.line(doc, world, xmas, KST)


def test_birthdays_both_of_them(world, korea):
    june = datetime(2026, 6, 21, 9, tzinfo=KST)
    doc = _doc(world, june - timedelta(hours=10), birthdays={"her": "06-21", "user": "06-21"})
    assert sim.birthdays(doc, june) == ["her", "user"]
    assert sim.summary(doc, world, june, KST)["birthday"] == "both"
    doc["birthdays"] = {"her": "02-29", "user": "03-01"}
    assert sim.birthdays(doc, datetime(2027, 2, 28, 9, tzinfo=KST)) == ["her"]  # (no 29th that year)
    assert sim.birthdays(doc, datetime(2028, 2, 28, 9, tzinfo=KST)) == []
    assert sim.birthdays(doc, datetime(2028, 3, 1, 9, tzinfo=KST)) == ["user"]


def test_her_birthday_begins_her_day_and_theirs_waits_until_she_is_up(world, korea):
    eve = datetime(2026, 6, 20, 22, tzinfo=KST)
    doc = _doc(world, eve)
    out = sim.advance(doc, world, eve + timedelta(hours=14), KST, birthdays={"her": "06-21", "user": "06-21"})
    occasions = [e for e in out if e["type"] == "occasion"]
    assert [e["id"] for e in occasions] == ["her_birthday", "user_birthday"]
    assert sim.A._t(occasions[0]["at"]).astimezone(KST).hour == 0  # (hers: as the date turns)
    up = sim.A._t(occasions[1]["at"]).astimezone(KST)
    assert up.hour >= sim.GIFT_HOURS[0] and occasions[1]["share"] and not occasions[0]["share"]
    assert all(e["type"] != "occasion" for e in sim.advance(doc, world, eve + timedelta(hours=22), KST))  # (once a year)
    text = sim.line(doc, world, eve + timedelta(hours=22), KST)
    assert "Today is your birthday" in text and "Today is their birthday" in text and "first thing" in text


def test_a_message_on_her_birthday_means_more_and_is_a_moment(world, korea):
    day = datetime(2026, 6, 21, 12, tzinfo=KST)
    plain, bday = _doc(world, day), _doc(world, day, birthdays={"her": "06-21", "user": ""})
    for doc in (plain, bday):
        doc["needs"]["affection"] = 0.6
        sim.heard(doc, world, "m1", day, warm=True, tz=KST)
    assert 0.6 - bday["needs"]["affection"] == pytest.approx(2 * (0.6 - plain["needs"]["affection"]))
    assert [m["kind"] for m in bday["moments"]] == ["birthday"] and not plain["moments"]
    sim.heard(bday, world, "m2", day + timedelta(minutes=5), tz=KST)
    assert len(bday["moments"]) == 1  # (once a year)
    bday["coins"] = 10_000
    assert sim.give(bday, world, "letter", day, KST)["birthday"] and not sim.give(plain, world, "coffee", day, KST).get("birthday")


def test_the_week_and_the_sky_lean_how_she_feels_a_little(world, korea):
    monday = datetime(2026, 11, 2, 8, 0, tzinfo=KST)
    doc = _doc(world, monday - timedelta(minutes=30))
    life = sim.for_state(doc, world, monday, KST)
    assert life["feel"]["sad"] == sim.MOODS["monday"]["sad"] and "Monday morning" in life["doing"]
    assert sim.for_state(doc, world, monday)["feel"].get("sad") is None  # (without the time zone: only what she is doing)
    friday = datetime(2026, 11, 6, 19, 0, tzinfo=KST)
    resting = {"place": "home", "activity": "rest"}
    korea["skies"] = {"2026-11-06": {"sky": "cloudy"}, "2026-11-07": {"sky": "clear"}, "2026-11-04": {"sky": "rain"}}
    assert sim.for_state(_doc(world, friday, **resting), world, friday, KST)["feel"]["happy"] == sim.MOODS["friday"]["happy"]
    clear_saturday = datetime(2026, 11, 7, 14, 0, tzinfo=KST)
    assert sim.for_state(_doc(world, clear_saturday, **resting), world, clear_saturday, KST)["feel"]["happy"] == sim.MOODS["bright_off"]["happy"]
    rainy = datetime(2026, 11, 4, 20, 0, tzinfo=KST)
    home = sim.for_state(_doc(world, rainy, **resting), world, rainy, KST)
    assert home["feel"]["sleepy"] == world["moods"]["wet"]["sleepy"]  # (hers: rain at home is cosy more than gloomy)
    out = sim.for_state(_doc(world, rainy, place="park", activity="walk"), world, rainy, KST)
    assert out["feel"]["sad"] == sim.MOODS["wet_out"]["sad"] and "rainy" in out["doing"]
    for when in (monday, friday, clear_saturday, rainy, datetime(2026, 12, 25, 12, tzinfo=KST)):
        for _name, nudge in sim.mood(_doc(world, when, birthdays={"her": "12-25", "user": "12-25"}), world, when):
            assert max(nudge.values()) <= sim.MOOD_MAX  # (subtle, always)


def test_what_they_do_together_she_comes_to_like_within_bounds(world):
    t = datetime(2026, 11, 7, 13, 0, tzinfo=KST)
    doc = _doc(world, t)
    sim.decide(doc, world, "boardgame", t, KST, with_user=True, minutes=480)
    for h in range(1, 40):
        doc["heard_at"] = sim.A._iso(t + timedelta(hours=h))  # (they keep talking: she stays)
        sim.advance(doc, world, t + timedelta(hours=h), KST)
    assert doc["tastes"]["boardgame"] == sim.TASTE_MAX  # (it grew, and no further than that)
    fresh = _doc(world, t)
    before = sim._score(fresh, world, "boardgame", world["activities"]["boardgame"], t, KST)
    fresh["tastes"] = dict(doc["tastes"])
    assert sim._score(fresh, world, "boardgame", world["activities"]["boardgame"], t, KST) == pytest.approx(before + sim.TASTE_MAX)
    assert [f for f in doc["favourites"] if f["kind"] == "activity" and f["id"] == "boardgame"]
    assert "come to like" in sim.line(doc, world, sim.A._t(doc["favourites"][0]["at"]) + timedelta(hours=1), KST)
    assert sim.normalized({**doc, "tastes": {"boardgame": 9, "moon": 1}}, world)["tastes"] == {"boardgame": sim.TASTE_MAX}


def test_a_gift_they_keep_sending_becomes_a_favourite(world):
    t = datetime(2026, 11, 7, 13, 0, tzinfo=KST)
    doc = _doc(world, t, coins=10_000)
    for i in range(sim.FAVOURITE_GIFT_AT + 2):
        out = sim.give(doc, world, "dessert_box", t + timedelta(minutes=i), KST)
        assert out["favourite"] == (i + 1 == sim.FAVOURITE_GIFT_AT)
    assert doc["received"]["dessert_box"] == sim.FAVOURITE_GIFT_AT + 2
    assert doc["tastes"]["dessert"] == pytest.approx(sim.TASTE_GIFT * (sim.FAVOURITE_GIFT_AT + 2))
    assert "a box of desserts has become a favourite" in sim.line(doc, world, t + timedelta(hours=1), KST).lower()
    assert "has become a favourite" not in sim.line(doc, world, t + sim.TASTE_TOLD + timedelta(hours=1), KST)  # (now and then)


def test_she_gives_them_something_on_their_birthday_once(world, korea):
    eve = datetime(2026, 3, 2, 22, tzinfo=KST)
    doc = _doc(world, eve)
    out = sim.advance(doc, world, eve + timedelta(hours=20), KST, birthdays={"her": "", "user": "03-03"})
    gave = [e for e in out if e["type"] == "gave"]
    assert len(gave) == 1 and gave[0]["why"] == "birthday" and gave[0]["id"] in ("bug_card", "boardgame_pass")
    assert gave[0]["note"]["ko"] and "생일" in gave[0]["note"]["ko"]
    assert doc["given"][-1]["id"] == gave[0]["id"]
    later = sim.advance(doc, world, eve + timedelta(hours=24), KST)
    assert not [e for e in later if e["type"] == "gave"]  # (once a year)
    t = eve + timedelta(hours=24)
    assert "you gave them" in sim.line(doc, world, t, KST) and "for their birthday" in sim.line(doc, world, t, KST)
    v = sim.view(doc, world, t, KST)
    assert v["given"][0]["for"] == {"kind": "birthday", "key": "", "name": {}} and v["gift"]["id"] == gave[0]["id"]
    # the same seed, the same day: the same gift
    again = _doc(world, eve)
    sim.advance(again, world, eve + timedelta(hours=20), KST, birthdays={"her": "", "user": "03-03"})
    assert again["given"][-1]["id"] == gave[0]["id"] and again["given"][-1]["at"] == gave[0]["at"]


def test_she_gives_for_a_milestone_that_just_came_not_an_old_one(world, korea):
    t = datetime(2026, 11, 4, 9, tzinfo=KST)
    doc = _doc(world, t)
    old = [{"key": "days_100", "at": (t - timedelta(days=30)).isoformat()}]
    assert not [e for e in sim.advance(doc, world, t + timedelta(hours=10), KST, milestones=old) if e["type"] == "gave"]
    assert [m["key"] for m in doc["moments"] if m["kind"] == "milestone"] == ["days_100"]  # (still a moment of theirs)
    doc = _doc(world, t)
    new = [{"key": "stage_trusted", "at": t.isoformat()}]
    gave = [e for e in sim.advance(doc, world, t + timedelta(hours=10), KST, milestones=new) if e["type"] == "gave"]
    assert len(gave) == 1 and gave[0]["why"] == "milestone:stage_trusted"
    assert "because you have grown close" in sim.line(doc, world, t + timedelta(hours=10), KST)


def test_rarely_just_because_and_only_when_close(world, korea):
    start = datetime(2026, 1, 5, 8, tzinfo=KST)
    quiet = {**world, "events": []}  # (only what she gives, and quickly)

    def given(stage, seed, weeks):
        doc = _doc(quiet, start, seed=seed)
        n = 0
        for week in range(1, weeks + 1):
            n += len([e for e in sim.advance(doc, quiet, start + timedelta(days=7 * week), KST, stage=stage) if e["type"] == "gave"
                      and e["why"] == "random"])
        return n, doc

    assert given("new", "a", 8)[0] == 0 and given("familiar", "a", 8)[0] == 0
    n, doc = given("companion", "a", 26)
    assert 0 < n <= 26 * 7 / sim.GIFT_RANDOM_GAP.days + 1  # (now and then: never two within a month)
    ats = [sim.A._t(g["at"]) for g in doc["given"] if g["why"] == "random"]
    assert all(b - a >= sim.GIFT_RANDOM_GAP for a, b in zip(ats, ats[1:]))


def test_after_something_happens_to_her_and_on_a_day_she_knows(world, korea):
    t = datetime(2026, 11, 7, 14, tzinfo=KST)
    doc = _doc(world, t, place="arcade", activity="arcade")
    event = next(e for e in world["events"] if e["id"] == "crane_win")
    found = [sim._occasion(_doc(world, t, seed=f"s{i}"), t, KST, "familiar", [], event, world["gifts_to_user"]) for i in range(40)]
    assert ("event:crane_win", "event:crane_win") in found and None in found  # (some days she does)
    assert sim._occasion(doc, t, KST, "new", [], event, world["gifts_to_user"]) is None  # (not to someone she hardly knows)
    pepero = datetime(2026, 11, 11, 12, tzinfo=KST)
    days = [sim._occasion(_doc(world, pepero, seed=f"s{i}"), pepero, KST, "trusted", [], None, world["gifts_to_user"]) for i in range(40)]
    assert ("day:pepero_day", "day:pepero_day") in days
    v = sim._given_for(world, "day:pepero_day")
    assert v == {"kind": "day", "key": "pepero_day", "name": {"ko": "빼빼로데이", "en": "Pepero Day"}}


def test_moments_they_share(world):
    t = datetime(2026, 11, 7, 14, tzinfo=KST)
    doc = _doc(world, t, with_user=sim.A._iso(t))
    event = {"id": "park_cat", "says": "a cat", "effects": {}}
    sim._fire(doc, event, t, KST, [])
    alone = _doc(world, t)
    sim._fire(alone, event, t, KST, [])
    assert [m["kind"] for m in doc["moments"]] == ["event"] and not alone["moments"]
    v = sim.view(doc, world, t, KST)
    assert v["moments"][0]["title"]["ko"] and v["moments"][0]["id"] == "park_cat"
    doc["moments"] = [{"kind": "event", "id": "x", "at": (t - timedelta(days=i)).isoformat()} for i in range(sim.MOMENTS_MAX + 10)]
    assert len(sim.normalized(doc, world)["moments"]) == sim.MOMENTS_MAX


def test_her_job_said_plainly(world):
    t = datetime(2026, 11, 4, 21, tzinfo=KST)
    text = sim.line(_doc(world, t), world, t, KST)
    assert "Your job: a QA (quality assurance) engineer at a game company" in text and "09:30–18:30" in text
    office = P.load("default")
    assert "Your job: an office worker" in sim.line(_doc(office, t), office, t, KST)
    assert sim.view(_doc(world, t), world, t, KST)["job"] == {"ko": "게임 회사 QA 엔지니어", "en": "QA engineer at a game company"}


def test_a_profile_with_a_bad_gift_or_mood_fails_loudly(world):
    with pytest.raises(ValueError):
        P.check({**world, "gifts_to_user": [{"id": "x", "names": {"ko": "a", "en": "a"}, "about": "a", "notes": {"default": {"ko": "a", "en": "a"}},
                                             "for": ["event:nope"]}]})
    with pytest.raises(ValueError):
        P.check({**world, "gifts_to_user": [{"id": "x", "names": {"ko": "a", "en": "a"}, "about": "a", "for": ["random"]}]})
    with pytest.raises(ValueError):
        P.check({**world, "moods": {"wet": {"gloomy": 0.2}}})
    with pytest.raises(ValueError):
        P.check({**world, "job": {"about": "x"}})


# ---- where the birthdays are kept, and who hears what she gave ----

def test_birthdays_are_kept_where_they_belong(db, tmp_path, monkeypatch):
    from app.mate import files
    from app.mate.store import MateError, MateStore
    from app.vault import SecretVault

    store = MateStore(db, SecretVault(db))
    mate = store.create(name="채린", persona={"description": "x", "birthday": "06-21"})
    assert mate["persona"]["birthday"] == "06-21"
    for bad in ("6/21", "02-30", "june"):
        with pytest.raises(MateError):
            store.update(mate["id"], {"persona": {"birthday": bad}})
    store.update(mate["id"], {"persona": {"description": "y"}})
    assert store.get(mate["id"])["persona"]["birthday"] == "06-21"  # (a patch without it keeps it)
    assert store.settings()["user_birthday"] == ""
    store.update_settings({"user_birthday": "02-29"})
    assert store.settings()["user_birthday"] == "02-29" and "user_birthday" in store.last_changed
    with pytest.raises(MateError):
        store.update_settings({"user_birthday": "13-01"})
    store.update_settings({"user_birthday": ""})
    assert store.user_birthday() == ""
    # the bundled ones: hers from her persona; Mao's persona isn't in the repo, so hers is in the code
    assert files.builtin_bundle("chaerin")["persona"]["birthday"] == "06-21"
    assert files.compose_persona({"key": "x", "birthday": "99-99"})["birthday"] == ""
    import json as _json

    (tmp_path / "personas").mkdir()
    (tmp_path / "personas" / "mao.json").write_text(_json.dumps({"key": "mao", "names": {"en": "Mao"}}), encoding="utf-8")
    monkeypatch.setattr(files, "BUILTIN_DIR", tmp_path)
    assert files.builtin_bundle("mao")["persona"]["birthday"] == files.BUILTIN_BIRTHDAYS["mao"] == "04-30"


def test_the_runtime_tells_her_day_both_birthdays(db, monkeypatch):
    from app.mate.life.runtime import LifeRuntime
    from app.mate.store import MateStore
    from app.vault import SecretVault

    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    store = MateStore(db, SecretVault(db))
    mate = store.create(name="채린", persona={"description": "x", "birthday": "06-21"})
    store._db.execute("UPDATE mates SET builtin = 'chaerin' WHERE id = ?", (mate["id"],))
    store.update_settings({"user_birthday": "03-03"})
    life = LifeRuntime(store)
    life.tick()
    assert store.life_doc(mate["id"], P.load("chaerin"))["birthdays"] == {"her": "06-21", "user": "03-03"}
    store.update_settings({"user_birthday": "04-04"})
    life.tick()
    assert store.life_doc(mate["id"], P.load("chaerin"))["birthdays"]["user"] == "04-04"
    assert "birthday" in store.get(mate["id"])["life"]  # (the flag on the mate document)


def test_what_she_gave_shows_in_her_chat_and_she_may_say_so(db, tmp_path, monkeypatch):
    from tests.test_mate_life_service import _reaching, _service

    _, store, mates = _service(db, monkeypatch, tmp_path)
    mate, calls = _reaching(store, mates, monkeypatch)
    notices = []
    monkeypatch.setattr(mates._svc, "add_notice", lambda sid, code, message, **kw: notices.append((sid, code, kw)))
    now = datetime.now(timezone.utc)
    gift = {"type": "gave", "id": "bug_card", "name": {"ko": "손글씨 버그 리포트 카드", "en": "A hand-written bug-report card"},
            "note": {"ko": "생일 축하해요", "en": "Happy birthday"}, "why": "birthday", "at": now.isoformat(), "share": True,
            "title": {"ko": "선물", "en": "A gift"}}
    mates._life_happened(mate["id"], [gift])
    assert notices == [("S", "life.gave", {"name": mate["name"], "gift": gift["name"], "item": "bug_card", "why": "birthday"})]
    assert len(calls) == 1 and calls[0][1]["meta"]["kind"] == "life_birthday" and "happy birthday" in calls[0][0] and "gift" in calls[0][0]
    calls.clear()
    mates._life_reach_out(mate["id"], [{**gift, "why": "random"}])
    assert calls[0][1]["meta"]["kind"] == "life_gave"
    calls.clear()
    morning = {"type": "occasion", "id": "user_birthday", "at": (now - timedelta(hours=3)).isoformat(), "share": True}
    mates._life_reach_out(mate["id"], [morning])  # (their birthday is news all morning)
    assert calls and calls[0][1]["meta"]["kind"] == "life_birthday"
    calls.clear()
    mates._life_reach_out(mate["id"], [{**gift, "why": "random", "at": (now - timedelta(hours=3)).isoformat()}])
    assert calls == []  # (anything else, only just now)
    mates._life_happened(mate["id"], [{"type": "occasion", "id": "her_birthday", "at": now.isoformat(), "share": False,
                                       "feel": {"happy": "slight"}, "title": {"ko": "생일", "en": "Her birthday"}}])
    assert store.state_doc(mate["id"])["feelings"]["happy"]["why"] == {"text": "생일"}


def test_a_gift_on_her_birthday_counts_more_between_them(db, monkeypatch):
    from app.mate import affinity as A
    from tests.test_mate_affinity import _svc

    _, store, mates = _svc(db)
    plain, bday = store.create(name="Plain"), store.create(name="Bday")
    for m, birthday in ((plain, False), (bday, True)):
        monkeypatch.setattr(mates.life, "give", lambda mate_id, item, b=birthday: {"code": "ok", "item": {"id": item}, "asleep": True, "birthday": b})
        monkeypatch.setattr(mates.life, "note", lambda mate_id, text: None)
        monkeypatch.setattr(mates.life, "view", lambda mate_id: {"enabled": True})
        mates.life_gift(m["id"], "letter")
    assert mates.relation_view(plain["id"])["affinity"] == A.GIFT
    assert mates.relation_view(bday["id"])["affinity"] == min(A.GIFT_CAP, 2 * A.GIFT)
    again = mates.relation_reset(bday["id"], "recompute")  # (the replay counts it the same)
    assert again["affinity"] == min(A.GIFT_CAP, 2 * A.GIFT)


def test_the_world_keeps_the_holidays_names():
    from app.mate.life.world import World

    named = World.named([{"date": "2026-09-25", "localName": "추석", "name": "Chuseok", "global": True},
                         {"date": "2026-03-01", "localName": "삼일절", "name": "Independence Movement Day"},
                         {"date": "2026-06-01", "localName": "x", "name": "Regional", "global": False, "counties": ["KR-11"]}])
    assert named == [{"date": "2026-03-01", "en": "Independence Movement Day", "local": "삼일절"},
                     {"date": "2026-09-25", "en": "Chuseok", "local": "추석"}]
