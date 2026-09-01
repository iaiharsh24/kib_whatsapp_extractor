"""Lightweight in-memory rate limiting for auth endpoints.

Counts failed attempts per client key (usually IP). Successful auth clears the
counter for that key. Single-process only — fine for our one API container; if
we ever scale horizontally, swap this for Redis.
"""
from __future__ import annotations

import os
import threading
import time
from collections import defaultdict


class RateLimiter:
    def __init__(self, max_failures: int, window_seconds: int):
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self._failures: dict[str, list[float]] = defaultdict(list)
        self._lock = threading.Lock()

    def is_blocked(self, key: str) -> tuple[bool, int]:
        """Return (blocked, retry_after_seconds). Does not record a new failure."""
        now = time.monotonic()
        with self._lock:
            hits = self._failures.get(key, [])
            cutoff = now - self.window_seconds
            recent = [t for t in hits if t > cutoff]
            if len(recent) >= self.max_failures:
                retry = int(self.window_seconds - (now - recent[0])) + 1
                return True, max(retry, 1)
            return False, 0

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            hits = self._failures[key]
            cutoff = now - self.window_seconds
            hits[:] = [t for t in hits if t > cutoff]
            hits.append(now)

    def reset(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)


def client_key(request) -> str:
    """Best-effort client identifier behind a reverse proxy."""
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded:
        return forwarded
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


# Defaults: 10 failed attempts per 15 minutes per IP.
_MAX_FAILURES = int(os.getenv("AUTH_RATE_LIMIT_MAX", "10"))
_WINDOW = int(os.getenv("AUTH_RATE_LIMIT_WINDOW_SECONDS", str(15 * 60)))

login_limiter = RateLimiter(_MAX_FAILURES, _WINDOW)
signup_limiter = RateLimiter(_MAX_FAILURES, _WINDOW)
