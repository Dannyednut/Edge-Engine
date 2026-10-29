"""Source adapters. Each adapter = fetch(transport) + pure parse(payload) so
parsers are unit-testable offline with recorded fixtures."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from ..transport import HttpResult


@dataclass
class RawEntry:
    stem: str            # path under the run's raw/ dir, no extension
    body: bytes          # exact bytes to persist (full body or bounded projection)
    meta: dict = field(default_factory=dict)


@dataclass
class SourceResult:
    source: str
    observations: list = field(default_factory=list)
    gaps: list = field(default_factory=list)
    raws: list = field(default_factory=list)
    notes: list = field(default_factory=list)


def bounded_body(result: HttpResult, projection: Optional[dict]) -> tuple[bytes, bool, Optional[str]]:
    """Return (bytes_to_store, raw_bounded, note).

    Full body kept when <= config.MAX_RAW_BYTES; otherwise the caller-supplied
    projection is stored and the full body is represented by its sha256 in
    the meta (meta.payload_sha256 always hashes the FULL body).
    """
    from .. import config
    if len(result.body) <= config.MAX_RAW_BYTES:
        return result.body, False, None
    if projection is None:
        return result.body, False, "over bound but no projection available; stored full"
    proj_bytes = json_dumps_bytes(projection)
    return proj_bytes, True, ("stored bounded projection of oversized payload; "
                              "full-body sha256 in evidence.payload_sha256")


def json_dumps_bytes(obj: Any) -> bytes:
    import json
    return json.dumps(obj, ensure_ascii=False, sort_keys=False).encode("utf-8")


def make_raw(result: HttpResult, stem: str, projection: Optional[dict] = None,
             extra_meta: Optional[dict] = None) -> RawEntry:
    body, bounded, note = bounded_body(result, projection)
    meta = {
        "url": result.url,
        "method": result.method,
        "http_status": result.status,
        "http_attempts": result.attempts,
        "error": result.error,
        "elapsed_ms": result.elapsed_ms,
        "payload_sha256": result.sha256,
        "payload_size_bytes": len(result.body),
        "stored_size_bytes": len(body),
        "raw_bounded": bounded,
        "fetched_at_utc": fetched_now_iso(),
    }
    if note:
        meta["note"] = note
    if extra_meta:
        meta.update(extra_meta)
    return RawEntry(stem=stem, body=body, meta=meta)


def fetched_now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_sharpe_ts(ts: Optional[str]) -> Optional[str]:
    """'2026-10-20T04:25:48.374+00:00' -> '2026-10-20T04:25:48Z' (None-safe)."""
    from datetime import datetime, timezone
    if not ts or not isinstance(ts, str):
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


# Registry filled by each module via `register`.
REGISTRY: dict[str, Callable[..., SourceResult]] = {}


def register(name: str):
    def deco(fn):
        REGISTRY[name] = fn
        return fn
    return deco


class FetchedJSON:
    """Outcome of one endpoint request: raw entry + parsed payload or gaps."""

    def __init__(self, result: HttpResult, raw: RawEntry,
                 payload: Any, error_gaps: list) -> None:
        self.result = result
        self.raw = raw
        self.payload = payload
        self.error_gaps = error_gaps

    @property
    def ok(self) -> bool:
        return self.payload is not None

    @property
    def raw_ref(self) -> str:
        return f"raw/{self.raw.stem}.json"

    @property
    def raw_bounded(self) -> bool:
        return bool(self.raw.meta.get("raw_bounded", False))

    def evidence(self, provenance: str, note: Optional[str] = None) -> dict:
        from ..models import evidence_block
        return evidence_block(self.result, raw_ref=self.raw_ref,
                              raw_bounded=self.raw_bounded,
                              provenance=provenance, note=note)


def request_json(*, transport, url: str, method: str = "GET", body: Optional[dict],
                 stem: str, run_id: str, collected_at_utc: str, source: str,
                 assets, metric_group: str = "funding",
                 projection: Optional[dict] = None,
                 require_status: int = 200) -> FetchedJSON:
    """Request an endpoint, persist the raw entry, and on any failure emit one
    gap row per asset (http_error / non_json_payload). Parsers handle
    payload-shape and per-asset field failures themselves."""
    from .. import config
    from ..models import make_gap
    result = transport.request(url, method=method, body=body)
    raw = make_raw(result, stem=stem, projection=projection)
    failure_evidence = {
        "endpoint": result.url,
        "request_method": result.method,
        "http_status": result.status,
        "elapsed_ms": result.elapsed_ms,
        "http_attempts": result.attempts,
        "error": result.error,
        "payload_sha256": result.sha256,
        "payload_size_bytes": len(result.body),
        "raw_ref": f"raw/{raw.stem}.json",
        "raw_bounded": bool(raw.meta.get("raw_bounded", False)),
        "provenance": "endpoint failure recorded, not bypassed",
    }
    gaps: list = []
    payload: Any = None
    if result.status != require_status:
        for a in assets:
            gaps.append(make_gap(
                run_id=run_id, collected_at_utc=collected_at_utc, source=source,
                asset=a, source_instrument=a, metric_group=metric_group,
                gap_reason=config.GAP_HTTP_ERROR,
                detail=f"HTTP {result.status} / {result.error}",
                evidence=failure_evidence))
    else:
        try:
            payload = result.json()
        except PayloadError as exc:
            payload = None
            for a in assets:
                gaps.append(make_gap(
                    run_id=run_id, collected_at_utc=collected_at_utc, source=source,
                    asset=a, source_instrument=a, metric_group=metric_group,
                    gap_reason=config.GAP_NON_JSON, detail=str(exc),
                    evidence=failure_evidence))
    return FetchedJSON(result, raw, payload, gaps)
