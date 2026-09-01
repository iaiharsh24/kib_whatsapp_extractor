"""Local file-based vector store (Chroma-style folder, no extra server)."""
from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path

from db.models import Message

ROOT = Path(__file__).resolve().parents[2]
VECTOR_DIR = Path(os.getenv("WA_VECTOR_DIR", ROOT / "local_data" / "chroma"))
VECTOR_FILE = VECTOR_DIR / "messages.jsonl"
TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_'-]{2,}")
STOP = {
    "the", "and", "for", "that", "this", "with", "from", "have", "you", "your",
    "are", "was", "were", "not", "but", "all", "can", "just", "about", "media",
}


def _tokenize(text: str) -> list[str]:
    return [tok.lower() for tok in TOKEN_RE.findall(text or "") if tok.lower() not in STOP]


def embed_text(text: str) -> dict[str, float]:
    tokens = _tokenize(text)
    if not tokens:
        return {}
    counts: dict[str, int] = {}
    for token in tokens:
        counts[token] = counts.get(token, 0) + 1
    norm = math.sqrt(sum(v * v for v in counts.values())) or 1.0
    return {k: round(v / norm, 6) for k, v in counts.items()}


def cosine(left: dict[str, float], right: dict[str, float]) -> float:
    if not left or not right:
        return 0.0
    return sum(left[k] * right[k] for k in set(left) & set(right))


def _read_all() -> list[dict]:
    if not VECTOR_FILE.exists():
        return []
    rows = []
    with VECTOR_FILE.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _write_all(rows: list[dict]) -> None:
    VECTOR_DIR.mkdir(parents=True, exist_ok=True)
    with VECTOR_FILE.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def upsert_messages(messages: list[Message]) -> None:
    if not messages:
        return
    existing = {row["id"]: row for row in _read_all()}
    for message in messages:
        existing[message.id] = {
            "id": message.id,
            "upload_id": message.upload_id,
            "text": f"{message.sender}: {message.raw_text}",
            "embedding": embed_text(f"{message.sender} {message.raw_text} {message.extracted_filename or ''}"),
        }
    _write_all(list(existing.values()))


def delete_upload_vectors(upload_id: str) -> None:
    rows = [row for row in _read_all() if row.get("upload_id") != upload_id]
    _write_all(rows)


def query_similar(text: str, limit: int = 8, ids: set[str] | None = None) -> list[dict]:
    vector = embed_text(text)
    scored = []
    for row in _read_all():
        if ids is not None and row["id"] not in ids:
            continue
        score = cosine(vector, row.get("embedding") or {})
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [{"id": row["id"], "text": row["text"], "score": round(score, 4)} for score, row in scored[:limit]]
