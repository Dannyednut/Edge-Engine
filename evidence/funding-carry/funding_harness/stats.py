"""Derived statistics + the PRE-REGISTERED decision-gate engine.

Reads every run under data/runs, rebuilds the paired series, computes the
EI-STRAT-001 §4.2 gate metrics and returns a verdict:

  PASS      median net APR > +3% AND daily persistence >= 70% AND flips <= 2
  FAIL      median net APR < +1.5% OR flips > 2
  BETWEEN_THRESHOLDS  coverage adequate but median sits between 1.5% and 3%
            with <= 2 flips (the pre-registered gate defines neither pass nor
            fail here; decision returned to the Instructor)
  UNRESOLVED  coverage insufficient (window < 14d, completeness < 85%, or
            CEX-leg coverage < 3 assets) — never reported as a pass

Threshold immutability: every run manifest embeds gate_config_sha256; if any
run (or this module) disagrees with the pre-registered hash, stats refuses to
produce a report (GateDriftError) instead of comparing against drifted
thresholds.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Optional

from . import config
from .collect import GateDriftError
from .convert import iso_date, iso_to_utc_slot12
from .pairing import build_pairs, dedupe_slots

VERDICT_PASS = "PASS"
VERDICT_FAIL = "FAIL"
VERDICT_BETWEEN = "BETWEEN_THRESHOLDS"
VERDICT_UNRESOLVED = "UNRESOLVED"


def _parse_ts(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


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


def compute_report(base_dir: Path, *, window_days: int = 14) -> dict:
    runs = load_runs(base_dir)
    check_gate_drift(runs)
    g = config.GATE_CONFIG

    # flatten
    all_pairs = [p for rec in runs for p in rec["pairs"]]
    all_obs = [o for rec in runs for o in rec["observations"]]
    all_gaps = [gp for rec in runs for gp in rec["gaps"]]

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

    # ---- per-asset gate metrics ------------------------------------------
    per_asset = {}
    for asset in sorted({p["asset"] for p in all_pairs}):
        asset_pairs = [p for p in all_pairs if p["asset"] == asset]
        primary = [p for p in asset_pairs if p.get("primary_cex_leg")]
        slots = dedupe_slots([(iso_to_utc_slot12(p["collected_at_utc"]),
                               p["net_apr_pre_registered"],
                               p["collected_at_utc"]) for p in primary])
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

        window_days_spanned = 0
        if eligible_days:
            d0 = datetime.strptime(eligible_days[0], "%Y-%m-%d").date()
            d1 = datetime.strptime(eligible_days[-1], "%Y-%m-%d").date()
            window_days_spanned = (d1 - d0).days + 1
        expected_slots = max(window_days_spanned, 1) * g["samples_per_day"]
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
            window_days_spanned, completeness, len(eligible_days),
            measured_median, persistence, flips, bool(cex_legs), g)

        per_asset[asset] = {
            "window_days_spanned": window_days_spanned,
            "eligible_days": eligible_days,
            "n_slots_with_complete_pair": len(slots),
            "expected_slots": expected_slots,
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
    for rec in runs:
        d = iso_date(rec["manifest"]["started_utc"]) if rec.get("manifest") \
            else rec["run_id"][:10]
        obs_sources = {o["source"] for o in rec["observations"]}
        for src in config.SOURCES:
            if src in obs_sources:
                per_source_dates.setdefault(src, []).append(d)

    report.update({
        "n_runs": len(runs),
        "window_requested_days": window_days,
        "per_asset": per_asset,
        "gaps_summary": gap_summary,
        "source_dates_with_complete_observations": {
            k: sorted(set(v)) for k, v in per_source_dates.items()},
        "coverage_statement": _coverage_statement(per_asset, gap_summary),
    })

    # ---- overall verdict --------------------------------------------------
    assets_with_cex = sum(
        1 for a in per_asset.values() if a["cex_leg_venues_observed"])
    if not per_asset:
        overall, oreason = VERDICT_UNRESOLVED, ["no complete paired observations"]
    elif all(a["verdict"] == VERDICT_PASS for a in per_asset.values()) \
            and assets_with_cex >= g["min_assets_with_cex_leg"]:
        overall, oreason = VERDICT_PASS, [
            "all assets pass; CEX-leg coverage on "
            f"{assets_with_cex} majors"]
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
            f"window {window_days}d < required {g['window_days_min']}d"]
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
            f"{asset}: {a['n_slots_with_complete_pair']} complete paired slots "
            f"over {a['window_days_spanned']}d (completeness "
            f"{a['sample_completeness']:.1%}, CEX legs "
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
