"""Higgsfield for the avatar pipeline: quotes (free) and jobs, run by the SERVER — never by the agent.

* Quotes: the account API's ``POST /jobs/{job_type}/cost`` (HiggsfieldService.quote, spends nothing). If Higgsfield
  wants input media in the params to price a job, the CLI's own ``generate cost`` is asked instead with placeholder
  files (uploads are free).
* Jobs: the official ``higgsfield`` CLI (the tool the official mates were made with), signed in with an
  ACCESS-ONLY credentials file the server writes for each call under the project (``.hf/``, 0600; no refresh token,
  so the CLI can never rotate the login — docs/higgsfield.md). ``generate create`` without ``--wait`` gives the job
  id at once (kept in the project, so a restart waits for the same job instead of paying twice), then
  ``generate wait <id>``; the result is downloaded into the project.
* Only the spending gate (app/avatar/plan.py) decides whether :meth:`Generator.create` may be called; this module
  never calls a purchase endpoint.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import time
import urllib.request
from pathlib import Path
from typing import Any

from app.higgsfield.agent import FILE_KEEP, _atomic_write, find_cli
from app.higgsfield.oauth import HiggsfieldError, cli_credentials, redact
from app.higgsfield.service import HiggsfieldService

TERMINAL_OK = {"completed", "succeeded", "success", "done", "finished"}
TERMINAL_BAD = {"failed", "error", "nsfw", "ip_detected", "canceled", "cancelled", "rejected"}
#: refused by Higgsfield's content rules: retrying the same request gives the same answer
REFUSED = {"nsfw", "ip_detected", "rejected"}
DOWNLOAD_MAX = 1024 * 1024 * 1024


class JobError(Exception):
    def __init__(self, message: str, *, code: str = "failed", retry: bool = True, job: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.retry = retry
        self.job = job or {}


def result_url(job: dict[str, Any]) -> str:
    """The result's address in any of the shapes the CLI / API answer with."""
    for k in ("result_url", "url", "output_url"):
        v = job.get(k)
        if isinstance(v, str) and v.startswith("http"):
            return v
    res = job.get("results") or job.get("result") or job.get("outputs")
    if isinstance(res, dict):
        raw = res.get("raw") or res.get("min") or res
        if isinstance(raw, dict) and isinstance(raw.get("url"), str):
            return raw["url"]
        if isinstance(res.get("url"), str):
            return res["url"]
    if isinstance(res, list):
        for r in res:
            if isinstance(r, dict):
                u = r.get("url") or ((r.get("raw") or {}).get("url") if isinstance(r.get("raw"), dict) else None)
                if isinstance(u, str):
                    return u
            if isinstance(r, str) and r.startswith("http"):
                return r
    return ""


def job_id(job: dict[str, Any]) -> str:
    for k in ("id", "job_id", "job_set_id"):
        v = job.get(k)
        if isinstance(v, str) and v:
            return v
    return ""


def status_of(job: dict[str, Any]) -> str:
    return str(job.get("status") or job.get("state") or "").lower()


def _first(data: Any) -> dict[str, Any]:
    if isinstance(data, list):
        data = data[0] if data else {}
    # `higgsfield generate create --json` answers with just the new job's id: ["<uuid>"]
    if isinstance(data, str) and data.strip():
        return {"id": data.strip()}
    if isinstance(data, dict) and isinstance(data.get("jobs"), list) and data["jobs"]:
        inner = data["jobs"][0]
        if isinstance(inner, dict):
            return {**inner, **{k: v for k, v in data.items() if k not in ("jobs",) and k not in inner}}
    return data if isinstance(data, dict) else {}


