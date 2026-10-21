"""End-to-end CLI flows offline: collect -> stats -> verify with FakeTransport,
plus the models fail-closed contract."""
from __future__ import annotations

import json

import pytest

import funding_harness.cli as cli
from funding_harness import config
from tests.fake_transport import FakeTransport, fx_bytes


def _full_transport(vooi_body=fx_bytes("vooi_no_majors.json")):
    empty = json.dumps({"retCode": 0, "retMsg": "OK", "result": {"list": []}}).encode()
    return FakeTransport([
        ("api.hyperliquid.xyz", 200, fx_bytes("hl_ok.json")),
        ("fapi.binance.com", 418, b"blocked"),
        ("symbol=ETHUSDT", 200, empty),          # per-symbol bybit fixture
        ("symbol=SOLUSDT", 200, empty),
        ("api.bybit.com", 200, fx_bytes("bybit_ok.json")),
        ("public/funding-rate", 200, fx_bytes("okx_funding_ok.json")),
        ("public/open-interest", 200, fx_bytes("okx_oi_ok.json")),
        ("market/ticker", 200, fx_bytes("okx_ticker_ok.json")),
        ("contract.mexc.com", 403, b"forbidden"),
        ("api.gateio.ws", 200, fx_bytes("gate_ok.json")),
        ("api.bitget.com", 200, fx_bytes("bitget_ok.json")),
        ("funding/rates", 200, fx_bytes("sharpe_funding_ok.json")),
        ("cross-exchange", 200, fx_bytes("sharpe_cross_ok.json")),
        ("perps-api.vooi.io", 200, vooi_body),
    ])


def test_cli_collect_exit1_with_gaps(tmp_path, monkeypatch):
    monkeypatch.setattr("funding_harness.transport.UrllibTransport",
                        _full_transport)
    rc = cli.main(["--base-dir", str(tmp_path), "collect"])
    assert rc == 1  # recorded with gaps (binance 418, mexc 403, vooi no majors)
    runs = list((tmp_path / "runs").iterdir())
    assert len(runs) == 1
    obs = [json.loads(l) for l in
           (runs[0] / "observations.jsonl").read_text().strip().splitlines() if l]
    gaps = [json.loads(l) for l in
            (runs[0] / "gaps.jsonl").read_text().strip().splitlines() if l]
    srcs = {o["source"] for o in obs}
    assert "hyperliquid" in srcs and "bybit" in srcs and "okx" in srcs
    gap_reasons = {(g["source"], g["quality"]["gap_reason"]) for g in gaps}
    assert ("binance", config.GAP_HTTP_ERROR) in gap_reasons
    assert ("mexc", config.GAP_HTTP_ERROR) in gap_reasons
    # pairs exist for HL-vs-bybit and HL-vs-okx on BTC
    pairs = [json.loads(l) for l in
             (runs[0] / "pairs.jsonl").read_text().strip().splitlines() if l]
    btc_pairs = {p["long_venue"] for p in pairs if p["asset"] == "BTC"}
    assert {"bybit", "okx"} <= btc_pairs
    # binance/mexc never zero-filled into a pair
    assert "binance" not in btc_pairs and "mexc" not in btc_pairs


def test_cli_verify_ok_after_collect(tmp_path, monkeypatch):
    monkeypatch.setattr("funding_harness.transport.UrllibTransport",
                        _full_transport)
    cli.main(["--base-dir", str(tmp_path), "collect"])
    assert cli.main(["--base-dir", str(tmp_path), "verify"]) == 0


def test_cli_stats_unresolved_single_run(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("funding_harness.transport.UrllibTransport",
                        _full_transport)
    cli.main(["--base-dir", str(tmp_path), "collect"])
    rc = cli.main(["--base-dir", str(tmp_path), "stats"])
    out = capsys.readouterr().out
    assert rc == 1
    assert "verdict=UNRESOLVED" in out  # single run < 14d window
    reports = list((tmp_path / "derived").glob("gate-report-*.json"))
    assert reports
    body = json.loads(reports[0].read_text())
    assert body["gate_config_sha256"] == config.gate_config_sha256()


def test_cli_collect_hard_failure_exit2(tmp_path, monkeypatch):
    dead = FakeTransport([], default_status=500, default_body=b"down")
    monkeypatch.setattr("funding_harness.transport.UrllibTransport", lambda: dead)
    rc = cli.main(["--base-dir", str(tmp_path), "collect"])
    assert rc == 2


# ------------------------------------------------------- fail-closed contract
def test_never_fabricates_funding_zero():
    from funding_harness.models import (funding_metrics, funding_unit_conventions,
                                        make_observation, validate_observation)
    m = funding_metrics(rate_native=None, interval_hours=8,
                        interval_assumed=True)
    assert m["funding_rate_native"] is None
    assert m["funding_rate_apr"] is None
    obs = {"schema_version": "1.0.0", "observation_id": "x", "observation_key": "k",
           "run_id": "r", "collected_at_utc": "t", "observation_ts_utc": "t",
           "observation_ts_basis": "response_time", "source": "bybit",
           "source_kind": "cex", "asset": "BTC", "source_instrument": "BTCUSDT",
           "metric_group": "funding", "metrics": m,
           "unit_conventions": funding_unit_conventions(),
           "evidence": {"endpoint": "e", "http_status": 200,
                        "payload_sha256": "p", "provenance": "x"},
           "quality": {"complete": True, "gap_reason": None, "warnings": []}}
    assert validate_observation(obs)  # incomplete metrics must not be "complete"
