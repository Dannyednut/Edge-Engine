"""EI-STRAT-005: the authorized timestamp is the GATE-WINDOW ANCHOR of a
FIXED 14-DAY UTC SLOT WINDOW, and it must be slot-aligned.

Instructor question: does the pre-registered design mean
  (a) a fixed 14-day UTC slot window, with an exact lower cutoff within
      its first slot; or
  (b) 14 full elapsed days from the exact authorized timestamp?

Determination: the pre-registered design (EI-STRAT-001 §4.2 as encoded in
GATE_CONFIG — window_days_min=14 x samples_per_day=2, completeness counted
in 12h collection slots, denominator fixed at 28) is reading (a): the
window is the fixed sequence of 28 consecutive 12h UTC slots
[anchor, anchor + 14 days), and the exact authorized timestamp is the
lower data cutoff for record inclusion (EI-STRAT-004). For a NON-aligned
anchor the two readings diverge: an 08:00Z start keeps its exact row
cutoff but the floor-12h grid ends 13 days 16 hours (= 328h = 336h - 8h)
after the exact start — 8 hours short of 14 full elapsed days — with an
8-hour dead zone at the grid head that can never contain an authorized
observation.

Adopted rule (instructor-preferred): authorized window boundaries must be
SLOT-ALIGNED — exactly 00:00:00Z or 12:00:00Z. For a slot-aligned anchor
floor12(anchor) == anchor, so BOTH readings describe the IDENTICAL
interval [anchor, anchor + 14 days): the ambiguity is dissolved without
touching GATE_CONFIG, the fixed 28-slot denominator, or the gate hash
(no pre-registration change). Exact record-timestamp filtering is
retained (inclusive lower / exclusive upper, second resolution).
Non-aligned --window-start values are refused before any computation
(WindowAnchorError; CLI exit 4) with the nearest slot boundaries named —
never floored silently.

--window-start is the GATE-WINDOW ANCHOR, NOT the time of the first
actual collection; the first admitted collection is an observed fact,
disclosed in the report, and never moves the grid.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from funding_harness import config
from funding_harness.cli import main as cli_main
from funding_harness.pairing import build_pairs
from funding_harness.stats import (WindowAnchorError, compute_report)
from funding_harness.store import write_run
from tests.test_completeness_definition import PREREGISTERED_HASH
from tests.test_pairing_stats import _funding_obs
from tests.test_window_boundary import ALLOWED_NET, PILOT_NET, _write_run

PILOT_TS = "2026-11-05T04:56:54Z"   # mirrors the real 2026-10-20T04:56:54Z pilot


def _one_run(base, run_id, ts, cex_rate):
    _write_run(base, run_id, ts, 0.0000125, cex_rate)


def test_non_aligned_window_start_is_refused(tmp_path):
    # The instructor's 08:00Z example — and any other sub-slot timestamp —
    # must be refused BEFORE any computation: a non-aligned anchor would
    # apply an exact row cutoff inside the first slot while the 28-slot
    # grid still starts at floor-12h (for 08:00Z the grid end sits 13 days
    # 16 hours = 328h after the exact start). Nothing is floored silently.
    _one_run(tmp_path, "20261105T090000Z", "2026-11-05T09:00:00Z", 0.00005273)
    for bad_start in ("2026-11-05T08:00:00Z",     # the instruction's example
                      "2026-11-05T12:00:01Z",     # one second past a boundary
                      "2026-11-05T04:56:54Z",     # the real pilot timestamp
                      "2026-11-05T23:59:59Z"):    # last second of a half-day
        with pytest.raises(WindowAnchorError) as exc:
            compute_report(tmp_path, window_start_utc=bad_start)
        msg = str(exc.value)
        assert "not slot-aligned" in msg
        assert "00:00:00Z" in msg and "12:00:00Z" in msg
        assert bad_start in msg                      # refused, not corrected
        assert "Re-anchor" in msg                    # actionable, fail closed


def test_refusal_names_the_two_nearest_slot_boundaries(tmp_path):
    _one_run(tmp_path, "20261105T090000Z", "2026-11-05T09:00:00Z", 0.00005273)
    with pytest.raises(WindowAnchorError) as exc:
        compute_report(tmp_path, window_start_utc="2026-11-05T08:00:00Z")
    # containing boundary (00:00:00Z) and next boundary (12:00:00Z), same day
    assert "2026-11-05T00:00:00Z" in str(exc.value)
    assert "2026-11-05T12:00:00Z" in str(exc.value)
    # the refusal states the arithmetic that motivates the rule
    assert "328" in str(exc.value)          # 336h - 8h for an 08:00Z start
    assert "13 days 16 hours" in str(exc.value)


def test_cli_refuses_non_aligned_start_exit_4_no_report(tmp_path):
    rc = cli_main(["--base-dir", str(tmp_path), "stats",
                   "--window-start", "2026-11-05T08:00:00Z"])
    assert rc == 4
    assert not (tmp_path / "derived").exists()   # fail closed: no artifacts


def test_aligned_anchor_grid_is_exactly_anchor_plus_14_days(tmp_path):
    # With a slot-aligned anchor, floor12 is an identity: the grid start IS
    # the exact authorized anchor and the grid end IS anchor + 14 full days
    # (also slot-aligned) — 28 consecutive 12h UTC slots, 336 hours.
    for anchor, first, end in (
            ("2026-11-05T00:00:00Z", "2026-11-05T00Z", "2026-11-19T00Z"),
            ("2026-11-05T12:00:00Z", "2026-11-05T12Z", "2026-11-19T12Z")):
        base = tmp_path / anchor.replace(":", "")
        base.mkdir()
        _one_run(base, "20261105T130000Z", "2026-11-05T13:00:00Z", 0.00005273)
        report = compute_report(base, window_start_utc=anchor)
        ew = report["evaluation_window"]
        assert ew["first_slot_utc"] == first
        assert ew["end_slot_exclusive_utc"] == end
        assert (datetime.strptime(end, "%Y-%m-%dT%HZ")
                - datetime.strptime(first, "%Y-%m-%dT%HZ")) == \
            timedelta(days=14)
        assert ew["grid_slots"] == 28 and ew["slots"] == 28
        ws = report["window_semantics"]
        assert ws["slot_alignment_validated"] is True
        assert ws["grid_span_hours"] == 336


def test_window_covers_exactly_14_elapsed_days_inclusive_lower_exclusive_upper(
        tmp_path):
    # For the aligned anchor 12:00:00Z the window [anchor, anchor+14d) is
    # simultaneously 'the fixed 14-day slot window' AND '14 full elapsed
    # days from the exact authorized timestamp' — the two readings coincide.
    # A record at the last second inside (…T11:59:59Z) is in; a record at
    # exactly anchor+14d (2026-11-19T12:00:00Z) belongs to the NEXT window.
    base = tmp_path
    _one_run(base, "20261119T115959Z", "2026-11-19T11:59:59Z", 0.00005273)
    _one_run(base, "20261119T120000Z", "2026-11-19T12:00:00Z", 0.0002)
    report = compute_report(base, window_start_utc="2026-11-05T12:00:00Z")
    a = report["per_asset"]["BTC"]
    assert a["n_slots_with_complete_pair"] == 1
    assert a["daily_median_net_apr_pre_registered"]["2026-11-19"] == \
        pytest.approx(ALLOWED_NET, abs=1e-6)
    assert a["slots_outside_evaluation_window"] == 1   # the 12:00:00Z row
    assert report["evaluation_window"]["end_slot_exclusive_utc"] == \
        "2026-11-19T12Z"


def test_same_day_pilot_excluded_under_aligned_anchor(tmp_path):
    # The EI-STRAT-004 guarantee, restated under the aligned rule with the
    # REAL pilot timestamp shape: pilot 04:56:54Z and the authorized anchor
    # 12:00:00Z share the UTC date; the pre-anchor pilot can never
    # contribute — it is excluded before slot aggregation and disclosed.
    base = tmp_path
    _one_run(base, "20261105T045654Z-pilot", PILOT_TS, 0.000001)
    _one_run(base, "20261105T130000Z-auth", "2026-11-05T13:00:00Z",
             0.00005273)
    report = compute_report(base, window_start_utc="2026-11-05T12:00:00Z")
    a = report["per_asset"]["BTC"]
    assert a["n_slots_with_complete_pair"] == 1
    assert a["daily_median_net_apr_pre_registered"]["2026-11-05"] == \
        pytest.approx(ALLOWED_NET, abs=1e-6)
    assert PILOT_NET not in a["daily_median_net_apr_pre_registered"].values()
    ew = report["evaluation_window"]
    assert ew["pairs_before_boundary_excluded"] == 1
    assert ew["boundary_excluded_primary_slots"] == ["2026-11-05T00Z"]
    assert ew["first_slot_utc"] == "2026-11-05T12Z"


def test_anchor_predating_a_same_day_sample_includes_it(tmp_path):
    # Honest boundary semantics: slot alignment alone does not detect
    # pilots. An anchor of 00:00:00Z ADMITS a same-date 04:56:54Z sample
    # because it postdates the anchor. The runbook rule is therefore that
    # the authorized anchor must be chosen strictly AFTER every
    # pre-authorization sample (the boundary is exact, not magic).
    base = tmp_path
    _one_run(base, "20261105T045654Z-pilot", PILOT_TS, 0.000001)
    report = compute_report(base, window_start_utc="2026-11-05T00:00:00Z")
    assert report["evaluation_window"]["pairs_before_boundary_excluded"] == 0
    a = report["per_asset"]["BTC"]
    assert a["n_slots_with_complete_pair"] == 1
    assert a["daily_median_net_apr_pre_registered"]["2026-11-05"] == \
        pytest.approx(PILOT_NET, abs=1e-6)


def test_anchor_is_gate_window_anchor_not_first_collection_time(tmp_path):
    # --window-start is the gate-window anchor; the first actual collection
    # is an observed fact disclosed separately and NEVER moves the grid.
    base = tmp_path
    _one_run(base, "20261105T130733Z", "2026-11-05T13:07:33Z", 0.00005273)
    report = compute_report(base, window_start_utc="2026-11-05T12:00:00Z")
    ew = report["evaluation_window"]
    ws = report["window_semantics"]
    assert ew["authorized_boundary_utc"] == "2026-11-05T12:00:00Z"
    assert ws["anchor_role"] == "gate_window_anchor"
    assert ws["anchor_is_first_collection_time"] is False
    assert ws["first_accepted_collection_utc"] == "2026-11-05T13:07:33Z"
    assert "observed fact" in ws["first_collection_role"]
    assert "never moves" in ws["first_collection_role"]
    # the grid derives from the anchor, not from the 13:07:33Z collection
    assert ew["first_slot_utc"] == "2026-11-05T12Z"
    assert ew["end_slot_exclusive_utc"] == "2026-11-19T12Z"


def test_default_anchor_is_flagged_as_first_collection_derived(tmp_path):
    # Without --window-start the anchor is DERIVED from the earliest run
    # timestamp — i.e. it IS first-collection-derived (date-truncated).
    # That conflation is exactly why the default anchor is diagnostic-only
    # and can never authorize a series; the report must say so.
    base = tmp_path
    _one_run(base, "20261105T045654Z-pilot", PILOT_TS, 0.000001)
    _one_run(base, "20261105T130000Z-auth", "2026-11-05T13:00:00Z",
             0.00005273)
    report = compute_report(base)
    ws = report["window_semantics"]
    assert ws["slot_alignment_validated"] is False
    assert ws["anchor_role"] == "diagnostic_earliest_run_derived_not_authorized"
    assert ws["anchor_is_first_collection_time"] is True
    assert "diagnostic" in ws["anchor_note"]
    assert "--window-start" in ws["anchor_note"]
    # first accepted collection is still disclosed as an observed fact
    assert ws["first_accepted_collection_utc"] == PILOT_TS


def test_window_semantics_rule_leaves_gate_hash_byte_identical(tmp_path):
    # EI-STRAT-005 dissolves the anchor ambiguity WITHOUT any
    # pre-registration change: GATE_CONFIG, the legacy completeness string
    # and the pre-registered hash stay byte-identical; every report still
    # embeds the same hash.
    assert config.gate_config_sha256() == PREREGISTERED_HASH
    base = tmp_path
    _one_run(base, "20261105T130000Z", "2026-11-05T13:00:00Z", 0.00005273)
    report = compute_report(base, window_start_utc="2026-11-05T12:00:00Z")
    assert report["gate_config_sha256"] == PREREGISTERED_HASH
    assert report["gate"] == config.GATE_CONFIG
    ws = report["window_semantics"]
    assert ws["interpretation"] == "fixed_14_day_utc_slot_window"
    assert ws["slot_alignment_required"] is True
    # the rule preserves the preregistered 28-slot interpretation explicitly
    assert "28" in ws["definition"]
    assert "[anchor, anchor + 14 days)" in ws["definition"]
    assert "328" in ws["rationale"] and "13 days 16 hours" in ws["rationale"]


def test_refusal_leaves_existing_evidence_untouched(tmp_path):
    # A refused invocation must not write, modify, or delete anything under
    # the data directory (the pilot run stays exactly as it was).
    base = tmp_path
    _one_run(base, "20261105T045654Z-pilot", PILOT_TS, 0.000001)
    before = sorted(str(p.relative_to(base)) for p in base.rglob("*"))
    with pytest.raises(WindowAnchorError):
        compute_report(base, window_start_utc="2026-11-05T08:00:00Z")
    after = sorted(str(p.relative_to(base)) for p in base.rglob("*"))
    assert before == after
