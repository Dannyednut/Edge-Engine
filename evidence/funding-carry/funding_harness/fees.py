"""NON-GATE fee sensitivity sidecar (EI-STRAT-003 task 3).

This module NEVER produces a verdict and is NEVER an input to the
pre-registered gate. The gate metric (``net_apr_pre_registered``) is defined
in ``config.GATE_CONFIG`` (hash-locked) and is intentionally left untouched:

    net_apr_pre_registered = gross_diff_apr - 0.002

i.e. the pre-registered metric prices exactly ONE 4-leg taker round trip per
YEAR. That is a screening proxy: the realized annualized fee drag scales with
turnover as

    fee_drag_annualized = round_trip_fee * (365 / holding_days)

so at a 7-day holding period the realizable drag is ~10.4%/yr, at 30 days
~2.4%/yr — versus the flat 0.20% the screening proxy subtracts. Reports
should therefore describe the gate metric as a "screening proxy net APR (one
round trip per year)", NOT as realizable net APR.

Any change to the gate itself requires explicit Instructor approval BEFORE
implementation (and would change gate_config_sha256, requiring an explicit
manifest-migration decision). This sidecar only adds context.
"""
from __future__ import annotations

import copy
from typing import Optional

SIDE_CAR_LABEL = "non_gate_fee_sensitivity"
DEFAULT_HOLDING_DAYS = (1, 7, 14, 30)
DAYS_PER_YEAR = 365.0

ASSUMPTIONS = (
    "round_trip_fee is the full 4-leg taker round trip (entry+exit on both "
    "the HL and the CEX leg), taken from the pre-registered band in "
    "GATE_CONFIG (conservative 0.20%, optimistic 0.10%) — read-only; the "
    "config is not modified",
    "fees are applied to notional and are constant over the holding period",
    "one round trip per holding period (position opened once and closed once)",
    "no slippage, funding-sign-change rebalancing, borrow, margin or "
    "liquidation costs are modeled here (slippage context is observed "
    "separately as VOOI at-size spread)",
    "holding periods shown are illustrative, not a strategy recommendation",
    "this sidecar does NOT affect the pre-registered verdict in any way",
)


def fee_drag_annualized(round_trip_fee: float, holding_days: float) -> float:
    """Annualized drag of one round trip amortized over ``holding_days``.

    fee * (365 / holding_days); e.g. 0.002 over 7 days = 10.43%/yr.
    """
    if holding_days <= 0:
        raise ValueError(f"holding_days must be > 0, got {holding_days}")
    return float(round_trip_fee) * (DAYS_PER_YEAR / float(holding_days))


def realizable_net_proxy(gross_apr: float, holding_days: float,
                         round_trip_fee: float) -> float:
    """Turnover-aware net APR estimate: gross minus the amortized fee drag.

    Illustrative context only — NOT the gate metric (the gate metric is
    ``gross_diff_apr - 0.002`` regardless of holding period).
    """
    return float(gross_apr) - fee_drag_annualized(round_trip_fee, holding_days)


def sensitivity_table(holding_days=DEFAULT_HOLDING_DAYS,
                      round_trip_fee_conservative: Optional[float] = None,
                      round_trip_fee_optimistic: Optional[float] = None) -> dict:
    """Build the labeled non-gate sensitivity table.

    ``round_trip_fee_*`` default from the pre-registered GATE_CONFIG band
    (read-only use: the config object is never modified).
    """
    # local import avoids any import-cycle ambiguity and makes the read-only
    # dependency explicit
    from . import config

    fee_c = (config.GATE_CONFIG["round_trip_fee_conservative"]
             if round_trip_fee_conservative is None
             else float(round_trip_fee_conservative))
    fee_o = (config.GATE_CONFIG["round_trip_fee_optimistic"]
             if round_trip_fee_optimistic is None
             else float(round_trip_fee_optimistic))

    rows = []
    for h in holding_days:
        drag_c = fee_drag_annualized(fee_c, h)
        drag_o = fee_drag_annualized(fee_o, h)
        rows.append({
            "holding_days": h,
            "round_trips_per_year": DAYS_PER_YEAR / float(h),
            "fee_drag_annualized_conservative": drag_c,
            "fee_drag_annualized_conservative_pct": round(drag_c * 100.0, 4),
            "fee_drag_annualized_optimistic": drag_o,
            "fee_drag_annualized_optimistic_pct": round(drag_o * 100.0, 4),
            # gross funding APR needed just to break even after fees at this
            # holding period (net = 0), per fee tier
            "breakeven_gross_apr_conservative": drag_c,
            "breakeven_gross_apr_optimistic": drag_o,
        })

    return {
        "sidecar": SIDE_CAR_LABEL,
        "affects_preregistered_verdict": False,
        "gate_metric_note": (
            "the pre-registered gate metric net_apr_pre_registered = "
            "gross_diff_apr - 0.002 prices exactly ONE round trip per year; "
            "it is a screening proxy, not realizable net APR. Realizable "
            "annualized fee drag = round_trip_fee x (365 / holding_days)."),
        "round_trip_fee_conservative": fee_c,
        "round_trip_fee_optimistic": fee_o,
        "assumptions": list(ASSUMPTIONS),
        "rows": rows,
    }


def apply_to_gate_report(report: dict,
                         holding_days=DEFAULT_HOLDING_DAYS) -> dict:
    """Attach turnover-aware context for each asset's measured median.

    ``report`` is a stats gate report (or any dict with
    per_asset.<asset>.median_net_apr_pre_registered). The gross median is
    reconstructed exactly (gross = net + round_trip_fee_conservative, the
    inverse of the pre-registered subtraction) and the realizable proxy is
    shown at each holding period. The input report is deep-copied and never
    mutated.
    """
    table = sensitivity_table(holding_days)
    per_asset_ctx = {}
    for asset, a in (report.get("per_asset") or {}).items():
        net = a.get("median_net_apr_pre_registered")
        if net is None:
            per_asset_ctx[asset] = {"median_net_apr_pre_registered": None,
                                    "note": "no measurable median in window"}
            continue
        gross = net + table["round_trip_fee_conservative"]
        per_asset_ctx[asset] = {
            "median_net_apr_pre_registered": net,
            "reconstructed_gross_diff_apr": gross,
            "realizable_net_proxy_by_holding_days": {
                str(h): realizable_net_proxy(
                    gross, h, table["round_trip_fee_conservative"])
                for h in holding_days
            },
            "note": ("context only; the pre-registered verdict uses "
                     "net_apr_pre_registered unchanged"),
        }
    out = copy.deepcopy(table)
    out["applied_to_report"] = {
        "generated_at_utc": report.get("generated_at_utc"),
        "gate_config_sha256": report.get("gate_config_sha256"),
        "per_asset": per_asset_ctx,
    }
    return out
