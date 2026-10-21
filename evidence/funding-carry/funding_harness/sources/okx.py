"""OKX USDT-swap funding via public endpoints (funding-rate + open-interest +
ticker per instrument). Units [R]: fundingRate decimal per 8h for majors
(funding_interval_assumed=True). Positive = longs pay shorts. OKX BTC was
observed pinned at exactly 0.0001 (=10.95% APR) on 2026-10-20 — clamp marker
applies."""
from __future__ import annotations

from .. import config
from ..convert import ConversionError, is_at_clamp, ms_to_iso_utc, safe_float
from ..models import (funding_metrics, funding_unit_conventions,
                      make_gap, make_observation)
from .base import SourceResult, register, request_json

SOURCE = "okx"
INTERVAL_HOURS = 8.0
INTERVAL_ASSUMED = True
PROVENANCE = "okx public v5 API (free, unauthenticated): public/funding-rate, public/open-interest, market/ticker"


@register(SOURCE)
def fetch(assets, transport, run_id: str, collected_at_utc: str) -> SourceResult:
    out = SourceResult(source=SOURCE)
    for asset in assets:
        inst = f"{asset}-USDT-SWAP"
        fetched = request_json(
            transport=transport,
            url=f"{config.ENDPOINTS['okx_funding']}?instId={inst}",
            method="GET", body=None, stem=f"okx/funding_{asset}",
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
                asset=asset, source_instrument=inst, metric_group="funding",
                gap_reason=config.GAP_MALFORMED, detail="data[] missing/empty",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        d = data[0]
        warnings: list[str] = []
        try:
            rate = safe_float(d.get("fundingRate"))
            settled = safe_float(d.get("settFundingRate"))
            nxt_ms = safe_float(d.get("fundingTime"))
        except ConversionError as exc:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=inst, metric_group="funding",
                gap_reason=config.GAP_FIELD_MISSING,
                detail=f"unparseable numeric field: {exc}",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        if rate is None:
            out.gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=SOURCE,
                asset=asset, source_instrument=inst, metric_group="funding",
                gap_reason=config.GAP_FIELD_MISSING,
                detail="fundingRate null/missing",
                evidence=fetched.evidence(PROVENANCE)))
            continue
        clamp = is_at_clamp(rate, config.CLAMP_REFERENCES[SOURCE]["rate"])
        if clamp:
            warnings.append("funding equals observed 1e-4/8h clamp reference "
                            "(10.95% APR); saturation marker")

        # OI + mark are context: failures become warnings, never fabricated values
        oi = oi_unit = oi_usd = mark = None
        fetched_oi = request_json(
            transport=transport,
            url=f"{config.ENDPOINTS['okx_oi']}?instId={inst}&instType=SWAP",
            method="GET", body=None, stem=f"okx/oi_{asset}",
            run_id=run_id, collected_at_utc=collected_at_utc,
            source=SOURCE, assets=[asset], metric_group="context")
        out.raws.append(fetched_oi.raw)
        out.gaps.extend(fetched_oi.error_gaps)
        if fetched_oi.ok:
            d_oi = (fetched_oi.payload.get("data") or [{}])[0] \
                if isinstance(fetched_oi.payload, dict) else {}
            try:
                oi = safe_float(d_oi.get("oi"))
                oi_usd = safe_float(d_oi.get("oiUsd"))
                oi_unit = d_oi.get("oiCcy") or asset
            except ConversionError:
                warnings.append("okx open-interest fields unparseable; recorded null")
        else:
            warnings.append("okx open-interest endpoint failed; OI null")

        fetched_tk = request_json(
            transport=transport,
            url=f"{config.ENDPOINTS['okx_ticker']}?instId={inst}",
            method="GET", body=None, stem=f"okx/ticker_{asset}",
            run_id=run_id, collected_at_utc=collected_at_utc,
            source=SOURCE, assets=[asset], metric_group="context")
        out.raws.append(fetched_tk.raw)
        out.gaps.extend(fetched_tk.error_gaps)
        if fetched_tk.ok:
            d_tk = (fetched_tk.payload.get("data") or [{}])[0] \
                if isinstance(fetched_tk.payload, dict) else {}
            try:
                mark = safe_float(d_tk.get("last"))
            except ConversionError:
                warnings.append("okx ticker last unparseable; mark null")
        else:
            warnings.append("okx ticker endpoint failed; mark null")

        out.observations.append(make_observation(
            run_id=run_id, collected_at_utc=collected_at_utc,
            observation_ts_utc=collected_at_utc,
            observation_ts_basis="response_time",
            source=SOURCE, source_kind="cex", asset=asset,
            source_instrument=inst, metric_group="funding",
            metrics=funding_metrics(
                rate_native=rate, interval_hours=INTERVAL_HOURS,
                interval_assumed=INTERVAL_ASSUMED, mark_price=mark,
                oi_native=oi, oi_unit=oi_unit, oi_usd=oi_usd,
                next_funding_ts_utc=ms_to_iso_utc(nxt_ms), at_clamp=clamp),
            unit_conventions=funding_unit_conventions(),
            evidence=fetched.evidence(PROVENANCE),
            warnings=warnings))
    return out
