"""Hyperliquid perp funding/OI via public info API (POST metaAndAssetCtxs).

Unit conventions [V EI-STRAT-001 §2.1, unit-checked]: `funding` is a decimal
fraction PER HOUR; APR = rate * 8760. Positive = longs pay shorts.
Response shape: [ {universe: [{name,...},...], marginTables, collateralToken},
                  [assetCtx, ...] ] (assetCtxs aligned with universe order).
"""
from __future__ import annotations

from .. import config
from ..convert import ConversionError, is_at_clamp, safe_float
from ..models import (evidence_block, funding_metrics, funding_unit_conventions,
                      make_gap, make_observation)
from .base import SourceResult, register, request_json

SOURCE = "hyperliquid"
INTERVAL_HOURS = 1.0
PROVENANCE = "hyperliquid public info API (free, unauthenticated); POST type=metaAndAssetCtxs"


def parse(payload, *, run_id: str, collected_at_utc: str, result: HttpResult,
          raw_ref: str, raw_bounded: bool, assets) -> SourceResult:
    out = SourceResult(source=SOURCE)
    bad = None
    if not isinstance(payload, (list, tuple)) or len(payload) != 2:
        bad = f"expected [meta, ctxs] array, got {type(payload).__name__}"
    else:
        meta, ctxs = payload
        if not isinstance(meta, dict) or not isinstance(ctxs, list):
            bad = "meta/ctxs wrong types"
        else:
            universe = meta.get("universe")
            if not isinstance(universe, list) or len(universe) != len(ctxs):
                bad = "universe missing or misaligned with ctxs"
    if bad:
        for a in assets:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=a, source_instrument=a, metric_group="funding",
                gap_reason=config.GAP_MALFORMED, detail=bad, evidence=_ev(result, raw_ref, raw_bounded)))
        return out

    names = [u.get("name") for u in meta["universe"]]
    index = {n: i for i, n in enumerate(names)}
    for asset in assets:
        i = index.get(asset)
        if i is None:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=asset, metric_group="funding",
                gap_reason=config.GAP_ASSET_MISSING,
                detail=f"asset {asset} not in HL universe ({len(names)} assets)",
                evidence=_ev(result, raw_ref, raw_bounded)))
            continue
        ctx = ctxs[i] or {}
        warnings: list[str] = []
        try:
            rate = safe_float(ctx.get("funding"))
            oi = safe_float(ctx.get("openInterest"))
            mark = safe_float(ctx.get("markPx"))
            oracle = safe_float(ctx.get("oraclePx"))
            vlm = safe_float(ctx.get("dayNtlVlm"))
        except ConversionError as exc:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=asset, metric_group="funding",
                gap_reason=config.GAP_FIELD_MISSING,
                detail=f"unparseable numeric field: {exc}",
                evidence=_ev(result, raw_ref, raw_bounded)))
            continue
        if rate is None:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=asset, metric_group="funding",
                gap_reason=config.GAP_FIELD_MISSING, detail="funding rate null/missing",
                evidence=_ev(result, raw_ref, raw_bounded)))
            continue
        clamp = is_at_clamp(rate, config.CLAMP_REFERENCES[SOURCE]["rate"])
        if clamp:
            warnings.append("funding pinned at observed 1.25e-5/h clamp reference "
                            "(10.95% APR); cap-saturated regime marker")
        oi_usd = oi * mark if (oi is not None and mark is not None) else None
        out.observations.append(make_observation(
            run_id=run_id, collected_at_utc=collected_at_utc,
            observation_ts_utc=collected_at_utc,
            observation_ts_basis="response_time",
            source=SOURCE, source_kind="dex_perp", asset=asset,
            source_instrument=asset, metric_group="funding",
            metrics=funding_metrics(
                rate_native=rate, interval_hours=INTERVAL_HOURS,
                interval_assumed=False, mark_price=mark, index_price=oracle,
                oi_native=oi, oi_unit=asset, oi_usd=oi_usd, volume_24h_usd=vlm,
                at_clamp=clamp),
            unit_conventions=funding_unit_conventions(),
            evidence=_ev(result, raw_ref, raw_bounded, note=PROVENANCE),
            warnings=warnings))
    return out


def _ev(result: HttpResult, raw_ref: str, raw_bounded: bool, note=None) -> dict:
    return evidence_block(result, raw_ref=raw_ref, raw_bounded=raw_bounded,
                          provenance=PROVENANCE, note=note)


@register(SOURCE)
def fetch(assets, transport, run_id: str, collected_at_utc: str) -> SourceResult:
    fetched = request_json(transport=transport,
                           url=config.ENDPOINTS["hyperliquid"],
                           method="POST", body={"type": "metaAndAssetCtxs"},
                           stem="hyperliquid/metaAndAssetCtxs",
                           run_id=run_id, collected_at_utc=collected_at_utc,
                           source=SOURCE, assets=assets, metric_group="funding")
    out = SourceResult(source=SOURCE)
    out.raws.append(fetched.raw)
    out.gaps.extend(fetched.error_gaps)
    if fetched.ok:
        parsed = parse(fetched.payload, run_id=run_id,
                       collected_at_utc=collected_at_utc, result=fetched.result,
                       raw_ref=fetched.raw_ref, raw_bounded=fetched.raw_bounded,
                       assets=assets)
        # per-asset gaps built by parse() must carry evidence too
        for g in parsed.gaps:
            g.setdefault("evidence", fetched.evidence(PROVENANCE))
        out.observations.extend(parsed.observations)
        out.gaps.extend(parsed.gaps)
    return out
