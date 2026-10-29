"""E-12 (Issue #17) item 3: offline reconciliation of scanner alerts.

All inputs are in-memory fixtures built with the canonical observation
helpers — NO transport, NO network, NO collection. GATE_CONFIG is never
modified (the fee sidecar reads it read-only, per fees.py design).
"""
from __future__ import annotations

import math

import pytest

from funding_harness import config, reconciliation
from funding_harness.models import (funding_metrics, funding_unit_conventions,
                                    make_observation)


# ------------------------------------------------------------------ fixtures

def _funding_obs(asset, source, rate_native, interval_hours, interval_assumed,
                 collected_at="2026-10-29T00:00:00Z"):
    return make_observation(
        run_id="e12", collected_at_utc=collected_at,
        observation_ts_utc=collected_at,
        observation_ts_basis="response_time", source=source,
        source_kind="dex_perp" if source == "hyperliquid" else "cex",
        asset=asset, source_instrument=asset, metric_group="funding",
        metrics=funding_metrics(rate_native=rate_native,
                                interval_hours=interval_hours,
                                interval_assumed=interval_assumed),
        unit_conventions=funding_unit_conventions(),
        evidence={"endpoint": "x", "http_status": 200, "payload_sha256": "h",
                  "provenance": "test", "raw_ref": "r", "raw_bounded": False})


def _alert(**overrides):
    """A funding_divergence-shaped alert (camelCase, as the scanner emits)."""
    alert = {
        "asset": "BTC",
        "longVenue": "hyperliquid",
        "shortVenue": "binance",
        "longFunding": 10.95,          # %/yr gross (0.0000125/h × 8760 × 100)
        "shortFunding": 43.8,          # %/yr gross (0.00005/h × 8760 × 100)
        "divergence": 32.85,           # pct-points/yr gross
        "dailyGrossIndicativeOn5k": 5000 * 32.85 / 100 / 365,
        "dailyProfitOn5k": 5000 * 32.85 / 100 / 365,  # deprecated alias
        "netEconomics": "unavailable",
        "fundingIntervalAssumption": "1h-assumed",
        "type": "DIVERGENCE",
        "direction": "DIVERGENCE",
        "oi": None,
        "scanTs": 1700000000000,
        "venueTs": None,
    }
    alert.update(overrides)
    return alert


def _corroborating_observations():
    # HL: 0.0000125/h (1h, NOT assumed) → 10.95%/yr ; Binance: 0.00005/h
    # (1h assumed — venue interval unpublished) → 43.8%/yr.
    return [
        _funding_obs("BTC", "hyperliquid", 0.0000125, 1, False),
        _funding_obs("BTC", "binance", 0.00005, 1, True),
    ]


# ------------------------------------------------------------------- tests

def test_corroborated_alert_is_gross_indicative_with_raw_units_preserved():
    report = reconciliation.reconcile_alerts([_alert()],
                                             _corroborating_observations())
    rec = report["candidates"][0]
    assert rec["classification"] == reconciliation.CLS_GROSS_INDICATIVE
    assert rec["gap_reasons"] == []
    long_obs = rec["legs"]["long"]["observation"]
    short_obs = rec["legs"]["short"]["observation"]
    # Per-venue RAW units, interval and its assumed flag are preserved…
    assert long_obs["funding_rate_native"] == 0.0000125
    assert long_obs["funding_interval_hours"] == 1
    assert long_obs["funding_interval_assumed"] is False
    assert short_obs["funding_rate_native"] == 0.00005
    assert short_obs["funding_interval_assumed"] is True
    # …as is the observation-time basis.
    assert long_obs["observation_ts_basis"] == "response_time"
    assert long_obs["observation_ts_utc"] == "2026-10-29T00:00:00Z"
    # Alert leg figures re-derive from the raw rates under the same interval.
    assert long_obs["rederived_apr_pct"] == pytest.approx(10.95)
    assert short_obs["rederived_apr_pct"] == pytest.approx(43.8)


def test_deprecated_alias_must_match_the_gross_named_field():
    a = _alert()
    assert a["dailyProfitOn5k"] == a["dailyGrossIndicativeOn5k"]
    report = reconciliation.reconcile_alerts([a], _corroborating_observations())
    rec = report["candidates"][0]
    assert rec["alert_figure_units"]["deprecated_daily_profit_on5k_is_gross"] is True
    # A mismatch between the alias and the gross field is a BLOCKER.
    bad = _alert(dailyProfitOn5k=999.0)
    rec_bad = reconciliation.reconcile_alerts([bad],
                                              _corroborating_observations())["candidates"][0]
    assert rec_bad["alert_figure_units"]["deprecated_daily_profit_on5k_is_gross"] is False


