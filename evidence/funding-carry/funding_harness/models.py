"""Canonical observation model + fail-closed validation.

One normalized row == one (source, instrument, metric-group, observation-time).
Complete rows go to observations.jsonl; incomplete evidence goes to gaps.jsonl
with a machine-readable gap_reason. There is no representation in this module
for "partial data promoted to a complete row" — that is forbidden by design.
"""
from __future__ import annotations

import hashlib
from typing import Any, Optional

from . import OBSERVATION_SCHEMA_VERSION, config

CANONICAL_METRIC_FIELDS = (
    "funding_rate_native",
    "funding_interval_hours",
    "funding_interval_assumed",
    "funding_rate_apr",
    "funding_rate_apr_pct",
    "funding_rate_8h_equiv",
    "at_clamp_reference",
    "mark_price",
    "index_price",
    "open_interest_native",
    "open_interest_unit",
    "open_interest_usd_estimate",
    "next_funding_ts_utc",
    "volume_24h_usd",
    "price_spread_at_size",
    "price_spread_headline",
    "net_apr_reference",
)

REQUIRED_TOP_FIELDS = (
    "schema_version", "observation_id", "observation_key", "run_id",
    "collected_at_utc", "observation_ts_utc", "observation_ts_basis",
    "source", "source_kind", "asset", "source_instrument",
    "metrics", "unit_conventions", "evidence", "quality",
)


def observation_key(source: str, asset: str, source_instrument: str,
                    metric_group: str, observation_ts_utc: str) -> str:
    return "|".join((source, asset, source_instrument, metric_group, observation_ts_utc))


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def make_observation(*, run_id: str, collected_at_utc: str, observation_ts_utc: str,
                     observation_ts_basis: str, source: str, source_kind: str,
                     asset: str, source_instrument: str, metric_group: str,
                     metrics: dict, unit_conventions: dict, evidence: dict,
                     warnings: Optional[list[str]] = None) -> dict:
    key = observation_key(source, asset, source_instrument, metric_group,
                          observation_ts_utc)
    obs = {
        "schema_version": OBSERVATION_SCHEMA_VERSION,
        "observation_id": _sha(key + "|" + run_id),
        "observation_key": key,
        "run_id": run_id,
        "collected_at_utc": collected_at_utc,
        "observation_ts_utc": observation_ts_utc,
        "observation_ts_basis": observation_ts_basis,
        "source": source,
        "source_kind": source_kind,
        "asset": asset,
        "source_instrument": source_instrument,
        "metric_group": metric_group,
        "metrics": metrics,
        "unit_conventions": unit_conventions,
        "evidence": evidence,
        "quality": {"complete": True, "gap_reason": None, "warnings": warnings or []},
    }
    problems = validate_observation(obs)
    if problems:
        raise ValueError(f"internal: invalid observation constructed: {problems}")
    return obs


def make_gap(*, run_id: str, collected_at_utc: str, source: str, asset: str,
             source_instrument: str, metric_group: str, gap_reason: str,
             detail: str, evidence: Optional[dict] = None) -> dict:
    return {
        "schema_version": OBSERVATION_SCHEMA_VERSION,
        "observation_id": None,
        "observation_key": observation_key(source, asset, source_instrument,
                                           metric_group, collected_at_utc),
        "run_id": run_id,
        "collected_at_utc": collected_at_utc,
        "observation_ts_utc": None,
        "observation_ts_basis": None,
        "source": source,
        "source_kind": None,
        "asset": asset,
        "source_instrument": source_instrument,
        "metric_group": metric_group,
        "metrics": {},
        "unit_conventions": {},
        "evidence": evidence or {},
        "quality": {"complete": False, "gap_reason": gap_reason, "warnings": [],
                    "detail": detail},
    }


def validate_observation(obs: dict) -> list[str]:
    """Fail-closed structural validation. Returns list of problems (empty=ok)."""
    problems: list[str] = []
    for f in REQUIRED_TOP_FIELDS:
        if f not in obs:
            problems.append(f"missing field: {f}")
    if problems:
        return problems
    if obs["schema_version"] != OBSERVATION_SCHEMA_VERSION:
        problems.append("schema_version mismatch")
    m = obs["metrics"]
    for f in CANONICAL_METRIC_FIELDS:
        if f not in m:
            problems.append(f"metrics missing canonical field: {f}")
    if "positive_means" not in obs["unit_conventions"]:
        problems.append("unit_conventions.positive_means missing")
    ev = obs["evidence"]
    for f in ("endpoint", "http_status", "payload_sha256", "provenance"):
        if f not in ev:
            problems.append(f"evidence missing field: {f}")
    # Forbidden fabricated values: funding must never silently default to 0.
    if obs["quality"]["complete"] and m.get("funding_rate_native") == 0.0 \
            and not m.get("at_clamp_reference") and obs["metric_group"] == "funding":
        problems.append("complete funding row with rate exactly 0.0 and no clamp flag")
    # Fail-closed: a COMPLETE funding row must carry an actual rate; complete
    # reference rows must carry either a rate or a net-APR reference.
    if obs["quality"]["complete"] and obs["metric_group"] == "funding":
        if m.get("funding_rate_native") is None or \
                m.get("funding_interval_hours") is None:
            problems.append("complete funding row missing rate/interval "
                            "(fail-closed: never promote partial evidence)")
    if obs["quality"]["complete"] and \
            obs["metric_group"] in ("funding_reference",
                                    "cross_exchange_reference"):
        if m.get("funding_rate_native") is None and \
                m.get("net_apr_reference") is None:
            problems.append("complete reference row carries neither rate nor "
                            "net-APR reference")
    return problems


