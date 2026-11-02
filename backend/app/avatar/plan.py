"""The plan (every Higgsfield job a brief needs), its price, the time it takes, and the spending gate.

Pure functions over the project document (no I/O), so the rules are tested on their own:

* :func:`jobs_for` — the jobs a brief needs, stage by stage (model, params, count), exactly the jobs the runner
  submits later (``params`` are the ones quoted: the same model + settings cost the same).
* :func:`price` — per-job quotes (``POST /jobs/{jt}/cost``: free) → item credits, stage subtotals, total, the reserve
  for redos and the hard cap.
* the gate — nothing that spends credits runs without a confirmation the USER made (``confirm``: the plan id and its
  total must match the plan on file, its quotes must be fresh), and never past the cap (the confirmed total plus the
  reserve, plus extras the user confirmed). :func:`check_spend` is called before every single job.
"""

from __future__ import annotations

import json
import math
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from app.avatar import presets as P

#: the reserve for redos, on top of the confirmed total: the cap is total × (1 + RESERVE)
RESERVE = 0.15
#: a single redo up to this many credits runs at once (within the cap); more needs the user's OK
AUTO_REDO_MAX = 5.0
#: a confirmation must be made on quotes at most this old
QUOTE_TTL = timedelta(minutes=30)
#: model + settings per job kind (ailism mate.py / MATE.md §3.5, §11-12)
IMAGE_JOB = "nano_banana_pro"
IMAGE_PARAMS = {"aspect_ratio": "3:4", "resolution": "2k"}
CUTOUT_JOB = "image_background_remover"
CLIP_JOB = "kling_o3_flf"
MATTE_JOB = "video_background_remover"

STAGES = ("design", "home", "stills", "clips", "matte")
#: rough minutes per job when running (seen on the official mates: stills ~40 s, Kling pro ~4 min, the
#: video remover ~1.3 min, our own matte+encode ~1 min per 1440px clip) and how many run at once
MINUTES = {"design": (1.5, 4), "home": (1.0, 1), "stills": (0.8, 3), "clips": (4.0, 2), "matte": (1.4, 1)}
PROCESS_MIN_PER_CLIP = 1.0


class GateError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: datetime | None = None) -> str:
    return (t or _now()).isoformat()


def _parse(s: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(s))
    except (TypeError, ValueError):
        return None


def clip_params(brief: dict[str, Any]) -> dict[str, Any]:
    return {"aspect_ratio": brief["aspect"], "duration": P.CLIP_SECONDS, "mode": P.TIERS[brief["tier"]]["mode"],
            "sound": "off"}


def jobs_for(brief: dict[str, Any]) -> list[dict[str, Any]]:
    """The plan's lines: one per stage and job kind, with the count."""
    out: list[dict[str, Any]] = []
    ref = brief["reference"]["mode"]
    if ref != "as_base":
        out.append({"key": "design", "stage": "design", "job_type": IMAGE_JOB, "params": dict(IMAGE_PARAMS),
                    "count": brief["candidates"], "what": "candidates"})
    out.append({"key": "home", "stage": "home", "job_type": CUTOUT_JOB, "params": {}, "count": 1, "what": "cutout"})
    if brief["stills"]:
        out.append({"key": "stills", "stage": "stills", "job_type": IMAGE_JOB, "params": dict(IMAGE_PARAMS),
                    "count": len(brief["stills"]), "what": "stills"})
    n = len(brief["clips"])
    out.append({"key": "clips", "stage": "clips", "job_type": CLIP_JOB, "params": clip_params(brief), "count": n,
                "what": "clips"})
    out.append({"key": "matte", "stage": "matte", "job_type": MATTE_JOB, "params": {}, "count": n,
                "what": "mattes"})
    return out


def quote_key(job_type: str, params: dict[str, Any]) -> str:
    return json.dumps([job_type, params], sort_keys=True)


def quote_requests(jobs: list[dict[str, Any]]) -> list[tuple[str, str, dict[str, Any]]]:
    """The distinct (key, job_type, params) to quote — the same model + settings are quoted once."""
    seen: dict[str, tuple[str, str, dict[str, Any]]] = {}
    for j in jobs:
        k = quote_key(j["job_type"], j["params"])
        seen.setdefault(k, (k, j["job_type"], j["params"]))
    return list(seen.values())


def minutes(jobs: list[dict[str, Any]]) -> float:
    total = 0.0
    for j in jobs:
        per, par = MINUTES.get(j["stage"], (1.0, 1))
        total += math.ceil(j["count"] / par) * per
        if j["stage"] == "matte":
            total += j["count"] * PROCESS_MIN_PER_CLIP
    return round(total, 1)


def price(brief: dict[str, Any], quotes: dict[str, Any], *, balance: float | None = None,
          credit_usd: float | None = None) -> dict[str, Any]:
    """A plan from the brief and the quotes (``quotes[key]`` = credits per job, or ``{"error": text}``)."""
    jobs = jobs_for(brief)
    lines, errors = [], []
    total = 0.0
    for j in jobs:
        q = quotes.get(quote_key(j["job_type"], j["params"]))
        unit = q if isinstance(q, (int, float)) and not isinstance(q, bool) else None
        line = {**j, "unit": unit, "credits": round(unit * j["count"], 4) if unit is not None else None}
        if unit is None:
            err = q.get("error") if isinstance(q, dict) else "no quote"
            line["error"] = err
            errors.append(f"{j['job_type']}: {err}")
        else:
            total += line["credits"]
        lines.append(line)
    total = round(total, 4)
    reserve = round(total * RESERVE, 4)
    plan = {
        "id": "plan_" + secrets.token_hex(6),
        "created_at": _iso(),
        "quoted_at": _iso(),
        "lines": lines,
        "total": total,
        "reserve": reserve,
        "cap": round(total + reserve, 4),
        "minutes": minutes(jobs),
        "complete": not errors,
        "errors": errors,
        "balance": balance,
        "credit_usd": credit_usd,
        "usd": round(total * credit_usd, 2) if credit_usd else None,
        "balance_after": round(balance - total, 4) if isinstance(balance, (int, float)) and not errors else None,
        "counts": {"candidates": brief["candidates"] if brief["reference"]["mode"] != "as_base" else 0,
                   "stills": len(brief["stills"]), "clips": len(brief["clips"])},
        "settings": {"aspect": brief["aspect"], "tier": brief["tier"], "preset": brief["preset"],
                     "mode": P.TIERS[brief["tier"]]["mode"], "seconds": P.CLIP_SECONDS},
    }
    return plan


