"""Account load balancing: stickiness, near-limit and primary-login policy,
live rate-limit state, cooldown until the reset, turn counting/release, and
the end-to-end failover of a persistent engine onto another account."""
import asyncio
import json
import stat
import sys
import textwrap
import threading
import time

import pytest

from app.providers import accounts as acc_mod
from app.providers import subscription as sub_mod
from app.providers.accounts import (
    AccountPool,
    AccountSnapshot,
    AccountStore,
    AccountUnavailable,
    BalancerState,
    HealthPolicy,
    LimitPolicy,
    apply_outcome,
    choose,
    classify_error,
    sticky_reason,
)
from app.providers.claude_code import ClaudeCodeProvider
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

PID = "__primary__claude"


def snap(id, **kw):
    return AccountSnapshot(id=id, label=id, **kw)


# ---- pure policy ---------------------------------------------------------------


def test_near_limit_accounts_are_a_last_resort():
    now = time.time()
    hot = snap("a", five=93.0, seven=10.0)
    ok = snap("b", five=40.0, seven=20.0)
    assert choose([hot, ok], strategy="round_robin", now=now, state=BalancerState()).id == "b"
    # every account near a limit: still serve, from the one furthest from it
    hot2 = snap("c", five=97.0, utilization=97.0)
    pick = choose([replace_util(hot, 93.0), hot2], strategy="round_robin", now=now, state=BalancerState())
    assert pick.id == "a"
    # 7-day threshold too
    assert choose([snap("w", seven=96.0), ok], strategy="least_busy", now=now, state=BalancerState()).id == "b"
    # thresholds are settings
    lax = LimitPolicy(five_hour=99.0, seven_day=99.0)
    st = BalancerState()
    picks = {choose([hot, ok], strategy="round_robin", now=now, state=st, limits=lax).id for _ in range(2)}
    assert picks == {"a", "b"}


def replace_util(a, util):
    from dataclasses import replace

    return replace(a, utilization=util)


def test_primary_modes():
    now = time.time()
    prim = snap(PID, is_primary=True)
    other = snap("x")
    st = BalancerState()
    # off: never chosen, even alone
    assert choose([prim], strategy="least_busy", now=now, state=st, primary_mode="off") is None
    # fallback: only when no other account has headroom
    assert choose([prim, other], strategy="least_busy", now=now, state=st, primary_mode="fallback").id == "x"
    near = snap("x", five=95.0)
    assert choose([prim, near], strategy="least_busy", now=now, state=st, primary_mode="fallback").id == PID
    cooling = snap("x", cooldown_until=now + 60)
    assert choose([prim, cooling], strategy="least_busy", now=now, state=st, primary_mode="fallback").id == PID
    # normal: an ordinary member
    picks = {choose([prim, other], strategy="round_robin", now=now, state=st).id for _ in range(2)}
    assert picks == {PID, "x"}


def test_sticky_reason():
    now = time.time()
    a, b = snap("a"), snap("b")
    assert sticky_reason(a, [a, b], now=now) is None  # usable: stay (cache)
    assert sticky_reason(snap("a", cooldown_until=now + 60), [a, b], now=now) == "cooling_down"
    assert sticky_reason(snap("a", status="expired"), [a, b], now=now) == "expired"
    assert sticky_reason(snap("a", enabled=False), [a, b], now=now) == "disabled"
    assert sticky_reason(a, [a, b], now=now, avoid={"a"}) == "failed"
    hot = snap("a", five=92.0)
    assert sticky_reason(hot, [hot, b], now=now) == "near_5h"  # a better account exists
    assert sticky_reason(hot, [hot, snap("b", five=95.0)], now=now) is None  # no better one: keep the cache
    assert sticky_reason(hot, [hot], now=now) is None
    prim = snap(PID, is_primary=True)
    assert sticky_reason(prim, [prim, b], now=now, primary_mode="fallback") == "fallback_only"
    assert sticky_reason(prim, [prim, snap("b", cooldown_until=now + 9)], now=now, primary_mode="fallback") is None
    assert sticky_reason(prim, [prim, b], now=now, primary_mode="off") == "excluded"


