"""EI-STRAT-003 task 2: the pre-registered three-major coverage condition.

If fewer than three majors (BTC, ETH, SOL) have adequate CEX-leg coverage,
the OVERALL verdict must be UNRESOLVED — never PASS, never
BETWEEN_THRESHOLDS, and not FAIL either (per-asset diagnostics stay visible
in per_asset).

Pre-audit holes fixed here (both reproduced by these tests before the fix):
  * two adequately covered majors with PASS-level data fell through to
    BETWEEN_THRESHOLDS at overall level;
  * FAIL-level data on insufficient coverage produced an overall FAIL even
    though the pre-registered decision metric was not computable.

GATE_CONFIG, its hash and all thresholds are untouched; the per-major
adequacy bar is DERIVED from the pre-registered completeness floor:
ceil(min_sample_completeness x window_slots) = ceil(0.85 x 28) = 24 slots.
"""
from __future__ import annotations

import pytest

from funding_harness.stats import (VERDICT_BETWEEN, VERDICT_FAIL,
                                   VERDICT_PASS, VERDICT_UNRESOLVED,
                                   compute_report)
from tests.test_gate_window import _write_window_majors


def test_two_majors_full_window_pass_is_unresolved_not_between(tmp_path):
    base, _ = _write_window_majors(tmp_path, days=14, assets=("BTC", "ETH"))
    report = compute_report(base)
    assert report["per_asset"]["BTC"]["verdict"] == VERDICT_PASS
    assert report["per_asset"]["ETH"]["verdict"] == VERDICT_PASS
    assert report["majors_coverage"]["adequate_majors"] == ["BTC", "ETH"]
    assert report["verdict"] == VERDICT_UNRESOLVED
    assert report["verdict"] not in (VERDICT_PASS, VERDICT_BETWEEN)
    assert any("2 of 3 required" in r for r in report["verdict_reasons"])


def test_one_major_full_window_is_unresolved(tmp_path):
    base, _ = _write_window_majors(tmp_path, days=14, assets=("BTC",))
    report = compute_report(base)
    assert report["majors_coverage"]["adequate_majors"] == ["BTC"]
    assert report["verdict"] == VERDICT_UNRESOLVED
    assert report["verdict"] not in (VERDICT_PASS, VERDICT_BETWEEN, VERDICT_FAIL)


def test_fail_with_insufficient_majors_is_unresolved_not_fail(tmp_path):
    # FAIL-level funding rates on two adequately covered majors; the third
    # major is absent entirely. Overall verdict: UNRESOLVED (insufficient
    # coverage precedence), while per-asset FAIL diagnostics remain visible.
    base, _ = _write_window_majors(tmp_path, days=14, assets=("BTC", "ETH"),
                                   cex_rate=0.000095)
    report = compute_report(base)
    assert report["per_asset"]["BTC"]["verdict"] == VERDICT_FAIL
    assert report["per_asset"]["ETH"]["verdict"] == VERDICT_FAIL
    assert report["verdict"] == VERDICT_UNRESOLVED
    assert any("adequate CEX-leg coverage" in r
               for r in report["verdict_reasons"])


def test_three_majors_adequate_pass_still_passes(tmp_path):
    # guards against over-tightening: full three-major coverage with
    # pass-level data must remain PASS
    base, _ = _write_window_majors(tmp_path, days=14)
    report = compute_report(base)
    assert report["majors_coverage"]["adequate_majors"] == \
        ["BTC", "ETH", "SOL"]
    assert report["majors_coverage"]["min_complete_pair_slots_per_major"] == 24
    assert report["verdict"] == VERDICT_PASS


def test_major_at_the_adequacy_bar_counts_below_it_does_not(tmp_path):
    # bar = ceil(0.85 * 28) = 24 complete paired slots in the window.
    # SOL with exactly 24 slots -> adequate -> overall PASS is possible.
    skip_ok = {("SOL", d, h) for d, h in
               [(2, 2), (5, 14), (8, 2), (11, 14)]}
    base_a = tmp_path / "at_bar"
    _write_window_majors(base_a, days=14, per_asset_skip=skip_ok)
    report = compute_report(base_a)
    assert report["per_asset"]["SOL"]["n_slots_with_complete_pair"] == 24
    assert report["majors_coverage"]["adequate_majors"] == \
        ["BTC", "ETH", "SOL"]
    assert report["verdict"] == VERDICT_PASS

    # SOL with 23 slots -> below the bar -> per-asset UNRESOLVED and only
    # two adequate majors -> overall UNRESOLVED.
    skip_low = skip_ok | {("SOL", 13, 2)}
    base_b = tmp_path / "below_bar"
    _write_window_majors(base_b, days=14, per_asset_skip=skip_low)
    report_b = compute_report(base_b)
    assert report_b["per_asset"]["SOL"]["n_slots_with_complete_pair"] == 23
    assert report_b["per_asset"]["SOL"]["verdict"] == VERDICT_UNRESOLVED
    assert report_b["majors_coverage"]["adequate_majors"] == ["BTC", "ETH"]
    assert report_b["verdict"] == VERDICT_UNRESOLVED
