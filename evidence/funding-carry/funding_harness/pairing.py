"""Derivation of HL-vs-CEX paired net-APR estimates from one run's raw
observations. These are DERIVED analysis records (pairs.jsonl), never mixed
into observations.jsonl.

Pre-registered model (EI-STRAT-001 §2.1 scenario table, carried to §4.2 gate):
    direction        SHORT HL perp + LONG CEX perp
    gross_diff_apr   = F_HL_apr - F_CEX_apr
    net_apr_pre_reg  = gross_diff_apr - 0.002   (conservative 0.20% round trip)
    net_apr_band     = gross_diff_apr - 0.001   (optimistic 0.10% round trip;
                      context only, NOT the gate metric)
Both legs must be COMPLETE; no pair is produced from partial evidence. The
VOOI at-size spread (when the scanner reports the pair) is attached as
context: |spread| > 1% sets exceeds_vooi_1pct_warning (the repo strategy
itself skips such pairs).
"""
from __future__ import annotations

from statistics import median
from typing import Optional

from . import config


def build_pairs(observations: list[dict], run_id: str,
                collected_at_utc: str) -> list[dict]:
    hl: dict[str, dict] = {}
    cex: dict[str, dict[str, dict]] = {}
    vooi: dict[str, list[dict]] = {}

    for obs in observations:
        if not obs.get("quality", {}).get("complete"):
            continue
        asset = obs.get("asset")
        src = obs.get("source")
        mg = obs.get("metric_group")
        if src == "hyperliquid" and mg == "funding":
            hl[asset] = obs
        elif src in config.CEX_SOURCES and mg == "funding":
            cex.setdefault(asset, {})[src] = obs
        elif src == "vooi" and mg == "context":
            vooi.setdefault(asset, []).append(obs)

    pairs: list[dict] = []
    for asset, hl_obs in sorted(hl.items()):
        f_hl = hl_obs["metrics"].get("funding_rate_apr")
        if f_hl is None:
            continue
        for cex_source, cex_obs in sorted(cex.get(asset, {}).items()):
            f_cex = cex_obs["metrics"].get("funding_rate_apr")
            if f_cex is None:
                continue
            gross = f_hl - f_cex
            gate = config.GATE_CONFIG
            pair = {
                "schema_version": "1.0.0",
                "run_id": run_id,
                "collected_at_utc": collected_at_utc,
                "asset": asset,
                "short_venue": "hyperliquid",
                "long_venue": cex_source,
                "f_hl_apr": f_hl,
                "f_cex_apr": f_cex,
                "gross_diff_apr": gross,
                "net_apr_pre_registered": gross - gate["round_trip_fee_conservative"],
                "net_apr_optimistic_band": gross - gate["round_trip_fee_optimistic"],
                "primary_cex_leg": False,
                "hl_at_clamp_reference": hl_obs["metrics"].get("at_clamp_reference"),
                "interval_mismatch_hours": (
                    (hl_obs["metrics"].get("funding_interval_hours") or 0)
                    - (cex_obs["metrics"].get("funding_interval_hours") or 0)),
                "hl_observation_id": hl_obs["observation_id"],
                "cex_observation_id": cex_obs["observation_id"],
                "vooi_context": _vooi_for(vooi.get(asset, []), cex_source),
            }
            pairs.append(pair)

    # deterministic primary-leg marking (first available in pre-registered order)
    for asset in {p["asset"] for p in pairs}:
        for source in config.PRIMARY_CEX_PRIORITY:
            match = [p for p in pairs
                     if p["asset"] == asset and p["long_venue"] == source]
            if match:
                match[0]["primary_cex_leg"] = True
                break
    return pairs


def _vooi_for(vooi_rows: list[dict], cex_source: str) -> Optional[dict]:
    for row in vooi_rows:
        m = row["metrics"]
        pair_long = (m.get("long_exchange") or "").lower()
        pair_short = (m.get("short_exchange") or "").lower()
        venues = {pair_long, pair_short}
        if cex_source in venues and "hyperliquid" in venues:
            at_size = m.get("price_spread_at_size")
            return {
                "price_spread_at_size": at_size,
                "price_spread_headline": m.get("price_spread_headline"),
                "exceeds_vooi_1pct_warning": bool(
                    at_size is not None and abs(at_size) > 0.01),
                "pair_instrument": row.get("source_instrument"),
            }
    return None


def pairs_series(pairs_rows: list[dict]) -> dict:
    """Group primary pairs by asset -> sorted list of (slot12, net_apr)."""
    from .convert import iso_to_utc_slot12, iso_date
    series: dict[str, list[tuple[str, float, str]]] = {}
    for p in pairs_rows:
        if not p.get("primary_cex_leg"):
            continue
        ts = p.get("collected_at_utc")
        if not ts:
            continue
        series.setdefault(p["asset"], []).append(
            (iso_to_utc_slot12(ts), p["net_apr_pre_registered"], ts))
    for asset in series:
        series[asset].sort(key=lambda x: x[2])
    return series


def dedupe_slots(asset_series: list[tuple[str, float, str]]) -> list[tuple[str, float]]:
    """One value per 12h slot (median if a slot has several)."""
    by_slot: dict[str, list[float]] = {}
    for slot, net, _ts in asset_series:
        by_slot.setdefault(slot, []).append(net)
    return [(slot, median(vals)) for slot, vals in sorted(by_slot.items())]
