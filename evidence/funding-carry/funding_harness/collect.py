"""Collection orchestrator: one manual invocation = one run directory.

Order of operations: guard gate-config drift -> call each enabled source ->
dedupe/validate -> derive pairs -> persist via store.write_run -> summarize.
Any unexpected source exception becomes per-asset gap rows (source_exception)
and never aborts the whole run.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from . import config
from .pairing import build_pairs
from .sources import get_fetcher
from .store import PersistResult, utc_now_iso, utc_now_run_id, write_run
from pathlib import Path


class GateDriftError(RuntimeError):
    """Raised when the in-repo gate config does not match its pre-registered hash."""


@dataclass
class CollectOutcome:
    run_id: str
    started_utc: str
    per_source: dict = field(default_factory=dict)
    total_observations: int = 0
    total_gaps: int = 0
    total_pairs: int = 0
    persist: Optional[PersistResult] = None
    exit_code: int = 0

    def summary_lines(self) -> list[str]:
        lines = [
            f"run_id={self.run_id}",
            f"{'source':14s} {'obs':>4s} {'gaps':>5s}",
        ]
        for name, st in self.per_source.items():
            lines.append(f"{name:14s} {st['observations']:4d} {st['gaps']:5d}"
                         + (f"  <- {st['error']}" if st.get("error") else ""))
        lines.append(f"observations={self.total_observations} gaps={self.total_gaps} "
                     f"pairs={self.total_pairs} duplicates={len(self.persist.duplicates_ignored) if self.persist else 0}")
        if self.exit_code == 0:
            lines.append("RESULT: collection complete, no gaps")
        elif self.exit_code == 1:
            lines.append("RESULT: collection recorded WITH GAPS "
                         "(see gaps.jsonl / run_manifest.json; missing sources "
                         "are gaps, never zero-filled)")
        else:
            lines.append("RESULT: HARD FAILURE — no complete observation was "
                         "collectable; nothing usable this slot")
        return lines


def run_collection(cfg: config.HarnessConfig, transport) -> CollectOutcome:
    expected = config.gate_config_sha256()
    if cfg.snapshot()["gate_config_sha256"] != expected:
        raise GateDriftError("HarnessConfig gate snapshot drifted from the "
                             "pre-registered GATE_CONFIG; refusing to collect.")

    run_id = utc_now_run_id()
    started = utc_now_iso()
    outcome = CollectOutcome(run_id=run_id, started_utc=started)

    source_results = []
    for name in cfg.sources:
        fetcher = get_fetcher(name)
        try:
            sr = fetcher(cfg.assets, transport, run_id, started)
        except Exception as exc:  # unexpected adapter crash -> explicit gaps
            from .sources.base import SourceResult
            from .models import make_gap
            sr = SourceResult(source=name)
            for a in cfg.assets:
                sr.gaps.append(make_gap(
                    run_id=run_id, collected_at_utc=started, source=name,
                    asset=a, source_instrument=a, metric_group="funding",
                    gap_reason=config.GAP_SOURCE_EXCEPTION,
                    detail=f"{type(exc).__name__}: {exc}", evidence={}))
            sr.notes.append(f"adapter raised {type(exc).__name__}")
        source_results.append(sr)
        outcome.per_source[name] = {
            "observations": len(sr.observations),
            "gaps": len(sr.gaps),
            "error": next((g["quality"]["detail"] for g in sr.gaps
                           if g["quality"]["gap_reason"] == config.GAP_HTTP_ERROR),
                          None),
        }

    pairs = build_pairs([o for sr in source_results for o in sr.observations],
                        run_id, started)
    snapshot = cfg.snapshot()
    snapshot["run_started_utc"] = started
    persist = write_run(base_dir=Path(cfg.base_dir), run_id=run_id,
                        started_utc=started, config_snapshot=snapshot,
                        source_results=source_results, pairs=pairs)
    outcome.persist = persist
    outcome.total_observations = persist.observations_written
    outcome.total_gaps = persist.gaps_written
    outcome.total_pairs = persist.pairs_written

    if outcome.total_observations == 0:
        outcome.exit_code = 2
    elif outcome.total_gaps > 0:
        outcome.exit_code = 1
    else:
        outcome.exit_code = 0
    return outcome
