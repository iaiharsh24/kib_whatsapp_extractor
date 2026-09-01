"""Parse iOS and Android WhatsApp chat export text files line by line."""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Iterator

from app.previews import normalize_urls

HEADER_IOS = re.compile(
    r"^\[(?P<date>\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}),\s*"
    r"(?P<time>\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?)\]\s*"
    r"(?P<rest>.*)$"
)
HEADER_ANDROID = re.compile(
    r"^(?P<date>\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}),\s*"
    r"(?P<time>\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?)\s*-\s*"
    r"(?P<rest>.*)$"
)
ATTACHED = re.compile(r"<attached:\s*(?P<file>[^>]+)>", re.IGNORECASE)
ATTACHED_FILE_LINE = re.compile(
    r"^(?P<file>.+?)\s*\(file attached\)\s*$",
    re.IGNORECASE,
)
OMITTED = re.compile(
    r"<media omitted>|<image omitted>|<video omitted>|"
    r"<audio omitted>|<document omitted>|<sticker omitted>",
    re.IGNORECASE,
)
SYSTEM_SKIP = re.compile(
    r"Messages and calls are end-to-end encrypted|"
    r"You created this group|Your security code|"
    r"This chat is with a business account",
    re.IGNORECASE,
)
DOC_EXT = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".csv", ".rtf", ".txt", ".zip"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".3gp", ".mkv"}
AUDIO_EXT = {".opus", ".mp3", ".m4a", ".ogg", ".wav", ".aac"}
BARE_FILE = re.compile(
    r"^(?P<file>[^\\/:*?\"<>|\n]+\.(?:jpg|jpeg|png|gif|webp|heic|bmp|mp4|mov|webm|3gp|mkv|"
    r"opus|mp3|m4a|ogg|wav|aac|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|rtf|zip))\s*$",
    re.IGNORECASE,
)
DATE_FORMATS = [
    "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%y %H:%M:%S", "%d/%m/%y %H:%M",
    "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%m/%d/%y %H:%M:%S", "%m/%d/%y %H:%M",
    "%d/%m/%Y %I:%M:%S %p", "%d/%m/%Y %I:%M %p", "%d/%m/%y %I:%M %p",
    "%m/%d/%Y %I:%M %p", "%m/%d/%y %I:%M %p", "%d-%m-%Y %H:%M", "%d.%m.%Y %H:%M",
]


def parse_datetime(date_str: str, time_str: str) -> datetime | None:
    date_str = date_str.replace(".", "/").replace("-", "/")
    combined = f"{date_str} {time_str.strip()}"
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(combined, fmt)
        except ValueError:
            continue
    return None


def classify_message(text: str, filename: str | None, urls: list[str]) -> tuple[str, str | None, str | None]:
    """Return (type, extracted_url, extracted_filename)."""
    url = next((item for item in urls if item), None)
    lowered_url = (url or "").lower()
    if url and ("/reel/" in lowered_url or "instagram.com/reel" in lowered_url or "youtube.com/shorts" in lowered_url or "/shorts/" in lowered_url):
        return "reel", url, filename
    if filename:
        suffix = Path(filename).suffix.lower()
        upper_name = filename.upper()
        if suffix in IMAGE_EXT or upper_name.startswith("IMG-"):
            return "image", url, filename
        if suffix in DOC_EXT or upper_name.startswith("DOC-"):
            return "document", url, filename
        if suffix in VIDEO_EXT or "VID-" in upper_name:
            return "reel", url, filename
        if suffix in AUDIO_EXT:
            return "media_omitted", url, filename
        if OMITTED.search(text or ""):
            if "image" in (text or "").lower() or "sticker" in (text or "").lower():
                return "image", url, filename
            if "video" in (text or "").lower():
                return "reel", url, filename
            return "media_omitted", url, filename
        return "document", url, filename
    if url:
        return "link", url, filename
    if OMITTED.search(text or ""):
        lowered = (text or "").lower()
        if "image" in lowered or "sticker" in lowered:
            return "image", None, filename
        if "video" in lowered:
            return "reel", None, filename
        if "document" in lowered:
            return "document", None, filename
        return "media_omitted", None, filename
    return "chat", None, filename


def chat_name_from_path(path: Path) -> str:
    stem = path.stem
    for prefix in ("WhatsApp Chat with ", "WhatsApp Chat - "):
        if stem.startswith(prefix):
            return stem[len(prefix):]
    return stem


def _split_sender(rest: str) -> tuple[str | None, str]:
    if ":" in rest:
        sender, content = rest.split(":", 1)
        return sender.strip(), content.strip()
    return None, rest.strip()


def _finalize(current: dict) -> dict | None:
    if current["is_system"] and SYSTEM_SKIP.search(current["raw_text"] or ""):
        return None
    msg_type, url, filename = classify_message(
        current["raw_text"],
        current.get("extracted_filename"),
        current.get("urls") or [],
    )
    current["type"] = msg_type
    current["extracted_url"] = url
    current["extracted_filename"] = filename
    return current


def iter_messages(path: Path, chat_name: str | None = None) -> Iterator[dict]:
    chat_name = chat_name or chat_name_from_path(path)
    current: dict | None = None
    with path.open(encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            line = raw.rstrip("\n").lstrip("\u200e\u200f\ufeff")
            match = HEADER_IOS.match(line) or HEADER_ANDROID.match(line)
            if match:
                if current:
                    done = _finalize(current)
                    if done:
                        yield done
                when = parse_datetime(match.group("date"), match.group("time"))
                if when is None:
                    current = None
                    continue
                sender, content = _split_sender(match.group("rest"))
                attached = ATTACHED.search(content)
                filename = attached.group("file").strip() if attached else None
                content_clean = ATTACHED.sub("", content).strip()
                if not filename:
                    attached_match = ATTACHED_FILE_LINE.search(content_clean)
                    if attached_match:
                        filename = attached_match.group("file").strip()
                        cleaned = ATTACHED_FILE_LINE.sub("", content_clean).strip()
                        content_clean = cleaned or content_clean
                current = {
                    "chat_name": chat_name,
                    "timestamp": when,
                    "sender": sender or "<system>",
                    "raw_text": content_clean,
                    "extracted_filename": filename,
                    "urls": normalize_urls(content_clean),
                    "is_system": sender is None,
                }
            elif current is not None:
                stripped = line.strip()
                attached_match = ATTACHED_FILE_LINE.match(stripped)
                existing_name = current.get("extracted_filename")
                if attached_match and not existing_name:
                    current["extracted_filename"] = attached_match.group("file").strip()
                elif existing_name and stripped in {existing_name, Path(existing_name).name}:
                    continue
                elif not existing_name and BARE_FILE.match(stripped):
                    current["extracted_filename"] = BARE_FILE.match(stripped).group("file").strip()
                else:
                    current["raw_text"] = (current["raw_text"] + "\n" + line).strip()
                    current["urls"].extend(u for u in normalize_urls(line) if u not in current["urls"])
    if current:
        done = _finalize(current)
        if done:
            yield done