def test_cooldown_lasts_until_the_limit_resets():
    now = time.time()
    reset = now + 3 * 3600
    d = apply_outcome(snap("a"), ok=False, code="provider_quota", now=now, policy=HealthPolicy(), until=reset)
    assert d.status == "cooldown" and reset <= d.cooldown_until <= reset + 60
    # unknown reset: the policy default
    d = apply_outcome(snap("a"), ok=False, code="provider_quota", now=now, policy=HealthPolicy())
    assert abs(d.cooldown_until - (now + HealthPolicy().quota_cooldown_s)) < 1
    # a weekly reset days away is honoured (capped at 8 days)
    far = now + 5 * 86400
    d = apply_outcome(snap("a"), ok=False, code="provider_quota", now=now, policy=HealthPolicy(), until=far)
    assert d.cooldown_until >= far


def test_classify_limit_messages():
    for text in ("You've hit your limit · resets 2pm (Asia/Seoul)", "You've reached your weekly limit",
                 "You're out of usage credits. Switch to another model", "Claude AI usage limit reached|1793774715"):
        assert classify_error("exec.cli.api_error", text) == "provider_quota", text
    assert classify_error("exec.cli.api_error", "x", {"error": "rate_limit", "kind": "usage_limit_reached"}) == "provider_quota"
    assert classify_error("exec.cli.api_error", "slow down", {"error": "rate_limit"}) == "rate_limited"
    assert classify_error("exec.cli.api_error", "x", {"error": "authentication_failed"}) == "provider_auth"
    assert classify_error("account.unavailable", "No Claude account…") == "failed"
    assert classify_error("exec.cli.error_during_execution", "tool failed: generated output") == "failed"


# ---- pool (DB + in-memory state) ------------------------------------------------


@pytest.fixture
def pool(db, monkeypatch):
    store = AccountStore(db, SecretVault(db))
    p = AccountPool(store)
    monkeypatch.setattr(p, "_host_usable", lambda provider: True)
    monkeypatch.setattr(store, "usable", lambda account: True)
    monkeypatch.setattr(sub_mod, "subscription_usage", lambda provider, cdir: {
        "windows": [{"label": "5h", "percent": 10.0, "resets_at": None, "kind": "five_hour"},
                    {"label": "7d", "percent": 10.0, "resets_at": None, "kind": "seven_day"}],
        "model_windows": []})
    store.set_pool("claude", enabled=True, strategy="round_robin")
    return p


def test_select_is_sticky_and_explains_switches(pool):
    store = pool._store
    b = store.create("claude", label="work")
    first = pool.select("claude")
    pool.release(first)
    # round robin would alternate; a sticky chat goes back to its account
    for _ in range(3):
        again = pool.select("claude", prefer=first.account_id)
        assert again.account_id == first.account_id and again.reason == "sticky" and again.previous_id is None
        pool.release(again)
    # its account cools down: moved, and the lease says why
    other = b["id"] if first.account_id == PID else PID
    pool._apply("claude", first.account_id, ok=False, code="provider_quota", until=time.time() + 3600)
    moved = pool.select("claude", prefer=first.account_id)
    assert moved.account_id == other and moved.previous_id == first.account_id
    assert "hit its" in moved.previous_why or "cooling down" in moved.previous_why
    pool.release(moved)


