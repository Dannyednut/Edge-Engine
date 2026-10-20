"""EI-STRAT-004 task 2: the hash-locked completeness-definition string is
LEGACY metadata — the effective calculation is the fixed pre-registered
14-day window (28 slots).

Regression context: EI-STRAT-003 fixed the denominator to the pre-registered
28-slot window, but GATE_CONFIG["completeness_definition"] still carries the
pre-audit string "(days_spanned * samples_per_day)". GATE_CONFIG is
hash-locked (gate_config_sha256), so the string CANNOT be edited here;
instead the stats report must state unambiguously that the hash-locked
string is legacy metadata and that the effective calculation is the fixed
window — without ever making the report self-contradictory.
"""
from __future__ import annotations

import pytest

from funding_harness import config
from funding_harness.stats import compute_report
from tests.test_gate_window import _write_window_majors

LEGACY_STRING = (
    "per asset: distinct 12h collection slots with >=1 complete paired "
    "observation / (days_spanned * samples_per_day)")
PREREGISTERED_HASH = \
    "d4f346105ca30d096ba0bba0cb48079114b58ef185c504f54b4eec91435ad46c"


def _single_slot_base(tmp_path):
    base, _ = _write_window_majors(tmp_path, days=1, skip_slots={(0, 14)})
    return base


def test_hash_locked_completeness_string_and_gate_hash_unchanged():
    # GATE_CONFIG is NOT edited by EI-STRAT-004: the legacy string and the
    # pre-registered hash are byte-identical.
    assert config.GATE_CONFIG["completeness_definition"] == LEGACY_STRING
    assert config.gate_config_sha256() == PREREGISTERED_HASH


def test_report_labels_legacy_string_and_states_effective_calculation(
        tmp_path):
    report = compute_report(_single_slot_base(tmp_path))

    meta = report["completeness_definition_metadata"]
    assert meta["hash_locked_string"] == LEGACY_STRING
    assert "legacy" in meta["string_status"]
    # the explanation must be unambiguous: legacy string, hash-locked,
    # effective calculation is the fixed window, changes need approval
    assert "hash-locked" in meta["explanation"]
    assert "fixed pre-registered 14-day window" in meta["explanation"]
    assert "days_spanned * samples_per_day" in meta["explanation"]
    assert "explicit Instructor approval" in meta["explanation"]
    assert meta["gate_config_sha256"] == PREREGISTERED_HASH

    eff = report["completeness_definition_effective"]
    assert "28" in eff
    assert "fixed pre-registered 14-day window" in eff
    assert "days_spanned" not in eff

    # the report itself is computed under the pre-registered hash
    assert report["gate_config_sha256"] == PREREGISTERED_HASH
    a = report["per_asset"]["BTC"]
    assert a["completeness_basis"] == "fixed_preregistered_window_eistrat003"


def test_report_numbers_follow_effective_definition_not_legacy(tmp_path):
    # A one-day, one-slot sample: the LEGACY string would give
    # 1 slot / (1 day * 2) = 0.5; the effective fixed window gives 1/28.
    report = compute_report(_single_slot_base(tmp_path))
    a = report["per_asset"]["BTC"]
    assert a["expected_slots"] == 28
    assert a["completeness_denominator_slots"] == 28
    assert a["sample_completeness"] == pytest.approx(1 / 28, abs=1e-4)
    assert a["sample_completeness"] != pytest.approx(0.5)

    # The legacy formula string must appear ONLY inside the labeled legacy
    # metadata block — never as the operative definition elsewhere in the
    # report (no self-contradictory report).
    assert "days_spanned * samples_per_day" not in \
        report["coverage_statement"]
    for asset, fields in report["per_asset"].items():
        for key, value in fields.items():
            if isinstance(value, str):
                assert "days_spanned * samples_per_day" not in value, \
                    (asset, key)
    assert report["verdict_reasons"]  # sanity: verdict still reasons-labeled
