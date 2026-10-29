"""Derived statistics + the PRE-REGISTERED decision-gate engine.

Reads every run under data/runs, rebuilds the paired series, computes the
EI-STRAT-001 §4.2 gate metrics and returns a verdict:

  PASS      median net APR > +3% AND daily persistence >= 70% AND flips <= 2
  FAIL      median net APR < +1.5% OR flips > 2
  BETWEEN_THRESHOLDS  coverage adequate but median sits between 1.5% and 3%
            with <= 2 flips (the pre-registered gate defines neither pass nor
            fail here; decision returned to the Instructor)
  UNRESOLVED  coverage insufficient — evaluation window not fully elapsed
            (< 14 consecutive days), completeness < 85%, fewer than 3 majors
            with adequate CEX-leg coverage, or no paired series — never
            reported as a pass

Completeness basis (EI-STRAT-003 methodology audit): the denominator is
ALWAYS the fixed pre-registered window size (14 days x 2 slots/day = 28
slots), anchored at the series start — never the observed date span — so
unobserved periods can never disappear from the denominator. A single-slot
initial sample is 1/28 = 3.6%, not 1/2 = 50%. The observed span is reported
separately as a diagnostic only.

Overall verdict precedence (EI-STRAT-003): fewer than 3 majors with adequate
CEX-leg coverage => UNRESOLVED before any PASS/FAIL/BETWEEN mapping (per-
asset diagnostics remain visible in per_asset).

Authorized-start boundary (EI-STRAT-004): an explicit --window-start is the
Instructor-authorized series start and is applied as an EXACT UTC timestamp
against each pair's/observation's actual collected_at_utc BEFORE slot
aggregation/deduplication — a pre-authorization sample collected on the same
UTC date (even in the same 12h slot) can never contribute to the authorized
series. Excluded rows are counted and disclosed in the report; the underlying
runs are never modified or deleted. The default anchor (earliest run
timestamp) is diagnostic only and is labeled in every report as NOT an
authorized series start (the earliest run may be the pre-authorization
pilot).

Completeness-definition metadata (EI-STRAT-004): the hash-locked
GATE_CONFIG["completeness_definition"] string (".../(days_spanned *
samples_per_day)") is LEGACY pre-registration metadata, superseded by the
fixed pre-registered window above. GATE_CONFIG is hash-locked, so the string
is retained verbatim; every report carries an explicit legacy-status block
(completeness_definition_metadata) plus the effective definition
(completeness_definition_effective) so the legacy string can never be read
as the operative calculation.

Authorized window semantics (EI-STRAT-005): the pre-registered design is a
FIXED 14-DAY UTC SLOT WINDOW — the 28 consecutive 12h UTC slots
[anchor, anchor + 14 days). An explicit --window-start is the GATE-WINDOW
ANCHOR (the Instructor-authorized boundary from which the grid is derived),
never the time of the first actual collection (an observed fact, disclosed
separately, that never moves the grid). The anchor must be SLOT-ALIGNED —
exactly 00:00:00Z or 12:00:00Z; a non-aligned value is refused BEFORE any
computation (WindowAnchorError; CLI exit 4) with the nearest boundaries
named, never floored silently. Slot alignment makes the alternative
reading — 14 full elapsed days from the exact authorized timestamp —
describe the IDENTICAL interval (for a non-aligned 08:00Z start the
floor-12h grid would end 13 days 16 hours = 328h after the exact start,
8h short of 14 elapsed days), so the fixed 28-slot denominator, GATE_CONFIG
and its hash are preserved unchanged. Exact record-timestamp filtering is
retained (inclusive lower / exclusive upper, second resolution).

Threshold immutability: every run manifest embeds gate_config_sha256; if any
run (or this module) disagrees with the pre-registered hash, stats refuses to
produce a report (GateDriftError) instead of comparing against drifted
thresholds.
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from typing import Optional

from . import config
from .collect import GateDriftError
from .convert import iso_date, iso_to_utc_slot12
from .pairing import build_pairs, dedupe_slots


def _slot_dt(slot_label: str) -> datetime:
    """'YYYY-MM-DDT00Z|12Z' slot key -> aware UTC datetime of slot start."""
    return datetime.strptime(slot_label, "%Y-%m-%dT%HZ").replace(
        tzinfo=timezone.utc)


class WindowAnchorError(ValueError):
    """Raised when --window-start is not a slot-aligned UTC slot boundary.

    EI-STRAT-005: authorized gate-window anchors must be exactly 00:00:00Z
    or 12:00:00Z. A non-aligned anchor would apply the exact row cutoff
    inside the first slot while the 28-slot grid still starts at floor-12h
    (for an 08:00Z start the grid end would sit 13 days 16 hours = 328h
    after the exact start — 8h short of 14 full elapsed days), so the
    window would match neither pre-registered reading. The tool refuses
    (fail closed) instead of flooring the value silently.
    """

VERDICT_PASS = "PASS"
VERDICT_FAIL = "FAIL"
VERDICT_BETWEEN = "BETWEEN_THRESHOLDS"
VERDICT_UNRESOLVED = "UNRESOLVED"


def _parse_ts(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _require_slot_aligned(boundary: datetime) -> None:
    """EI-STRAT-005: authorized anchors must sit on a 12h UTC slot boundary.

    A slot-aligned anchor makes floor-12h an identity operation, so the
    grid start IS the exact authorized anchor and the grid end IS
    anchor + 14 full days (also slot-aligned). Then the pre-registered
    reading — a fixed 14-day UTC slot window whose exact lower cutoff is
    the anchor — and the alternative reading — 14 full elapsed days from
    the exact authorized timestamp — describe the IDENTICAL interval, and
    the fixed 28-slot denominator and gate hash are preserved unchanged.
    """
    if (boundary.hour in (0, 12) and boundary.minute == 0
            and boundary.second == 0 and boundary.microsecond == 0):
        return
    day0 = boundary.replace(hour=0, minute=0, second=0, microsecond=0)
    prev_boundary = day0 if boundary.hour < 12 else day0 + timedelta(hours=12)
    next_boundary = prev_boundary + timedelta(hours=12)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    raise WindowAnchorError(
        f"--window-start {boundary.strftime(fmt)} is not slot-aligned. "
        "The authorized gate-window anchor must be exactly 00:00:00Z or "
        "12:00:00Z so the fixed 28-slot grid [anchor, anchor + 14 days) "
        "coincides with 14 full elapsed days from the exact authorized "
        "timestamp; a non-aligned start would apply an exact row cutoff "
        "inside the first slot while the grid still starts at its "
        "floor-12h (e.g. an 08:00Z start would end 13 days 16 hours = "
        "328h after the exact start — 8h short of 14 elapsed days). "
        "Re-anchor to the containing or next slot boundary: "
        f"{prev_boundary.strftime(fmt)} or {next_boundary.strftime(fmt)} "
        "(EI-STRAT-005; nothing was floored silently).")


def preregistered_window_slots(g: dict) -> int:
    """Fixed completeness denominator: window_days_min x samples_per_day = 28.

    EI-STRAT-003 audit fix: the denominator is the pre-registered window size
    and is NEVER derived from the observed date span, so unobserved periods
    always stay in the denominator (a single-slot initial sample is 1/28 =
    3.6%, not 1/2 = 50%).
    """
    return int(g["window_days_min"]) * int(g["samples_per_day"])


def _window_anchor(runs: list[dict], override: Optional[str]) -> Optional[str]:
    """UTC date ('YYYY-MM-DD') the pre-registered 14-day window starts on.

    Default anchor: the earliest run timestamp (manifest started_utc, with
    fallbacks to the run's first pair / observation). An explicit override
    (CLI --window-start) pins the Instructor-authorized series start; the
    override is additionally applied as an EXACT UTC timestamp boundary
    against every record's collected_at_utc BEFORE slot aggregation (see
    compute_report — EI-STRAT-004), so pre-start samples on the anchor date
    cannot contribute. Slots before the anchor are excluded from metrics and
    missing slots count against completeness (missing-beginning coverage
    cannot hide). The DEFAULT anchor is diagnostic only: it is NOT an
    authorized series start and reports label it as such.
    """
    if override:
        return _parse_ts(override).strftime("%Y-%m-%d")
    candidates = []
    for rec in runs:
        ts = (rec.get("manifest") or {}).get("started_utc")
        if not ts and rec["pairs"]:
            ts = rec["pairs"][0].get("collected_at_utc")
        if not ts and rec["observations"]:
            ts = rec["observations"][0].get("collected_at_utc")
        if ts:
            candidates.append(_parse_ts(ts).strftime("%Y-%m-%d"))
    return min(candidates) if candidates else None


def load_runs(base_dir: Path) -> list[dict]:
    runs_root = base_dir / "runs"
    if not runs_root.exists():
        return []
    out = []
    for run_dir in sorted(p for p in runs_root.iterdir() if p.is_dir()):
        rec: dict = {"run_dir": run_dir, "run_id": run_dir.name}
        manifest = run_dir / "run_manifest.json"
        rec["manifest"] = json.loads(manifest.read_text(encoding="utf-8")) \
            if manifest.exists() else None
        obs = _read_jsonl(run_dir / "observations.jsonl")
        pairs = _read_jsonl(run_dir / "pairs.jsonl")
        if not pairs and obs:
            pairs = build_pairs(obs, run_dir.name,
                                rec["manifest"]["started_utc"]
                                if rec["manifest"] else run_dir.name)
        rec["observations"] = obs
        rec["pairs"] = pairs
        rec["gaps"] = _read_jsonl(run_dir / "gaps.jsonl")
        out.append(rec)
    return out


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def check_gate_drift(runs: list[dict]) -> None:
    expected = config.gate_config_sha256()
    for rec in runs:
        manifest = rec.get("manifest") or {}
        snapshot_hash = ((manifest.get("config_snapshot") or {})
                         .get("gate_config_sha256"))
        if snapshot_hash != expected:
            raise GateDriftError(
                f"run {rec['run_id']} was collected under a different "
                f"gate configuration (manifest {snapshot_hash} != current "
                f"{expected}); refusing to compute gate metrics against "
                "altered thresholds")


def compute_report(base_dir: Path, *, window_days: int = 14,
                   window_start_utc: Optional[str] = None) -> dict:
    """Compute the gate report over the FIXED pre-registered 14-day window.

    ``window_days`` is diagnostic only (reported as window_requested_days);
    the gate window length is fixed by GATE_CONFIG and never changes.
    ``window_start_utc`` optionally pins the authorized series start (UTC);
    it is applied as an EXACT timestamp boundary against every record's
    collected_at_utc BEFORE slot aggregation (EI-STRAT-004). By default the
    window anchors at the earliest run timestamp — a diagnostic anchor that
    is NOT an authorized series start (see evaluation_window.anchor_note).
    """
    runs = load_runs(base_dir)
    check_gate_drift(runs)
    g = config.GATE_CONFIG

    # ---- authorized-start boundary (EI-STRAT-004) -------------------------
    # An explicit --window-start is the Instructor-authorized series start.
    # It is compared (inclusive >=) against each pair/observation/gap's
    # ACTUAL collected_at_utc at second resolution BEFORE slot aggregation /
    # deduplication, so a pre-authorization pilot sample collected on the
    # same UTC date — even inside the same 12h slot — can never contribute
    # to the authorized series. Excluded rows are counted and disclosed
    # below; the underlying runs are never modified or deleted.
    boundary_utc = _parse_ts(window_start_utc) if window_start_utc else None
    if boundary_utc is not None:
        # EI-STRAT-005: fail closed BEFORE any computation. --window-start
        # is the authorized GATE-WINDOW ANCHOR and must coincide with a 12h
        # UTC slot boundary; nothing about the report is produced otherwise.
        _require_slot_aligned(boundary_utc)

    def _in_authorized_series(ts: str) -> bool:
        return boundary_utc is None or _parse_ts(ts) >= boundary_utc

    # flatten (boundary-filtered)
    excluded_pairs: list[dict] = []
    all_pairs: list[dict] = []
    for rec in runs:
        for p in rec["pairs"]:
            (all_pairs if _in_authorized_series(p["collected_at_utc"])
             else excluded_pairs).append(p)
    all_obs = [o for rec in runs for o in rec["observations"]
               if _in_authorized_series(o["collected_at_utc"])]
    all_gaps = [gp for rec in runs for gp in rec["gaps"]
                if _in_authorized_series(gp["collected_at_utc"])]
    excluded_primary_slots = sorted({
        iso_to_utc_slot12(p["collected_at_utc"]) for p in excluded_pairs
        if p.get("primary_cex_leg")})

    report: dict = {
        "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tool": "funding-carry-evidence-harness",
        "gate_config_sha256": config.gate_config_sha256(),
        "runs_used": [rec["run_id"] for rec in runs],
        "gate": g,
    }

    if not runs:
        report.update({"verdict": VERDICT_UNRESOLVED,
                       "verdict_reasons": ["no collection runs exist yet"]})
        return report

    # ---- pre-registered evaluation window (fixed; EI-STRAT-003 audit) ----
    # Denominator is FIXED at window_days_min x samples_per_day = 28 slots;
    # it never derives from the observed date span.
    window_slots = preregistered_window_slots(g)
    gate_window_days = int(g["window_days_min"])
    anchor_date = _window_anchor(runs, window_start_utc)
    if anchor_date is None:
        report.update({"verdict": VERDICT_UNRESOLVED,
                       "verdict_reasons": ["cannot determine the window "
                                           "anchor: no run timestamps"]})
        return report
    # Slot grid: the 28 half-day slots starting at the window anchor. With
    # the EI-STRAT-005 slot-alignment validation above, floor-12h of an
    # explicit anchor is an IDENTITY operation: the grid start IS the exact
    # authorized anchor and the grid end IS anchor + 14 full days (also
    # slot-aligned) — both candidate readings of the pre-registered window
    # coincide. The default earliest-run anchor keeps its EI-STRAT-003
    # date semantics (midnight grid start); it is diagnostic-only.
    if boundary_utc is not None:
        first_slot_dt = boundary_utc.replace(minute=0, second=0,
                                             microsecond=0)
        first_slot_dt = first_slot_dt.replace(
            hour=12 if first_slot_dt.hour >= 12 else 0)
    else:
        d0 = date.fromisoformat(anchor_date)
        first_slot_dt = datetime(d0.year, d0.month, d0.day,
                                 tzinfo=timezone.utc)
    window_end_dt = first_slot_dt + timedelta(days=gate_window_days)
    window_end_exclusive = window_end_dt.date().isoformat()

    # ---- per-asset gate metrics ------------------------------------------
    per_asset = {}
    for asset in sorted({p["asset"] for p in all_pairs}):
        asset_pairs = [p for p in all_pairs if p["asset"] == asset]
        primary = [p for p in asset_pairs if p.get("primary_cex_leg")]
        slots_all = dedupe_slots([(iso_to_utc_slot12(p["collected_at_utc"]),
                                   p["net_apr_pre_registered"],
                                   p["collected_at_utc"]) for p in primary])
        # metrics use only slots inside the fixed evaluation-window grid;
        # slots outside are reported separately (never silently dropped or
        # merged). Grid membership is a datetime comparison on the slot
        # start (EI-STRAT-004), equivalent to the EI-STRAT-003 date-prefix
        # test for midnight-anchored windows.
        slots = [(s, v) for s, v in slots_all
                 if first_slot_dt <= _slot_dt(s) < window_end_dt]
        slots_outside = len(slots_all) - len(slots)
        days: dict[str, list[float]] = {}
        for slot, net in slots:
            days.setdefault(iso_date(slot), []).append(net)
        daily_medians = {d: median(v) for d, v in sorted(days.items())}
        eligible_days = sorted(daily_medians)
        positive_days = sum(1 for v in daily_medians.values() if v > 0)
        persistence = positive_days / len(eligible_days) if eligible_days else 0.0

        # sign flips between consecutive eligible days (zeros excluded)
        signs = [1 if v > 0 else (-1 if v < 0 else 0)
                 for v in daily_medians.values()]
        flips = 0
        last_nonzero = 0
        for s in signs:
            if s == 0:
                continue
            if last_nonzero != 0 and s != last_nonzero:
                flips += 1
            last_nonzero = s

        # Diagnostics only (legacy 'window_days_spanned' kept for report
        # continuity; NEITHER value feeds the completeness denominator):
        window_days_spanned = 0
        window_days_elapsed = 0
        if slots_all:
            observed_days = sorted({s[:10] for s, _ in slots_all})
            d0 = datetime.strptime(observed_days[0], "%Y-%m-%d").date()
            d1 = datetime.strptime(observed_days[-1], "%Y-%m-%d").date()
            window_days_spanned = (d1 - d0).days + 1
            window_days_elapsed = (d1 - date.fromisoformat(anchor_date)).days + 1
        expected_slots = window_slots            # FIXED 28 — EI-STRAT-003
        completeness = len(slots) / expected_slots if expected_slots else 0.0

        cex_legs = sorted({p["long_venue"] for p in primary}) or \
            sorted({p["long_venue"] for p in asset_pairs})
        hl_rows = [o for o in all_obs if o["source"] == "hyperliquid"
                   and o["asset"] == asset and o["metric_group"] == "funding"]
        clamp_share = (sum(1 for o in hl_rows
                           if o["metrics"].get("at_clamp_reference")) /
                       len(hl_rows)) if hl_rows else None

        # Sharpe third-party comparison (cross-exchange reference rows)
        sharpe_nets = [o["metrics"].get("net_apr_reference") for o in all_obs
                       if o["source"] == "sharpe"
                       and o["metric_group"] == "cross_exchange_reference"
                       and o["asset"] == asset
                       and o["metrics"].get("net_apr_reference") is not None]
        sharpe_median = median(sharpe_nets) if sharpe_nets else None

        measured_median = median([v for v in daily_medians.values()]) \
            if daily_medians else None

        verdict, reasons = _verdict_for(
            window_days_elapsed, completeness, len(eligible_days),
            measured_median, persistence, flips, bool(cex_legs), g)

        per_asset[asset] = {
            "window_days_spanned": window_days_spanned,
            "window_days_elapsed": window_days_elapsed,
            "window_start_utc": anchor_date,
            "window_end_utc_exclusive": window_end_exclusive,
            "n_slots_observed_total": len(slots_all),
            "slots_outside_evaluation_window": slots_outside,
            "eligible_days": eligible_days,
            "n_slots_with_complete_pair": len(slots),
            "expected_slots": expected_slots,
            "completeness_denominator_slots": window_slots,
            "completeness_basis": "fixed_preregistered_window_eistrat003",
            "sample_completeness": round(completeness, 4),
            "daily_median_net_apr_pre_registered": {
                d: round(v, 6) for d, v in daily_medians.items()},
            "median_net_apr_pre_registered": measured_median,
            "median_net_apr_pct": (round(measured_median * 100, 3)
                                   if measured_median is not None else None),
            "daily_persistence": round(persistence, 4),
            "positive_days": positive_days,
            "sign_flips": flips,
            "cex_leg_venues_observed": cex_legs,
            "hl_clamp_pinned_share": (round(clamp_share, 4)
                                      if clamp_share is not None else None),
            "sharpe_net_apr_median_reference": sharpe_median,
            "sharpe_delta_vs_measured": (
                round(sharpe_median - measured_median, 6)
                if (sharpe_median is not None and measured_median is not None)
                else None),
            "verdict": verdict,
            "verdict_reasons": reasons,
        }

    # ---- honest coverage / gaps summary ----------------------------------
    gap_summary: dict[str, dict[str, int]] = {}
    for gp in all_gaps:
        src = gp.get("source", "?")
        reason = gp.get("quality", {}).get("gap_reason", "?")
        gap_summary.setdefault(src, {}).setdefault(reason, 0)
        gap_summary[src][reason] += 1
    per_source_dates: dict[str, list[str]] = {}
    # built from the boundary-filtered observations (EI-STRAT-004): a source
    # date is listed only when an in-boundary complete observation exists
    for o in all_obs:
        per_source_dates.setdefault(o["source"], []).append(
            iso_date(o["collected_at_utc"]))

    report.update({
        "n_runs": len(runs),
        "window_requested_days": window_days,
        "evaluation_window": {
            "anchor_utc": anchor_date,
            "anchor_basis": ("authorized_start_override"
                             if boundary_utc is not None
                             else "default_earliest_run"),
            "authorized_boundary_utc": (
                boundary_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
                if boundary_utc is not None else None),
            "anchor_note": (
                "window anchored at the Instructor-authorized series start "
                "(--window-start), applied as an exact UTC timestamp "
                "against each record's collected_at_utc before slot "
                "aggregation; pre-start samples are excluded and disclosed "
                "below"
                if boundary_utc is not None else
                "window anchored at the earliest recorded run timestamp; "
                "this is NOT an authorized series start — the earliest run "
                "may be a pre-authorization pilot sample, and under this "
                "default anchor pre-start observations are included. Pass "
                "--window-start with the Instructor-authorized start before "
                "evaluating any authorized series"),
            "first_slot_utc": first_slot_dt.strftime("%Y-%m-%dT%HZ"),
            "end_utc_exclusive": window_end_exclusive,
            "end_slot_exclusive_utc": window_end_dt.strftime("%Y-%m-%dT%HZ"),
            "days": gate_window_days,
            "slots": window_slots,
            "grid_slots": window_slots,
            "denominator_basis": "fixed_preregistered_window (EI-STRAT-003)",
            "window_start_override": bool(window_start_utc),
            "pairs_before_boundary_excluded": len(excluded_pairs),
            "boundary_excluded_primary_slots": excluded_primary_slots,
        },
        "per_asset": per_asset,
        "gaps_summary": gap_summary,
        "source_dates_with_complete_observations": {
            k: sorted(set(v)) for k, v in per_source_dates.items()},
        "coverage_statement": _coverage_statement(per_asset, gap_summary),
    })

    # ---- completeness-definition metadata clarity (EI-STRAT-004) ----------
    # GATE_CONFIG is hash-locked, so its pre-audit completeness_definition
    # string cannot be edited; the report states its legacy status explicitly
    # so it can never be read as the operative definition.
    report["completeness_definition_effective"] = (
        "per asset: distinct 12h collection slots with >=1 complete paired "
        "observation inside the fixed pre-registered 14-day window, divided "
        "by window_days_min x samples_per_day = "
        f"{window_slots} (the denominator NEVER derives from the observed "
        "date span)")
    report["completeness_definition_metadata"] = {
        "hash_locked_string": g["completeness_definition"],
        "string_status": "legacy_preregistration_metadata_superseded",
        "explanation": (
            "The hash-locked GATE_CONFIG['completeness_definition'] string "
            "describes the pre-audit span-derived denominator "
            "(days_spanned * samples_per_day). It is LEGACY METADATA, "
            "superseded by the EI-STRAT-003 fixed pre-registered 14-day "
            "window (window_days_min x samples_per_day = "
            f"{window_slots} slots); the effective calculation never "
            "derives the denominator from the observed date span. The "
            "string is retained verbatim because GATE_CONFIG is hash-locked "
            "(gate_config_sha256); changing it would change the hash and "
            "requires explicit Instructor approval BEFORE any such change."),
        "effective_calculation": report["completeness_definition_effective"],
        "gate_config_sha256": report["gate_config_sha256"],
    }

    # ---- authorized window semantics (EI-STRAT-005) -----------------------
    # The pre-registered design is a FIXED 14-DAY UTC SLOT WINDOW: the 28
    # consecutive 12h UTC slots [anchor, anchor + 14 days). --window-start
    # is the GATE-WINDOW ANCHOR, never the time of the first actual
    # collection; because the anchor is validated slot-aligned above, the
    # alternative reading — 14 full elapsed days from the exact authorized
    # timestamp — describes the IDENTICAL interval, so the pre-registered
    # 28-slot interpretation holds without any gate change.
    if all_pairs:
        first_accepted_ts = min(p["collected_at_utc"] for p in all_pairs)
    elif all_obs:
        first_accepted_ts = min(o["collected_at_utc"] for o in all_obs)
    else:
        first_accepted_ts = None
    if boundary_utc is not None:
        anchor_role = "gate_window_anchor"
        anchor_is_first_collection = False
        alignment_note = (
            "anchor validated slot-aligned (00:00:00Z | 12:00:00Z) before "
            "computation; the grid start equals the exact authorized "
            "anchor (floor-12h is an identity operation here) and the grid "
            "end equals anchor + 14 full days")
    else:
        # The default anchor is DERIVED from the earliest recorded run
        # timestamp (date-truncated) — i.e. it IS first-collection-derived.
        # That conflation is exactly why it is diagnostic-only and can
        # never authorize a series.
        anchor_role = "diagnostic_earliest_run_derived_not_authorized"
        anchor_is_first_collection = True
        alignment_note = (
            "no --window-start given: the anchor is derived from the "
            "earliest recorded run timestamp (date-truncated) — it is "
            "first-collection-derived, which is exactly why it is "
            "diagnostic-only and NOT an authorized series start; the "
            "earliest run may be the pre-authorization pilot. Authorized "
            "evaluation requires an explicit slot-aligned --window-start")
    report["window_semantics"] = {
        "interpretation": "fixed_14_day_utc_slot_window",
        "definition": (
            "the pre-registered evaluation window is the fixed sequence of "
            "28 consecutive 12-hour UTC slots [anchor, anchor + 14 days) "
            "(window_days_min x samples_per_day = "
            f"{window_slots}); record timestamps are filtered EXACTLY "
            "(inclusive lower, exclusive upper) against this interval "
            "BEFORE slot aggregation/deduplication (EI-STRAT-004), then "
            "floored to their containing 12h UTC slot"),
        "alternative_reading_note": (
            "for a slot-aligned anchor the alternative reading — 14 full "
            "elapsed days from the exact authorized timestamp — describes "
            "the IDENTICAL interval [anchor, anchor + 14 days); the two "
            "readings only diverge for non-aligned timestamps, which are "
            "refused before any computation (WindowAnchorError, CLI "
            "exit 4)"),
        "anchor_role": anchor_role,
        "anchor_is_first_collection_time": anchor_is_first_collection,
        "first_accepted_collection_utc": first_accepted_ts,
        "first_collection_role": (
            "observed fact, not a window input — the collected_at_utc of "
            "the first record admitted to the evaluation window; it must "
            "be >= the anchor and never moves the 28-slot grid"),
        "slot_alignment_required": True,
        "slot_alignment_validated": boundary_utc is not None,
        "slot_alignment_rule": (
            "an authorized --window-start must be exactly 00:00:00Z or "
            "12:00:00Z; non-aligned values are refused (WindowAnchorError, "
            "CLI exit 4) with the nearest slot boundaries named — never "
            "floored silently"),
        "rationale": (
            "a non-aligned anchor such as 08:00Z would put the exact row "
            "cutoff inside the first slot while the 28-slot grid still "
            "starts at floor-12h: the grid end would sit 13 days 16 hours "
            "(328h = 336h - 8h) after the exact start — 8 hours short of "
            "14 full elapsed days — matching neither pre-registered "
            "reading; slot alignment makes grid start == exact anchor and "
            "the two readings identical, preserving the fixed 28-slot "
            "denominator and the gate hash unchanged"),
        "grid_span_hours": 336,
        "anchor_note": alignment_note,
    }

    # ---- overall verdict --------------------------------------------------
    # EI-STRAT-003: enforce the pre-registered three-major coverage condition
    # BEFORE any PASS/FAIL/BETWEEN mapping. A major is 'adequately covered'
    # when it has >= ceil(min_sample_completeness x window_slots) complete
    # HL-vs-CEX paired slots inside the evaluation window (the same 85% bar
    # the per-asset gate applies). With fewer than the required majors, the
    # pre-registered metric is not computable as a decision => UNRESOLVED
    # (never PASS, never BETWEEN_THRESHOLDS, and not FAIL either — per-asset
    # diagnostics remain visible in per_asset).
    min_adequate_slots = math.ceil(
        g["min_sample_completeness"] * window_slots)
    major_detail = {a: per_asset[a]["n_slots_with_complete_pair"]
                    for a in config.ASSETS if a in per_asset}
    adequate_majors = [a for a in config.ASSETS
                       if major_detail.get(a, 0) >= min_adequate_slots]
    report["majors_coverage"] = {
        "required_majors": g["min_assets_with_cex_leg"],
        "min_complete_pair_slots_per_major": min_adequate_slots,
        "adequate_majors": adequate_majors,
        "major_complete_pair_slots": major_detail,
        "definition": (
            "a major counts as adequately covered when it has >= ceil("
            "min_sample_completeness x window_slots) complete HL-vs-CEX "
            "paired slots inside the pre-registered 14-day window"),
    }
    if not per_asset:
        overall, oreason = VERDICT_UNRESOLVED, ["no complete paired observations"]
    elif len(adequate_majors) < g["min_assets_with_cex_leg"]:
        overall, oreason = VERDICT_UNRESOLVED, [
            f"majors with adequate CEX-leg coverage: "
            f"{', '.join(adequate_majors) or 'none'} "
            f"({len(adequate_majors)} of "
            f"{g['min_assets_with_cex_leg']} required; bar: >= "
            f"{min_adequate_slots} complete paired slots per major in the "
            "14-day window); per pre-registration, insufficient coverage "
            "returns UNRESOLVED — not PASS, BETWEEN_THRESHOLDS, or FAIL "
            "(per-asset diagnostics remain in per_asset)"]
    elif all(a["verdict"] == VERDICT_PASS for a in per_asset.values()):
        overall, oreason = VERDICT_PASS, [
            "all assets pass; CEX-leg coverage adequate on "
            f"{len(adequate_majors)} majors"]
    elif any(a["verdict"] == VERDICT_FAIL for a in per_asset.values()):
        overall, oreason = VERDICT_FAIL, [
            f"{sum(1 for a in per_asset.values() if a['verdict'] == VERDICT_FAIL)}"
            " asset(s) fail the pre-registered gate"]
    elif any(a["verdict"] == VERDICT_UNRESOLVED for a in per_asset.values()):
        overall, oreason = VERDICT_UNRESOLVED, [
            "one or more assets lack sufficient coverage; per instruction, "
            "insufficient source coverage returns UNRESOLVED, not a pass"]
    else:
        overall, oreason = VERDICT_BETWEEN, [
            "coverage adequate; all assets sit between the pass and fail "
            "thresholds (neither pass nor fail is defined by the gate)"]
    report["verdict"] = overall
    report["verdict_reasons"] = oreason
    return report


def _verdict_for(window_days, completeness, eligible_days, median_net,
                 persistence, flips, has_cex, g) -> tuple[str, list[str]]:
    reasons = []
    if window_days < g["window_days_min"]:
        return VERDICT_UNRESOLVED, [
            f"evaluation window elapsed {window_days}d < required "
            f"{g['window_days_min']}d consecutive days"]
    if completeness < g["min_sample_completeness"]:
        return VERDICT_UNRESOLVED, [
            f"completeness {completeness:.3f} < "
            f"{g['min_sample_completeness']} (missing-source periods are "
            "reported as gaps, not counted as coverage)"]
    if not has_cex or median_net is None:
        return VERDICT_UNRESOLVED, ["no complete CEX leg / no paired series"]
    if flips > g["max_sign_flips_fail_gt"]:
        return VERDICT_FAIL, [f"sign-flips {flips} > {g['max_sign_flips_fail_gt']}"]
    if median_net < g["median_net_apr_fail_lt"]:
        return VERDICT_FAIL, [f"median net APR {median_net:.4f} < "
                              f"{g['median_net_apr_fail_lt']}"]
    if median_net > g["median_net_apr_pass_gt"] and \
            persistence >= g["min_daily_persistence"]:
        return VERDICT_PASS, [
            f"median net APR {median_net:.4f} > {g['median_net_apr_pass_gt']} "
            f"and persistence {persistence:.2f} >= "
            f"{g['min_daily_persistence']}"]
    return VERDICT_BETWEEN, [
        f"median net APR {median_net:.4f} between "
        f"{g['median_net_apr_fail_lt']} and {g['median_net_apr_pass_gt']} "
        f"(persistence {persistence:.2f}, flips {flips})"]


def _coverage_statement(per_asset: dict, gap_summary: dict) -> str:
    parts = []
    for asset, a in per_asset.items():
        parts.append(
            f"{asset}: {a['n_slots_with_complete_pair']}/"
            f"{a['completeness_denominator_slots']} complete paired slots in "
            f"the fixed pre-registered window (completeness "
            f"{a['sample_completeness']:.1%}, observed span "
            f"{a['window_days_spanned']}d, CEX legs "
            f"{','.join(a['cex_leg_venues_observed']) or 'NONE'})")
    if gap_summary:
        parts.append("gap summary: " + "; ".join(
            f"{src} {', '.join(f'{r} x{n}' for r, n in reasons.items())}"
            for src, reasons in sorted(gap_summary.items())))
    else:
        parts.append("no gaps recorded")
    return " | ".join(parts)


def write_report(base_dir: Path, report: dict) -> Path:
    out_dir = base_dir / "derived"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = out_dir / f"gate-report-{stamp}.json"
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.flush()
    tmp.replace(path)
    return path
