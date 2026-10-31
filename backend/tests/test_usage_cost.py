"""API-equivalent cost: per turn at the source, legacy cumulative values
normalized for history and the Usage page; plan windows; default model."""
import json

import pytest

from app.providers import catalog
from app.providers._stream_json import StreamJsonAccumulator
from app.providers.base import ProviderEvent
from app.providers.subscription import _claude_windows
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.turn_cost import TurnCostNormalizer, normalize_events
from app.services.usage_service import UsageService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

# total_cost_usd of one real chat's turns on ONE persistent engine process
# (the CLI's running total), then the same chat's next turn.
REAL = [0.527495, 11.031194800000003, 12.858359600000009, 13.095744600000009, 13.691400200000007,
        15.055953600000008, 17.580392600000014, 18.057675000000014, 63.83168899999998, 64.40684259999999,
        78.40446599999997]


def _result(total):
    return {"type": "result", "subtype": "success", "result": "ok", "session_id": "s",
            "total_cost_usd": total, "usage": {"input_tokens": 1, "output_tokens": 2}}


def _svc(db):
    vault = SecretVault(db)
    return SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))


def _legacy(total):
    # what the persistent engine recorded before cost_kind existed
    return {"text": "x", "model": "claude-opus-5-5", "usage": {"input_tokens": 10, "output_tokens": 5},
            "cost_usd": total, "provider": "claude", "num_turns": 3}


# ---- source: per-turn cost from the CLI's running total -----------------------


def test_accumulator_reports_turn_share_of_process_total():
    base = 0.0
    costs = []
    for total in REAL[:4]:
        acc = StreamJsonAccumulator(cost_base=base)
        (ev,) = list(acc.feed(_result(total)))
        assert ev.type == "turn.complete" and ev.data["cost_kind"] == "turn"
        assert ev.data["process_cost_usd"] == pytest.approx(total)
        costs.append(ev.data["cost_usd"])
        base = acc.cost_total
    assert costs == pytest.approx([REAL[0], REAL[1] - REAL[0], REAL[2] - REAL[1], REAL[3] - REAL[2]])


def test_accumulator_one_shot_and_failed_turns():
    acc = StreamJsonAccumulator()  # one-shot: the process IS the turn
    (ev,) = list(acc.feed(_result(0.42)))
    assert ev.data["cost_usd"] == pytest.approx(0.42)
    # a stopped/failed turn still spent tokens: the cost rides on the error
    acc = StreamJsonAccumulator(cost_base=1.0)
    (ev,) = list(acc.feed({**_result(1.5), "subtype": "error_during_execution", "is_error": True}))
    assert ev.type == "error" and ev.data["cost_usd"] == pytest.approx(0.5) and ev.data["cost_kind"] == "turn"
    assert ev.data["usage"]["output_tokens"] == 2
    # a total below the base = the counter restarted
    acc = StreamJsonAccumulator(cost_base=5.0)
    (ev,) = list(acc.feed(_result(0.2)))
    assert ev.data["cost_usd"] == pytest.approx(0.2)


# ---- legacy normalization -------------------------------------------------------


def test_normalizer_real_sequence():
    norm = TurnCostNormalizer()
    out = [norm.feed(_legacy(v)) for v in REAL]
    per_turn = [d["cost_usd"] for d in out]
    expected = [REAL[0]] + [b - a for a, b in zip(REAL, REAL[1:])]
    assert per_turn == pytest.approx(expected, abs=1e-6)
    assert sum(per_turn) == pytest.approx(REAL[-1], abs=1e-5)  # ~$78, not the $308 the sum of totals gave
    assert sum(REAL) > 300
    assert all(d["cost_kind"] == "turn" and d["cost_normalized"] for d in out)
    assert out[3]["cost_reported_usd"] == REAL[3]
    # the engine respawned: its running total starts small again -> taken as is
    assert norm.feed(_legacy(0.31))["cost_usd"] == pytest.approx(0.31)
    assert norm.feed(_legacy(0.5))["cost_usd"] == pytest.approx(0.19)


