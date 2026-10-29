"""Offline test fixtures built from REAL payloads captured by the EI-STRAT-002
reachability probe (2026-10-20T04:29Z), trimmed/bounded for repo size.
Provenance: download/edge-intelligence/evidence/EI-STRAT-002/probe/ (outside
the repo; this directory holds bounded extracts for unit tests only)."""
from __future__ import annotations

import json
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))
