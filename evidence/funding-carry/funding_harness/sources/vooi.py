"""VOOI public arbitrage-scanner as executable-spread CONTEXT for the funding
family (priceSpreadAtSize for HL-vs-CEX pairs; the repo's cex-hl strategy
skips pairs with |spread| > 1%). Not a funding source: VOOI leg fundingRate
strings are recorded as raw context only (per-venue interval conventions not
verified).

Endpoint (EI-STRAT-001 §2.2 [O]): GET /arbitrage-scanner?minOpenInterest=10000
&notionalUsd=5000&orderBy=priceSpread on perps-api.vooi.io, unauthenticated.
Observed 2026-10-20: the scanner response contained only thin/alias assets and
NO majors — the harness records that absence as an explicit per-asset gap
(asset_not_in_scanner_response), never as a zero spread.
"""
from __future__ import annotations

from .. import config
from ..convert import ConversionError, safe_float
from ..models import (context_metrics, funding_unit_conventions,
                      make_gap, make_observation)
from .base import SourceResult, register, request_json

SOURCE = "vooi"
PROVENANCE = ("vooi public scanner API (free, unauthenticated): "
              "/arbitrage-scanner?minOpenInterest=10000&notionalUsd=5000&orderBy=priceSpread")
HL = "hyperliquid"


@register(SOURCE)
def fetch(assets, transport, run_id: str, collected_at_utc: str) -> SourceResult:
    fetched = request_json(
        transport=transport, url=config.ENDPOINTS["vooi"],
        method="GET", body=None, stem="vooi/arbitrage_scanner",
        run_id=run_id, collected_at_utc=collected_at_utc,
        source=SOURCE, assets=assets, metric_group="context")
    out = SourceResult(source=SOURCE)
    out.raws.append(fetched.raw)
    out.gaps.extend(fetched.error_gaps)
    if not fetched.ok:
        return out
    payload = fetched.payload
    items = payload if isinstance(payload, list) \
        else (payload.get("items") if isinstance(payload, dict) else None)
    if not isinstance(items, list):
        for a in assets:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=a, source_instrument=a, metric_group="context",
                gap_reason=config.GAP_MALFORMED,
                detail=f"expected items array, got {type(payload).__name__}",
                evidence=fetched.evidence(PROVENANCE)))
        return out

    by_asset = {}
    for it in items:
        if isinstance(it, dict) and it.get("asset"):
            by_asset.setdefault(str(it["asset"]), it)

    for asset in assets:
        item = by_asset.get(asset)
        if item is None:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=asset, metric_group="context",
                gap_reason=config.GAP_ASSET_MISSING,
                detail=f"asset {asset} not present in scanner response "
                       f"({len(items)} items today; majors are typically absent "
                       f"under priceSpread ordering)",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        pairs = item.get("pairs") or []
        hl_pairs = []
        for p in pairs:
            if not isinstance(p, dict):
                continue
            long_x = str((p.get("long") or {}).get("exchange", "")).lower()
            short_x = str((p.get("short") or {}).get("exchange", "")).lower()
            if HL in (long_x, short_x):
                hl_pairs.append(p)
        if not hl_pairs:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=asset, metric_group="context",
                gap_reason=config.GAP_ASSET_MISSING,
                detail="no Hyperliquid-involving pair in scanner item",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        for p in hl_pairs:
            warnings = []
            try:
                at_size = safe_float(p.get("priceSpreadAtSize"))
                headline = safe_float(p.get("priceSpread"))
            except ConversionError as exc:
                out.gaps.append(make_gap(
                    run_id=run_id, collected_at_utc=collected_at_utc,
                    source=SOURCE, asset=asset,
                    source_instrument=_pair_label(p), metric_group="context",
                    gap_reason=config.GAP_FIELD_MISSING,
                    detail=f"unparseable spread field: {exc}",
                    evidence=fetched.evidence(PROVENANCE)))
                continue
            long_leg = p.get("long") or {}
            short_leg = p.get("short") or {}
            out.observations.append(make_observation(
                run_id=run_id, collected_at_utc=collected_at_utc,
                observation_ts_utc=collected_at_utc,
                observation_ts_basis="response_time",
                source=SOURCE, source_kind="aggregator", asset=asset,
                source_instrument=_pair_label(p), metric_group="context",
                metrics=context_metrics(
                    price_spread_at_size=at_size,
                    price_spread_headline=headline,
                    extra={
                        "funding_spread_1h_raw": p.get("fundingSpread1h"),
                        "long_exchange": long_leg.get("exchange"),
                        "short_exchange": short_leg.get("exchange"),
                        "long_price": _sf(long_leg.get("price")),
                        "short_price": _sf(short_leg.get("price")),
                        "long_oi_raw": long_leg.get("openInterest"),
                        "short_oi_raw": short_leg.get("openInterest"),
                        "long_slippage_pct_raw": long_leg.get("slippage"),
                        "short_slippage_pct_raw": short_leg.get("slippage"),
                        "long_funding_rate_raw": long_leg.get("fundingRate"),
                        "short_funding_rate_raw": short_leg.get("fundingRate"),
                    }),
                unit_conventions=funding_unit_conventions(
                    native_basis="vooi scanner context row; spreads are venue "
                                 "reported fractions/percent per scanner units"),
                evidence=fetched.evidence(PROVENANCE),
                warnings=warnings))
    return out


def _sf(v):
    try:
        return safe_float(v)
    except ConversionError:
        return None


def _pair_label(p: dict) -> str:
    long_x = (p.get("long") or {}).get("exchange", "?")
    short_x = (p.get("short") or {}).get("exchange", "?")
    return f"{long_x}->{short_x}"
