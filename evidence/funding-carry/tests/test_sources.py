"""Source parsers: canonical shape, units, and fail-closed behavior on
malformed / missing / blocked-endpoint payloads. All offline (FakeTransport)."""
from __future__ import annotations

import json

import pytest

from funding_harness import config
from tests.fake_transport import COLLECTED, RUN_ID, FakeTransport, fx_bytes
from funding_harness.sources import get_fetcher

ASSETS = ("BTC", "ETH", "SOL")


# ---------------------------------------------------------------- hyperliquid
def test_hl_ok_units_and_clamp():
    r = get_fetcher("hyperliquid")(ASSETS, FakeTransport(
        [("api.hyperliquid.xyz", 200, fx_bytes("hl_ok.json"))]), RUN_ID, COLLECTED)
    assert not r.gaps
    by_asset = {o["asset"]: o for o in r.observations}
    btc = by_asset["BTC"]
    assert btc["metrics"]["funding_rate_native"] == 0.0000125
    assert btc["metrics"]["funding_interval_hours"] == 1
    assert btc["metrics"]["funding_rate_apr"] == pytest.approx(0.1095)
    assert btc["metrics"]["at_clamp_reference"] is True
    assert "cap-saturated" in " ".join(btc["quality"]["warnings"])
    assert btc["unit_conventions"]["positive_means"] == "longs_pay_shorts"
    # SOL was forced off-clamp in the fixture
    sol = by_asset["SOL"]
    assert sol["metrics"]["at_clamp_reference"] is False
    assert sol["metrics"]["funding_rate_apr"] == pytest.approx(0.08163, rel=1e-3)
    # OI context: native + USD estimate both present, USD flagged as estimate
    assert btc["metrics"]["open_interest_native"] is not None
    assert btc["metrics"]["open_interest_usd_estimate"] is not None


def test_hl_wrong_shape_is_malformed_gap_not_crash():
    r = get_fetcher("hyperliquid")(ASSETS, FakeTransport(
        [("api.hyperliquid.xyz", 200, fx_bytes("hl_wrong_shape.json"))]),
        RUN_ID, COLLECTED)
    assert not r.observations
    assert len(r.gaps) == 3
    assert all(g["quality"]["gap_reason"] == config.GAP_MALFORMED for g in r.gaps)


def test_hl_misaligned_universe_is_malformed():
    r = get_fetcher("hyperliquid")(ASSETS, FakeTransport(
        [("api.hyperliquid.xyz", 200, fx_bytes("hl_misaligned.json"))]),
        RUN_ID, COLLECTED)
    assert not r.observations and len(r.gaps) == 3


def test_hl_missing_asset_is_gap():
    r = get_fetcher("hyperliquid")(("DOGE",), FakeTransport(
        [("api.hyperliquid.xyz", 200, fx_bytes("hl_ok.json"))]), RUN_ID, COLLECTED)
    assert not r.observations
    assert r.gaps[0]["quality"]["gap_reason"] == config.GAP_ASSET_MISSING


# ---------------------------------------------------------------------- bybit
def test_bybit_ok_interval_assumed_and_oi():
    r = get_fetcher("bybit")(("BTC",), FakeTransport(
        [("api.bybit.com", 200, fx_bytes("bybit_ok.json"))]), RUN_ID, COLLECTED)
    assert not r.gaps
    btc = r.observations[0]
    assert btc["metrics"]["funding_rate_native"] == pytest.approx(0.00005273)
    assert btc["metrics"]["funding_interval_assumed"] is True
    assert btc["metrics"]["funding_rate_apr"] == pytest.approx(0.05773935)
    assert btc["metrics"]["next_funding_ts_utc"] == "2026-10-20T08:00:00Z"


def test_bybit_symbol_absent_is_gap():
    r = get_fetcher("bybit")(("ETH",), FakeTransport(
        [("api.bybit.com", 200, fx_bytes("bybit_empty_list.json"))]),
        RUN_ID, COLLECTED)
    assert not r.observations
    assert r.gaps[0]["quality"]["gap_reason"] == config.GAP_ASSET_MISSING


def test_bybit_retcode_error_is_malformed():
    body = json.dumps({"retCode": 10001, "retMsg": "err", "result": {"list": None}})
    r = get_fetcher("bybit")(("BTC",), FakeTransport(
        [("api.bybit.com", 200, body.encode())]), RUN_ID, COLLECTED)
    assert r.gaps[0]["quality"]["gap_reason"] == config.GAP_MALFORMED


# ------------------------------------------------------------------------ okx
def _okx_transport():
    return FakeTransport([
        ("public/funding-rate", 200, fx_bytes("okx_funding_ok.json")),
        ("public/open-interest", 200, fx_bytes("okx_oi_ok.json")),
        ("market/ticker", 200, fx_bytes("okx_ticker_ok.json")),
    ])


def test_okx_ok_with_clamp_flag():
    r = get_fetcher("okx")(("BTC",), _okx_transport(), RUN_ID, COLLECTED)
    assert not r.gaps
    o = r.observations[0]
    assert o["metrics"]["funding_rate_native"] == pytest.approx(0.0001)
    assert o["metrics"]["at_clamp_reference"] is True
    assert o["metrics"]["open_interest_unit"] == "BTC"
    assert o["metrics"]["mark_price"] == pytest.approx(82068)
    assert o["source_instrument"] == "BTC-USDT-SWAP"


