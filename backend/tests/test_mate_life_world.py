"""Her day in the real world (app/mate/life/world.py): no work on weekends or public holidays, now and then a weekend
overtime instead; the real sky where the user is."""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.mate.life import profile as P
from app.mate.life import sim
from app.mate.life.world import World

KST = ZoneInfo("Asia/Seoul")


def _work_days(doc, world, start, days):
    out = {}
    for d in range(days):
        day = start + timedelta(days=d)
        out[day.strftime("%Y-%m-%d")] = {b["activity"] for b in sim._blocks(doc, world, day)}
    return out


def test_weekdays_work_days_off_do_not_and_overtime_is_rare():
    world = P.load("chaerin")
    doc = sim.new(world, datetime(2026, 1, 5, 12, tzinfo=KST), KST, "mate_t")
    try:
        sim.REAL["holidays"] = {"2026-01-07"}  # (a Wednesday off)
        days = _work_days(doc, world, datetime(2026, 1, 5, 12, tzinfo=KST), 7)
        assert "work" in days["2026-01-05"] and "work" not in days["2026-01-07"], "a holiday is a day off"
        assert all("work" not in days[d] for d in ("2026-01-10", "2026-01-11")), "no work on the weekend"
        # weekend overtime: on some days off, never on a working day
        many = _work_days(doc, world, datetime(2026, 1, 3, 12, tzinfo=KST), 7 * 60)
        off = [d for d, acts in many.items() if datetime.fromisoformat(d).weekday() >= 5]
        overtime = [d for d in off if "overtime" in many[d]]
        assert 0 < len(overtime) < len(off) * 0.25
        assert not any("overtime" in acts for d, acts in many.items() if datetime.fromisoformat(d).weekday() < 5 and d != "2026-01-07")
    finally:
        sim.REAL["holidays"] = set()


def test_the_real_sky():
    skies = World.skies({"daily": {"time": ["2026-01-05", "2026-01-06"], "weather_code": [3, 73], "temperature_2m_min": [-4.2, -6],
                                   "temperature_2m_max": [2.6, 0]},
                         "current": {"time": "2026-01-05T14:00", "weather_code": 61, "temperature_2m": 1.4}}, "Seoul")
    assert skies["2026-01-05"] == {"sky": "rain", "low": -4, "high": 3, "city": "Seoul", "temp": 1}
    assert skies["2026-01-06"]["sky"] == "snow"
    try:
        sim.REAL["skies"] = skies
        world = P.load("chaerin")
        now = datetime(2026, 1, 5, 14, tzinfo=KST)
        doc = sim.new(world, now, KST, "mate_t")
        assert sim.weather(doc, now) == "rain"
        assert "in Seoul it is 1°C and raining" in sim.line(doc, world, now, KST)
        assert sim.summary(doc, world, now, KST)["temp"] == 1
    finally:
        sim.REAL["skies"] = {}