def test_live_rate_limit_feeds_balancing(pool):
    store = pool._store
    work = store.create("claude", label="work")
    reset = time.time() + 2 * 3600
    # an engine on the primary login reports it's refused until `reset`
    pool.record_live("claude", PID, {"status": "rejected", "rateLimitType": "five_hour", "resetsAt": reset,
                                     "unifiedWindows": {"five_hour": {"utilization": 1.0, "resetsAt": reset},
                                                        "seven_day": {"utilization": 0.4, "resetsAt": reset + 9e4}}})
    assert pool.limit_info(PID)["type"] == "five_hour"
    lease = pool.select("claude", prefer=PID)
    assert lease.account_id == work["id"]
    assert "5-hour limit" in lease.previous_why
    pool.release(lease)
    # live utilization (fresher than the 60s plan cache) moves picks too
    pool.record_live("claude", work["id"], {"status": "allowed_warning", "unifiedWindows": {
        "five_hour": {"utilization": 0.93, "resetsAt": reset}, "seven_day": {"utilization": 0.2, "resetsAt": reset}}})
    # allowed again (e.g. the limit reset early): the primary's cooldown is lifted
    pool.record_live("claude", PID, {"status": "allowed", "unifiedWindows": {
        "five_hour": {"utilization": 0.05, "resetsAt": reset}, "seven_day": {"utilization": 0.4, "resetsAt": reset}}})
    assert pool.limit_info(PID) is None
    lease = pool.select("claude", prefer=work["id"])
    assert lease.account_id == PID and "93% of its 5-hour limit" in lease.previous_why
    pool.release(lease)


def test_turn_counting_is_idempotent_and_released(pool):
    lease = pool.select("claude", begin_turn=True)
    aid = lease.account_id
    assert pool.counters(aid) == (1, 1)
    pool.begin_turn(lease)  # double begin: still one turn
    assert pool.counters(aid) == (1, 1)
    pool.end_turn(lease)
    pool.end_turn(lease)  # double end: never negative
    assert pool.counters(aid) == (0, 1)
    pool.begin_turn(lease)
    pool.release(lease)  # release ends a running turn too (crash / cancel path)
    pool.release(lease)
    assert pool.counters(aid) == (0, 0)
    pool.begin_turn(lease)  # a released lease can't count again
    assert pool.counters(aid) == (0, 0)


def test_concurrent_picks_respect_max_concurrency(pool, db):
    pool._store.set_pool("claude", primary_mode="off")
    acc = pool._store.create("claude", label="solo", max_concurrency=3)
    leases, errors = [], []
    lock = threading.Lock()

    def take():
        try:
            lease = pool.select("claude", begin_turn=True)
            with lock:
                leases.append(lease)
        except AccountUnavailable as exc:
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=take) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(leases) == 3 and len(errors) == 5
    assert pool.counters(acc["id"])[0] == 3
    assert "busy" in str(errors[0])
    for lease in leases:
        pool.release(lease)
    assert pool.counters(acc["id"]) == (0, 0)


def test_nothing_usable_says_when(pool):
    pool._store.set_pool("claude", primary_mode="off")
    acc = pool._store.create("claude", label="work")
    reset = time.time() + 5400
    pool._apply("claude", acc["id"], ok=False, code="provider_quota", until=reset)
    with pytest.raises(AccountUnavailable) as err:
        pool.select("claude")
    msg = str(err.value)
    assert "excluded from load balancing" in msg and "work" in msg and "available again at" in msg
    assert err.value.earliest and err.value.earliest >= reset
    assert pool.acquire("claude") is None  # the old one-shot API: None


def test_pool_settings_roundtrip(pool):
    s = pool._store.set_pool("claude", primary_mode="fallback", near_5h=85, near_7d=150, auto_compact_window=400000)
    assert s["primary_mode"] == "fallback" and s["near_5h"] == 85.0 and s["near_7d"] == 100.0
    assert s["auto_compact_window"] == 400000 and s["enabled"] and s["strategy"] == "round_robin"
    with pytest.raises(ValueError):
        pool._store.set_pool("claude", primary_mode="sometimes")


# ---- stream parser --------------------------------------------------------------