def test_leg_rate_mismatch_is_blocked_with_explicit_reason():
    # Alert claims 20%/yr for the HL leg but the raw rate annualizes to 10.95%.
    a = _alert(longFundingApr=0.20)  # decimal APR ×100 = 20 pct-points
    rec = reconciliation.reconcile_alerts([a],
                                          _corroborating_observations())["candidates"][0]
    assert rec["classification"] == reconciliation.CLS_BLOCKED
    assert "leg_rate_mismatch" in rec["gap_reasons"]


def test_missing_observation_for_one_venue_is_blocked_and_recorded():
    obs = [_funding_obs("BTC", "hyperliquid", 0.0000125, 1, False)]  # no binance row
    rec = reconciliation.reconcile_alerts([_alert()], obs)["candidates"][0]
    assert rec["classification"] == reconciliation.CLS_BLOCKED
    assert rec["legs"]["long"]["ok"] is True
    assert rec["legs"]["short"]["gap_reason"] == "missing_observation"


def test_malformed_alert_figures_are_blocked_never_reconciled():
    for bad in ({"divergence": float("nan")}, {"divergence": float("inf")},
                {"divergence": "30%"}, {"spreadApr": float("nan")}):
        rec = reconciliation.reconcile_alerts([_alert(**bad)],
                                              _corroborating_observations())["candidates"][0]
        assert rec["classification"] == reconciliation.CLS_BLOCKED, bad
        # No fabricated economics: a blocked record must not classify any
        # net-verdict — the malformed figure never reaches the legs' math.
        assert rec["classification"] != reconciliation.CLS_NET_VERIFIED


def test_net_verified_is_unreachable_without_net_cost_evidence():
    # A verified-basis net figure (Sharpe-sourced) alone must NOT award
    # NET-VERIFIED — venue costs AND interval semantics are required.
    a = _alert(netApr=0.12, netAprBasis="sharpe-net")
    rec = reconciliation.reconcile_alerts([a],
                                          _corroborating_observations())["candidates"][0]
    assert rec["classification"] == reconciliation.CLS_DATA_CORRECTNESS

    # Forging a net_cost_evidence block flips to the reserved class — this
    # proves the gate exists, and equally that scanner output (which never
    # carries such a block) can never reach NET-VERIFIED by accident.
    b = _alert(netApr=0.12, netAprBasis="sharpe-net",
               net_cost_evidence={"venue_costs": "verified", "interval": "verified"})
    rec_b = reconciliation.reconcile_alerts([b],
                                            _corroborating_observations())["candidates"][0]
    assert rec_b["classification"] == reconciliation.CLS_NET_VERIFIED


def test_fee_sensitivity_sidecar_attached_read_only_and_labeled():
    rec = reconciliation.reconcile_alerts([_alert()],
                                          _corroborating_observations())["candidates"][0]
    sidecar = rec["fee_sensitivity_sidecar"]
    assert sidecar["sidecar"] == "non_gate_fee_sensitivity"
    assert sidecar["affects_preregistered_verdict"] is False
    # Sensitivity across plausible holding periods — the one-time 0.20%
    # gate deduction must NOT appear as a flat annualized drag here.
    holding_days = [row["holding_days"] for row in sidecar["rows"]]
    assert holding_days == [1, 7, 14, 30]
    drags = [row["fee_drag_annualized_conservative"] for row in sidecar["rows"]]
    assert drags[0] > drags[-1]  # turnover-scaled, decreasing with holding period
    # GATE_CONFIG untouched (read-only use).
    assert config.GATE_CONFIG["round_trip_fee_conservative"] == 0.002


def test_batch_report_counts_and_offline_markers():
    alerts = [
        _alert(),                                            # GROSS-INDICATIVE
        _alert(asset="MISSING"),                             # BLOCKED (no obs)
        _alert(netApr=0.12, netAprBasis="sharpe-net"),       # DATA-CORRECTNESS
    ]
    report = reconciliation.reconcile_alerts(alerts, _corroborating_observations())
    assert report["offline"] is True
    assert report["network_calls"] == 0
    assert report["affects_preregistered_verdict"] is False
    assert report["classification_counts"] == {
        reconciliation.CLS_DATA_CORRECTNESS: 1,
        reconciliation.CLS_GROSS_INDICATIVE: 1,
        reconciliation.CLS_NET_VERIFIED: 0,
        reconciliation.CLS_BLOCKED: 1,
    }
    assert "never" in report["coverage_statement"]


def test_e12_candidate_classification_statement():
    rows = reconciliation.classify_candidates()
    by_name = {r["candidate"]: r["classification"] for r in rows}
    assert by_name["perp_funding"] == reconciliation.CLS_DATA_CORRECTNESS
    assert by_name["funding_divergence"] == reconciliation.CLS_GROSS_INDICATIVE
    assert by_name["cross_dex_arb"] == reconciliation.CLS_BLOCKED
    assert by_name["equity_perp_cross_venue"] == reconciliation.CLS_BLOCKED
    # None may be NET-VERIFIED until evidence backs venue costs + intervals.
    assert reconciliation.CLS_NET_VERIFIED not in by_name.values()
