"""Sharpe.ai public no-auth mirror as a THIRD-PARTY REFERENCE (never ground
truth — EI-STRAT-001 flagged Sharpe netApr provenance as uncited/no-go as a
primary source; here it is recorded side-by-side with direct venue measurement
so the gate series can be compared against Sharpe's claim).

Endpoints (packages/sharpe-client/src/index.ts [V]):
  GET /api/funding/rates?coin={ASSET}   -> per-venue rows, interval_hours explicit
  GET /api/arbitrage/cross-exchange     -> pair rows incl. netApr (fraction APR)

Row fields observed 2026-10-20: exchange, base_coin, rate, interval_hours,
updated_at, mark_price, instrument_status / symbol, longExchange, shortExchange,
longRate, shortRate, netApr, grossApr, intervalHours, oiLong, oiShort.
"""
from __future__ import annotations

from .. import config
from ..convert import ConversionError, is_at_clamp, safe_float
from ..models import (funding_unit_conventions, make_gap, make_observation,
                      reference_metrics)
from .base import SourceResult, normalize_sharpe_ts, register, request_json

SOURCE = "sharpe"
PROVENANCE = ("sharpe.ai public no-auth mirror (third-party reference; "
              "aggregated/derived values, provenance not decomposable)")
CLAMP_BY_INTERVAL = {1: 0.0000125, 8: 0.0001}   # observed reference points only


def _parse_rows_array(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("rows"), list):
            return data["rows"]
    return None


