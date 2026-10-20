"""Unit conversions and fail-closed numeric parsing.

Rule: a value that cannot be parsed becomes None (and the observation is
marked incomplete upstream). Nothing in this harness ever substitutes a
default numeric value (especially not zero) for missing data.
"""
from __future__ import annotations

from typing import Any, Optional

HOURS_PER_YEAR = 24.0 * 365.0


class ConversionError(ValueError):
    """Raised when a payload value cannot be converted to a number."""


def safe_float(value: Any) -> Optional[float]:
    """Parse int/float/numeric-string to float; None on null/empty/invalid.

    Rejects booleans (a common JSON foot-gun), NaN and infinities.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        raise ConversionError(f"boolean where number expected: {value!r}")
    if isinstance(value, (int, float)):
        f = float(value)
    elif isinstance(value, str):
        s = value.strip()
        if not s or s.lower() in ("", "null", "none", "nan", "n/a", "-"):
            return None
        try:
            f = float(s)
        except ValueError as exc:
            raise ConversionError(f"unparseable number: {value!r}") from exc
    else:
        raise ConversionError(f"unsupported number type: {type(value).__name__}")
    if f != f or f in (float("inf"), float("-inf")):
        raise ConversionError(f"non-finite number: {value!r}")
    return f


def funding_apr(rate_per_interval: Optional[float], interval_hours: Optional[float]) -> Optional[float]:
    """Annualize a per-interval funding rate (decimal fraction) to APR fraction.

    apr = rate * (HOURS_PER_YEAR / interval_hours)
    e.g. 0.0000125 per 1h -> 0.1095 (=10.95% APR); 0.0001 per 8h -> 0.1095.
    """
    rate = safe_float(rate_per_interval) if not isinstance(rate_per_interval, float) else rate_per_interval
    if rate is None or interval_hours is None:
        return None
    if interval_hours <= 0:
        raise ConversionError(f"non-positive interval_hours: {interval_hours}")
    return rate * (HOURS_PER_YEAR / float(interval_hours))


def rate_8h_equivalent(rate_per_interval: Optional[float], interval_hours: Optional[float]) -> Optional[float]:
    """Convert a per-interval rate to its equivalent per-8h rate (decimal).

    A 1h rate covers 1/8th of an 8h interval, so multiply by 8/interval_hours
    (e.g. 0.0000125 per 1h -> 0.0001 per 8h; 0.00005 per 4h -> 0.0001).
    """
    if rate_per_interval is None or interval_hours is None:
        return None
    if interval_hours <= 0:
        raise ConversionError(f"non-positive interval_hours: {interval_hours}")
    return rate_per_interval * (8.0 / float(interval_hours))


def apr_pct(apr_fraction: Optional[float]) -> Optional[float]:
    return None if apr_fraction is None else apr_fraction * 100.0


def is_at_clamp(rate_per_interval: Optional[float], reference: Optional[float],
                rel_tol: float = 1e-9) -> bool:
    """True when the raw rate equals the observed clamp reference exactly.

    Used ONLY to flag regime saturation; never to modify a rate.
    """
    if rate_per_interval is None or reference is None:
        return False
    return abs(rate_per_interval - reference) <= rel_tol * max(abs(rate_per_interval), abs(reference))


def ms_to_iso_utc(ms: Optional[float]) -> Optional[str]:
    """Epoch milliseconds -> 'YYYY-MM-DDTHH:MM:SSZ' (None passes through)."""
    from datetime import datetime, timezone
    if ms is None:
        return None
    f = float(ms)
    if f != f or f in (float("inf"), float("-inf")):
        raise ConversionError(f"non-finite epoch ms: {ms!r}")
    dt = datetime.fromtimestamp(f / 1000.0, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def s_to_iso_utc(seconds: Optional[float]) -> Optional[str]:
    """Epoch seconds -> 'YYYY-MM-DDTHH:MM:SSZ' (None passes through)."""
    from datetime import datetime, timezone
    if seconds is None:
        return None
    f = float(seconds)
    if f != f or f in (float("inf"), float("-inf")):
        raise ConversionError(f"non-finite epoch seconds: {seconds!r}")
    dt = datetime.fromtimestamp(f, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_to_utc_slot12(ts_utc: str) -> str:
    """'YYYY-MM-DDTHH:MM:SSZ' -> 12h collection slot key 'YYYY-MM-DDT00Z|12Z'."""
    from datetime import datetime, timezone
    dt = datetime.strptime(ts_utc, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    slot_hour = "00" if dt.hour < 12 else "12"
    return f"{dt.strftime('%Y-%m-%d')}T{slot_hour}Z"


def iso_date(ts_utc: str) -> str:
    return ts_utc[:10]
