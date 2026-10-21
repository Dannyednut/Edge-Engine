"""EI-STRAT-006: safe anchor-selection guidance — documentation regression.

The runbook's practical guidance must reconcile the generic slot-boundary
heuristic with the KNOWN pre-authorization pilot (real sample: run
`20261020T045654Z`, collected 2026-10-20T04:56:54Z):

  1. A valid authorized anchor is exactly 00:00:00Z or 12:00:00Z on some
     UTC date (slot-aligned; `stats` refuses anything else, exit 4).
  2. It must be STRICTLY LATER than every pre-authorization observation.
     The slot boundary 2026-10-20T00:00:00Z is INVALID despite being
     aligned: it predates the pilot and would admit it into the first
     slot. The generic "first collection ~08:00-10:00Z -> anchor
     00:00:00Z that day" pattern is conditional, never a rule by itself.
  3. It is selected as part of an explicit authorization act — never
     inferred from the pilot, never backdated from the first observed
     collection, never derived from exploratory timing.
  4. The historical demo anchor 2026-10-20T12:00:00Z (EI-STRAT-005
     read-only verification) is NOT an authorized start and MUST NOT be
     presented or reused as a usable future start.
  5. The intended first collection is an observed event at or after the
     anchor; it never changes the window boundaries.

The core distinction pinned here: slot alignment is necessary but NOT
sufficient. `_require_slot_aligned` accepts both 2026-10-20T00:00:00Z and
2026-10-20T12:00:00Z (both are boundaries); the ordering rule against
pre-authorization samples — and the authorization act itself — are what
separate a valid anchor from the predating boundary and the demo. These
tests keep the runbook wording honest so the guidance cannot silently
regress to the pre-EI-STRAT-006 unconditional suggestion.

No authorized timestamp is selected or announced anywhere in this task;
the actual anchor decision rests with the Principal.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from funding_harness.stats import _require_slot_aligned

RUNBOOK = Path(__file__).resolve().parents[1] / "RUNBOOK.md"

PILOT_TS = "2026-10-20T04:56:54Z"                 # the real pre-authorization pilot
PILOT_PREDATING_BOUNDARY = "2026-10-20T00:00:00Z"  # slot-aligned but INVALID
DEMO_ANCHOR = "2026-10-20T12:00:00Z"               # slot-aligned but demo-only


def _runbook_text() -> str:
    return RUNBOOK.read_text(encoding="utf-8")


def _normalized() -> str:
    """Whitespace-normalized runbook text (phrase asserts survive reflow)."""
    return " ".join(_runbook_text().split())


def _ts(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def test_runbook_requires_a_valid_slot_boundary():
    text = _normalized()
    assert "exactly `00:00:00Z` or `12:00:00Z`" in text
    # Alignment is stated as necessary but NOT sufficient (EI-STRAT-006).
    assert "Alignment is necessary but NOT sufficient" in text


def test_runbook_marks_the_pilot_predating_boundary_invalid():
    text = _normalized()
    # The distinction the task names: a valid slot-aligned anchor vs one
    # that predates the known pilot.
    assert PILOT_PREDATING_BOUNDARY in text
    assert PILOT_TS in text
    assert "makes `2026-10-20T00:00:00Z` INVALID" in text
    assert "predates the pilot" in text
    assert "would admit the pilot into the first slot" in text


def test_runbook_makes_the_generic_same_day_pattern_conditional():
    text = _normalized()
    # The generic suggestion survives only as a CONDITIONAL pattern.
    assert (
        "anchor `00:00:00Z` that day" in text  # the generic pattern, named
    )
    assert "conditional, never a rule by itself" in text
    # The pre-EI-STRAT-006 unconditional phrasing is gone.
    assert "Practically: pick the slot boundary" not in text


def test_runbook_requires_explicit_authorization_not_backdating():
    text = _normalized()
    assert "selected as part of explicit authorization" in text
    assert "never inferred from the pilot" in text
    assert "never backdated from the first observed collection" in text
    assert "never derived from exploratory timing" in text
    assert "BEFORE the first authorized `collect`" in text


def test_runbook_marks_the_demo_anchor_not_authorized():
    text = _normalized()
    assert DEMO_ANCHOR in text
    assert "is NOT an authorized start" in text
    assert "MUST NOT be presented or reused as a usable future start" in text


def test_runbook_first_collection_is_an_observed_event_never_moves_the_window():
    text = _normalized()
    assert "an observed event at or after the anchor" in text
    assert "It never changes the window boundaries" in text
    assert "regardless of when the first collection actually lands" in text


def test_runbook_reserves_the_anchor_decision_for_the_principal():
    text = _normalized()
    assert "the actual anchor decision rests with the Principal" in text


def test_runbook_section_covers_eistrat006():
    text = _normalized()
    assert "EI-STRAT-004/005/006 — read before any authorized run" in text


def test_slot_alignment_alone_accepts_the_invalid_boundaries():
    # Functional half of the documentation rule: BOTH the pilot-predating
    # boundary and the demo anchor pass the alignment gate — alignment is
    # necessary but NOT sufficient. The ordering rule against
    # pre-authorization samples (and the explicit authorization act) is
    # the discriminator, which is exactly why the runbook states it.
    _require_slot_aligned(_ts(PILOT_PREDATING_BOUNDARY))   # aligned: no raise
    _require_slot_aligned(_ts(DEMO_ANCHOR))                # aligned: no raise
    # Yet the predating boundary is strictly BEFORE the pilot...
    assert _ts(PILOT_PREDATING_BOUNDARY) < _ts(PILOT_TS)
    # ...while a VALID anchor for this repository must be strictly AFTER
    # every pre-authorization observation — i.e. the ordering rule, not
    # alignment, is what rejects 2026-10-20T00:00:00Z.
    assert not (_ts(PILOT_TS) < _ts(PILOT_PREDATING_BOUNDARY))