def test_context_size_per_main_call():
    from app.providers._stream_json import StreamJsonAccumulator

    acc = StreamJsonAccumulator()
    usage = {"input_tokens": 2, "cache_read_input_tokens": 400_000, "cache_creation_input_tokens": 12_000, "output_tokens": 9}
    msg = {"type": "assistant", "message": {"id": "m1", "model": "claude-opus-5-5", "usage": usage,
                                            "content": [{"type": "text", "text": "a"}]}}
    evs = list(acc.feed(msg))
    ctx = [e for e in evs if e.type == "context.update"]
    assert ctx and ctx[0].data["tokens"] == 412_002 and ctx[0].data["source"] == "call"
    # the same call's next content block: not reported twice
    assert not [e for e in acc.feed(msg) if e.type == "context.update"]
    # a subagent's calls don't change the main context
    sub = {**msg, "parent_tool_use_id": "agent1", "message": {**msg["message"], "id": "m2"}}
    assert not [e for e in acc.feed(sub) if e.type == "context.update"]
    # a typed usage-limit error travels on the terminal error
    err = {"type": "assistant", "error": "rate_limit", "api_error": "usage_limit_reached", "is_api_error_message": True,
           "api_error_params": {"rate_limit_info": {"status": "rejected", "rateLimitType": "five_hour", "resetsAt": 1793774715}},
           "message": {"id": "m3", "content": [{"type": "text", "text": "You've hit your limit"}],
                       "usage": {"input_tokens": 0, "output_tokens": 0}}}
    list(acc.feed(err))
    (end,) = list(acc.feed({"type": "result", "subtype": "success", "is_error": True, "result": "You've hit your limit"}))
    assert end.type == "error" and end.data["api_error"]["kind"] == "usage_limit_reached"
    assert end.data["api_error"]["rate_limit_info"]["resetsAt"] == 1793774715


def test_compaction_notice():
    from app.providers._stream_json import StreamJsonAccumulator

    acc = StreamJsonAccumulator()
    (ev,) = list(acc.feed({"type": "system", "subtype": "compact_boundary", "compact_metadata": {
        "trigger": "auto", "pre_tokens": 871_000, "post_tokens": 52_400, "duration_ms": 4175}}))
    assert ev.data["code"] == "context.compacted" and ev.data["trigger"] == "auto"
    assert ev.data["pre_tokens"] == 871_000 and ev.data["post_tokens"] == 52_400
    assert "871k → 52k" in ev.data["message"] and "auto" in ev.data["message"]


def test_context_limits_follow_model_and_setting():
    from app.providers.catalog import clean_auto_compact_window, context_limits, context_window

    assert context_window("claude-opus-5-5") == 1_000_000
    assert context_window("claude-sonnet-4-5") == 200_000
    assert context_window("claude-sonnet-4-5[1m]") == 1_000_000
    assert context_limits("claude-opus-5-5") == {"window": 1_000_000, "model_window": 1_000_000, "threshold": 967_000}
    assert context_limits("claude-opus-5-5", 300_000)["threshold"] == 267_000  # measured on the CLI
    assert context_limits("claude-sonnet-4-5", 400_000)["window"] == 200_000  # capped by the model
    assert clean_auto_compact_window(0) == 0
    with pytest.raises(ValueError):
        clean_auto_compact_window(5000)


# ---- end to end: persistent engine on a pool ------------------------------------

