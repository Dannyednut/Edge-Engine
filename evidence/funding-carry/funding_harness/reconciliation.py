"""Offline reconciliation of scanner funding alerts against harness
observations — E-12 (Issue #17) item 3: evidence measurement, not a new
harness.

This module REUSES the canonical observation schema (``models``), the
unit conversions (``convert``) and the NON-GATE fee sensitivity sidecar
(``fees``). It adds only the piece that was missing: an offline,
fixture-backed path that reconciles the funding scanners' alert rows
(``funding_divergence`` / ``perp_funding`` shapes, snake_case or
camelCase) against per-venue raw observations, preserving per row:

  - the per-venue RAW rate units and the funding interval (hours) with
    its explicit ``interval_assumed`` flag,
  - the observation-time basis (``observation_ts_basis``) and the
    observation timestamp,
  - BOTH leg rates (alert figures re-derived from raw rates under the
    recorded interval),
  - the fee assumptions, attached READ-ONLY as the labeled non-gate
    sensitivity table across plausible holding periods (never the
    one-time 0.20% gate deduction presented as realizable annualized
    drag), and
  - EXPLICIT missingness (any leg without a complete corroborating
    observation is a recorded gap, never an invented value).

Candidate classification (E-12 acceptance):
  DATA-CORRECTNESS  raw rates corroborate the alert figures AND the
                    alert declares a verified net-APR basis whose value
                    is carried verbatim (Sharpe ``netApr`` field) — the
                    unit/labeling defect class is closed for it
  GROSS-INDICATIVE  raw rates corroborate the alert, but net economics
                    are unavailable (no fee/holding/basis model): the
                    profit figure is gross/indicative ONLY
  NET-VERIFIED      RESERVED — requires evidence backing BOTH venue
                    costs AND funding-interval semantics (an explicit
                    ``net_cost_evidence`` block on the alert). Nothing
                    in this repository provides that today, so this
                    module can never award it from scanner output alone
  BLOCKED           evidence missing/mismatched/malformed: the alert
                    cannot be reconciled (gap recorded with reason)

NO collection, NO transport, NO network: inputs are plain in-memory
rows. ``GATE_CONFIG`` is never modified; the fee sidecar reads it
read-only, exactly as ``fees.py`` already does.
"""
from __future__ import annotations

import math
from typing import Any, Optional

from . import fees
from .convert import funding_apr

# Relative tolerance when re-deriving an alert's annualized leg figure
# from the raw rate under the recorded interval (floating-point headroom).
RATE_TOLERANCE = 1e-6

# E-12 candidate classification (acceptance criterion of Issue #17).
CLS_DATA_CORRECTNESS = "DATA-CORRECTNESS"
CLS_GROSS_INDICATIVE = "GROSS-INDICATIVE"
CLS_NET_VERIFIED = "NET-VERIFIED"
CLS_BLOCKED = "BLOCKED"


def _f(alert: dict, *names: str) -> Any:
    """Fetch the first present key among snake_case/camelCase aliases."""
    for n in names:
        if n in alert:
            return alert[n]
    return None


def _venue_key(venue: Any) -> str:
    return str(venue or "").strip().lower()


def _funding_obs_index(observations: list[dict]) -> dict:
    """(asset, source) → complete funding observation (first wins)."""
    idx: dict[tuple[str, str], dict] = {}
    for obs in observations or []:
        if obs.get("metric_group") != "funding":
            continue
        if not obs.get("quality", {}).get("complete"):
            continue
        key = (str(obs.get("asset", "")).upper(), _venue_key(obs.get("source")))
        idx.setdefault(key, obs)
    return idx


