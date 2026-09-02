"""Short-lived HMAC signatures for /api/files/ URLs.

Session JWTs must never appear in query strings (they land in access logs, browser
history, and Referer headers). Instead we mint a scoped signature valid for one
file for FILE_URL_TTL_SECONDS (default 15 minutes).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import time
from urllib.parse import quote, unquote, urlencode

from app.auth import SECRET

FILE_URL_TTL_SECONDS = int(os.getenv("FILE_URL_TTL_SECONDS", str(15 * 60)))

_FILE_PATH_RE = re.compile(r"^/api/files/(?P<upload_id>[^/]+)/(?P<filename>.+)$")


def _sign(upload_id: str, filename: str, exp: int) -> str:
    msg = f"{upload_id}\0{unquote(filename)}\0{exp}".encode()
    return hmac.new(SECRET.encode(), msg, hashlib.sha256).hexdigest()


def signed_file_url(upload_id: str, filename: str) -> str:
    """Return a browser-usable path with exp+sig query params."""
    clean_name = unquote(filename)
    exp = int(time.time()) + FILE_URL_TTL_SECONDS
    sig = _sign(upload_id, clean_name, exp)
    quoted = quote(clean_name, safe="/")
    query = urlencode({"exp": exp, "sig": sig})
    return f"/api/files/{upload_id}/{quoted}?{query}"


def sign_stored_file_path(path: str | None) -> str | None:
    """Sign a stored DB path like /api/files/upload_abc/photo.jpg."""
    if not path or not str(path).startswith("/api/files/"):
        return path
    base = str(path).split("?", 1)[0]
    match = _FILE_PATH_RE.match(base)
    if not match:
        return path
    return signed_file_url(match.group("upload_id"), match.group("filename"))


def verify_file_signature(upload_id: str, filename: str, exp: int, sig: str) -> bool:
    if not sig or exp <= 0:
        return False
    if exp < int(time.time()):
        return False
    expected = _sign(upload_id, unquote(filename), exp)
    return hmac.compare_digest(expected, sig)


def parse_sign_request_paths(paths: list[str]) -> list[tuple[str, str, str]]:
    """Return (original_path, upload_id, filename) for each valid /api/files/ path."""
    out: list[tuple[str, str, str]] = []
    for raw in paths:
        if not raw:
            continue
        base = str(raw).split("?", 1)[0]
        match = _FILE_PATH_RE.match(base)
        if match:
            out.append((raw, match.group("upload_id"), match.group("filename")))
    return out
