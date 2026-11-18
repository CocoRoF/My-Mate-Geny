"""When the sun rises and sets where the user is, so the light behind her follows the season (docs/mate-life.md): in a Seoul
summer it is still light at seven in the evening, in winter it is dark by six. NOAA's approximation (its solar calculator's
equations): within a minute or two, no network, no dependency. Pure.
"""

from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache

#: the sun's edge on the horizon, refraction included (90° 50′)
ZENITH = math.radians(90.833)


@lru_cache(maxsize=512)
def times_utc(day: date, lat: float, lon: float) -> tuple[datetime, datetime] | None:
    """Sunrise and sunset (UTC) on ``day`` at ``lat``/``lon`` (degrees, east positive). None: the sun doesn't rise or doesn't set
    that day (a polar night or day)."""
    g = 2 * math.pi / 365 * (day.timetuple().tm_yday - 1)
    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g)
                       - 0.040849 * math.sin(2 * g))
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
            - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))
    phi = math.radians(lat)
    cos_ha = math.cos(ZENITH) / (math.cos(phi) * math.cos(decl)) - math.tan(phi) * math.tan(decl)
    if not -1.0 <= cos_ha <= 1.0:
        return None
    ha = math.degrees(math.acos(cos_ha))
    noon = datetime.combine(day, time(0), tzinfo=timezone.utc)
    rise = noon + timedelta(minutes=720 - 4 * (lon + ha) - eqtime)
    sets = noon + timedelta(minutes=720 - 4 * (lon - ha) - eqtime)
    return rise, sets


def minutes(local: datetime, lat: float, lon: float) -> tuple[int, int] | None:
    """Sunrise and sunset on ``local``'s date, as minutes after its local midnight (in its time zone). None: no sunrise or sunset."""
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    found = times_utc(local.date(), round(lat, 2), round(lon, 2))
    if found is None:
        return None
    rise, sets = (round((t.astimezone(local.tzinfo) - midnight).total_seconds() / 60) if local.tzinfo else
                  round((t.replace(tzinfo=None) - midnight).total_seconds() / 60) for t in found)
    return rise, sets


def season(local: datetime, lat: float | None = None) -> str:
    """spring | summer | autumn | winter by the month, the other way round south of the equator."""
    month = local.month if lat is None or lat >= 0 else (local.month + 5) % 12 + 1
    return ("winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn",
            "winter")[month - 1]
