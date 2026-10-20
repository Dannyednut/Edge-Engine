"""EI-STRAT-004 task 1: the authorized-start boundary is an EXACT timestamp.

Regression context: the pre-audit stats truncated --window-start to a UTC
DATE and filtered 12h slots by date prefix, so a pre-authorization pilot
sample collected on the same UTC date as the authorized series start (even
in the same 12h slot — the real pilot was recorded 2026-10-20T04:56:54Z)
could contribute to the authorized series via slot aggregation/median
dedupe. The fix filters each pair's ACTUAL collected_at_utc against the
authorized boundary BEFORE slot aggregation/deduplication.

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

# The authorized start shares its UTC date AND its T00Z 12h slot with the
# pilot observation (mirrors the real 2026-10-20 pilot-vs-authorized-start
# hazard): pilot 03:00Z and allowed 09:00Z both floor to slot 2026-11-05T00Z.
AUTHORIZED_START = "2026-11-05T08:00:00Z"
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


def test_pre_start_pilot_cannot_contribute_same_date_same_slot(tmp_path):
    # THE mandated fixture: pre-start observation and allowed observation in
    # the same UTC date / 12h bucket. The pilot pair (03:00Z < 08:00Z start)
    # must be excluded BEFORE slot aggregation/median dedupe — the authorized
    # slot value is the allowed observation's value alone.
    base = _fixture_same_slot(tmp_path)
    report = compute_report(base, window_start_utc=AUTHORIZED_START)
    a = report["per_asset"]["BTC"]
    assert a["n_slots_with_complete_pair"] == 1
    assert a["sample_completeness"] == pytest.approx(1 / 28, abs=1e-4)
    slot_median = a["daily_median_net_apr_pre_registered"]["2026-11-05"]
    assert slot_median == pytest.approx(ALLOWED_NET, abs=1e-6)
    assert a["median_net_apr_pre_registered"] == pytest.approx(
        ALLOWED_NET, abs=1e-6)
    # decisive: the slot value is NOT influenced by the pilot rate
    assert slot_median != pytest.approx(
        (PILOT_NET + ALLOWED_NET) / 2, abs=1e-6)

    ew = report["evaluation_window"]
    assert ew["window_start_override"] is True
    assert ew["anchor_basis"] == "authorized_start_override"
    assert ew["authorized_boundary_utc"] == AUTHORIZED_START
    # excluded evidence is disclosed, never silently dropped
    assert ew["pairs_before_boundary_excluded"] == 1
    assert ew["boundary_excluded_primary_slots"] == ["2026-11-05T00Z"]
    assert report["verdict"] == VERDICT_UNRESOLVED  # 1 slot < 14d window


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
    # second resolution: 07:59:59Z (before an 08:00:00Z start) is excluded,
    # 08:00:00Z exactly is included — a date-level filter cannot do this.
    base = tmp_path
    _write_run(base, "20261105T075959Z", "2026-11-05T07:59:59Z",
               0.0000125, 0.0002)          # net ~ -11.15% (distinct)
    _write_run(base, "20261105T080000Z", "2026-11-05T08:00:00Z",
               0.0000125, 0.00005273)      # net ~ +4.976%
    report = compute_report(base, window_start_utc=AUTHORIZED_START)
    a = report["per_asset"]["BTC"]
    assert report["evaluation_window"]["pairs_before_boundary_excluded"] == 1
    assert a["n_slots_with_complete_pair"] == 1
    assert a["daily_median_net_apr_pre_registered"]["2026-11-05"] == \
        pytest.approx(ALLOWED_NET, abs=1e-6)


def test_override_grid_is_exactly_28_slots_from_floor12_start(tmp_path):
    # The fixed pre-registered denominator is preserved under any override:
    # the grid is the 28 half-day slots [floor12(start), floor12(start)+14d).
    base = _fixture_same_slot(tmp_path)
    report = compute_report(base, window_start_utc=AUTHORIZED_START)
    ew = report["evaluation_window"]
    assert ew["first_slot_utc"] == "2026-11-05T00Z"   # floor12(08:00Z)
    assert ew["end_slot_exclusive_utc"] == "2026-11-19T00Z"
    assert ew["grid_slots"] == 28
    assert ew["slots"] == 28
    assert (datetime.strptime("2026-11-19T00Z", "%Y-%m-%dT%HZ")
            - datetime.strptime("2026-11-05T00Z", "%Y-%m-%dT%HZ")) == \
        timedelta(days=14)
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
