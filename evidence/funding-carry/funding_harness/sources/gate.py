"""Gate.io USDT futures funding via public contract details.

Units: `funding_rate` decimal per `funding_interval` seconds (EXPLICIT per
contract; majors are 28800s=8h — interval_assumed=False when present).
Positive = longs pay shorts. mark_price included; open_interest_usd was null
on 2026-10-20 probe (recorded as null, never zero-filled).
"""
from __future__ import annotations

from .. import config
from ..convert import ConversionError, is_at_clamp, safe_float
from ..models import (funding_metrics, funding_unit_conventions,
                      make_gap, make_observation)
from .base import SourceResult, register, request_json

SOURCE = "gate"
PROVENANCE = "gate.io public v4 API (free, unauthenticated): /futures/usdt/contracts/{symbol}"


@register(SOURCE)
def fetch(assets, transport, run_id: str, collected_at_utc: str) -> SourceResult:
    out = SourceResult(source=SOURCE)
    for asset in assets:
        symbol = f"{asset}_USDT"
        fetched = request_json(
            transport=transport,
            url=f"{config.ENDPOINTS['gate']}/{symbol}",
            method="GET", body=None, stem=f"gate/contract_{asset}",
            run_id=run_id, collected_at_utc=collected_at_utc,
            source=SOURCE, assets=[asset], metric_group="funding")
        out.raws.append(fetched.raw)
        out.gaps.extend(fetched.error_gaps)
        if not fetched.ok:
            continue
        c = fetched.payload if isinstance(fetched.payload, dict) else {}
        warnings: list[str] = []
        try:
            rate = safe_float(c.get("funding_rate"))
            interval_s = safe_float(c.get("funding_interval"))
            mark = safe_float(c.get("mark_price"))
            oi_usd = safe_float(c.get("open_interest_usd"))
        except ConversionError as exc:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=symbol, metric_group="funding",
                gap_reason=config.GAP_FIELD_MISSING,
                detail=f"unparseable numeric field: {exc}",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        if rate is None:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=symbol, metric_group="funding",
                gap_reason=config.GAP_FIELD_MISSING,
                detail="funding_rate null/missing",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        interval_hours = interval_s / 3600.0 if interval_s else None
        interval_assumed = interval_hours is None
        if interval_assumed:
            interval_hours = 8.0
            warnings.append("funding_interval absent; assumed 8h for majors")
        clamp = (interval_hours == 8.0 and
                 is_at_clamp(rate, config.CLAMP_REFERENCES[SOURCE]["rate"]))
        if clamp:
            warnings.append("funding equals observed 1e-4/8h clamp reference "
                            "(10.95% APR); saturation marker")
        out.observations.append(make_observation(
            run_id=run_id, collected_at_utc=collected_at_utc,
            observation_ts_utc=collected_at_utc,
            observation_ts_basis="response_time",
            source=SOURCE, source_kind="cex", asset=asset,
            source_instrument=symbol, metric_group="funding",
            metrics=funding_metrics(
                rate_native=rate, interval_hours=interval_hours,
                interval_assumed=interval_assumed, mark_price=mark,
                oi_usd=oi_usd, at_clamp=clamp),
            unit_conventions=funding_unit_conventions(),
            evidence=fetched.evidence(PROVENANCE),
            warnings=warnings))
    return out
