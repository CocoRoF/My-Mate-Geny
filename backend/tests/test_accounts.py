import time

from app.providers.accounts import (
    AccountSnapshot,
    BalancerState,
    HealthPolicy,
    apply_outcome,
    choose,
    classify_error,
    ineligible_reason,
    over_capacity,
)


def snap(id, **kw):
    return AccountSnapshot(id=id, **kw)


def test_least_busy_picks_lowest_load():
    now = time.time()
    a = snap("a", in_flight=3, max_concurrency=4)  # load .75
    b = snap("b", in_flight=1, max_concurrency=4)  # load .25
    pick = choose([a, b], strategy="least_busy", now=now, state=BalancerState())
    assert pick.id == "b"


def test_round_robin_cycles():
    now = time.time()
    st = BalancerState()
    accs = [snap("a"), snap("b"), snap("c")]
    picks = [choose(accs, strategy="round_robin", now=now, state=st).id for _ in range(4)]
    assert picks == ["a", "b", "c", "a"]


def test_weighted_favors_higher_weight():
    now = time.time()
    st = BalancerState()
    accs = [snap("a", weight=3), snap("b", weight=1)]
    picks = [choose(accs, strategy="weighted", now=now, state=st).id for _ in range(4)]
    assert picks.count("a") == 3 and picks.count("b") == 1


def test_eligibility_filters():
    now = time.time()
    assert ineligible_reason(snap("a", enabled=False), now=now) == "disabled"
    assert ineligible_reason(snap("a", usable=False), now=now) == "no_credentials"
    assert ineligible_reason(snap("a", status="expired"), now=now) == "expired"
    assert ineligible_reason(snap("a", cooldown_until=now + 100), now=now) == "cooling_down"
    assert ineligible_reason(snap("a", in_flight=4, max_concurrency=4), now=now) == "at_capacity"
    assert ineligible_reason(snap("a"), now=now) is None


def test_choose_skips_ineligible_and_over_capacity_fallback():
    now = time.time()
    full = snap("a", in_flight=4, max_concurrency=4)
    cooling = snap("b", status="cooldown", cooldown_until=now + 100)
    assert choose([full, cooling], strategy="least_busy", now=now, state=BalancerState()) is None
    assert over_capacity([full, cooling], now=now).id == "a"


def test_rate_limit_triggers_cooldown():
    now = time.time()
    p = HealthPolicy()
    d = apply_outcome(snap("a"), ok=False, code="rate_limited", now=now, policy=p)
    assert d.status == "cooldown"
    assert d.cooldown_until > now


def test_auth_failure_expires():
    now = time.time()
    d = apply_outcome(snap("a"), ok=False, code="provider_auth", now=now, policy=HealthPolicy())
    assert d.status == "expired"


def test_success_clears_health():
    d = apply_outcome(snap("a", consecutive_failures=2, status="cooldown"), ok=True, code=None,
                      now=time.time(), policy=HealthPolicy())
    assert d.status == "ready" and d.consecutive_failures == 0


def test_classify_error():
    assert classify_error("exec.cli.exited", "rate limit exceeded") == "rate_limited"
    assert classify_error("exec.cli.exited", "401 unauthorized") == "provider_auth"
    assert classify_error("exec.cli.timeout", "timed out") == "timeout"


def test_most_remaining_puts_unknown_usage_last():
    from app.providers.accounts import AccountSnapshot, _most_remaining

    base = dict(enabled=True, weight=1, max_concurrency=8, in_flight=0,
                status="ready", cooldown_until=0.0, usable=True, last_used=0.0)
    sub40 = AccountSnapshot(id="sub", utilization=40.0, **base)
    apikey = AccountSnapshot(id="key", utilization=None, **base)
    sub90 = AccountSnapshot(id="sub90", utilization=90.0, **base)
    assert _most_remaining([apikey, sub40, sub90]).id == "sub"
    assert _most_remaining([apikey]).id == "key"  # still usable when it's the only one
