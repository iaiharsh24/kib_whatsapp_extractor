"""Local summaries, tags, and retrieval — no API keys required."""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from datetime import datetime

TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_'-]{2,}")
STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "from", "have", "has", "had",
    "are", "was", "were", "you", "your", "yours", "they", "them", "their",
    "will", "would", "could", "should", "just", "about", "into", "out", "our",
    "not", "but", "all", "any", "can", "did", "does", "doing", "been", "being",
    "than", "then", "there", "here", "what", "when", "where", "which", "who",
    "how", "why", "also", "too", "very", "more", "some", "such", "only",
    "media", "omitted", "attached", "file", "http", "https", "www", "com",
    "please", "pls", "yeah", "yes", "okay", "ok", "hahaha", "haha", "lol",
}

TAG_RULES = [
    ("Finance", r"\b(invoice|payment|budget|q[1-4]|revenue|sales|gst|costing)\b"),
    ("Marketing", r"\b(brand|campaign|marketing|newsletter|logo|instagram|reel)\b"),
    ("Legal", r"\b(legal|contract|nda|copyright|license|terms)\b"),
    ("Design", r"\b(design|layout|mockup|figma|illustration|print)\b"),
    ("Meetings", r"\b(meeting|call|standup|agenda|minutes)\b"),
    ("Documents", r"\b(pdf|doc|brief|spec|prd|prompt|handbook)\b"),
    ("Video", r"\b(video|reel|clip|mp4|recording)\b"),
    ("Research", r"\b(research|findings|analysis|study|notes)\b"),
    ("Production", r"\b(production|print|kit|factory|delivery)\b"),
    ("Urgent", r"\b(urgent|asap|eod|deadline|today)\b"),
]


def tokenize(text: str) -> list[str]:
    return [
        token.lower()
        for token in TOKEN_RE.findall(text or "")
        if token.lower() not in STOPWORDS
    ]


def embedding_from_text(text: str) -> dict[str, float]:
    tokens = tokenize(text)
    if not tokens:
        return {}
    counts = Counter(tokens)
    norm = math.sqrt(sum(value * value for value in counts.values())) or 1.0
    return {token: round(value / norm, 6) for token, value in counts.items()}


def cosine(left: dict[str, float], right: dict[str, float]) -> float:
    if not left or not right:
        return 0.0
    keys = set(left) & set(right)
    return sum(left[key] * right[key] for key in keys)


def dump_embedding(vector: dict[str, float]) -> str:
    return json.dumps(vector, ensure_ascii=False)


def load_embedding(raw: str | None) -> dict[str, float]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def suggest_tags(*texts: str) -> list[str]:
    blob = "\n".join(t for t in texts if t)
    found: list[str] = []
    for name, pattern in TAG_RULES:
        if re.search(pattern, blob, re.IGNORECASE):
            found.append(name)
    return found[:6]


def format_when(value: datetime | None) -> str:
    if not value:
        return "an unknown date"
    return value.strftime("%d %b %Y")


def summarize_chat(chat_name: str, messages: list[dict], senders: list[str], start, end) -> str:
    informative = [
        (msg.get("text_content") or "").strip()
        for msg in messages
        if (msg.get("text_content") or "").strip()
        and not msg.get("is_media")
        and len((msg.get("text_content") or "")) > 24
    ]
    snippets = informative[:3]
    people = ", ".join(senders[:6]) or "unknown senders"
    lines = [
        f"Chat '{chat_name}' covers {len(messages)} messages from {format_when(start)} to {format_when(end)}.",
        f"People in the thread: {people}.",
    ]
    if snippets:
        lines.append("Representative discussion: " + " | ".join(s[:140] for s in snippets[:2]))
    media_count = sum(1 for msg in messages if msg.get("is_media"))
    if media_count:
        lines.append(f"{media_count} media items were shared in this export.")
    else:
        lines.append("This export is mostly text with little attached media.")
    tags = suggest_tags(" ".join(informative[:20]))
    if tags:
        lines.append("Likely topics: " + ", ".join(tags) + ".")
    return "\n".join(lines[:5])


def summarize_media(filename: str, media_type: str, sender: str, when, nearby: list[str]) -> str:
    context = " ".join(nearby)[:400]
    lines = [
        f"{media_type} file '{filename}' was shared by {sender} on {format_when(when)}.",
    ]
    if context:
        lines.append("Surrounding chat: " + context[:220])
    else:
        lines.append("No nearby chat text was available to explain this file.")
    tags = suggest_tags(filename, context)
    if tags:
        lines.append("Suggested tags: " + ", ".join(tags) + ".")
    else:
        lines.append(f"Treat this as a {media_type.lower()} asset until it is annotated on the canvas.")
    lines.append("Open the file locally from the library or pin it onto a project canvas.")
    return "\n".join(lines[:5])


def transcript_from_nearby(media_type: str, nearby: list[str]) -> str | None:
    if media_type not in {"Video", "Reel", "Audio"}:
        return None
    if not nearby:
        return "No local transcript. Nearby chat was empty."
    return "Local stand-in transcript from nearby messages:\n" + "\n".join(nearby[:6])


def chunk_texts(messages: list[dict], size: int = 8) -> list[tuple[str, str, str]]:
    """Return (source_id, source_type, chunk_text) candidates from parsed messages."""
    chunks = []
    batch: list[str] = []
    first_id = None
    for msg in messages:
        text = (msg.get("text_content") or "").strip()
        if not text:
            continue
        if first_id is None:
            first_id = msg.get("id")
        stamp = msg["timestamp"].strftime("%Y-%m-%d %H:%M") if msg.get("timestamp") else ""
        batch.append(f"{stamp} {msg.get('sender')}: {text}")
        if len(batch) >= size:
            chunks.append((first_id or "", "Message", "\n".join(batch)))
            batch = []
            first_id = None
    if batch:
        chunks.append((first_id or "", "Message", "\n".join(batch)))
    return chunks
