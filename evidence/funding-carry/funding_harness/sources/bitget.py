"""Bitget USDT-mix funding via public current-fund-rate.

Units [R]: fundingRate decimal per 8h for majors (interval_assumed=True;
response carries no interval). Positive = longs pay shorts. Bitget BTC/ETH
observed exactly 0.0001 (=10.95% APR) on 2026-10-20 — clamp marker applies.
"""
from __future__ import annotations

from .. import config
from ..convert import ConversionError, is_at_clamp, safe_float
from ..models import (funding_metrics, funding_unit_conventions,
                      make_gap, make_observation)
from .base import SourceResult, register, request_json

SOURCE = "bitget"
INTERVAL_HOURS = 8.0
INTERVAL_ASSUMED = True
PROVENANCE = "bitget public v2 mix API (free, unauthenticated): market/current-fund-rate"


@register(SOURCE)
def fetch(assets, transport, run_id: str, collected_at_utc: str) -> SourceResult:
    out = SourceResult(source=SOURCE)
    for asset in assets:
        symbol = f"{asset}USDT"
        fetched = request_json(
            transport=transport,
            url=f"{config.ENDPOINTS['bitget']}?productType=usdt-futures&symbol={symbol}",
            method="GET", body=None, stem=f"bitget/funding_{asset}",
            run_id=run_id, collected_at_utc=collected_at_utc,
            source=SOURCE, assets=[asset], metric_group="funding")
        out.raws.append(fetched.raw)
        out.gaps.extend(fetched.error_gaps)
        if not fetched.ok:
            continue
        data = fetched.payload.get("data") if isinstance(fetched.payload, dict) else None
        if not isinstance(data, list) or not data:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=symbol, metric_group="funding",
                gap_reason=config.GAP_MALFORMED, detail="data[] missing/empty",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        d = data[0]
        warnings: list[str] = []
        try:
            rate = safe_float(d.get("fundingRate"))
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
                detail="fundingRate null/missing",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        clamp = is_at_clamp(rate, config.CLAMP_REFERENCES[SOURCE]["rate"])
        if clamp:
            warnings.append("funding equals observed 1e-4/8h clamp reference "
                            "(10.95% APR); saturation marker")
        out.observations.append(make_observation(
            run_id=run_id, collected_at_utc=collected_at_utc,
            observation_ts_utc=collected_at_utc,
            observation_ts_basis="response_time",
            source=SOURCE, source_kind="cex", asset=asset,
            source_instrument=d.get("symbol") or symbol, metric_group="funding",
            metrics=funding_metrics(
                rate_native=rate, interval_hours=INTERVAL_HOURS,
                interval_assumed=INTERVAL_ASSUMED, at_clamp=clamp),
            unit_conventions=funding_unit_conventions(),
            evidence=fetched.evidence(PROVENANCE),
            warnings=warnings))
    return out
