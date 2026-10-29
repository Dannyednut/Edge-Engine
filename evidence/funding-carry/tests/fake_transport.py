"""Shared offline transport + helpers for the harness test suite."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

PKG_DIR = Path(__file__).resolve().parent.parent
if str(PKG_DIR) not in sys.path:
    sys.path.insert(0, str(PKG_DIR))

from funding_harness.sources.base import RawEntry, SourceResult  # noqa: E402
from funding_harness.transport import HttpResult  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def fx_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


class FakeTransport:
    """Scripted transport: list of (url_contains, status, body). Records calls.
    First matching rule wins; unmatched URLs -> connection error."""

    def __init__(self, rules, default_status=None, default_body=b""):
        self.rules = list(rules)
        self.calls: list[str] = []
        self.default_status = default_status
        self.default_body = default_body

    def request(self, url, method="GET", body=None, timeout_s=None):
        self.calls.append(f"{method} {url}")
        for contains, status, payload in self.rules:
            if contains in url:
                return HttpResult(url=url, method=method, status=status,
                                  body=payload, elapsed_ms=1)
        if self.default_status is not None:
            return HttpResult(url=url, method=method, status=self.default_status,
                              body=self.default_body, elapsed_ms=1)
        return HttpResult(url=url, method=method, status=None, body=b"",
                          elapsed_ms=1, error="ConnectionError: unmatched url "
                          "(fake transport)")


RUN_ID = "20261101T080000Z"
COLLECTED = "2026-11-01T08:00:00Z"
