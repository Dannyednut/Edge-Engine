"""Store: run isolation, dedupe, manifests, hash verification, tamper checks."""
from __future__ import annotations

import json

import pytest

from funding_harness.models import make_gap, make_observation
from funding_harness.store import resolve_run_dir, verify, write_run
from tests.fake_transport import COLLECTED, RUN_ID


def _obs(asset="BTC", source="bybit", ts=COLLECTED, rate=0.00005273, **kw):
    from funding_harness.models import funding_metrics, funding_unit_conventions
    return make_observation(
        run_id=RUN_ID, collected_at_utc=COLLECTED, observation_ts_utc=ts,
        observation_ts_basis="response_time", source=source, source_kind="cex",
        asset=asset, source_instrument=f"{asset}USDT", metric_group="funding",
        metrics=funding_metrics(rate_native=rate, interval_hours=8,
                                interval_assumed=True, **kw),
        unit_conventions=funding_unit_conventions(),
        evidence={"endpoint": "https://x", "http_status": 200,
                  "payload_sha256": "abc", "provenance": "test",
                  "raw_ref": "raw/x.json", "raw_bounded": False})


class _SR:
    def __init__(self, source, observations, gaps=(), raws=()):
        self.source = source
        self.observations = list(observations)
        self.gaps = list(gaps)
        self.raws = list(raws)
        self.notes = []


def test_write_run_persists_and_dedupes(tmp_path):
    sr = _SR("bybit", [_obs(), _obs()])  # identical observation_key twice
    res = write_run(base_dir=tmp_path, run_id=RUN_ID, started_utc=COLLECTED,
                    config_snapshot={"gate_config_sha256": "x"},
                    source_results=[sr], pairs=[])
    assert res.observations_written == 1
    assert len(res.duplicates_ignored) == 1
    manifest = json.loads((res.run_dir / "run_manifest.json").read_text())
    assert manifest["counts"]["observations"] == 1
    assert manifest["duplicates_ignored_keys"]


def test_run_dirs_never_collide(tmp_path):
    d1 = resolve_run_dir(tmp_path, RUN_ID)
    d1.mkdir(parents=True)
    d2 = resolve_run_dir(tmp_path, RUN_ID)
    assert d1 != d2 and d2.name.endswith("-2")


def test_invalid_observation_demoted_not_written(tmp_path):
    bad = _obs()
    bad["metrics"].pop("funding_rate_apr")  # breaks canonical shape
    res = write_run(base_dir=tmp_path, run_id=RUN_ID, started_utc=COLLECTED,
                    config_snapshot={}, source_results=[_SR("bybit", [bad])],
                    pairs=[])
    assert res.observations_written == 0
    assert len(res.rejected_invalid) == 1
    lines = (res.run_dir / "observations.jsonl").read_text().strip()
    assert lines == ""


def test_raw_hash_verification_passes(tmp_path):
    raw_bytes = b'{"hello": "world"}'
    from funding_harness.sources.base import RawEntry
    raw = RawEntry(stem="bybit/tickers_BTCUSDT", body=raw_bytes,
                   meta={"payload_sha256": __import__("hashlib").sha256(
                       raw_bytes).hexdigest(), "raw_bounded": False})
    res = write_run(base_dir=tmp_path, run_id=RUN_ID, started_utc=COLLECTED,
                    config_snapshot={}, source_results=[_SR("bybit", [], raws=[raw])],
                    pairs=[])
    report = verify(tmp_path)
    assert report["ok"] is True
    assert report["runs_checked"] == 1
    assert report["raw_files_checked"] == 1
    assert res.run_dir.exists()


def test_verify_detects_tampered_raw(tmp_path):
    from funding_harness.sources.base import RawEntry
    raw_bytes = b'{"funding": 0.0001}'
    raw = RawEntry(stem="bybit/x", body=raw_bytes,
                   meta={"payload_sha256": __import__("hashlib").sha256(
                       raw_bytes).hexdigest(), "raw_bounded": False})
    res = write_run(base_dir=tmp_path, run_id=RUN_ID, started_utc=COLLECTED,
                    config_snapshot={}, source_results=[_SR("bybit", [], raws=[raw])],
                    pairs=[])
    raw_path = res.run_dir / "raw" / "bybit" / "x.json"
    raw_path.write_bytes(b'{"funding": 9.9}')  # tamper
    report = verify(tmp_path)
    assert report["ok"] is False
    assert report["hash_mismatches"]


def test_verify_detects_cross_run_conflicting_duplicates(tmp_path):
    # same observation_key, different payload hash across two runs
    for i, run_id in enumerate((RUN_ID, "20261101T200000Z")):
        o = _obs(ts=f"2026-11-01T0{i}:00:00Z")
        o["evidence"]["payload_sha256"] = f"hash-{i}"
        o["observation_key"] = "bybit|BTC|BTCUSDT|funding|2026-11-01T00:00:00Z"
        o["observation_id"] = f"id-{i}"
        res = write_run(base_dir=tmp_path, run_id=run_id,
                        started_utc=COLLECTED, config_snapshot={},
                        source_results=[_SR("bybit", [o])], pairs=[])
    report = verify(tmp_path)
    assert report["cross_run_duplicates"], "conflicting duplicate must be flagged"


def test_gaps_written_separately_from_observations(tmp_path):
    gap = make_gap(run_id=RUN_ID, collected_at_utc=COLLECTED, source="binance",
                   asset="BTC", source_instrument="BTCUSDT",
                   metric_group="funding", gap_reason="http_error",
                   detail="HTTP 418")
    res = write_run(base_dir=tmp_path, run_id=RUN_ID, started_utc=COLLECTED,
                    config_snapshot={}, source_results=[_SR("binance", [], gaps=[gap])],
                    pairs=[])
    assert res.gaps_written == 1 and res.observations_written == 0
    gap_line = json.loads(
        (res.run_dir / "gaps.jsonl").read_text().strip().splitlines()[0])
    assert gap_line["quality"]["complete"] is False
    assert gap_line["quality"]["gap_reason"] == "http_error"
