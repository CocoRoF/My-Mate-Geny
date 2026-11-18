"""The real world around her day (docs/mate-life.md): the weather where the user is and the public holidays of their country,
from open APIs without a key — Open-Meteo (weather) and Nager.Date (holidays, with their names: Seollal and Chuseok move every
year). What it finds goes into ``sim.REAL``, with the user's country (the days of the year she knows there: life/days.py); without
a network her day goes on as before (a made-up sky, weekends and the calendar's days off).

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
#: where a country's holidays of a year are kept once found: [{date, en, local}]
HOLIDAYS_KEY = "holidays.named:{country}:{year}"
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

#: …and where it is, for the light of the day (sunrise and sunset: sim.slot) when they haven't said where they are
TZ_WHERE = {
    "Asia/Seoul": (37.57, 126.98), "Asia/Tokyo": (35.68, 139.69), "Asia/Shanghai": (31.23, 121.47), "Asia/Hong_Kong": (22.32, 114.17),
    "Asia/Taipei": (25.03, 121.57), "Asia/Singapore": (1.35, 103.82), "Asia/Bangkok": (13.76, 100.5), "Asia/Ho_Chi_Minh": (10.82, 106.63),
    "Asia/Jakarta": (-6.21, 106.85), "Asia/Manila": (14.6, 120.98), "Asia/Kolkata": (28.61, 77.21), "Australia/Sydney": (-33.87, 151.21),
    "Australia/Melbourne": (-37.81, 144.96), "Pacific/Auckland": (-36.85, 174.76), "Europe/London": (51.51, -0.13),
    "Europe/Dublin": (53.35, -6.26), "Europe/Paris": (48.86, 2.35), "Europe/Berlin": (52.52, 13.4), "Europe/Madrid": (40.42, -3.7),
    "Europe/Rome": (41.9, 12.5), "Europe/Amsterdam": (52.37, 4.9), "Europe/Brussels": (50.85, 4.35), "Europe/Zurich": (47.38, 8.54),
    "Europe/Vienna": (48.21, 16.37), "Europe/Stockholm": (59.33, 18.07), "Europe/Oslo": (59.91, 10.75), "Europe/Copenhagen": (55.68, 12.57),
    "Europe/Helsinki": (60.17, 24.94), "Europe/Warsaw": (52.23, 21.01), "Europe/Prague": (50.08, 14.44), "Europe/Lisbon": (38.72, -9.14),
    "America/New_York": (40.71, -74.01), "America/Chicago": (41.88, -87.63), "America/Denver": (39.74, -104.99),
    "America/Los_Angeles": (34.05, -118.24), "America/Phoenix": (33.45, -112.07), "America/Anchorage": (61.22, -149.9),
    "Pacific/Honolulu": (21.31, -157.86), "America/Toronto": (43.65, -79.38), "America/Vancouver": (49.28, -123.12),
    "America/Mexico_City": (19.43, -99.13), "America/Sao_Paulo": (-23.55, -46.63), "America/Argentina/Buenos_Aires": (-34.6, -58.38),
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

    def where(self) -> tuple[float, float] | None:
        """Where on earth they are, for sunrise and sunset: their location, else their time zone's city, else nowhere (the clock)."""
        loc = self.store.location() or {}
        if loc.get("lat") is not None and loc.get("lon") is not None:
            return float(loc["lat"]), float(loc["lon"])
        return TZ_WHERE.get(self.store.tz_and_key()[1])

    def country(self) -> str:
        loc = self.store.location() or {}
        if loc.get("country"):
            return loc["country"]
        return TZ_COUNTRY.get(self.store.tz_and_key()[1], "")

    async def refresh(self, *, force: bool = False) -> None:
        """Weather every half hour, holidays once a year per country; failures are quiet and retried later."""
        if not settings.life_world:
            return
        sim.REAL["country"] = self.country()  # (no network needed: the days of the year she knows there come with it)
        sim.REAL["where"] = self.where()  # (nor for the light: sunrise and sunset are worked out here)
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
            sim.REAL["holidays"], sim.REAL["holiday_names"] = set(), {}
            return
        year = datetime.now(timezone.utc).year
        found: list[dict[str, str]] = []
        for y in (year, year + 1):
            key = HOLIDAYS_KEY.format(country=country, year=y)
            raw = self.store._setting(key)
            if not raw and time.monotonic() - self._tried.get(key, -1e9) > RETRY_S:
                self._tried[key] = time.monotonic()
                r = await client.get(HOLIDAYS_URL.format(year=y, country=country))
                if r.status_code == 200:
                    raw = json.dumps(self.named(r.json()), ensure_ascii=False)
                    self.store._put_setting(key, raw)
                elif r.status_code in (204, 404):  # (a country it doesn't know: weekends only)
                    raw = "[]"
                    self.store._put_setting(key, raw)
            found += [h for h in json.loads(raw or "[]") if isinstance(h, dict) and h.get("date")]
        sim.REAL["holidays"] = {h["date"] for h in found}
        names: dict[str, list[dict[str, str]]] = {}
        for h in found:
            names.setdefault(h["date"], []).append({"en": str(h.get("en") or ""), "local": str(h.get("local") or "")})
        sim.REAL["holiday_names"] = names

    @staticmethod
    def named(doc: Any) -> list[dict[str, str]]:
        """Nager.Date's answer → the country-wide holidays, with their names: [{date, en, local}] (a regional one is not hers)."""
        out = []
        for h in doc if isinstance(doc, list) else []:
            if isinstance(h, dict) and h.get("date") and (h.get("global", True) or not h.get("counties")):
                out.append({"date": str(h["date"]), "en": str(h.get("name") or ""), "local": str(h.get("localName") or "")})
        return sorted(out, key=lambda h: h["date"])