def funding_metrics(*, rate_native: Optional[float], interval_hours: Optional[float],
                    interval_assumed: bool, mark_price: Optional[float] = None,
                    index_price: Optional[float] = None,
                    oi_native: Optional[float] = None, oi_unit: Optional[str] = None,
                    oi_usd: Optional[float] = None,
                    next_funding_ts_utc: Optional[str] = None,
                    volume_24h_usd: Optional[float] = None,
                    at_clamp: bool = False) -> dict:
    from .convert import apr_pct, funding_apr, rate_8h_equivalent
    # Clamp flagging never alters the rate: APR is always computed from the
    # raw observed value; at_clamp_reference is a regime-saturation marker.
    apr = funding_apr(rate_native, interval_hours)
    return {
        "funding_rate_native": rate_native,
        "funding_interval_hours": interval_hours,
        "funding_interval_assumed": bool(interval_assumed),
        "funding_rate_apr": apr,
        "funding_rate_apr_pct": apr_pct(apr),
        "funding_rate_8h_equiv": rate_8h_equivalent(rate_native, interval_hours),
        "at_clamp_reference": bool(at_clamp),
        "mark_price": mark_price,
        "index_price": index_price,
        "open_interest_native": oi_native,
        "open_interest_unit": oi_unit,
        "open_interest_usd_estimate": oi_usd,
        "next_funding_ts_utc": next_funding_ts_utc,
        "volume_24h_usd": volume_24h_usd,
        "price_spread_at_size": None,
        "price_spread_headline": None,
        "net_apr_reference": None,
    }


def context_metrics(*, price_spread_at_size: Optional[float],
                    price_spread_headline: Optional[float],
                    extra: Optional[dict] = None) -> dict:
    base = funding_metrics(rate_native=None, interval_hours=None,
                           interval_assumed=False)
    base.update({
        "price_spread_at_size": price_spread_at_size,
        "price_spread_headline": price_spread_headline,
    })
    if extra:
        base.update(extra)
    return base


def reference_metrics(*, rate_native: Optional[float], interval_hours: Optional[float],
                      net_apr: Optional[float],
                      mark_price: Optional[float] = None,
                      oi_usd: Optional[float] = None,
                      volume_24h_usd: Optional[float] = None,
                      extra: Optional[dict] = None) -> dict:
    base = funding_metrics(rate_native=rate_native, interval_hours=interval_hours,
                           interval_assumed=False, mark_price=mark_price,
                           oi_usd=oi_usd, volume_24h_usd=volume_24h_usd)
    base["net_apr_reference"] = net_apr
    if extra:
        base.update(extra)
    return base


def funding_unit_conventions(positive_means: str = "longs_pay_shorts",
                             native_basis: str = "decimal_fraction_per_interval") -> dict:
    return {
        "positive_means": positive_means,
        "native_rate_basis": native_basis,
        "apr_definition": "rate_per_interval * (hours_per_year / interval_hours); "
                          "hours_per_year = 8760",
        "note": "all rates decimal fractions; *_pct fields are x100 of the same value",
    }


def evidence_block(result, *, raw_ref: Optional[str], raw_bounded: bool,
                   provenance: str, note: Optional[str] = None) -> dict:
    ev = {
        "endpoint": result.url,
        "request_method": result.method,
        "http_status": result.status,
        "elapsed_ms": result.elapsed_ms,
        "http_attempts": result.attempts,
        "error": result.error,
        "payload_sha256": result.sha256,
        "payload_size_bytes": len(result.body),
        "raw_ref": raw_ref,
        "raw_bounded": raw_bounded,
        "provenance": provenance,
        "tool_version": _tool_version(),
    }
    if note:
        ev["note"] = note
    return ev


def _tool_version() -> str:
    from . import TOOL_VERSION
    return TOOL_VERSION


def gate_thresholds() -> dict:
    return dict(config.GATE_CONFIG)
