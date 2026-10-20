"""Unit conversions — the correctness backbone of every downstream number."""
from __future__ import annotations

import pytest

from funding_harness.convert import (ConversionError, apr_pct, funding_apr,
                                     is_at_clamp, iso_to_utc_slot12, ms_to_iso_utc,
                                     rate_8h_equivalent, safe_float,
                                     s_to_iso_utc)


def test_hourly_to_apr_matches_eistrat001_unit_check():
    # EI-STRAT-001 [O]: HL 0.0000125/h == +10.95% APR
    assert funding_apr(0.0000125, 1) == pytest.approx(0.1095)


def test_8h_to_apr_same_anchor():
    # 1e-4 per 8h is the identical 10.95% APR observed on OKX/Bitget
    assert funding_apr(0.0001, 8) == pytest.approx(0.1095)


def test_4h_interval():
    assert funding_apr(0.00005, 4) == pytest.approx(0.1095)


def test_negative_rate_preserves_sign():
    assert funding_apr(-0.0000531, 8) == pytest.approx(-0.0581445)


def test_apr_pct():
    assert apr_pct(0.1095) == pytest.approx(10.95)


def test_8h_equivalent():
    assert rate_8h_equivalent(0.0000125, 1) == pytest.approx(0.0001)
    assert rate_8h_equivalent(0.0001, 8) == pytest.approx(0.0001)


def test_safe_float_variants():
    assert safe_float("0.0001") == 0.0001
    assert safe_float(" 0.0001 ") == 0.0001
    assert safe_float(0) == 0.0
    assert safe_float(None) is None
    assert safe_float("") is None
    assert safe_float("null") is None
    assert safe_float("NaN") is None
    with pytest.raises(ConversionError):
        safe_float("abc")
    with pytest.raises(ConversionError):
        safe_float(True)
    with pytest.raises(ConversionError):
        safe_float(float("inf"))


def test_non_positive_interval_rejected():
    with pytest.raises(ConversionError):
        funding_apr(0.0001, 0)


def test_clamp_detection_exact():
    assert is_at_clamp(0.0000125, 0.0000125)
    assert is_at_clamp(float("0.0000125000000"), 0.0000125)
    assert not is_at_clamp(0.0000093187, 0.0000125)
    assert not is_at_clamp(None, 0.0000125)


def test_ms_and_s_to_iso():
    assert ms_to_iso_utc(1792483200000) == "2026-10-20T08:00:00Z"
    assert s_to_iso_utc(1792483200) == "2026-10-20T08:00:00Z"
    assert ms_to_iso_utc(None) is None


def test_slot12_keys():
    assert iso_to_utc_slot12("2026-11-01T08:00:00Z") == "2026-11-01T00Z"
    assert iso_to_utc_slot12("2026-11-01T12:00:00Z") == "2026-11-01T12Z"
    assert iso_to_utc_slot12("2026-11-01T23:59:59Z") == "2026-11-01T12Z"