@register(SOURCE)
def fetch(assets, transport, run_id: str, collected_at_utc: str) -> SourceResult:
    out = SourceResult(source=SOURCE)
    for asset in assets:
        # --- per-venue funding reference -----------------------------------
        fetched = request_json(
            transport=transport,
            url=f"{config.ENDPOINTS['sharpe_funding']}?coin={asset}",
            method="GET", body=None, stem=f"sharpe/funding_rates_{asset}",
            run_id=run_id, collected_at_utc=collected_at_utc,
            source=SOURCE, assets=[asset], metric_group="funding_reference")
        out.raws.append(fetched.raw)
        out.gaps.extend(fetched.error_gaps)
        if fetched.ok:
            rows = _parse_rows_array(fetched.payload)
            if rows is None:
                out.gaps.append(make_gap(
                    run_id=run_id, collected_at_utc=collected_at_utc,
                    source=SOURCE, asset=asset, source_instrument=asset,
                    metric_group="funding_reference",
                    gap_reason=config.GAP_MALFORMED,
                    detail="expected array/data.rows payload",
                    evidence=fetched.evidence(PROVENANCE)))
            else:
                emitted = 0
                for r in rows:
                    if not isinstance(r, dict):
                        continue
                    if str(r.get("base_coin", "")).upper() != asset:
                        continue
                    if r.get("instrument_status") not in (None, "trading"):
                        continue
                    exchange = r.get("exchange")
                    try:
                        rate = safe_float(r.get("rate"))
                        interval = safe_float(r.get("interval_hours"))
                        mark = safe_float(r.get("mark_price"))
                        oi = safe_float(r.get("open_interest"))
                    except ConversionError:
                        continue
                    if rate is None or interval is None or not exchange:
                        continue
                    warnings = []
                    if r.get("exchange") and "liquid" in str(exchange).lower():
                        warnings.append("sharpe mirror row for Hyperliquid; "
                                        "cross-check against direct HL measurement")
                    clamp = is_at_clamp(rate, CLAMP_BY_INTERVAL.get(int(interval)))
                    if clamp:
                        warnings.append("rate equals observed clamp reference; "
                                        "saturation marker")
                    ts = normalize_sharpe_ts(r.get("updated_at")) or collected_at_utc
                    out.observations.append(make_observation(
                        run_id=run_id, collected_at_utc=collected_at_utc,
                        observation_ts_utc=ts,
                        observation_ts_basis="source_updated_at",
                        source=SOURCE, source_kind="reference", asset=asset,
                        source_instrument=f"{exchange}:{r.get('symbol', asset)}",
                        metric_group="funding_reference",
                        metrics=reference_metrics(
                            rate_native=rate, interval_hours=interval,
                            net_apr=None, mark_price=mark, oi_usd=oi),
                        unit_conventions=funding_unit_conventions(
                            native_basis="decimal_fraction_per_stated_interval"),
                        evidence=fetched.evidence(PROVENANCE),
                        warnings=warnings))
                    emitted += 1
                if emitted == 0:
                    out.gaps.append(make_gap(
                        run_id=run_id, collected_at_utc=collected_at_utc,
                        source=SOURCE, asset=asset, source_instrument=asset,
                        metric_group="funding_reference",
                        gap_reason=config.GAP_ASSET_MISSING,
                        detail=f"no usable rows for {asset} in "
                               f"{len(rows)}-row response",
                        evidence=fetched.evidence(PROVENANCE)))

    # --- cross-exchange pair reference (HL-involving majors) ---------------
    fetched = request_json(
        transport=transport, url=config.ENDPOINTS["sharpe_cross_exchange"],
        method="GET", body=None, stem="sharpe/cross_exchange",
        run_id=run_id, collected_at_utc=collected_at_utc,
        source=SOURCE, assets=assets, metric_group="cross_exchange_reference")
    out.raws.append(fetched.raw)
    out.gaps.extend(fetched.error_gaps)
    if fetched.ok:
        rows = _parse_rows_array(fetched.payload)
        if rows is None:
            for a in assets:
                out.gaps.append(make_gap(
                    run_id=run_id, collected_at_utc=collected_at_utc,
                    source=SOURCE, asset=a, source_instrument=a,
                    metric_group="cross_exchange_reference",
                    gap_reason=config.GAP_MALFORMED,
                    detail="expected array/data.rows payload",
                    evidence=fetched.evidence(PROVENANCE)))
        else:
            majors = {a.upper() for a in assets}
            emitted = {a: 0 for a in assets}
            for r in rows:
                if not isinstance(r, dict):
                    continue
                sym = str(r.get("symbol", "")).upper()
                if sym not in majors:
                    continue
                long_x = r.get("longExchange") or ""
                short_x = r.get("shortExchange") or ""
                if "hyperliquid" not in (long_x + short_x).lower():
                    continue
                try:
                    net_apr = safe_float(r.get("netApr"))
                    gross = safe_float(r.get("grossApr"))
                    long_rate = safe_float(r.get("longRate"))
                    short_rate = safe_float(r.get("shortRate"))
                    interval = safe_float(r.get("intervalHours"))
                    oi_long = safe_float(r.get("oiLong"))
                    oi_short = safe_float(r.get("oiShort"))
                except ConversionError:
                    continue
                out.observations.append(make_observation(
                    run_id=run_id, collected_at_utc=collected_at_utc,
                    observation_ts_utc=collected_at_utc,
                    observation_ts_basis="response_time",
                    source=SOURCE, source_kind="reference", asset=sym,
                    source_instrument=f"{long_x}->{short_x}",
                    metric_group="cross_exchange_reference",
                    metrics=reference_metrics(
                        rate_native=None, interval_hours=interval,
                        net_apr=net_apr, oi_usd=oi_short,
                        extra={
                            "sharpe_gross_apr_reference": gross,
                            "sharpe_long_rate": long_rate,
                            "sharpe_short_rate": short_rate,
                            "sharpe_long_exchange": long_x,
                            "sharpe_short_exchange": short_x,
                            "sharpe_oi_long_usd": oi_long,
                            "sharpe_spread_source": r.get("spreadSource"),
                        }),
                    unit_conventions=funding_unit_conventions(
                        native_basis="sharpe pair row; netApr is a fraction APR"),
                    evidence=fetched.evidence(PROVENANCE),
                    warnings=[
                        "third-party pair reference; compare against direct "
                        "HL-vs-CEX measurement, never substitute for it",
                    ]))
                emitted[sym] += 1
            for a in assets:
                if emitted[a] == 0:
                    out.gaps.append(make_gap(
                        run_id=run_id, collected_at_utc=collected_at_utc,
                        source=SOURCE, asset=a, source_instrument=a,
                        metric_group="cross_exchange_reference",
                        gap_reason=config.GAP_ASSET_MISSING,
                        detail=f"no HL-involving pair rows for {a} in "
                               f"{len(rows)}-row response",
                        evidence=fetched.evidence(PROVENANCE)))
    return out
