"""EI-STRAT-004 task 1: the authorized-start boundary is an EXACT timestamp.

Regression context: the pre-audit stats truncated --window-start to a UTC
DATE and filtered 12h slots by date prefix, so a pre-authorization pilot
sample collected on the same UTC date as the authorized series start (even
in the same 12h slot — the real pilot was recorded 2026-10-20T04:56:54Z)
could contribute to the authorized series via slot aggregation/median
dedupe. The fix filters each pair's ACTUAL collected_at_utc against the
authorized boundary BEFORE slot aggregation/deduplication.

EI-STRAT-005 supersedes the mid-slot-cutoff capability: authorized window
boundaries must be SLOT-ALIGNED (exactly 00:00:00Z or 12:00:00Z), so the
EI-STRAT-004 scenario of an 08:00Z exact cutoff INSIDE the pilot's slot is
no longer expressible — a non-aligned --window-start is refused
(WindowAnchorError, CLI exit 4; refusal semantics live in
tests/test_window_semantics.py). The pilot-exclusion guarantee itself is
strengthened: for an aligned anchor there is no partial slot — either the
whole slot is authorized or it is entirely pre-anchor — and the exact
timestamp filter still excludes every row strictly before the anchor.

The pre-registered gate, its hash and the fixed 28-slot denominator are
unchanged; the pilot run itself is never deleted or rewritten — excluded
rows are counted and disclosed in the report instead.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from funding_harness import config
from funding_harness.pairing import build_pairs
from funding_harness.stats import (VERDICT_UNRESOLVED, compute_report)
from funding_harness.store import write_run
from tests.test_pairing_stats import _funding_obs

# The pilot and allowed observations share their UTC date AND their T00Z
# 12h slot (mirrors the real 2026-10-20 pilot-vs-authorized-start hazard):
# pilot 03:00Z and allowed 09:00Z both floor to slot 2026-11-05T00Z.
# Under EI-STRAT-005 the only expressible authorized anchors for this date
# are the slot boundaries 00:00:00Z and 12:00:00Z (see the tests below).
PILOT_TS = "2026-11-05T03:00:00Z"
ALLOWED_TS = "2026-11-05T09:00:00Z"

# Distinct per-observation net APRs: HL pinned at 10.95% APR in both legs;
# pilot CEX leg ~0.11% APR -> net ~+10.64%; allowed CEX leg 5.774% APR ->
# net ~+4.976% (the standard pass-level fixture value).
PILOT_NET = 0.1095 - 0.000001 * 3 * 365 - 0.002
ALLOWED_NET = 0.1095 - 0.00005273 * 3 * 365 - 0.002


def _write_run(base, run_id, ts, hl_rate, cex_rate, assets=("BTC",)):
    obs = []
    for asset in assets:
        obs.append(_funding_obs(asset, "hyperliquid", ts, hl_rate))
        obs.append(_funding_obs(asset, "bybit", ts, hl_rate, cex_rate))
    write_run(base_dir=base, run_id=run_id, started_utc=ts,
              config_snapshot={"gate_config_sha256":
                               config.gate_config_sha256()},
              source_results=[], pairs=build_pairs(obs, run_id, ts))


def _fixture_same_slot(base):
    """Pilot (pre-start) + allowed observation: same UTC date, same 12h slot."""
    _write_run(base, "20261105T030000Z-pilot", PILOT_TS, 0.0000125, 0.000001)
    _write_run(base, "20261105T090000Z-auth", ALLOWED_TS, 0.0000125,
               0.00005273)
    return base


def test_same_slot_pilot_and_allowed_under_aligned_anchors(tmp_path):
    # EI-STRAT-004's mandated fixture (pre-start pilot + allowed observation
    # in the SAME UTC date / 12h bucket) under EI-STRAT-005's aligned rule:
    # the 08:00Z mid-slot cutoff that used to separate pilot (03:00Z) from
    # allowed (09:00Z) inside slot [00Z,12Z) is no longer expressible — it
    # is refused (WindowAnchorError; see test_window_semantics.py). For the
    # two expressible anchors there is no partial slot: anchoring at
    # 00:00:00Z admits BOTH rows of the shared slot (both are then
    # in-window authorized observations; the slot median is the median of
    # both); anchoring at 12:00:00Z places the WHOLE slot before the anchor
    # so both rows are pre-start, excluded and disclosed.
    base = _fixture_same_slot(tmp_path)

    at_midnight = compute_report(base,
                                 window_start_utc="2026-11-05T00:00:00Z")
    a = at_midnight["per_asset"]["BTC"]
    assert at_midnight["evaluation_window"][
        "pairs_before_boundary_excluded"] == 0
    assert a["n_slots_with_complete_pair"] == 1
    assert a["sample_completeness"] == pytest.approx(1 / 28, abs=1e-4)
    # both rows are in the authorized window: the slot median is the honest
    # median of the two admitted observations
    assert a["daily_median_net_apr_pre_registered"]["2026-11-05"] == \
        pytest.approx((PILOT_NET + ALLOWED_NET) / 2, abs=1e-6)

    at_noon = compute_report(base, window_start_utc="2026-11-05T12:00:00Z")
    ew = at_noon["evaluation_window"]
    assert ew["window_start_override"] is True
    assert ew["anchor_basis"] == "authorized_start_override"
    assert ew["authorized_boundary_utc"] == "2026-11-05T12:00:00Z"
    # excluded evidence is disclosed, never silently dropped: the whole
    # pre-anchor slot (both rows) is excluded
    assert ew["pairs_before_boundary_excluded"] == 2
    assert ew["boundary_excluded_primary_slots"] == ["2026-11-05T00Z"]
    # no in-window pair remains for the asset -> it drops out of per_asset
    # and the overall verdict is UNRESOLVED (never a pass)
    assert "BTC" not in at_noon["per_asset"]
    assert at_noon["verdict"] == VERDICT_UNRESOLVED
    assert any("no complete paired observations" in r
               for r in at_noon["verdict_reasons"])
    assert at_noon["window_semantics"]["slot_alignment_validated"] is True


def test_default_anchor_is_labeled_not_authorized(tmp_path):
    # Without --window-start the anchor is the earliest run timestamp — which
    # IS the pilot here. The report must say loudly that this is NOT an
    # authorized series start (the pilot must not be silently promoted into
    # an authorized series observation by a default anchor).
    base = _fixture_same_slot(tmp_path)
    dflt = compute_report(base)
    ew = dflt["evaluation_window"]
    assert ew["window_start_override"] is False
    assert ew["anchor_basis"] == "default_earliest_run"
    assert ew["authorized_boundary_utc"] is None
    assert ew["pairs_before_boundary_excluded"] == 0
    assert "not an authorized series start" in ew["anchor_note"].lower()
    assert "pilot" in ew["anchor_note"].lower()

    # Documented diagnostic behavior under the default anchor: everything is
    # included (slot 00Z median of pilot+allowed). This is exactly why the
    # runbook mandates --window-start for any authorized evaluation.
    da = dflt["per_asset"]["BTC"]
    assert da["daily_median_net_apr_pre_registered"]["2026-11-05"] == \
        pytest.approx((PILOT_NET + ALLOWED_NET) / 2, abs=1e-6)


def test_pilot_alone_in_pre_start_slot_is_excluded_and_disclosed(tmp_path):
    # Authorized start at 12:00Z: the pilot (03:00Z, slot T00Z) is alone in
    # its pre-start slot. It must not count as an observed authorized slot —
    # it is excluded from metrics and disclosed via the boundary-exclusion
    # disclosure (the slot grid starts at the floor-12h of the boundary).
    base = tmp_path
    _write_run(base, "20261105T030000Z-pilot", PILOT_TS, 0.0000125, 0.000001)
    _write_run(base, "20261105T130000Z-auth", "2026-11-05T13:00:00Z",
               0.0000125, 0.00005273)
    report = compute_report(base, window_start_utc="2026-11-05T12:00:00Z")
    a = report["per_asset"]["BTC"]
    assert a["n_slots_with_complete_pair"] == 1
    assert a["n_slots_observed_total"] == 1
    assert a["slots_outside_evaluation_window"] == 0
    assert a["sample_completeness"] == pytest.approx(1 / 28, abs=1e-4)
    assert a["daily_median_net_apr_pre_registered"]["2026-11-05"] == \
        pytest.approx(ALLOWED_NET, abs=1e-6)
    assert PILOT_NET not in \
        a["daily_median_net_apr_pre_registered"].values()
    ew = report["evaluation_window"]
    assert ew["first_slot_utc"] == "2026-11-05T12Z"
    assert ew["boundary_excluded_primary_slots"] == ["2026-11-05T00Z"]
    assert ew["pairs_before_boundary_excluded"] == 1


def test_boundary_is_exact_timestamp_inclusive(tmp_path):
    # The boundary is compared against each pair's actual collected_at_utc at
    # second resolution: 11:59:59Z (before the 12:00:00Z anchor) is excluded
    # and 12:00:00Z exactly is included — a date-level filter cannot do
    # this. The excluded row's slot [00Z,12Z) lies entirely before the
    # aligned anchor; the included row's slot [12Z,24Z) is the first grid
    # slot. Exact filtering is retained under the aligned rule.
    base = tmp_path
    _write_run(base, "20261105T115959Z", "2026-11-05T11:59:59Z",
               0.0000125, 0.0002)          # net ~ -11.15% (distinct)
    _write_run(base, "20261105T120000Z", "2026-11-05T12:00:00Z",
               0.0000125, 0.00005273)      # net ~ +4.976%
    report = compute_report(base, window_start_utc="2026-11-05T12:00:00Z")
    a = report["per_asset"]["BTC"]
    assert report["evaluation_window"]["pairs_before_boundary_excluded"] == 1
    assert a["n_slots_with_complete_pair"] == 1
    assert a["daily_median_net_apr_pre_registered"]["2026-11-05"] == \
        pytest.approx(ALLOWED_NET, abs=1e-6)


def test_override_grid_is_exactly_28_slots_from_aligned_anchor(tmp_path):
    # EI-STRAT-005: the grid is the 28 half-day slots [anchor, anchor+14d)
    # with the anchor validated slot-aligned — so floor12(anchor) == anchor
    # and the grid start IS the exact authorized anchor.
    base = _fixture_same_slot(tmp_path)
    report = compute_report(base, window_start_utc="2026-11-05T00:00:00Z")
    ew = report["evaluation_window"]
    assert ew["first_slot_utc"] == "2026-11-05T00Z"   # the anchor itself
    assert ew["end_slot_exclusive_utc"] == "2026-11-19T00Z"
    assert ew["grid_slots"] == 28
    assert ew["slots"] == 28
    assert (datetime.strptime("2026-11-19T00Z", "%Y-%m-%dT%HZ")
            - datetime.strptime("2026-11-05T00Z", "%Y-%m-%dT%HZ")) == \
        timedelta(days=14)
    # a noon anchor: grid [12:00Z, +14d) — 28 slots ending at 12:00Z
    report_noon = compute_report(base,
                                 window_start_utc="2026-11-05T12:00:00Z")
    ewn = report_noon["evaluation_window"]
    assert ewn["first_slot_utc"] == "2026-11-05T12Z"
    assert ewn["end_slot_exclusive_utc"] == "2026-11-19T12Z"
    assert ewn["grid_slots"] == 28
    # midnight overrides keep the EI-STRAT-003 date-window semantics
    # (regression guard; the full penalty scenario lives in
    # test_gate_window.py::test_missing_beginning_penalized_...)
    base2 = tmp_path / "midnight"
    base2.mkdir()
    _write_run(base2, "20261103T020000Z", "2026-11-03T02:00:00Z",
               0.0000125, 0.00005273)
    r2 = compute_report(base2, window_start_utc="2026-11-01T00:00:00Z")
    assert r2["evaluation_window"]["first_slot_utc"] == "2026-11-01T00Z"
    assert r2["evaluation_window"]["end_slot_exclusive_utc"] == \
        "2026-11-15T00Z"
    assert r2["per_asset"]["BTC"]["n_slots_with_complete_pair"] == 1
    assert r2["per_asset"]["BTC"]["slots_outside_evaluation_window"] == 0
