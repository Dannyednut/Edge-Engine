"""HTTP transport layer: pluggable, timeout-bounded, retry-once, no proxies.

The harness is stdlib-only (urllib). Tests inject a FakeTransport; nothing
here ever reads credentials, env vars, or config files.
"""
from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

from . import config


class PayloadError(ValueError):
    """Raised when a body cannot be parsed as JSON."""


@dataclass
class HttpResult:
    url: str
    method: str
    status: Optional[int]        # None = network-level failure
    body: bytes
    elapsed_ms: int
    error: Optional[str] = None
    attempts: int = 1
    sha256: str = field(default="")

    def __post_init__(self) -> None:
        if not self.sha256:
            import hashlib
            self.sha256 = hashlib.sha256(self.body).hexdigest()

    def json(self) -> Any:
        if not self.body:
            raise PayloadError(f"empty body from {self.url} (status={self.status})")
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PayloadError(f"non-JSON body from {self.url}: {exc}") from exc


class Transport(Protocol):
    def request(self, url: str, method: str = "GET",
                body: Optional[dict] = None,
                timeout_s: Optional[float] = None) -> HttpResult: ...


class UrllibTransport:
    """Single-shot transport with one bounded retry on network/5xx failures."""

    def __init__(self, user_agent: str = config.USER_AGENT,
                 timeout_s: float = config.HTTP_TIMEOUT_S,
                 retries: int = config.HTTP_RETRIES,
                 backoff_s: float = config.HTTP_BACKOFF_S) -> None:
        self.user_agent = user_agent
        self.timeout_s = timeout_s
        self.retries = retries
        self.backoff_s = backoff_s
        self._ssl = ssl.create_default_context()

    def request(self, url: str, method: str = "GET",
                body: Optional[dict] = None,
                timeout_s: Optional[float] = None) -> HttpResult:
        timeout = timeout_s if timeout_s is not None else self.timeout_s
        attempts = 0
        last: Optional[HttpResult] = None
        max_attempts = 1 + max(0, self.retries)
        while attempts < max_attempts:
            attempts += 1
            last = self._once(url, method, body, timeout, attempts)
            if last.status is not None and last.status < 500:
                return last                       # success or definitive HTTP error
            if last.status is None and last.error and "SSLError" in last.error:
                return last                       # TLS config issue will not heal
            if attempts < max_attempts:
                time.sleep(self.backoff_s)
        return last  # type: ignore[return-value]

    def _once(self, url: str, method: str, body: Optional[dict],
              timeout: float, attempts: int) -> HttpResult:
        data = None
        headers = {"User-Agent": self.user_agent, "Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self._ssl) as resp:
                payload = resp.read()
                return HttpResult(url=url, method=method, status=resp.status,
                                  body=payload,
                                  elapsed_ms=int((time.time() - t0) * 1000),
                                  attempts=attempts)
        except urllib.error.HTTPError as exc:
            try:
                payload = exc.read()
            except Exception:
                payload = b""
            return HttpResult(url=url, method=method, status=exc.code,
                              body=payload,
                              elapsed_ms=int((time.time() - t0) * 1000),
                              error=f"HTTPError {exc.code}", attempts=attempts)
        except Exception as exc:  # network errors, timeouts, DNS, TLS
            return HttpResult(url=url, method=method, status=None, body=b"",
                              elapsed_ms=int((time.time() - t0) * 1000),
                              error=f"{type(exc).__name__}: {exc}", attempts=attempts)