FAKE = r'''
import json, os, queue, sys, threading, time
q = queue.Queue()
def reader():
    for line in sys.stdin:
        line = line.strip()
        if line:
            q.put(json.loads(line))
    q.put(None)
threading.Thread(target=reader, daemon=True).start()
def emit(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
args = sys.argv[1:]
model = args[args.index("--model") + 1]
FAKE_DIR = "__FAKE_DIR__"
cfg = os.environ.get("CLAUDE_CONFIG_DIR", "")
account = os.path.basename(os.path.dirname(cfg)) if cfg else "primary"
log = open(FAKE_DIR + "/calls.log", "a")
log.write(json.dumps({"pid": os.getpid(), "argv": args, "account": account,
                      "compact": os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW")}) + "\n"); log.flush()
SID = "fake-sess"
window = int(os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") or 1000000)
limited = os.path.exists(FAKE_DIR + "/limit-" + account)
spent = [0.0]
ctx = [20000]
while True:
    msg = q.get()
    if msg is None:
        break
    if msg["type"] == "control_request":
        req = msg["request"]
        resp = {}
        if req["subtype"] == "get_context_usage":
            resp = {"totalTokens": ctx[0], "maxTokens": window, "rawMaxTokens": 1000000,
                    "autoCompactThreshold": window - 33000, "isAutoCompactEnabled": True,
                    "autocompactSource": "env" if os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") else "model-default",
                    "model": model}
        emit({"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"], "response": resp}})
        continue
    content = msg["message"]["content"]
    text = content if isinstance(content, str) else content[-1]["text"]
    emit({"type": "system", "subtype": "init", "session_id": SID, "model": model})
    if limited:
        reset = int(open(FAKE_DIR + "/limit-" + account).read())
        info = {"status": "rejected", "rateLimitType": "five_hour", "resetsAt": reset}
        emit({"type": "rate_limit_event", "rate_limit_info": {**info, "unifiedWindows": {
            "five_hour": {"utilization": 1.0, "resetsAt": reset}, "seven_day": {"utilization": 0.3, "resetsAt": reset + 99999}}}})
        emit({"type": "assistant", "error": "rate_limit", "api_error": "usage_limit_reached", "is_api_error_message": True,
              "api_error_params": {"rate_limit_info": info},
              "message": {"id": "err", "model": "<synthetic>", "content": [{"type": "text", "text": "You've hit your limit · resets 2pm"}],
                          "usage": {"input_tokens": 0, "output_tokens": 0}}})
        emit({"type": "result", "subtype": "success", "is_error": True, "result": "You've hit your limit · resets 2pm",
              "session_id": SID, "total_cost_usd": spent[0], "usage": {}})
        continue
    ctx[0] += 1000
    emit({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "unifiedWindows": {
        "five_hour": {"utilization": 0.2, "resetsAt": 1993774715}, "seven_day": {"utilization": 0.1, "resetsAt": 1994774715}}}})
    emit({"type": "assistant", "message": {"id": "m%d" % ctx[0], "model": model,
          "usage": {"input_tokens": 3, "cache_read_input_tokens": ctx[0] - 503, "cache_creation_input_tokens": 500},
          "content": [{"type": "text", "text": "[%s] %s" % (account, text.strip().splitlines()[-1])}]}})
    spent[0] += 0.1
    emit({"type": "result", "subtype": "success", "is_error": False, "result": "[%s] %s" % (account, text.strip().splitlines()[-1]),
          "session_id": SID, "total_cost_usd": spent[0], "usage": {"input_tokens": 3, "output_tokens": 2}})
    if "RACE" in text:
        # a background task finished right as the turn ended: Claude reacts at once
        emit({"type": "system", "subtype": "init", "session_id": SID, "model": model})
        emit({"type": "assistant", "message": {"id": "auto", "model": model, "content": [{"type": "text", "text": "auto done"}]}})
        emit({"type": "result", "subtype": "success", "is_error": False, "result": "auto done", "session_id": SID,
              "total_cost_usd": spent[0], "usage": {}})
'''


def _calls(tmp_path):
    return [json.loads(line) for line in open(tmp_path / "calls.log")]


async def _until(q, pred, timeout=15):
    seen = []
    while True:
        m = await asyncio.wait_for(q.get(), timeout)
        seen.append(m)
        if pred(m):
            return seen


async def _turn(svc, q, sid, text):
    svc.start_turn(sid, text)
    return await _until(q, lambda m: m["type"] == "run.state" and not m["data"]["running"])


