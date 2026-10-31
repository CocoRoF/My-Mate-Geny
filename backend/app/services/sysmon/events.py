"""Threshold alerts with hysteresis — what lands in the admin log.

Every watched quantity is a :class:`Gauge`: a small state machine over
``ok -> warn -> crit``. A level is *entered* only after ``sustain``
consecutive samples at or above its threshold, and *left* only after
``clear_sustain`` samples below ``threshold - margin``, so a value hovering
around a line logs once, not every tick. A gauge that recovered and trips
again within ``cooldown`` seconds changes state silently (no second log).

Transitions are returned as :class:`Transition`; the monitor writes them to
the :class:`~app.services.log_service.LogService` (source ``monitor``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

LEVELS = ("ok", "warn", "crit")
_RANK = {lv: i for i, lv in enumerate(LEVELS)}


@dataclass
class Transition:
    key: str
    kind: str          # raise | escalate | ease | clear | event
    level: str         # the new level (warn | crit | ok) or the event's log level
    value: float
    peak: float
    since: float
    logged: bool       # False when suppressed by the cooldown


@dataclass
class Gauge:
    key: str
    warn: float
    crit: float | None = None
    margin: float = 5.0
    sustain: int = 3
    clear_sustain: int = 10
    cooldown: float = 600.0

    level: str = "ok"
    since: float = 0.0
    peak: float = 0.0
    value: float = 0.0
    logged: bool = False
    _up: int = 0
    _down: int = 0
    _last_clear: float = -1e18
    _last_escalate: float = -1e18

    def target(self, v: float) -> str:
        if self.crit is not None and v >= self.crit:
            return "crit"
        if v >= self.warn:
            return "warn"
        return "ok"

    def update(self, v: float, now: float) -> Transition | None:
        self.value = v
        if self.level != "ok":
            self.peak = max(self.peak, v)
        want = self.target(v)
        cur = self.level
        if _RANK[want] > _RANK[cur]:
            self._down = 0
            self._up += 1
            if self._up < self.sustain:
                return None
            self._up = 0
            if cur == "ok":
                self.level, self.since, self.peak = want, now, v
                self.logged = now - self._last_clear >= self.cooldown
                return Transition(self.key, "raise", want, v, v, now, self.logged)
            self.level = want
            # Bouncing crit -> warn -> crit within one episode logs the first escalation only
            # (until the cooldown passes).
            log = self.logged and now - self._last_escalate >= self.cooldown
            if log:
                self._last_escalate = now
            return Transition(self.key, "escalate", want, v, self.peak, self.since, log)
        self._up = 0
        if cur == "ok":
            return None
        # Below the current level by more than the margin?
        line = (self.crit if cur == "crit" else self.warn) or 0.0
        if v >= line - self.margin:
            self._down = 0
            return None
        self._down += 1
        if self._down < self.clear_sustain:
            return None
        self._down = 0
        lower = "warn" if cur == "crit" and v >= self.warn - self.margin else "ok"
        if lower == "warn":
            self.level = "warn"
            return Transition(self.key, "ease", "warn", v, self.peak, self.since, False)
        self.level = "ok"
        self._last_clear = now
        t = Transition(self.key, "clear", "ok", v, self.peak, self.since, self.logged)
        self.logged = False
        return t

    def snapshot(self) -> dict[str, Any]:
        return {"key": self.key, "level": self.level, "since": self.since, "value": self.value,
                "peak": self.peak, "warn": self.warn, "crit": self.crit}


@dataclass
class Window:
    """Last-N-seconds values (for 'swap grew by X in 5 min', 'CPU for 1 min')."""

    span: float
    items: list[tuple[float, float]] = field(default_factory=list)

    def add(self, now: float, v: float) -> None:
        self.items.append((now, v))
        cut = now - self.span
        while self.items and self.items[0][0] < cut:
            self.items.pop(0)

    def growth(self) -> float:
        """Current value minus the window's minimum (0 when shrinking)."""
        if not self.items:
            return 0.0
        return max(0.0, self.items[-1][1] - min(v for _, v in self.items))


class Gauges:
    """A keyed set of gauges; keys come and go (engines, disks, GPUs)."""

    def __init__(self) -> None:
        self.g: dict[str, Gauge] = {}

    def get(self, key: str, **params: Any) -> Gauge:
        g = self.g.get(key)
        if g is None:
            g = self.g[key] = Gauge(key=key, **params)
        else:
            # Thresholds may be re-configured; keep the state.
            for k, v in params.items():
                setattr(g, k, v)
        return g

    def drop_missing(self, prefix: str, alive: set[str]) -> None:
        for k in [k for k in self.g if k.startswith(prefix) and k not in alive]:
            del self.g[k]

    def active(self) -> list[dict[str, Any]]:
        return [g.snapshot() for g in self.g.values() if g.level != "ok"]