def _reconcile_leg(venue: Any, asset: str, expected_apr_pct: Optional[float],
                   obs_index: dict, tol: float) -> dict:
    """Reconcile ONE alert leg against a complete funding observation.

    Returns a per-leg record preserving the raw units/interval/basis and
    an explicit ``ok``/``gap_reason`` — never a fabricated value.
    """
    rec: dict[str, Any] = {
        "venue": venue,
        "ok": False,
        "gap_reason": None,
        "observation": None,
    }
    obs = obs_index.get((str(asset).upper(), _venue_key(venue)))
    if obs is None:
        rec["gap_reason"] = "missing_observation"
        return rec

    m = obs["metrics"]
    rate_native = m.get("funding_rate_native")
    interval = m.get("funding_interval_hours")
    if rate_native is None or interval is None:
        # validate_observation forbids complete rows like this; defensive.
        rec["gap_reason"] = "incomplete_observation_metrics"
        return rec

    apr = funding_apr(rate_native, interval)
    if apr is None:
        rec["gap_reason"] = "unannualizable_rate"
        return rec
    apr_pct = apr * 100.0

    rec["observation"] = {
        # preserve per-venue RAW units and interval, and the time basis
        "source": obs.get("source"),
        "asset": obs.get("asset"),
        "funding_rate_native": rate_native,
        "funding_interval_hours": interval,
        "funding_interval_assumed": bool(m.get("funding_interval_assumed")),
        "funding_rate_apr_pct": m.get("funding_rate_apr_pct"),
        "rederived_apr_pct": apr_pct,
        "observation_ts_utc": obs.get("observation_ts_utc"),
        "observation_ts_basis": obs.get("observation_ts_basis"),
    }

    if expected_apr_pct is None:
        # The alert does not publish a per-leg figure — the raw rate still
        # corroborates the pair; nothing to compare, nothing invented.
        rec["ok"] = True
        rec["note"] = "alert_carries_no_leg_figure"
        return rec

    if not isinstance(expected_apr_pct, (int, float)) or not math.isfinite(expected_apr_pct):
        rec["gap_reason"] = "malformed_alert_leg_figure"
        return rec

    denom = max(abs(apr_pct), abs(expected_apr_pct), 1e-12)
    if abs(apr_pct - expected_apr_pct) / denom > tol:
        rec["gap_reason"] = "leg_rate_mismatch"
        rec["expected_apr_pct"] = expected_apr_pct
        return rec

    rec["ok"] = True
    return rec


def reconcile_alert(alert: dict, observations: list[dict],
                    tol: float = RATE_TOLERANCE) -> dict:
    """Reconcile ONE scanner alert against canonical observations.

    The returned record is a DERIVED analysis object (like
    ``pairing.build_pairs`` output): it is never a substitute for raw
    observations and never mutates its inputs.
    """
    asset = _f(alert, "asset")
    long_venue = _f(alert, "long_venue", "longVenue")
    short_venue = _f(alert, "short_venue", "shortVenue")
    divergence = _f(alert, "divergence")
    spread_apr = _f(alert, "spread_apr", "spreadApr")
    net_apr = _f(alert, "net_apr", "netApr")
    net_basis = _f(alert, "net_apr_basis", "netAprBasis")
    interval_assumption = _f(alert, "funding_interval_assumption",
                             "fundingIntervalAssumption")
    daily_gross = _f(alert, "daily_gross_indicative_on5k",
                     "dailyGrossIndicativeOn5k")
    daily_gross_alias = _f(alert, "daily_profit_on5k", "dailyProfitOn5k")

    record: dict[str, Any] = {
        "kind": "alert_reconciliation",
        "asset": asset,
        "long_venue": long_venue,
        "short_venue": short_venue,
        "classification": None,
        "gap_reasons": [],
        "legs": {},
        "alert_figure_units": {
            # E-12: state the units honestly, including which figures are
            # gross/indicative and which annualization basis they carry.
            "divergence": "%/yr (pct-points, gross-indicative, 1h-assumed)",
            "spread_apr": "decimal-fraction APR (gross unless basis says net)",
            "daily_gross_indicative_on5k": "USD/day on $5k, gross-indicative",
            "deprecated_daily_profit_on5k_is_gross": daily_gross_alias == daily_gross
            if (daily_gross is not None and daily_gross_alias is not None)
            else None,
        },
        "interval_assumption": interval_assumption or "unspecified",
        # Labeled non-gate context, read-only (see fees.py):
        "fee_sensitivity_sidecar": fees.sensitivity_table(),
    }

    malformed = False
    for v in (divergence, spread_apr):
        if v is not None and (not isinstance(v, (int, float)) or not math.isfinite(v)):
            malformed = True
    if malformed:
        record["classification"] = CLS_BLOCKED
        record["gap_reasons"].append("malformed_alert_figures")
        return record

    # Long-leg annualized figure: prefer the explicit leg fields when the
    # alert carries them (perp_funding decimal APRs → convert to pct);
    # otherwise the divergence's gross split is not per-leg and no leg
    # figure is compared (raw corroboration only).
    long_apr_pct = _f(alert, "long_funding_apr_pct")
    short_apr_pct = _f(alert, "short_funding_apr_pct")
    if long_apr_pct is None:
        lf = _f(alert, "long_funding_apr", "longFundingApr")
        long_apr_pct = lf * 100.0 if isinstance(lf, (int, float)) else None
    if short_apr_pct is None:
        sf = _f(alert, "short_funding_apr", "shortFundingApr")
        short_apr_pct = sf * 100.0 if isinstance(sf, (int, float)) else None

    obs_index = _funding_obs_index(observations)
    long_leg = _reconcile_leg(long_venue, asset, long_apr_pct, obs_index, tol)
    short_leg = _reconcile_leg(short_venue, asset, short_apr_pct, obs_index, tol)
    record["legs"] = {"long": long_leg, "short": short_leg}
    for leg in (long_leg, short_leg):
        if not leg["ok"] and leg["gap_reason"]:
            record["gap_reasons"].append(leg["gap_reason"])

    if record["gap_reasons"]:
        record["classification"] = CLS_BLOCKED
        return record

    # Evidence corroborates both legs. Classify the ECONOMICS honestly:
    # NET-VERIFIED requires explicit net-cost evidence (both venue costs
    # AND interval semantics) — scanner output never carries that block,
    # so it stays unreachable from this path by construction.
    has_net_cost_evidence = isinstance(
        _f(alert, "net_cost_evidence"), dict) and bool(_f(alert, "net_cost_evidence"))
    verified_net = (isinstance(net_apr, (int, float)) and math.isfinite(net_apr)
                    and net_basis in ("sharpe-net", "sharpe_net"))
    if has_net_cost_evidence:
        # Reserved branch — requires evidence this repo does not yet have.
        record["classification"] = CLS_NET_VERIFIED
    elif verified_net:
        # A third-party net figure carried verbatim with its basis named:
        # the DATA-CORRECTNESS class (unit/labeling defects closed; the
        # net value remains a provider claim, labeled as such).
        record["classification"] = CLS_DATA_CORRECTNESS
    else:
        record["classification"] = CLS_GROSS_INDICATIVE
    return record