def _service(db, tmp_path, monkeypatch, *, pool_on=True, accounts=("work",)):
    fake = tmp_path / "claude"
    fake.write_text(f"#!{sys.executable}\n" + textwrap.dedent(FAKE).replace("__FAKE_DIR__", str(tmp_path)))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: ClaudeCodeProvider(binary=str(fake)))
    monkeypatch.setattr(ss_mod, "link_shared_state", lambda provider, account_id: None)
    monkeypatch.setattr(acc_mod.settings.__class__, "home_dir", property(lambda self: tmp_path / "home"))
    vault = SecretVault(db)
    store = AccountStore(db, vault)
    pool = AccountPool(store)
    monkeypatch.setattr(pool, "_host_usable", lambda provider: True)
    monkeypatch.setattr(store, "usable", lambda account: True)
    monkeypatch.setattr(sub_mod, "subscription_usage", lambda provider, cdir: (_ for _ in ()).throw(RuntimeError("offline")))
    made = [store.create("claude", label=name) for name in accounts]
    store.set_pool("claude", enabled=pool_on, strategy="round_robin")
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)), pool=pool)
    return svc, pool, made


async def test_failover_continues_the_turn_on_another_account(db, tmp_path, monkeypatch):
    svc, pool, (work,) = _service(db, tmp_path, monkeypatch)
    sid = svc.create(provider="claude", model="claude-opus-5-5", workspace_path=str(tmp_path))["id"]
    q = svc.subscribe(sid)
    try:
        # pin the chat to the primary login, which then hits its 5-hour limit
        svc.update(sid, account_id=PID)
        reset = int(time.time()) + 7200
        (tmp_path / "limit-primary").write_text(str(reset))
        seen = await _turn(svc, q, sid, "hello")
        done = [m for m in seen if m["type"] == "turn.complete"]
        assert done and done[0]["data"]["text"] == f"[{work['id']}] hello"  # same turn, other account
        assert not [m for m in seen if m["type"] == "error"]
        fo = [m for m in seen if m["type"] == "notice" and m["data"]["code"] == "account.failover"]
        assert fo and "5-hour limit" in fo[0]["data"]["message"] and "continued on work" in fo[0]["data"]["message"]
        assert len([m for m in seen if m["type"] == "session.start"]) == 1
        # the limited account cools down until its reset; the new engine resumed the CLI session
        primary = next(a for a in pool.public_accounts("claude") if a["primary"])
        assert primary["status"] == "cooldown" and primary["ineligible_reason"] == "cooling_down"
        calls = _calls(tmp_path)
        assert [c["account"] for c in calls] == ["primary", work["id"]]
        assert calls[1]["argv"][calls[1]["argv"].index("--resume") + 1] == "fake-sess"
        # counters: no active turn left, one live engine on `work`, none on the primary
        assert pool.counters(PID) == (0, 0) and pool.counters(work["id"]) == (0, 1)
        # sticky from now on: the next turn stays on `work`, same process
        seen = await _turn(svc, q, sid, "again")
        assert next(m for m in seen if m["type"] == "turn.complete")["data"]["text"] == f"[{work['id']}] again"
        assert len(_calls(tmp_path)) == 2
        assert svc.get(sid)["accounts"]["claude"]["id"] == work["id"]
        # persisted: a reload shows the failover notice and the context size
        evs = svc.events(sid)
        assert any(e["type"] == "notice" and e["data"]["code"] == "account.failover" for e in evs)
        ctx = [e for e in evs if e["type"] == "context.update"]
        assert ctx and ctx[-1]["data"]["source"] == "cli" and ctx[-1]["data"]["window"] == 1_000_000
        assert ctx[-1]["data"]["threshold"] == 967_000
    finally:
        await svc.shutdown()
    assert pool.counters(work["id"]) == (0, 0)  # shutdown released the engine's lease


