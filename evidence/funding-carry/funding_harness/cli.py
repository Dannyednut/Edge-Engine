"""Manual CLI: python -m funding_harness <collect|stats|verify>

No scheduler, no daemon, no cron — every action is a single explicitly
invoked process that exits when done. Exit codes:
  collect: 0 complete (no gaps) · 1 recorded with gaps · 2 hard failure
  stats:   0 verdict computed (PASS/FAIL/BETWEEN) · 1 UNRESOLVED
  verify:  0 consistent · 1 inconsistencies found
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import TOOL_NAME, TOOL_VERSION, config
from .collect import GateDriftError, run_collection
from .stats import VERDICT_UNRESOLVED, compute_report, write_report
from .store import verify as verify_store

DEFAULT_BASE_DIR = Path(__file__).resolve().parent.parent / "data"


def _base_dir(args) -> Path:
    return Path(args.base_dir).resolve() if args.base_dir else DEFAULT_BASE_DIR


def cmd_collect(args) -> int:
    from .transport import UrllibTransport
    cfg = config.HarnessConfig(base_dir=str(_base_dir(args)))
    if args.assets:
        cfg.assets = tuple(a.strip().upper() for a in args.assets.split(",") if a.strip())
    if args.sources:
        cfg.sources = tuple(s.strip() for s in args.sources.split(",") if s.strip())
    outcome = run_collection(cfg, UrllibTransport())
    for line in outcome.summary_lines():
        print(line)
    if outcome.persist is not None:
        print(f"run_dir={outcome.persist.run_dir}")
    return outcome.exit_code


def cmd_stats(args) -> int:
    base = _base_dir(args)
    report = compute_report(base, window_days=args.window_days)
    path = write_report(base, report)
    print(f"verdict={report['verdict']}")
    for r in report.get("verdict_reasons", []):
        print(f"  - {r}")
    for asset, a in (report.get("per_asset") or {}).items():
        print(f"  {asset}: median_net_apr={a['median_net_apr_pre_registered']} "
              f"({a['median_net_apr_pct']}%) persistence={a['daily_persistence']} "
              f"flips={a['sign_flips']} completeness={a['sample_completeness']} "
              f"-> {a['verdict']}")
    print(f"coverage: {report.get('coverage_statement')}")
    print(f"report={path}")
    return 1 if report["verdict"] == VERDICT_UNRESOLVED else 0


def cmd_verify(args) -> int:
    report = verify_store(_base_dir(args))
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m funding_harness",
        description=f"{TOOL_NAME} v{TOOL_VERSION} — read-only funding-carry "
                    "evidence collection (manual invocation only; no scheduler)")
    p.add_argument("--base-dir", help="data directory "
                   f"(default {DEFAULT_BASE_DIR})")
    sub = p.add_subparsers(dest="command", required=True)

    c = sub.add_parser("collect", help="run one manual collection (writes a "
                       "new run directory; never modifies existing runs)")
    c.add_argument("--assets", help="comma-separated assets (default BTC,ETH,SOL)")
    c.add_argument("--sources", help="comma-separated subset of sources to probe")
    c.set_defaults(func=cmd_collect)

    s = sub.add_parser("stats", help="compute derived statistics + pre-registered "
                       "gate verdict across all recorded runs")
    s.add_argument("--window-days", type=int, default=14)
    s.set_defaults(func=cmd_stats)

    v = sub.add_parser("verify", help="consistency/hash checks across all runs")
    v.set_defaults(func=cmd_verify)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except GateDriftError as exc:
        print(f"GATE-DRIFT REFUSAL: {exc}", file=sys.stderr)
        return 3