def unit_of(plan: dict[str, Any] | None, stage: str) -> float | None:
    for line in (plan or {}).get("lines") or []:
        if line["stage"] == stage:
            return line.get("unit")
    return None


# ---------------------------------------------------------------- the gate

def cap(doc: dict[str, Any]) -> float:
    """The most this project may spend: the confirmed cap plus the extras the user confirmed."""
    c = doc.get("confirmation") or {}
    extra = sum(float(x.get("total") or 0) for x in doc.get("extras") or [] if x.get("status") == "confirmed")
    return round(float(c.get("cap") or 0) + extra, 4)


def committed(doc: dict[str, Any]) -> float:
    return round(float((doc.get("ledger") or {}).get("committed") or 0), 4)


def confirm(doc: dict[str, Any], plan_id: Any, total: Any, *, now: datetime | None = None) -> dict[str, Any]:
    """The user's confirmation of the plan on file → the confirmation record (GateError when it doesn't match)."""
    plan = doc.get("plan")
    if not plan:
        raise GateError("no_plan", "there is no estimate to confirm")
    if doc.get("confirmation") and doc["confirmation"].get("plan_id") == plan["id"]:
        raise GateError("already_confirmed", "this plan is already confirmed")
    if doc.get("status") in ("canceled", "applied"):
        raise GateError("closed", "this project is closed")
    if str(plan_id or "") != plan["id"]:
        raise GateError("plan_changed", "the plan changed since this estimate was shown — look at the new one")
    try:
        t = float(total)
    except (TypeError, ValueError):
        raise GateError("total_mismatch", "the confirmed total is missing") from None
    if not plan.get("complete"):
        raise GateError("incomplete", "some prices could not be quoted; nothing can start until they are")
    if abs(t - float(plan["total"])) > 1e-6:
        raise GateError("total_mismatch", f"the confirmed total ({t:g}) is not the plan's ({plan['total']:g})")
    quoted = _parse(plan.get("quoted_at"))
    if quoted is None or (now or _now()) - quoted > QUOTE_TTL:
        raise GateError("stale_quote", "the prices are older than 30 minutes — estimate again first")
    return {"plan_id": plan["id"], "total": plan["total"], "cap": plan["cap"], "at": _iso(now)}


def check_spend(doc: dict[str, Any], credits: float, *, allow_paused: bool = False) -> None:
    """Before ANY job is submitted: a user-confirmed plan, the same plan, and room under the cap."""
    conf = doc.get("confirmation")
    plan = doc.get("plan") or {}
    if not conf:
        raise GateError("not_confirmed", "nothing that spends credits may run before the user confirms the plan")
    if conf.get("plan_id") != plan.get("id") or abs(float(conf.get("total") or 0) - float(plan.get("total") or 0)) > 1e-6:
        raise GateError("plan_changed", "the plan on file is not the one the user confirmed")
    if doc.get("status") == "canceled":
        raise GateError("canceled", "the project was canceled")
    if doc.get("paused") and not allow_paused:
        raise GateError("paused", "the project is paused")
    room = cap(doc) - committed(doc)
    if float(credits) > room + 1e-6:
        raise GateError("over_cap", f"this needs {credits:g} credits but only {max(room, 0):g} are left under the "
                                    f"confirmed cap of {cap(doc):g}")


def commit(doc: dict[str, Any], credits: float) -> None:
    led = doc.setdefault("ledger", {"committed": 0.0, "jobs": 0})
    led["committed"] = round(float(led.get("committed") or 0) + float(credits), 4)
    led["jobs"] = int(led.get("jobs") or 0) + 1


def redo_decision(doc: dict[str, Any], credits: float) -> str:
    """'auto' (runs now), or 'confirm' (the user must OK an extra first)."""
    if credits <= AUTO_REDO_MAX:
        try:
            check_spend(doc, credits, allow_paused=True)
            return "auto"
        except GateError:
            pass
    return "confirm"


def new_extra(reason: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    total = round(sum(float(i["credits"]) for i in items), 4)
    return {"id": "x_" + secrets.token_hex(5), "reason": reason, "items": items, "total": total,
            "status": "pending", "at": _iso()}


def confirm_extra(doc: dict[str, Any], xid: Any, total: Any) -> dict[str, Any]:
    if not doc.get("confirmation"):
        raise GateError("not_confirmed", "confirm the plan first")
    for x in doc.get("extras") or []:
        if x["id"] == xid:
            if x["status"] != "pending":
                raise GateError("closed", "that request is no longer open")
            try:
                t = float(total)
            except (TypeError, ValueError):
                raise GateError("total_mismatch", "the confirmed total is missing") from None
            if abs(t - float(x["total"])) > 1e-6:
                raise GateError("total_mismatch", "the confirmed total does not match the request")
            x["status"] = "confirmed"
            x["confirmed_at"] = _iso()
            return x
    raise GateError("not_found", "no such request")
