"""EI-STRAT-003 task 3: NON-GATE fee sensitivity sidecar.

The sidecar shows how the ONE-TIME round-trip fee affects returns at
illustrative holding periods (1/7/14/30 days). It never produces a verdict,
never feeds the gate, never mutates GATE_CONFIG or any report it reads.
"""
from __future__ import annotations

import copy
import json

import pytest

from funding_harness import cli, config, fees

CONSERVATIVE = config.GATE_CONFIG["round_trip_fee_conservative"]   # 0.002
OPTIMISTIC = config.GATE_CONFIG["round_trip_fee_optimistic"]       # 0.001


def test_fee_drag_exact_values():
    # annualized drag of one 0.20% round trip amortized over H days
    assert fees.fee_drag_annualized(0.002, 1) == pytest.approx(0.73)
    assert fees.fee_drag_annualized(0.002, 7) == \
        pytest.approx(0.002 * 365 / 7)
    assert fees.fee_drag_annualized(0.002, 14) == \
        pytest.approx(0.002 * 365 / 14)
    assert fees.fee_drag_annualized(0.002, 30) == \
        pytest.approx(0.002 * 365 / 30)


def test_drag_decreases_with_holding_period():
    drags = [fees.fee_drag_annualized(0.002, h) for h in (1, 7, 14, 30, 90)]
    assert drags == sorted(drags, reverse=True)


def test_realizable_net_proxy():
    gross = 0.05
    assert fees.realizable_net_proxy(gross, 30, 0.002) == \
        pytest.approx(0.05 - 0.002 * 365 / 30)
    # a 5% gross APR cannot survive weekly turnover at 0.20% per round trip
    assert fees.realizable_net_proxy(gross, 7, 0.002) < 0


def test_sidecar_labels_and_non_gate_contract():
    t = fees.sensitivity_table()
    assert t["sidecar"] == "non_gate_fee_sensitivity"
    assert t["affects_preregistered_verdict"] is False
    assert t["assumptions"]
    assert "screening proxy" in t["gate_metric_note"]
    assert "verdict" not in t                     # never a verdict object
    assert [r["holding_days"] for r in t["rows"]] == [1, 7, 14, 30]
    for r in t["rows"]:
        h = r["holding_days"]
        assert r["fee_drag_annualized_conservative"] == \
            pytest.approx(fees.fee_drag_annualized(CONSERVATIVE, h))
        assert r["fee_drag_annualized_optimistic"] == \
            pytest.approx(fees.fee_drag_annualized(OPTIMISTIC, h))
        # break-even gross APR equals the drag itself (net = 0)
        assert r["breakeven_gross_apr_conservative"] == \
            pytest.approx(r["fee_drag_annualized_conservative"])


def test_sidecar_does_not_mutate_gate_config_or_report():
    before = json.dumps(config.GATE_CONFIG, sort_keys=True)
    report = {"generated_at_utc": "x", "gate_config_sha256": "h",
              "per_asset": {"BTC": {"median_net_apr_pre_registered": 0.03}}}
    snapshot = copy.deepcopy(report)
    out = fees.apply_to_gate_report(report)
    assert json.dumps(config.GATE_CONFIG, sort_keys=True) == before
    assert report == snapshot                     # input report untouched
    btc = out["applied_to_report"]["per_asset"]["BTC"]
    # gross = net + pre-registered fee (exact inverse of the gate subtraction)
    assert btc["reconstructed_gross_diff_apr"] == pytest.approx(0.032)
    assert "1" in btc["realizable_net_proxy_by_holding_days"]
    assert "30" in btc["realizable_net_proxy_by_holding_days"]


def test_sidecar_handles_missing_median():
    report = {"per_asset": {"SOL": {"median_net_apr_pre_registered": None}}}
    out = fees.apply_to_gate_report(report)
    sol = out["applied_to_report"]["per_asset"]["SOL"]
    assert sol["median_net_apr_pre_registered"] is None
    assert "note" in sol


def test_cli_fees_offline(tmp_path, capsys, monkeypatch):
    # the sidecar must work with the network kill-switch on (CI-safe by design)
    monkeypatch.setenv("FUNDING_HARNESS_OFFLINE", "1")
    out_path = tmp_path / "fees.json"
    rc = cli.main(["fees", "--holding-days", "1,7,14,30",
                   "--out", str(out_path)])
    assert rc == 0
    assert "non-gate" in capsys.readouterr().out
    data = json.loads(out_path.read_text())
    assert data["sidecar"] == "non_gate_fee_sensitivity"
    assert data["affects_preregistered_verdict"] is False