async def test_no_usable_account_fails_clearly(db, tmp_path, monkeypatch):
    svc, pool, (work,) = _service(db, tmp_path, monkeypatch)
    pool._store.set_pool("claude", primary_mode="off")
    reset = int(time.time()) + 3600
    (tmp_path / f"limit-{work['id']}").write_text(str(reset))
    sid = svc.create(provider="claude", model="claude-opus-5-5", workspace_path=str(tmp_path))["id"]
    q = svc.subscribe(sid)
    try:
        seen = await _turn(svc, q, sid, "hello")
        err = [m for m in seen if m["type"] == "error"]
        assert len(err) == 1 and err[0]["data"]["code"] == "account.unavailable"
        msg = err[0]["data"]["message"]
        assert msg.startswith("Account work hit its 5-hour limit") and "available again at" in msg
        assert len(_calls(tmp_path)) == 1  # never loops
        assert pool.counters(work["id"]) == (0, 0)
        # the next turn fails fast, without spawning anything
        seen = await _turn(svc, q, sid, "again")
        assert next(m for m in seen if m["type"] == "error")["data"]["code"] == "account.unavailable"
        assert len(_calls(tmp_path)) == 1
    finally:
        await svc.shutdown()


async def test_sticky_respawn_and_auto_compact_window(db, tmp_path, monkeypatch):
    svc, pool, (work, home) = _service(db, tmp_path, monkeypatch, accounts=("work", "home"))
    sid = svc.create(provider="claude", model="claude-opus-5-5", workspace_path=str(tmp_path))["id"]
    q = svc.subscribe(sid)
    try:
        await _turn(svc, q, sid, "one")
        first = _calls(tmp_path)[0]["account"]
        first_id = PID if first == "primary" else first
        assert _calls(tmp_path)[0]["compact"] is None  # CLI default
        # idle reaper closes the engine: the respawn goes back to the same account (round robin would not)
        await svc._engines.shutdown(sid, reason="idle")
        seen = await _turn(svc, q, sid, "two")
        assert _calls(tmp_path)[1]["account"] == first
        assert not any(m["type"] == "notice" and m["data"]["code"].startswith("account.") for m in seen)
        # a per-chat auto-compact window: passed on spawn (the engine restarts at the turn boundary)
        svc.update(sid, auto_compact_window=300_000)
        seen = await _turn(svc, q, sid, "three")
        last = _calls(tmp_path)[-1]
        assert last["compact"] == "300000" and last["account"] == first and len(_calls(tmp_path)) == 3
        ctx = [m for m in seen if m["type"] == "context.update"]
        calls_ctx = [m for m in ctx if m["data"]["source"] == "call"]
        assert calls_ctx and calls_ctx[0]["data"]["tokens"] > 20000
        cli = [m for m in ctx if m["data"]["source"] == "cli"][-1]["data"]
        assert cli["window"] == 300_000 and cli["threshold"] == 267_000 and cli["window_source"] == "env"
        # global default + "back to default" (-1)
        pool._store.set_pool("claude", auto_compact_window=600_000)
        svc.update(sid, auto_compact_window=-1)
        assert svc.auto_compact_window(svc.get(sid)) == 600_000
        # a manual switch moves the live engine at the next turn, and says so
        other = home["id"] if first_id == work["id"] else work["id"]
        svc.update(sid, account_id=other)
        seen = await _turn(svc, q, sid, "four")
        assert _calls(tmp_path)[-1]["account"] == other
        note = next(m for m in seen if m["type"] == "notice" and m["data"]["code"] == "account.switched")
        assert "chosen by hand" in note["data"]["message"]
        assert pool.counters(first_id) == (0, 0) and pool.counters(other) == (0, 1)
    finally:
        await svc.shutdown()