class Generator:
    def __init__(self, service: HiggsfieldService) -> None:
        self.service = service
        self._quotes: dict[str, tuple[float, float]] = {}
        self._usd: tuple[float, float | None] | None = None

    # ---- account ----

    def account_id(self) -> str | None:
        return self.service.default_id()

    def cli(self) -> str | None:
        return find_cli()

    async def balance(self) -> dict[str, Any] | None:
        aid = self.account_id()
        if aid is None:
            return None
        acc = await self.service.fresh_account(aid)
        return {"credits": acc.get("credits"), "plan": acc.get("plan"), "email": acc.get("email"),
                "status": acc.get("status")}

    async def credit_usd(self) -> float | None:
        """Dollars per credit on the account's plan (ailism-ai hf_account / higgsfield_meta.plan_credit_usd), from
        ``GET /account/billing/plans`` (a read). None when it can't be told."""
        if self._usd and time.monotonic() - self._usd[0] < 24 * 3600:
            return self._usd[1]
        aid = self.account_id()
        if aid is None:
            return None
        value = None
        try:
            plan_type = (self.service.account(aid) or {}).get("plan")
            data = await self.service.api(aid, "GET", "/account/billing/plans")
            items = data.get("items") or data.get("plans") or [] if isinstance(data, dict) else data
            items = [p for p in items or [] if isinstance(p, dict)]
            values = {}
            for p in items:
                v = _plan_usd(p)
                if v:
                    values[str(p.get("type") or p.get("plan_type") or p.get("id") or p.get("name") or "")] = v
            if plan_type and str(plan_type) in values:
                value = values[str(plan_type)]
            elif plan_type:
                for k, v in values.items():
                    if k.lower() == str(plan_type).lower():
                        value = v
            if value is None and len(set(values.values())) == 1:
                value = next(iter(values.values()))
        except (HiggsfieldError, AttributeError, TypeError, ValueError):
            value = None
        self._usd = (time.monotonic(), value)
        return value

    # ---- quotes (free) ----

    async def quote(self, job_type: str, params: dict[str, Any], *, workdir: Path,
                    placeholders: dict[str, Path] | None = None) -> float:
        """Credits for one job (cached 10 minutes). HiggsfieldError when Higgsfield can't price it."""
        key = json.dumps([job_type, params], sort_keys=True)
        hit = self._quotes.get(key)
        if hit and time.monotonic() - hit[0] < 600:
            return hit[1]
        aid = self.account_id()
        if aid is None:
            raise HiggsfieldError("not_connected", "no Higgsfield account is connected")
        body = dict(params)
        if job_type in ("nano_banana_pro", "kling_o3_flf") and "prompt" not in body:
            body["prompt"] = "A character portrait."
        try:
            credits = float((await self.service.quote(aid, job_type, body))["credits"])
        except HiggsfieldError as exc:
            if exc.code != "invalid_params" or not placeholders or not self.cli():
                raise
            credits = await self.cli_cost(job_type, body, placeholders, workdir=workdir)
        self._quotes[key] = (time.monotonic(), credits)
        return credits

    async def cli_cost(self, job_type: str, params: dict[str, Any], media: dict[str, Path], *,
                       workdir: Path) -> float:
        flags = []
        for k, v in params.items():
            flags += [f"--{k}", str(v)]
        for flag, path in media.items():
            flags += [f"--{flag}", str(path)]
        data = await self._cli(["generate", "cost", job_type, *flags, "--json"], workdir=workdir, timeout=180)
        d = _first(data) if not isinstance(data, (int, float)) else {"credits": data}
        for k in ("credits", "cost", "total_credits", "estimated_credits"):
            v = d.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return float(v)
        raise HiggsfieldError("bad_json", "the CLI's cost answer has no credits")

    # ---- the CLI ----

    async def _env(self, workdir: Path) -> tuple[dict[str, str], Path]:
        aid = self.account_id()
        if aid is None:
            raise JobError("no Higgsfield account is connected", code="not_connected", retry=False)
        exe = self.cli()
        if exe is None:
            raise JobError("the higgsfield CLI isn't installed on this server", code="no_cli", retry=False)
        try:
            tokens = await self.service.access_token(aid, keep=FILE_KEEP)
        except HiggsfieldError as exc:
            raise JobError("Higgsfield needs a new sign-in: " + redact(exc.text()), code="signed_out",
                           retry=False) from None
        base = workdir / ".hf"
        base.mkdir(parents=True, exist_ok=True)
        os.chmod(base, 0o700)
        d = base / secrets.token_hex(6)  # one folder per call: parallel jobs never share (or delete) one file
        d.mkdir(mode=0o700)
        await asyncio.to_thread(_atomic_write, d / "credentials.json", json.dumps(cli_credentials(tokens["access"])))
        ws = (self.service._row(aid).get("info") or {}).get("workspace_id")
        await asyncio.to_thread(_atomic_write, d / "config.json", json.dumps({"workspace_id": ws} if ws else {}))
        return {"PATH": f"{os.path.dirname(exe)}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}",
                "HOME": os.environ.get("HOME", ""), "HIGGSFIELD_CREDENTIALS_PATH": str(d / "credentials.json"),
                "HIGGSFIELD_CONFIG_PATH": str(d / "config.json"), "HIGGSFIELD_NO_UPDATE_CHECK": "1",
                "NO_COLOR": "1"}, d

    async def _cli(self, args: list[str], *, workdir: Path, timeout: float) -> Any:
        env, creds = await self._env(workdir)
        exe = self.cli() or "higgsfield"
        # (stdin closed: with no --prompt the CLI reads one from it, and a pipe nobody writes to holds it until the timeout)
        proc = await asyncio.create_subprocess_exec(exe, *args, cwd=str(workdir), env=env,
                                                    stdin=asyncio.subprocess.DEVNULL,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except (TimeoutError, asyncio.TimeoutError):
            proc.kill()
            await proc.wait()
            raise JobError(f"higgsfield {args[0]} {args[1] if len(args) > 1 else ''}: timed out", code="timeout")
        finally:
            shutil.rmtree(creds, ignore_errors=True)  # (the token never lingers on disk)
        text = out.decode("utf-8", "replace").strip()
        try:
            return json.loads(text)
        except ValueError:
            # (a JSON document after progress lines)
            for start in (text.find("{"), text.find("[")):
                if start >= 0:
                    try:
                        return json.loads(text[start:])
                    except ValueError:
                        pass
            said = (err.decode("utf-8", "replace") or text or f"exit {proc.returncode}").strip()[-400:]
            raise JobError(redact(said) or "no answer", code="cli_error") from None

    async def create(self, job_type: str, flags: list[str], *, workdir: Path) -> dict[str, Any]:
        """Submit one job (SPENDS CREDITS — only after the gate said yes). → the job ({id, status, …})."""
        data = await self._cli(["generate", "create", job_type, *flags, "--json"], workdir=workdir, timeout=600)
        job = _first(data)
        if not job_id(job) and not result_url(job):
            raise JobError("Higgsfield gave no job id: " + json.dumps(data)[:300], code="cli_error", job=job)
        return job

    async def wait(self, jid: str, *, workdir: Path, timeout_s: float = 1800) -> dict[str, Any]:
        """The job once it is finished (JobError when it failed or was refused)."""
        deadline = time.monotonic() + timeout_s
        job: dict[str, Any] = {}
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise JobError("the job took too long", code="timeout", job=job)
            mins = max(1, int(min(left, 900) // 60))
            try:
                job = _first(await self._cli(["generate", "wait", jid, "--timeout", f"{mins}m", "--quiet", "--json"],
                                             workdir=workdir, timeout=mins * 60 + 120))
            except JobError as exc:
                if exc.code == "timeout":
                    continue
                job = _first(await self._cli(["generate", "get", jid, "--json"], workdir=workdir, timeout=120))
            st = status_of(job)
            if st in TERMINAL_OK or (result_url(job) and st not in TERMINAL_BAD):
                return job
            if st in TERMINAL_BAD:
                msg = str(job.get("error") or job.get("message") or job.get("failure_reason") or st)
                raise JobError(f"Higgsfield: {msg}"[:300], code=st, retry=st not in REFUSED, job=job)
            await asyncio.sleep(5)

    async def download(self, url: str, path: Path) -> None:
        def get() -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".part")
            req = urllib.request.Request(url, headers={"User-Agent": "my-mate-geny"})
            size = 0
            with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as fh:  # noqa: S310 - job results
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > DOWNLOAD_MAX:
                        raise JobError("the result is too large", code="too_large", retry=False)
                    fh.write(chunk)
            if size == 0:
                raise JobError("the result was empty", code="empty")
            os.replace(tmp, path)
        try:
            await asyncio.to_thread(get)
        except JobError:
            raise
        except Exception as exc:  # noqa: BLE001 - network
            raise JobError(f"download failed: {type(exc).__name__}", code="download") from None


def _plan_usd(p: dict[str, Any]) -> float | None:
    """$/credit of one billing plan (ailism-ai higgsfield_meta.plan_credit_usd)."""
    def num(*keys: str) -> float | None:
        for k in keys:
            v = p.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
                return float(v)
        return None
    credits = num("credits", "credits_per_month", "monthly_credits")
    price = num("final_price_cents")
    if price and credits:
        return round(price / 100 / credits, 6)
    ratio = num("dollar_to_credits_ratio")
    if ratio:
        return round(1 / ratio if ratio >= 1 else ratio, 6)
    price = num("price_cents")
    if price and credits:
        return round(price / 100 / credits, 6)
    return None
