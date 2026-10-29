"""Binance USDⓈ-M funding via public premiumIndex.

BLOCKED REALITY: Binance fapi has returned HTTP 418 (IP ban) to EI's network
since EI-S004 (2026-10-13), confirmed again by EI-STRAT-001 (2026-10-19) and
the EI-STRAT-002 probe (2026-10-20). This adapter remains implemented so each
collection run records the block as an explicit gap row (http_error) — a
missing CEX rate must NEVER be zero-filled (EI-STRAT-002 instruction).

Units [R]: lastFundingRate decimal per 8h for majors; `time` is the server's
quote timestamp (used as observation time when reachable).
"""
from __future__ import annotations

from .. import config
from ..convert import ConversionError, is_at_clamp, ms_to_iso_utc, safe_float
from ..models import (funding_metrics, funding_unit_conventions,
                      make_gap, make_observation)
from .base import SourceResult, register, request_json

SOURCE = "binance"
INTERVAL_HOURS = 8.0
INTERVAL_ASSUMED = True
PROVENANCE = ("binance public fapi (free, unauthenticated): /fapi/v1/premiumIndex; "
              "persistently HTTP 418 from EI network since EI-S004 (2026-10-13)")


def parse_rows(payload, assets, *, run_id, collected_at_utc, fetched):
    obs, gaps = [], []
    rows = payload if isinstance(payload, list) else None
    if rows is None:
        for a in assets:
            gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=a, source_instrument=f"{a}USDT", metric_group="funding",
                gap_reason=config.GAP_MALFORMED,
                detail=f"expected array payload, got {type(payload).__name__}",
                evidence=fetched.evidence(PROVENANCE)))
        return obs, gaps
    by_symbol = {}
    for r in rows:
        if isinstance(r, dict) and r.get("symbol") in {f"{a}USDT" for a in assets}:
            by_symbol[r["symbol"]] = r
    for asset in assets:
        symbol = f"{asset}USDT"
        row = by_symbol.get(symbol)
        if row is None:
            gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=symbol, metric_group="funding",
                gap_reason=config.GAP_ASSET_MISSING,
                detail=f"{symbol} absent from premiumIndex response",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        warnings = []
        try:
            rate = safe_float(row.get("lastFundingRate"))
            mark = safe_float(row.get("markPrice"))
            index = safe_float(row.get("indexPrice"))
            srv_ts = safe_float(row.get("time"))
        except ConversionError as exc:
            gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=symbol, metric_group="funding",
                gap_reason=config.GAP_FIELD_MISSING,
                detail=f"unparseable numeric field: {exc}",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        if rate is None:
            gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=symbol, metric_group="funding",
                gap_reason=config.GAP_FIELD_MISSING,
                detail="lastFundingRate null/missing",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        clamp = is_at_clamp(rate, config.CLAMP_REFERENCES[SOURCE]["rate"])
        if clamp:
            warnings.append("funding equals observed 1e-4/8h clamp reference "
                            "(10.95% APR); saturation marker")
        obs.append(make_observation(
            run_id=run_id, collected_at_utc=collected_at_utc,
            observation_ts_utc=ms_to_iso_utc(srv_ts) or collected_at_utc,
            observation_ts_basis="source_reported_time" if srv_ts else "response_time",
            source=SOURCE, source_kind="cex", asset=asset,
            source_instrument=symbol, metric_group="funding",
            metrics=funding_metrics(
                rate_native=rate, interval_hours=INTERVAL_HOURS,
                interval_assumed=INTERVAL_ASSUMED, mark_price=mark,
                index_price=index,
                next_funding_ts_utc=ms_to_iso_utc(safe_float(row.get("nextFundingTime"))),
                at_clamp=clamp),
            unit_conventions=funding_unit_conventions(),
            evidence=fetched.evidence(PROVENANCE),
            warnings=warnings))
    return obs, gaps


@register(SOURCE)
def fetch(assets, transport, run_id: str, collected_at_utc: str) -> SourceResult:
    fetched = request_json(
        transport=transport, url=config.ENDPOINTS["binance"],
        method="GET", body=None, stem="binance/premiumIndex",
        run_id=run_id, collected_at_utc=collected_at_utc,
        source=SOURCE, assets=assets, metric_group="funding")
    out = SourceResult(source=SOURCE)
    out.raws.append(fetched.raw)
    out.gaps.extend(fetched.error_gaps)
    if fetched.ok:
        projection = None
        if isinstance(fetched.payload, list):
            wanted = {f"{a}USDT" for a in assets}
            projection = [r for r in fetched.payload
                          if isinstance(r, dict) and r.get("symbol") in wanted]
        obs, gaps = parse_rows(fetched.payload, assets, run_id=run_id,
                               collected_at_utc=collected_at_utc, fetched=fetched)
        for g in gaps:
            g.setdefault("evidence", fetched.evidence(PROVENANCE))
        out.observations.extend(obs)
        out.gaps.extend(gaps)
    return out