async def test_auto_turn_right_after_a_turn_is_not_dropped(db, tmp_path, monkeypatch):
    svc, pool, _ = _service(db, tmp_path, monkeypatch, pool_on=False)
    sid = svc.create(provider="claude", model="claude-opus-5-5", workspace_path=str(tmp_path))["id"]
    q = svc.subscribe(sid)
    try:
        await _turn(svc, q, sid, "RACE please")
        # Claude's own turn (reacting to a background task) still reaches the chat
        auto = await _until(q, lambda m: m["type"] == "turn.complete" and m["data"]["text"] == "auto done")
        assert any(m["type"] == "session.start" and m["data"].get("trigger") == "background" for m in auto)
        await _until(q, lambda m: m["type"] == "run.state" and not m["data"]["running"])
        assert svc.messages(sid)[-1]["content"] == "auto done"
    finally:
        await svc.shutdown()


def test_plan_usage_backs_off_after_429(monkeypatch):
    from app.providers import accounts as acc_mod
    from app.providers import subscription as sub

    calls = []

    def throttled(provider, cdir):
        calls.append(cdir)
        raise sub.UsageError("usage request failed (429)")

    monkeypatch.setattr(sub, "subscription_usage", throttled)
    pool = acc_mod.AccountPool.__new__(acc_mod.AccountPool)
    pool._plan_cache = {}
    clock = [1000.0]
    monkeypatch.setattr(acc_mod.time, "time", lambda: clock[0])
    acct = {"id": "a1", "auth_mode": "oauth"}
    first = pool.plan_usage("claude", "a1", account=acct)
    assert "429" in first["error"] and len(calls) == 1
    clock[0] += acc_mod.PLAN_TTL_S + 1  # a normal TTL later: still backing off
    pool.plan_usage("claude", "a1", account=acct)
    assert len(calls) == 1
    clock[0] += acc_mod.PLAN_BACKOFF_S  # past the backoff: asks again
    pool.plan_usage("claude", "a1", account=acct)
    assert len(calls) == 2


def test_seven_day_priority_spreads_the_weekly_budget():
    # primary: 5h 43% / 7d 56%; hrjang: 5h 60% / 7d 8% (the screenshot case, 5h flipped)
    a = snap("primary", five=43.0, seven=56.0, utilization=56.0)
    b = snap("hrjang", five=60.0, seven=8.0, utilization=60.0)
    st = BalancerState()
    # balanced: the fuller window decides -> primary (56) beats hrjang (60)
    assert choose([a, b], strategy="most_remaining", now=0, state=st, limits=LimitPolicy()).id == "primary"
    # 7-day first: the account with the most weekly headroom wins
    assert choose([a, b], strategy="most_remaining", now=0, state=st,
                  limits=LimitPolicy(priority="seven_day")).id == "hrjang"
    # 5-hour first
    assert choose([a, b], strategy="most_remaining", now=0, state=st,
                  limits=LimitPolicy(priority="five_hour")).id == "primary"


def test_seven_day_priority_prefers_near_5h_over_near_7d():
    # both near a limit: a full 5-hour window resets in hours, a full week doesn't
    full_5h = snap("a", five=95.0, seven=20.0, utilization=95.0)
    full_7d = snap("b", five=10.0, seven=97.0, utilization=97.0)
    st = BalancerState()
    seven_first = LimitPolicy(priority="seven_day")
    assert choose([full_5h, full_7d], strategy="least_busy", now=0, state=st, limits=seven_first).id == "a"
    five_first = LimitPolicy(priority="five_hour")
    assert choose([full_5h, full_7d], strategy="least_busy", now=0, state=st, limits=five_first).id == "b"
    from app.providers.accounts import near_limit_reason
    both = snap("c", five=95.0, seven=97.0, utilization=97.0)
    assert near_limit_reason(both, seven_first) == "near_7d"
    assert near_limit_reason(both, LimitPolicy()) == "near_5h"


def test_limit_priority_setting_round_trips(db):
    store = AccountStore(db, SecretVault(db))
    assert store.pool("claude")["limit_priority"] == "balanced"
    assert store.set_pool("claude", limit_priority="seven_day")["limit_priority"] == "seven_day"
    with pytest.raises(ValueError):
        store.set_pool("claude", limit_priority="monthly")
