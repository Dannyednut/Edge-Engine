"""Pairing + gate statistics: pre-registered net-APR model and verdict logic."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from funding_harness import config
from funding_harness.collect import GateDriftError
from funding_harness.models import (funding_metrics, funding_unit_conventions,
                                    make_observation)
from funding_harness.pairing import build_pairs, dedupe_slots
from funding_harness.stats import (VERDICT_BETWEEN, VERDICT_FAIL,
                                   VERDICT_PASS, VERDICT_UNRESOLVED,
                                   check_gate_drift, compute_report)
from funding_harness.store import write_run
from tests.fake_transport import COLLECTED


def _funding_obs(asset, source, collected_at, hl_rate, cex_rate=None,
                 interval=8, clamp=False):
    from funding_harness.models import make_gap
    rate = hl_rate if source == "hyperliquid" else cex_rate
    return make_observation(
        run_id="r", collected_at_utc=collected_at, observation_ts_utc=collected_at,
        observation_ts_basis="response_time", source=source,
        source_kind="dex_perp" if source == "hyperliquid" else "cex",
        asset=asset, source_instrument=asset, metric_group="funding",
        metrics=funding_metrics(rate_native=rate,
                                interval_hours=1 if source == "hyperliquid" else interval,
                                interval_assumed=(source != "hyperliquid"),
                                at_clamp=clamp),
        unit_conventions=funding_unit_conventions(),
        evidence={"endpoint": "x", "http_status": 200, "payload_sha256": "h",
                  "provenance": "test", "raw_ref": "r", "raw_bounded": False})


# ------------------------------------------------------------------- pairing
def test_pair_net_apr_matches_preregistered_formula():
    obs = [_funding_obs("BTC", "hyperliquid", COLLECTED, 0.0000125),
           _funding_obs("BTC", "bybit", COLLECTED, None, 0.00005273)]
    pairs = build_pairs(obs, "r", COLLECTED)
    assert len(pairs) == 1
    p = pairs[0]
    # HL 0.0000125/h = 10.95% APR ; Bybit 0.00005273/8h = 5.774% APR
    assert p["f_hl_apr"] == pytest.approx(0.1095)
    assert p["f_cex_apr"] == pytest.approx(0.00005273 * 3 * 365)
    assert p["gross_diff_apr"] == pytest.approx(p["f_hl_apr"] - p["f_cex_apr"])
    assert p["net_apr_pre_registered"] == pytest.approx(
        p["gross_diff_apr"] - 0.002)
    assert p["primary_cex_leg"] is True  # bybit is first reachable in priority


def test_pair_requires_both_legs():
    obs = [_funding_obs("BTC", "hyperliquid", COLLECTED, 0.0000125)]
    assert build_pairs(obs, "r", COLLECTED) == []
    obs2 = [_funding_obs("BTC", "bybit", COLLECTED, None, 0.0001)]
    assert build_pairs(obs2, "r", COLLECTED) == []


def test_primary_leg_priority_binance_before_bybit():
    obs = [_funding_obs("BTC", "hyperliquid", COLLECTED, 0.0000125),
           _funding_obs("BTC", "bybit", COLLECTED, None, 0.00005273),
           _funding_obs("BTC", "binance", COLLECTED, None, 0.0001)]
    pairs = build_pairs(obs, "r", COLLECTED)
    primaries = [p for p in pairs if p["primary_cex_leg"]]
    assert len(primaries) == 1
    assert primaries[0]["long_venue"] == "binance"


# ---------------------------------------------------------------- gate stats
def _slot_time(day: int, hour: int) -> str:
    return f"2026-11-{day:02d}T{hour:02d}:00:00Z"


def _write_window(tmp_path, *, days, hl_rate=0.0000125, cex_rate=0.00005273,
                  skip_slots=(), extra_flip_days=(), cex_source="bybit"):
    """Write a synthetic 2-samples/day window; returns (base_dir, n_pairs)."""
    t0 = datetime(2026, 11, 1, tzinfo=timezone.utc)
    made = 0
    for d in range(days):
        for slot_hour in (2, 14):
            ts = (t0 + timedelta(days=d, hours=slot_hour)).strftime(
                "%Y-%m-%dT%H:%M:%SZ")
            if (d, slot_hour) in skip_slots:
                continue
            hl = hl_rate
            cex = cex_rate
            if d in extra_flip_days:
                hl = -0.0000125  # funding sign flip on HL
            obs = []
            for asset in ("BTC", "ETH", "SOL"):
                obs.append(_funding_obs(asset, "hyperliquid", ts, hl))
                obs.append(_funding_obs(asset, cex_source, ts, hl, cex))
            run_id = ts.replace("-", "").replace(":", "").replace("T", "T") \
                .replace("Z", "Z")
            run_id = f"{t0.year}{t0.month:02d}{t0.day:02d}T{slot_hour:02d}0000Z-{d}-{slot_hour}"
            write_run(base_dir=tmp_path, run_id=run_id, started_utc=ts,
                      config_snapshot={"gate_config_sha256":
                                       config.gate_config_sha256()},
                      source_results=[], pairs=build_pairs(obs, run_id, ts))
            made += 1
    return tmp_path, made


def test_gate_pass_full_window(tmp_path):
    base, _ = _write_window(tmp_path, days=14)
    report = compute_report(base)
    a = report["per_asset"]["BTC"]
    # HL at cap (10.95% APR) vs Bybit 5.7739% APR -> gross 5.176%, net 3.176%>3%
    assert a["median_net_apr_pre_registered"] == pytest.approx(0.04976, abs=1e-4)
    assert a["sign_flips"] == 0
    assert a["daily_persistence"] == 1.0
    assert report["verdict"] == VERDICT_PASS


def test_gate_fail_low_median(tmp_path):
    # CEX funding near HL funding -> net ~0.095% << 1.5%
    base, _ = _write_window(tmp_path, days=14, cex_rate=0.000095)
    report = compute_report(base)
    assert report["verdict"] == VERDICT_FAIL


def test_gate_fail_sign_flips(tmp_path):
    base, _ = _write_window(tmp_path, days=14, extra_flip_days={4, 8, 12})
    report = compute_report(base)
    a = report["per_asset"]["BTC"]
    assert a["sign_flips"] >= 3
    assert report["verdict"] == VERDICT_FAIL


def test_unresolved_short_window(tmp_path):
    base, _ = _write_window(tmp_path, days=7)
    report = compute_report(base)
    assert report["per_asset"]["BTC"]["verdict"] == VERDICT_UNRESOLVED
    assert report["verdict"] == VERDICT_UNRESOLVED  # 7d < 14d window


def test_unresolved_below_completeness(tmp_path):
    # drop 12 of 28 slots -> completeness 16/28 = 57% < 85%
    skips = {(d, h) for d in range(7) for h in (2,)}
    base, _ = _write_window(tmp_path, days=14, skip_slots=skips)
    report = compute_report(base)
    assert report["per_asset"]["BTC"]["sample_completeness"] < 0.85
    assert report["verdict"] == VERDICT_UNRESOLVED


def test_between_thresholds(tmp_path):
    # HL 8.5% APR (1h) vs CEX 6% APR (8h) -> gross 2.5%, net 2.3%: inside the
    # [1.5%, 3%] band the pre-registered gate defines neither pass nor fail
    hl_rate = 0.085 / 8760          # 8.5% APR as hourly rate
    cex_rate = 0.06 / (3 * 365)     # 6.0% APR as 8h rate
    base, _ = _write_window(tmp_path, days=14, hl_rate=hl_rate, cex_rate=cex_rate)
    report = compute_report(base)
    a = report["per_asset"]["BTC"]
    assert 0.015 <= a["median_net_apr_pre_registered"] <= 0.03
    assert report["verdict"] == VERDICT_BETWEEN
    assert report["verdict"] != VERDICT_UNRESOLVED


def test_gate_drift_refuses(tmp_path):
    base, _ = _write_window(tmp_path, days=14)
    # tamper with one manifest's gate hash
    mpath = next((base / "runs").glob("*/run_manifest.json"))
    manifest = json.loads(mpath.read_text())
    manifest["config_snapshot"]["gate_config_sha256"] = "drifted"
    mpath.write_text(json.dumps(manifest))
    with pytest.raises(GateDriftError):
        compute_report(base)


def test_empty_state_is_unresolved(tmp_path):
    report = compute_report(tmp_path)
    assert report["verdict"] == VERDICT_UNRESOLVED
    assert "no collection runs" in report["verdict_reasons"][0]
