"""Bybit linear perp funding via public v5 market/tickers (single symbol).

Units [R]: `fundingRate` is a decimal fraction per 8h interval for majors
(BTC/ETH/SOL); Bybit supports other intervals on some symbols, which is why
funding_interval_assumed=True is recorded. Positive = longs pay shorts.
Response: {retCode:0, result:{list:[{symbol, fundingRate, nextFundingTime,
markPrice, openInterest(base units), turnover24h(USD), volume24h(base)}...]}}.
"""
from __future__ import annotations

from .. import config
from ..convert import ConversionError, is_at_clamp, ms_to_iso_utc, safe_float
from ..models import (funding_metrics, funding_unit_conventions,
                      make_gap, make_observation)
from .base import SourceResult, register, request_json

SOURCE = "bybit"
INTERVAL_HOURS = 8.0
INTERVAL_ASSUMED = True
PROVENANCE = "bybit public v5 market/tickers (free, unauthenticated); category=linear"


def parse_symbol(row, asset, *, run_id, collected_at_utc, fetched, warnings_base=()):
    warnings = list(warnings_base)
    try:
        rate = safe_float(row.get("fundingRate"))
        oi = safe_float(row.get("openInterest"))
        mark = safe_float(row.get("markPrice"))
        turnover = safe_float(row.get("turnover24h"))
        nxt = ms_to_iso_utc(safe_float(row.get("nextFundingTime")))
    except ConversionError as exc:
        return None, make_gap(
            run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
            asset=asset, source_instrument=row.get("symbol") or f"{asset}USDT",
            metric_group="funding", gap_reason=config.GAP_FIELD_MISSING,
            detail=f"unparseable numeric field: {exc}",
            evidence=fetched.evidence(PROVENANCE))
    if rate is None:
        return None, make_gap(
            run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
            asset=asset, source_instrument=row.get("symbol") or f"{asset}USDT",
            metric_group="funding", gap_reason=config.GAP_FIELD_MISSING,
            detail="fundingRate null/missing",
            evidence=fetched.evidence(PROVENANCE))
    clamp = is_at_clamp(rate, config.CLAMP_REFERENCES[SOURCE]["rate"])
    if clamp:
        warnings.append("funding equals observed 1e-4/8h clamp reference "
                        "(10.95% APR); saturation marker")
    obs = make_observation(
        run_id=run_id, collected_at_utc=collected_at_utc,
        observation_ts_utc=collected_at_utc,
        observation_ts_basis="response_time",
        source=SOURCE, source_kind="cex", asset=asset,
        source_instrument=row.get("symbol") or f"{asset}USDT",
        metric_group="funding",
        metrics=funding_metrics(
            rate_native=rate, interval_hours=INTERVAL_HOURS,
            interval_assumed=INTERVAL_ASSUMED, mark_price=mark,
            oi_native=oi, oi_unit=asset,
            next_funding_ts_utc=nxt, volume_24h_usd=turnover, at_clamp=clamp),
        unit_conventions=funding_unit_conventions(),
        evidence=fetched.evidence(PROVENANCE),
        warnings=warnings)
    return obs, None


@register(SOURCE)
def fetch(assets, transport, run_id: str, collected_at_utc: str) -> SourceResult:
    out = SourceResult(source=SOURCE)
    for asset in assets:
        symbol = f"{asset}USDT"
        fetched = request_json(
            transport=transport,
            url=f"{config.ENDPOINTS['bybit']}?category=linear&symbol={symbol}",
            method="GET", body=None, stem=f"bybit/tickers_{symbol}",
            run_id=run_id, collected_at_utc=collected_at_utc,
            source=SOURCE, assets=[asset], metric_group="funding")
        out.raws.append(fetched.raw)
        out.gaps.extend(fetched.error_gaps)
        if not fetched.ok:
            continue
        payload = fetched.payload
        rows = (payload.get("result") or {}).get("list") \
            if isinstance(payload, dict) else None
        ret_code = payload.get("retCode") if isinstance(payload, dict) else None
        if rows is None or ret_code not in (0, "0", None):
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=symbol, metric_group="funding",
                gap_reason=config.GAP_MALFORMED,
                detail=f"result.list missing or retCode={ret_code}",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        if not rows:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=symbol, metric_group="funding",
                gap_reason=config.GAP_ASSET_MISSING,
                detail=f"{symbol} absent from tickers response",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        obs, gap = parse_symbol(rows[0], asset, run_id=run_id,
                                collected_at_utc=collected_at_utc, fetched=fetched)
        if obs:
            out.observations.append(obs)
        else:
            out.gaps.append(gap)
    return out
