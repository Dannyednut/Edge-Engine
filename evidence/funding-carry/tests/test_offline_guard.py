"""EI-STRAT-003 task 4: transport-level offline kill-switch for CI.

CI runs the suite with FUNDING_HARNESS_OFFLINE=1 so a real network attempt
raises at the transport layer instead of contacting anything. These tests
verify the structural guarantee (and that `collect` under the guard fails
closed into gap rows, never silently succeeding).
"""
from __future__ import annotations

import json

import pytest

from funding_harness import cli
from funding_harness.transport import (OFFLINE_ENV_VAR, TransportBlockedError,
                                       UrllibTransport)


def test_offline_env_blocks_all_network(monkeypatch):
    monkeypatch.setenv(OFFLINE_ENV_VAR, "1")
    transport = UrllibTransport()
    with pytest.raises(TransportBlockedError) as excinfo:
        transport.request("https://api.hyperliquid.xyz/info",
                          method="POST", body={"type": "metaAndAssetCtxs"})
    message = str(excinfo.value)
    assert OFFLINE_ENV_VAR in message
    assert "api.hyperliquid.xyz" in message


def test_guard_is_inert_without_the_env_var(monkeypatch):
    # no network call is made here: a blocked-URL scheme fails at connect
    # time inside urllib and is returned as a normal failed HttpResult, which
    # proves the guard itself did not raise when the env var is absent
    monkeypatch.delenv(OFFLINE_ENV_VAR, raising=False)
    transport = UrllibTransport(timeout_s=5.0)
    result = transport.request("https://funding-harness-guard.invalid/x")
    assert result.status is None                       # network-level failure
    assert result.error and "TransportBlockedError" not in result.error


def test_collect_under_offline_guard_writes_gaps_never_network(tmp_path,
                                                               monkeypatch):
    monkeypatch.setenv(OFFLINE_ENV_VAR, "1")
    rc = cli.main(["--base-dir", str(tmp_path), "collect"])
    assert rc in (1, 2)                # recorded-with-gaps or hard failure
    run_dirs = sorted((tmp_path / "runs").iterdir())
    assert run_dirs, "the run must still be recorded (fail-closed, not silent)"
    gaps = []
    for line in (run_dirs[0] / "gaps.jsonl").read_text().splitlines():
        if line.strip():
            gaps.append(json.loads(line))
    assert gaps, "blocked sources must become explicit gap rows"
    reasons = {g["quality"]["gap_reason"] for g in gaps}
    assert "source_exception" in reasons