def test_normalizer_leaves_other_kinds_alone():
    norm = TurnCostNormalizer()
    # before the persistent engine (no provider recorded): one process per turn
    old = {"model": "claude-opus-5-5", "cost_usd": 0.34}
    assert norm.feed(old)["cost_usd"] == 0.34 and norm.feed(old)["cost_kind"] == "turn"
    assert norm.feed({"model": "gpt-6", "provider": "codex", "cost_usd": 0.0})["cost_kind"] == "none"
    assert norm.feed({"text": "", "superseded": True, "provider": "claude"}) == {
        "text": "", "superseded": True, "provider": "claude"}
    marked = {"cost_usd": 0.7, "cost_kind": "turn", "provider": "claude"}
    assert norm.feed(_legacy(5.0))["cost_usd"] == 5.0
    assert norm.feed(marked) is marked  # already per turn
    # a marked event ends the legacy run: the next unmarked value isn't a delta of 5.0
    assert norm.feed(_legacy(6.0))["cost_usd"] == 6.0
    # a codex turn in between doesn't break the claude engine's running total
    norm.feed({"provider": "codex", "cost_usd": 0.0, "model": "gpt-6"})
    assert norm.feed(_legacy(6.5))["cost_usd"] == pytest.approx(0.5)


def test_history_and_usage_serve_per_turn_costs(db, tmp_path):
    svc = _svc(db)
    sid = svc.create(provider="claude", model="claude-opus-5-5", workspace_path=str(tmp_path))["id"]
    other = svc.create(provider="claude", model="claude-opus-5-5", workspace_path=str(tmp_path))["id"]
    for v in REAL[:3]:
        svc._add_event(sid, ProviderEvent(type="session.start", data={"provider": "claude"}))
        svc._add_event(sid, ProviderEvent(type="turn.complete", data=_legacy(v)))
    svc._add_event(other, ProviderEvent(type="turn.complete", data=_legacy(2.0)))  # its own engine
    # a new-format turn (true per turn, from a later process) and a stopped one
    svc._add_event(sid, ProviderEvent(type="turn.complete", data={
        **_legacy(0.25), "cost_kind": "turn", "process_cost_usd": 0.25}))
    svc._add_event(sid, ProviderEvent(type="error", data={
        "code": "turn.interrupted", "message": "Stopped by user", "provider": "claude",
        "cost_usd": 0.05, "cost_kind": "turn", "usage": {"output_tokens": 7}}))
    svc._add_event(sid, ProviderEvent(type="error", data={"code": "exec.cli.exited", "message": "x"}))

    evs = [e for e in svc.events(sid) if e["type"] == "turn.complete"]
    assert [e["data"]["cost_usd"] for e in evs] == pytest.approx(
        [REAL[0], REAL[1] - REAL[0], REAL[2] - REAL[1], 0.25], abs=1e-6)
    # a replay tail (WebSocket attach after a cursor) gets the same values
    cursor = evs[1]["eid"]
    tail = [e for e in svc.events(sid, after=cursor) if e["type"] == "turn.complete"]
    assert tail[0]["data"]["cost_usd"] == pytest.approx(REAL[2] - REAL[1], abs=1e-6)
    # stored data is untouched (normalized on read)
    raw = db.query_one("SELECT data FROM events WHERE id = ?", (evs[1]["eid"],))
    assert json.loads(raw["data"])["cost_usd"] == REAL[1]

    s = UsageService(db).summary(days=3)
    assert s["cost_basis"] == "api_equivalent"
    assert s["total"]["cost_usd"] == pytest.approx(REAL[2] + 0.25 + 0.05 + 2.0, abs=1e-3)
    assert s["total"]["turns"] == 6  # 3 legacy + 1 new + the stopped one + the other chat
    assert s["recent"][0]["cost_usd"] == pytest.approx(0.05)  # newest first


def test_normalize_events_with_prior_tail():
    prior = [_legacy(1.0), _legacy(3.0)]
    evs = normalize_events([{"type": "turn.complete", "data": _legacy(4.5)}], prior)
    assert evs[0]["data"]["cost_usd"] == pytest.approx(1.5)


# ---- plan windows ---------------------------------------------------------------------