def test_okx_oi_failure_degrades_to_warning_not_gap():
    rules = [
        ("public/funding-rate", 200, fx_bytes("okx_funding_ok.json")),
        ("public/open-interest", 503, b"boom"),
        ("market/ticker", 200, fx_bytes("okx_ticker_ok.json")),
    ]
    r = get_fetcher("okx")(("BTC",), FakeTransport(rules), RUN_ID, COLLECTED)
    assert len(r.observations) == 1
    o = r.observations[0]
    assert o["metrics"]["open_interest_native"] is None
    assert any("open-interest endpoint failed" in w
               for w in o["quality"]["warnings"])


# ----------------------------------------------------------------------- gate
def test_gate_explicit_interval_not_assumed():
    r = get_fetcher("gate")(("BTC",), FakeTransport(
        [("api.gateio.ws", 200, fx_bytes("gate_ok.json"))]), RUN_ID, COLLECTED)
    o = r.observations[0]
    assert o["metrics"]["funding_interval_hours"] == 8.0
    assert o["metrics"]["funding_interval_assumed"] is False
    assert o["metrics"]["open_interest_usd_estimate"] is None  # null stays null


# --------------------------------------------------------------------- bitget
def test_bitget_clamp_flagged():
    r = get_fetcher("bitget")(("BTC",), FakeTransport(
        [("api.bitget.com", 200, fx_bytes("bitget_ok.json"))]), RUN_ID, COLLECTED)
    o = r.observations[0]
    assert o["metrics"]["funding_rate_native"] == pytest.approx(0.0001)
    assert o["metrics"]["at_clamp_reference"] is True


# -------------------------------------------------------------------- binance
def test_binance_418_is_recorded_gap_never_zero():
    r = get_fetcher("binance")(ASSETS, FakeTransport(
        [("fapi.binance.com", 418, b"<html>418</html>")]), RUN_ID, COLLECTED)
    assert not r.observations
    assert len(r.gaps) == 3
    for g in r.gaps:
        assert g["quality"]["gap_reason"] == config.GAP_HTTP_ERROR
        assert "418" in g["quality"]["detail"]
        assert g["metrics"] == {}


def test_binance_ok_filters_symbols_and_uses_server_time():
    r = get_fetcher("binance")(("BTC",), FakeTransport(
        [("fapi.binance.com", 200, fx_bytes("binance_ok.json"))]), RUN_ID, COLLECTED)
    assert len(r.observations) == 1
    o = r.observations[0]
    assert o["observation_ts_utc"] == "2026-10-20T00:00:00Z"
    assert o["observation_ts_basis"] == "source_reported_time"
    assert o["metrics"]["funding_rate_native"] == pytest.approx(0.0001)


# ----------------------------------------------------------------------- mexc
def test_mexc_403_is_recorded_gap():
    r = get_fetcher("mexc")(ASSETS, FakeTransport(
        [("contract.mexc.com", 403, b"forbidden")]), RUN_ID, COLLECTED)
    assert not r.observations
    assert all(g["quality"]["gap_reason"] == config.GAP_HTTP_ERROR for g in r.gaps)


# --------------------------------------------------------------------- sharpe
def test_sharpe_reference_rows_and_hl_cross_exchange():
    rules = [
        ("funding/rates", 200, fx_bytes("sharpe_funding_ok.json")),
        ("cross-exchange", 200, fx_bytes("sharpe_cross_ok.json")),
    ]
    r = get_fetcher("sharpe")(ASSETS, FakeTransport(rules), RUN_ID, COLLECTED)
    funding_refs = [o for o in r.observations
                    if o["metric_group"] == "funding_reference"]
    cross_refs = [o for o in r.observations
                  if o["metric_group"] == "cross_exchange_reference"]
    assert funding_refs and cross_refs
    apex = next(o for o in funding_refs if "ApeX" in o["source_instrument"])
    assert apex["metrics"]["funding_rate_native"] == pytest.approx(0.0000125)
    assert apex["metrics"]["funding_interval_hours"] == 1
    assert apex["observation_ts_basis"] == "source_updated_at"
    btc_cross = next(o for o in cross_refs if o["asset"] == "BTC")
    assert btc_cross["metrics"]["net_apr_reference"] is not None
    assert "never substitute" in " ".join(btc_cross["quality"]["warnings"])


# ----------------------------------------------------------------------- vooi
def test_vooi_absence_of_majors_is_honest_gap():
    r = get_fetcher("vooi")(ASSETS, FakeTransport(
        [("perps-api.vooi.io", 200, fx_bytes("vooi_no_majors.json"))]),
        RUN_ID, COLLECTED)
    assert not r.observations
    assert len(r.gaps) == 3
    assert all(g["quality"]["gap_reason"] == config.GAP_ASSET_MISSING
               for g in r.gaps)


def test_vooi_context_row_with_at_size():
    r = get_fetcher("vooi")(("BTC",), FakeTransport(
        [("perps-api.vooi.io", 200, fx_bytes("vooi_btc_ok.json"))]),
        RUN_ID, COLLECTED)
    o = r.observations[0]
    assert o["metrics"]["price_spread_at_size"] == pytest.approx(0.0003)
    assert o["metrics"]["funding_rate_native"] is None  # context row, no rate