def reconcile_alerts(alerts: list[dict], observations: list[dict],
                     tol: float = RATE_TOLERANCE) -> dict:
    """Reconcile a batch of alerts; returns the batch report with counts."""
    records = [reconcile_alert(a, observations, tol) for a in (alerts or [])]
    counts = {
        CLS_DATA_CORRECTNESS: 0,
        CLS_GROSS_INDICATIVE: 0,
        CLS_NET_VERIFIED: 0,
        CLS_BLOCKED: 0,
    }
    for r in records:
        counts[r["classification"]] += 1
    return {
        "kind": "alert_reconciliation_report",
        "offline": True,
        "network_calls": 0,
        "affects_preregistered_verdict": False,
        "candidates": records,
        "classification_counts": counts,
        "coverage_statement": (
            "every candidate is classified DATA-CORRECTNESS, "
            "GROSS-INDICATIVE, NET-VERIFIED (reserved; requires venue-cost "
            "AND interval evidence) or BLOCKED; missingness is explicit "
            "and values are never fabricated"
        ),
    }


def classify_candidates() -> list[dict]:
    """E-12 acceptance: classify each candidate strategy honestly.

    This is the EM's evidence-status statement for Issue #17 — the
    classifications follow the corrected source at this head:
      - perp_funding: the unit/labeling defects (gross-as-net fallback,
        100× unit mismatch) are FIXED → DATA-CORRECTNESS; net economics
        remain provider-claimed (Sharpe) and never locally verified.
      - funding_divergence: figures are now honestly labeled
        gross/indicative with net unavailable → GROSS-INDICATIVE.
      - cross_dex_arb: stays monitoring-only (coverage/execution/latency
        design gate unsatisfied) → BLOCKED.
      - equity_perp_cross_venue: dex_scopes absent; scanner fails closed;
        no HIP-3 census authorized → BLOCKED.
    None is NET-VERIFIED; all live approvals remain 0.
    """
    return [
        {
            "candidate": "perp_funding",
            "classification": CLS_DATA_CORRECTNESS,
            "reason": (
                "E-12 fixed the gross-as-net fallback and the 100× VOOI unit "
                "mismatch; netApr is carried only from the verified Sharpe "
                "field with basis labeled; VOOI-only rows are gross-indicative "
                "with an explicit 1h-assumed basis"
            ),
        },
        {
            "candidate": "funding_divergence",
            "classification": CLS_GROSS_INDICATIVE,
            "reason": (
                "figures labeled gross/indicative (dailyGrossIndicativeOn5k; "
                "deprecated alias documented as gross); net economics "
                "unavailable until both legs' fees, interval, holding/"
                "persistence and basis assumptions are represented"
            ),
        },
        {
            "candidate": "cross_dex_arb",
            "classification": CLS_BLOCKED,
            "reason": (
                "monitoring-only: scanner hardcodes hyperevm + three DEXes; "
                "multi-chain coverage, genuine execution quote/depth source "
                "and latency budget are unsatisfied design gates"
            ),
        },
        {
            "candidate": "equity_perp_cross_venue",
            "classification": CLS_BLOCKED,
            "reason": (
                "dex_scopes absent; scanner correctly fails closed; no HIP-3 "
                "deployer census or scope configuration without explicit "
                "Principal authorization"
            ),
        },
    ]
