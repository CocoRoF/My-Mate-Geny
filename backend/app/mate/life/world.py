"""The real world around her day (docs/mate-life.md): the weather where the user is and the public holidays of their country,
from open APIs without a key — Open-Meteo (weather) and Nager.Date (holidays). What it finds goes into ``sim.REAL``; without a
network her day goes on as before (a made-up sky, weekends off).

Where the user is: ``MateStore.location()`` (the console finds it from their connection, or they pick a city in Settings →
Language). Without one, the country is read from their time zone, for the holidays.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from app.config import settings
from app.mate.life import sim

WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
HOLIDAYS_URL = "https://date.nager.at/api/v3/PublicHolidays/{year}/{country}"
WEATHER_EVERY_S = 30 * 60
RETRY_S = 10 * 60
#: when no location is set: the country a time zone belongs to (for its holidays)
TZ_COUNTRY = {
    "Asia/Seoul": "KR", "Asia/Tokyo": "JP", "Asia/Shanghai": "CN", "Asia/Hong_Kong": "HK", "Asia/Taipei": "TW", "Asia/Singapore": "SG",
    "Asia/Bangkok": "TH", "Asia/Ho_Chi_Minh": "VN", "Asia/Jakarta": "ID", "Asia/Manila": "PH", "Asia/Kolkata": "IN",
    "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Pacific/Auckland": "NZ",
    "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Madrid": "ES", "Europe/Rome": "IT",
    "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/Zurich": "CH", "Europe/Vienna": "AT", "Europe/Stockholm": "SE",
    "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Europe/Helsinki": "FI", "Europe/Warsaw": "PL", "Europe/Prague": "CZ",
    "Europe/Lisbon": "PT", "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US",
    "America/Phoenix": "US", "America/Anchorage": "US", "Pacific/Honolulu": "US", "America/Toronto": "CA", "America/Vancouver": "CA",
    "America/Mexico_City": "MX", "America/Sao_Paulo": "BR", "America/Argentina/Buenos_Aires": "AR",
}

#: WMO weather codes (Open-Meteo) → the four skies her day knows
def sky_of(code: int) -> str:
    if code in (71, 73, 75, 77, 85, 86):
        return "snow"
    if code >= 51:
        return "rain"  # (drizzle, rain, showers, thunderstorms)
    if code >= 2:
        return "cloudy"  # (partly cloudy, overcast, fog)
    return "clear"


class World:
    def __init__(self, store: Any, log: Any = None, client: Any = None) -> None:
        self.store = store
        self._log = log
        self._client = client  # (tests hand in one; otherwise a fresh httpx client per refresh)
        self._weather_at = 0.0
        self._weather_for: tuple[float, float] | None = None
        self._tried: dict[str, float] = {}

    def country(self) -> str:
        loc = self.store.location() or {}
        if loc.get("country"):
            return loc["country"]
        return TZ_COUNTRY.get(self.store.tz_and_key()[1], "")

    async def refresh(self, *, force: bool = False) -> None:
        """Weather every half hour, holidays once a year per country; failures are quiet and retried later."""
        if not settings.life_world:
            return
        try:
            if self._client is not None:
                await self._refresh(self._client, force)
            else:
                async with httpx.AsyncClient(timeout=10, headers={"User-Agent": "MyMateGeny"}) as client:
                    await self._refresh(client, force)
        except Exception as exc:  # noqa: BLE001 - her day goes on without the world
            if self._log:
                self._log("info", f"life: the world is out of reach: {exc}")

    async def _refresh(self, client: Any, force: bool) -> None:
        await self._holidays(client)
        loc = self.store.location()
        if not loc:
            sim.REAL["skies"] = {}
            return
        where = (loc["lat"], loc["lon"])
        if not force and where == self._weather_for and time.monotonic() - self._weather_at < WEATHER_EVERY_S:
            return
        r = await client.get(WEATHER_URL, params={
            "latitude": loc["lat"], "longitude": loc["lon"], "timezone": "auto", "past_days": 2, "forecast_days": 3,
            "current": "temperature_2m,weather_code,is_day", "daily": "weather_code,temperature_2m_max,temperature_2m_min"})
        r.raise_for_status()
        sim.REAL["skies"] = self.skies(r.json(), loc.get("city") or "")
        self._weather_for, self._weather_at = where, time.monotonic()

    @staticmethod
    def skies(doc: dict[str, Any], city: str) -> dict[str, dict[str, Any]]:
        """Open-Meteo's answer → {date: {sky, low, high, city}}; today also has the temperature and the sky right now."""
        daily = doc.get("daily") or {}
        out: dict[str, dict[str, Any]] = {}
        for i, day in enumerate(daily.get("time") or []):
            try:
                out[day] = {"sky": sky_of(int(daily["weather_code"][i])), "low": round(float(daily["temperature_2m_min"][i])),
                            "high": round(float(daily["temperature_2m_max"][i])), "city": city}
            except (KeyError, IndexError, TypeError, ValueError):
                continue
        now = doc.get("current") or {}
        today = str(now.get("time") or "")[:10]
        if today and now.get("weather_code") is not None:
            out.setdefault(today, {"city": city})
            out[today] |= {"sky": sky_of(int(now["weather_code"])), "temp": round(float(now.get("temperature_2m") or 0))}
        return out

    async def _holidays(self, client: Any) -> None:
        country = self.country()
        if not country:
            sim.REAL["holidays"] = set()
            return
        year = datetime.now(timezone.utc).year
        days: set[str] = set()
        for y in (year, year + 1):
            key = f"holidays:{country}:{y}"
            raw = self.store._setting(key)
            if not raw and time.monotonic() - self._tried.get(key, -1e9) > RETRY_S:
                self._tried[key] = time.monotonic()
                r = await client.get(HOLIDAYS_URL.format(year=y, country=country))
                if r.status_code == 200:
                    found = sorted({h["date"] for h in r.json() if isinstance(h, dict) and h.get("date") and (h.get("global", True) or not h.get("counties"))})
                    raw = json.dumps(found)
                    self.store._put_setting(key, raw)
                elif r.status_code in (204, 404):  # (a country it doesn't know: weekends only)
                    raw = "[]"
                    self.store._put_setting(key, raw)
            days |= set(json.loads(raw or "[]"))
        sim.REAL["holidays"] = days
