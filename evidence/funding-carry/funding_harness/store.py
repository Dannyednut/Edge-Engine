"""Run persistence: per-run directories, JSONL writers, manifests, verify.

Layout (all under the NEW dedicated evidence path
<repo>/evidence/funding-carry/data/ — disjoint from data/khope-study and
data/limusd-study and from all paper-trader state):

  data/runs/<run_id>/
      raw/<source>/<name>.json          exact response bytes (or bounded
                                        projection when > MAX_RAW_BYTES; meta
                                        always carries the FULL-body sha256)
      raw/<source>/<name>.meta.json     fetch metadata per raw file
      observations.jsonl                complete canonical rows only
      gaps.jsonl                        explicit gap rows (missing sources)
      pairs.jsonl                       derived HL-vs-CEX net-APR estimates
      run_manifest.json                 config snapshot + hashes + counts

Append semantics: each invocation creates a NEW run directory; nothing
existing is ever opened for modification. Cross-run dedupe/conflict reporting
lives in verify().
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from . import TOOL_VERSION, OBSERVATION_SCHEMA_VERSION
from .models import observation_key, validate_observation

JSONL_SUFFIX = ".jsonl"


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def utc_now_run_id() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def utc_now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def resolve_run_dir(base_dir: Path, run_id: str) -> Path:
    """Unique run dir; same-second collisions get -2, -3, ... suffixes."""
    d = base_dir / "runs" / run_id
    n = 1
    while d.exists():
        n += 1
        d = base_dir / "runs" / f"{run_id}-{n}"
    return d


def _atomic_write_jsonl(path: Path, rows: list[dict]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)
    return len(rows)


def _write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


@dataclass
class PersistResult:
    run_dir: Path
    observations_written: int = 0
    gaps_written: int = 0
    pairs_written: int = 0
    duplicates_ignored: list = field(default_factory=list)
    rejected_invalid: list = field(default_factory=list)


def write_run(*, base_dir: Path, run_id: str, started_utc: str,
              config_snapshot: dict, source_results: list,
              pairs: list[dict], notes: Optional[list] = None) -> PersistResult:
    """Persist one collection run. Performs within-run dedupe by
    observation_key (first wins, duplicates recorded in the manifest) and a
    final fail-closed structural validation of every observation before it
    touches disk (invalid rows are demoted to rejects, never written as
    observations)."""
    run_dir = resolve_run_dir(base_dir, run_id)
    (run_dir / "raw").mkdir(parents=True, exist_ok=True)

    seen_keys: set[str] = set()
    observations: list[dict] = []
    gaps: list[dict] = []
    duplicates: list[str] = []
    rejects: list[dict] = []

    for sr in source_results:
        gaps.extend(sr.gaps)
        for obs in sr.observations:
            key = obs["observation_key"]
            if key in seen_keys:
                duplicates.append(key)
                continue
            problems = validate_observation(obs)
            if problems:
                rejects.append({"observation_key": key, "problems": problems,
                                "source": sr.source})
                continue
            seen_keys.add(key)
            observations.append(obs)

    # raw payloads (bounded per MAX_RAW_BYTES) + per-file meta
    payload_hashes = []
    for sr in source_results:
        for raw in sr.raws:
            raw_path = run_dir / "raw" / f"{raw.stem}.json"
            meta_path = run_dir / "raw" / f"{raw.stem}.meta.json"
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = raw_path.with_suffix(".tmp")
            tmp.write_bytes(raw.body)
            tmp.replace(raw_path)
            _write_json(meta_path, raw.meta)
            payload_hashes.append({
                "raw_ref": f"raw/{raw.stem}.json",
                "sha256": raw.meta.get("payload_sha256"),
                "raw_bounded": bool(raw.meta.get("raw_bounded", False)),
            })

    obs_n = _atomic_write_jsonl(run_dir / "observations.jsonl", observations)
    gap_n = _atomic_write_jsonl(run_dir / "gaps.jsonl", gaps)
    pair_n = _atomic_write_jsonl(run_dir / "pairs.jsonl", pairs)

    manifest = {
        "run_id": run_dir.name,
        "tool_version": TOOL_VERSION,
        "observation_schema_version": OBSERVATION_SCHEMA_VERSION,
        "started_utc": started_utc,
        "ended_utc": utc_now_iso(),
        "config_snapshot": config_snapshot,
        "counts": {
            "observations": obs_n,
            "gaps": gap_n,
            "pairs": pair_n,
            "duplicates_ignored": len(duplicates),
            "rejects_invalid": len(rejects),
            "raw_files": len(payload_hashes),
        },
        "per_source": {
            sr.source: {
                "observations": len(sr.observations),
                "gaps": len(sr.gaps),
                "notes": sr.notes,
            } for sr in source_results
        },
        "payload_hashes": payload_hashes,
        "duplicates_ignored_keys": duplicates,
        "rejects_invalid": rejects,
        "notes": notes or [],
    }
    _write_json(run_dir / "run_manifest.json", manifest)
    return PersistResult(run_dir=run_dir, observations_written=obs_n,
                         gaps_written=gap_n, pairs_written=pair_n,
                         duplicates_ignored=duplicates,
                         rejected_invalid=rejects)


# ---------------------------------------------------------------------------
# Cross-run verification (consistency/hash checks)
# ---------------------------------------------------------------------------

def verify(base_dir: Path) -> dict:
    report = {"runs_checked": 0, "raw_files_checked": 0,
              "hash_mismatches": [], "jsonl_errors": [],
              "cross_run_duplicates": [], "ok": True}
    runs_root = base_dir / "runs"
    if not runs_root.exists():
        report["ok"] = False
        report["jsonl_errors"].append("no runs directory yet")
        return report
    seen_keys: dict[str, dict] = {}
    for run_dir in sorted(p for p in runs_root.iterdir() if p.is_dir()):
        report["runs_checked"] += 1
        manifest_path = run_dir / "run_manifest.json"
        if not manifest_path.exists():
            report["jsonl_errors"].append(f"{run_dir.name}: missing run_manifest.json")
            report["ok"] = False
            continue
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for entry in manifest.get("payload_hashes", []):
            raw_path = run_dir / entry["raw_ref"]
            report["raw_files_checked"] += 1
            if not raw_path.exists():
                report["hash_mismatches"].append(
                    {"run": run_dir.name, "raw_ref": entry["raw_ref"],
                     "problem": "file missing"})
                report["ok"] = False
                continue
            actual = sha256_bytes(raw_path.read_bytes())
            # For bounded payloads the stored bytes are a projection; the
            # manifest sha256 refers to the FULL original body and is checked
            # against the recorded stored-size marker instead.
            if not entry.get("raw_bounded"):
                if actual != entry["sha256"]:
                    report["hash_mismatches"].append(
                        {"run": run_dir.name, "raw_ref": entry["raw_ref"],
                         "problem": "stored bytes hash != manifest payload hash"})
                    report["ok"] = False
            else:
                meta_path = run_dir / entry["raw_ref"].replace(".json", ".meta.json")
                if meta_path.exists():
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    if meta.get("payload_sha256") != entry["sha256"]:
                        report["hash_mismatches"].append(
                            {"run": run_dir.name, "raw_ref": entry["raw_ref"],
                             "problem": "meta sha256 != manifest sha256"})
                        report["ok"] = False
        for line_kind in ("observations", "gaps", "pairs"):
            path = run_dir / f"{line_kind}{JSONL_SUFFIX}"
            if not path.exists():
                report["jsonl_errors"].append(f"{run_dir.name}: missing {path.name}")
                report["ok"] = False
                continue
            with open(path, encoding="utf-8") as f:
                for i, line in enumerate(f):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError as exc:
                        report["jsonl_errors"].append(
                            f"{run_dir.name}/{path.name}:{i}: {exc}")
                        report["ok"] = False
                        continue
                    if line_kind == "observations":
                        key = row.get("observation_key")
                        if key:
                            prev = seen_keys.get(key)
                            if prev is None:
                                seen_keys[key] = {
                                    "run": run_dir.name,
                                    "sha": row.get("evidence", {}).get("payload_sha256"),
                                }
                            elif prev["sha"] != row.get("evidence", {}).get("payload_sha256"):
                                report["cross_run_duplicates"].append(
                                    {"observation_key": key,
                                     "runs": [prev["run"], run_dir.name],
                                     "problem": "same key, different payload hash"})
                                report["ok"] = False
    return report
