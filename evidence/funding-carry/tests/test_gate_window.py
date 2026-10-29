"""EI-STRAT-003 task 1: completeness denominator reconciliation.

The completeness denominator is ALWAYS the fixed pre-registered window
(14 days x 2 slots/day = 28 slots) — never the observed date span — so
unobserved periods can never disappear from the denominator.

Regression context: the first-sample narrative said "1/28 = 3.6%" while the
pre-audit code computed 1/2 = 50% for the same single-slot sample (its
denominator was derived from the observed date span). These tests pin the
corrected behavior end to end.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from funding_harness import config
from funding_harness.pairing import build_pairs
from funding_harness.stats import (VERDICT_PASS, VERDICT_UNRESOLVED,
                                   compute_report,
                                   preregistered_window_slots)
from funding_harness.store import write_run
from tests.test_pairing_stats import _funding_obs

WINDOW_SLOTS = preregistered_window_slots(config.GATE_CONFIG)


def _write_window_majors(tmp_path, *, days, assets=("BTC", "ETH", "SOL"),
                         hl_rate=0.0000125, cex_rate=0.00005273,
                         skip_slots=(), start_day=1, per_asset_skip=()):
    """Synthetic 2-samples/day window with per-asset slot control.

    start_day: November day the series begins (1..30).
    per_asset_skip: set of (asset, day, slot_hour) tuples to omit, so single
    assets can be made sparse without touching the others.
    """
    t0 = datetime(2026, 11, start_day, tzinfo=timezone.utc)
    made = 0
    for d in range(days):
        for slot_hour in (2, 14):
            if (d, slot_hour) in skip_slots:
                continue
            ts = (t0 + timedelta(days=d, hours=slot_hour)).strftime(
                "%Y-%m-%dT%H:%M:%SZ")
            obs = []
            for asset in assets:
                if (asset, d, slot_hour) in per_asset_skip:
                    continue
                obs.append(_funding_obs(asset, "hyperliquid", ts, hl_rate))
                obs.append(_funding_obs(asset, "bybit", ts, hl_rate, cex_rate))
            run_id = f"202611{start_day + d:02d}T{slot_hour:02d}0000Z"
            write_run(base_dir=tmp_path, run_id=run_id, started_utc=ts,
                      config_snapshot={"gate_config_sha256":
                                       config.gate_config_sha256()},
                      source_results=[], pairs=build_pairs(obs, run_id, ts))
            made += 1
    return tmp_path, made


def test_gate_config_hash_unchanged_since_preregistration():
    # pins GATE_CONFIG byte-identity across the entire EI-STRAT-003 refactor
    assert config.gate_config_sha256() == \
        "d4f346105ca30d096ba0bba0cb48079114b58ef185c504f54b4eec91435ad46c"


def test_preregistered_window_slots_is_28():
    assert WINDOW_SLOTS == 28  # 14 days x 2 slots/day, from GATE_CONFIG only


def test_single_slot_initial_sample_is_one_over_28(tmp_path):
    # regression: pre-audit code reported 0.5 (1 observed slot / span-derived
    # denominator of 2). The pre-registered denominator is the fixed 28-slot
    # window, matching the report narrative 1/28 = 3.6%.
    base, _ = _write_window_majors(tmp_path, days=1, skip_slots={(0, 14)})
    report = compute_report(base)
    a = report["per_asset"]["BTC"]
    assert a["n_slots_with_complete_pair"] == 1
    assert a["expected_slots"] == 28
    assert a["completeness_denominator_slots"] == 28
    assert a["completeness_basis"] == "fixed_preregistered_window_eistrat003"
    assert a["sample_completeness"] == pytest.approx(1 / 28, abs=1e-4)
    assert report["evaluation_window"]["slots"] == 28
    assert a["verdict"] == VERDICT_UNRESOLVED
    assert any("elapsed 1d" in r for r in a["verdict_reasons"])
    assert report["verdict"] == VERDICT_UNRESOLVED
    # overall level: no major is adequately covered yet -> majors reason
    assert any("adequate CEX-leg coverage" in r
               for r in report["verdict_reasons"])


def test_missing_middle_slots_count_against_fixed_denominator(tmp_path):
    # two fully unobserved middle days (4 slots) -> 24/28; the denominator
    # stays 28 and the unobserved period is visible in completeness
    skips = {(d, h) for d in (5, 6) for h in (2, 14)}
    base, _ = _write_window_majors(tmp_path, days=14, skip_slots=skips)
    report = compute_report(base)
    a = report["per_asset"]["BTC"]
    assert a["n_slots_with_complete_pair"] == 24
    assert a["completeness_denominator_slots"] == 28
    assert a["sample_completeness"] == pytest.approx(24 / 28, abs=1e-4)
    # 24/28 = 0.857 >= 0.85 -> the gate can still pass on pass-level rates
    assert report["verdict"] == VERDICT_PASS


def test_missing_middle_below_completeness_is_unresolved(tmp_path):
    skips = {(d, h) for d in (5, 6, 7) for h in (2, 14)}  # 6 slots missing
    base, _ = _write_window_majors(tmp_path, days=14, skip_slots=skips)
    report = compute_report(base)
    assert report["per_asset"]["BTC"]["sample_completeness"] == \
        pytest.approx(22 / 28, abs=1e-4)
    assert report["per_asset"]["BTC"]["verdict"] == VERDICT_UNRESOLVED
    assert report["verdict"] == VERDICT_UNRESOLVED


def test_missing_end_window_not_elapsed_is_unresolved(tmp_path):
    # 12 observed days: completeness 24/28 = 0.857 would pass the 85% bar,
    # but the pre-registered 14-consecutive-day window has not fully elapsed
    base, _ = _write_window_majors(tmp_path, days=12)
    report = compute_report(base)
    a = report["per_asset"]["BTC"]
    assert a["sample_completeness"] == pytest.approx(24 / 28, abs=1e-4)
    assert a["verdict"] == VERDICT_UNRESOLVED
    assert any("elapsed 12d" in r for r in a["verdict_reasons"])
    assert report["verdict"] == VERDICT_UNRESOLVED


def test_missing_beginning_penalized_by_window_start_override(tmp_path):
    # the series actually starts Nov 3 while the authorized start is Nov 1.
    # With the override, the first two days (4 slots) count against
    # completeness, and slots beyond the fixed window (Nov 16) are excluded
    # from metrics and reported separately.
    base, _ = _write_window_majors(tmp_path, days=14, start_day=3)
    without = compute_report(base)
    assert without["per_asset"]["BTC"]["sample_completeness"] == \
        pytest.approx(1.0)
    assert without["verdict"] == VERDICT_PASS

    with_override = compute_report(
        base, window_start_utc="2026-11-01T00:00:00Z")
    a = with_override["per_asset"]["BTC"]
    # window semantics: [anchor, anchor + 14 days) = Nov 1..14 inclusive
    # (anchor day counts as day 1). Data covers Nov 3..16, so Nov 3..14
    # (24 slots) are inside the window; Nov 15 + Nov 16 slots (4) fall
    # outside and are reported separately.
    assert a["n_slots_with_complete_pair"] == 24        # Nov 3..14
    assert a["slots_outside_evaluation_window"] == 4    # Nov 15 + Nov 16
    assert a["sample_completeness"] == pytest.approx(24 / 28, abs=1e-4)
    assert with_override["evaluation_window"]["window_start_override"] is True
    # 24/28 = 0.857 >= 0.85 and rates are pass-level -> still PASS, but the
    # missing beginning is visibly penalized in completeness (1.0 -> 0.857)
    assert with_override["verdict"] == VERDICT_PASS


def test_window_days_param_is_diagnostic_only(tmp_path):
    base, _ = _write_window_majors(tmp_path, days=14)
    report = compute_report(base, window_days=7)
    assert report["window_requested_days"] == 7
    assert report["evaluation_window"]["days"] == 14
    assert report["evaluation_window"]["slots"] == 28
    assert report["verdict"] == VERDICT_PASS


def test_full_14day_series_fixed_denominator_fields(tmp_path):
    base, _ = _write_window_majors(tmp_path, days=14)
    report = compute_report(base)
    a = report["per_asset"]["SOL"]
    assert a["n_slots_with_complete_pair"] == 28
    assert a["sample_completeness"] == pytest.approx(1.0)
    assert a["completeness_denominator_slots"] == 28
    assert a["window_days_elapsed"] == 14
    assert report["verdict"] == VERDICT_PASS
