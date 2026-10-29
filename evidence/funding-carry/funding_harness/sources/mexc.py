"""MEXC contract funding via public funding_rate endpoint.

BLOCKED REALITY: contract.mexc.com returned HTTP 403 to EI's network during
the EI-STRAT-002 probe (2026-10-20). Implemented like binance.py so the block
is recorded as an explicit gap row every run (never zero-filled).

Units [R]: fundingRate decimal per 8h for majors; nextSettleTime epoch seconds.
"""
from __future__ import annotations

from .. import config
from ..convert import ConversionError, is_at_clamp, s_to_iso_utc, safe_float
from ..models import (funding_metrics, funding_unit_conventions,
                      make_gap, make_observation)
from .base import SourceResult, register, request_json

SOURCE = "mexc"
INTERVAL_HOURS = 8.0
INTERVAL_ASSUMED = True
PROVENANCE = ("mexc public contract API (free, unauthenticated): "
              "/api/v1/contract/funding_rate/{symbol}; HTTP 403 from EI network "
              "as of EI-STRAT-002 probe 2026-10-20")


@register(SOURCE)
def fetch(assets, transport, run_id: str, collected_at_utc: str) -> SourceResult:
    out = SourceResult(source=SOURCE)
    for asset in assets:
        symbol = f"{asset}_USDT"
        fetched = request_json(
            transport=transport,
            url=f"{config.ENDPOINTS['mexc']}/{symbol}",
            method="GET", body=None, stem=f"mexc/funding_{asset}",
            run_id=run_id, collected_at_utc=collected_at_utc,
            source=SOURCE, assets=[asset], metric_group="funding")
        out.raws.append(fetched.raw)
        out.gaps.extend(fetched.error_gaps)
        if not fetched.ok:
            continue
        body = fetched.payload
        d = body.get("data") if isinstance(body, dict) else None
        if not isinstance(d, dict) or body.get("success") is not True:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=symbol, metric_group="funding",
                gap_reason=config.GAP_MALFORMED,
                detail=f"success/data missing (code={body.get('code') if isinstance(body, dict) else '?'})",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        warnings = []
        try:
            rate = safe_float(d.get("fundingRate"))
            mark = safe_float(d.get("markPrice"))
            settle_s = safe_float(d.get("nextSettleTime"))
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
                interval_assumed=INTERVAL_ASSUMED, mark_price=mark,
                next_funding_ts_utc=s_to_iso_utc(settle_s), at_clamp=clamp),
            unit_conventions=funding_unit_conventions(),
            evidence=fetched.evidence(PROVENANCE),
            warnings=warnings))
    return out