def test_claude_windows_include_reset_times_and_model_limits():
    usage = {
        "five_hour": {"utilization": 52.0, "resets_at": "2026-10-31T09:20:01+00:00"},
        "seven_day": {"utilization": 7.0, "resets_at": "2026-11-05T22:00:01+00:00"},
        "seven_day_opus": {"utilization": 12.0, "resets_at": "2026-11-05T22:00:00+00:00"},
        "limits": [
            {"kind": "session", "percent": 52, "scope": None},
            {"kind": "weekly_scoped", "percent": 3, "resets_at": "2026-11-05T22:00:00+00:00",
             "scope": {"model": {"id": None, "display_name": "Fable"}}},
        ],
    }
    windows, models = _claude_windows(usage)
    assert [(w["kind"], w["percent"], w["resets_at"][:10]) for w in windows] == [
        ("five_hour", 52.0, "2026-10-31"), ("seven_day", 7.0, "2026-11-05")]
    assert [(w["label"], w["percent"], w["kind"]) for w in models] == [
        ("Fable", 3.0, "model_weekly"), ("Opus", 12.0, "model_weekly")]


def test_public_accounts_carry_both_windows(db, monkeypatch, tmp_path):
    from app.providers import accounts as acc_mod
    from app.providers import subscription as sub

    calls = []

    def fake_usage(provider, cdir):
        calls.append(cdir)
        return {"windows": [{"label": "Session (5hr)", "percent": 52.0, "resets_at": "r5", "kind": "five_hour"},
                            {"label": "Weekly (7 day)", "percent": 7.0, "resets_at": "r7", "kind": "seven_day"}],
                "model_windows": [{"label": "Fable", "percent": 0.0, "resets_at": "r7", "kind": "model_weekly"}]}

    monkeypatch.setattr(sub, "subscription_usage", fake_usage)
    pool = acc_mod.AccountPool(acc_mod.AccountStore(db, SecretVault(db)))
    monkeypatch.setattr(pool, "_host_usable", lambda provider: True)
    (primary,) = pool.public_accounts("claude")
    assert primary["label"] == acc_mod.PRIMARY_LABEL
    assert primary["utilization"] == 52.0  # the balancer's max, unchanged
    assert [w["kind"] for w in primary["windows"]] == ["five_hour", "seven_day"]
    assert primary["model_windows"][0]["label"] == "Fable" and primary["plan_fetched_at"]
    pool.public_accounts("claude")
    assert len(calls) == 1  # cached (~60s)

    # a failed refresh keeps the last windows and says why
    pool._plan_cache[primary["id"]] = (pool._plan_cache[primary["id"]][0], 0.0)
    monkeypatch.setattr(sub, "subscription_usage", lambda p, c: (_ for _ in ()).throw(RuntimeError("boom")))
    (again,) = pool.public_accounts("claude")
    assert again["plan_error"] == "boom" and again["windows"][0]["percent"] == 52.0 and again["utilization"] == 52.0


# ---- default model ----------------------------------------------------------------


def test_default_claude_model_is_opus_5_5(db, tmp_path):
    assert catalog.DEFAULT_CLAUDE_MODEL == "claude-opus-5-5"
    live = [{"id": "claude-fable-5"}, {"id": "claude-sonnet-5-5"}, {"id": "claude-opus-5-5"}]
    assert catalog._claude_default(live) == "claude-opus-5-5"
    assert catalog._claude_default([{"id": "claude-sonnet-6"}, {"id": "claude-opus-6"}]) == "claude-opus-6"
    assert catalog._STATIC["claude"]["default_model"] == "claude-opus-5-5"

    svc = _svc(db)
    s = svc.create(provider="claude", model="", workspace_path=str(tmp_path))
    assert s["model"] == "claude-opus-5-5"
    assert svc.create(provider="claude", model="claude-sonnet-5-5", workspace_path=str(tmp_path))["model"] == \
        "claude-sonnet-5-5"  # an explicit choice is kept
    assert svc.update(s["id"], model="")["model"] == "claude-opus-5-5"
    codex = svc.create(provider="codex", model="", workspace_path=str(tmp_path))
    assert codex["model"] == ""  # codex: "" = the account's own default
    assert svc.update(codex["id"], provider="claude", model="")["model"] == "claude-opus-5-5"
