"""Append-only WhatsApp ingest with zip extract, hash dedupe, and local media links."""
from __future__ import annotations

import hashlib
import threading
import zipfile
from pathlib import Path
from urllib.parse import quote

from app.parser import classify_message, iter_messages
from app.previews import fetch_preview, instant_preview, is_fetchable_url, normalize_urls, primary_url
from app.vectors import upsert_messages
from app.zip_extract import (
    EXTRACT_DIR,
    extract_zip,
    find_chat_exports,
    index_media,
    lookup_media,
    looks_like_zip,
)
from db import SessionLocal, engine
from db.models import Message, Upload, new_id
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

BATCH = 200
TAG_RULES = [
    ("Finance", ("invoice", "payment", "budget", "q1", "q2", "q3", "q4", "revenue", "gst")),
    ("Marketing", ("brand", "campaign", "marketing", "newsletter", "logo", "instagram", "reel")),
    ("Legal", ("legal", "contract", "nda", "copyright", "license")),
    ("Design", ("design", "layout", "mockup", "figma", "print")),
    ("Meetings", ("meeting", "call", "standup", "agenda")),
    ("Urgent", ("urgent", "asap", "eod", "deadline")),
]


def message_hash(sender: str, timestamp, text: str) -> str:
    raw = f"{sender}|{timestamp.isoformat()}|{text}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def auto_tags(text: str, msg_type: str) -> list[str]:
    blob = (text or "").lower()
    found = [msg_type]
    for name, needles in TAG_RULES:
        if any(needle in blob for needle in needles):
            found.append(name)
    return found


def _attach_local_file(parsed: dict, upload_id: str, media_index: dict[str, Path]) -> dict:
    local = lookup_media(parsed.get("extracted_filename"), media_index)
    if local is not None:
        parsed["extracted_filename"] = local.name
        parsed["extracted_url"] = f"/api/files/{upload_id}/{quote(local.name)}"
    msg_type, url, filename = classify_message(
        parsed.get("raw_text") or "",
        parsed.get("extracted_filename"),
        parsed.get("urls") or [],
    )
    parsed["type"] = msg_type
    parsed["extracted_filename"] = filename or parsed.get("extracted_filename")
    if url and not str(parsed.get("extracted_url") or "").startswith("/api/files/"):
        parsed["extracted_url"] = url
    elif url and str(parsed.get("extracted_url") or "").startswith("/api/files/"):
        parsed["link_preview"] = instant_preview(url)
    if parsed.get("extracted_url") and str(parsed["extracted_url"]).startswith("http"):
        parsed["link_preview"] = instant_preview(parsed["extracted_url"])
    return parsed


def _existing_hashes(db, workspace_id: str | None, hashes: list[str]) -> set[str]:
    if not workspace_id or not hashes:
        return set()
    found: set[str] = set()
    for index in range(0, len(hashes), 400):
        chunk = hashes[index : index + 400]
        found.update(
            item[0]
            for item in db.query(Message.content_hash)
            .filter(Message.workspace_id == workspace_id, Message.content_hash.in_(chunk))
            .all()
        )
    return found


def _insert_messages_ignore(db, rows: list[dict]) -> None:
    if not rows:
        return
    if engine.dialect.name == "postgresql":
        stmt = pg_insert(Message).on_conflict_do_nothing(constraint="uq_message_workspace_hash")
    else:
        stmt = sqlite_insert(Message).on_conflict_do_nothing(index_elements=["workspace_id", "content_hash"])
    db.execute(stmt, rows)


def _flush(db, batch: list[dict]) -> tuple[int, int]:
    """Insert new rows, skipping duplicates by workspace + content hash."""
    total = len(batch)
    unique: dict[str, dict] = {}
    for row in batch:
        if not row.get("workspace_id"):
            continue
        unique[row["content_hash"]] = row
    rows = []
    for row in unique.values():
        payload = dict(row)
        payload.setdefault("id", new_id("msg"))
        rows.append(payload)
    if not rows:
        return 0, total
    workspace_id = rows[0]["workspace_id"]
    existing = _existing_hashes(db, workspace_id, [row["content_hash"] for row in rows])
    new_rows = [row for row in rows if row["content_hash"] not in existing]
    if not new_rows:
        return 0, total
    _insert_messages_ignore(db, new_rows)
    db.flush()
    inserted: list[Message] = []
    hashes = [row["content_hash"] for row in new_rows]
    for index in range(0, len(hashes), 400):
        inserted.extend(
            db.query(Message)
            .filter(Message.workspace_id == workspace_id, Message.content_hash.in_(hashes[index : index + 400]))
            .all()
        )
    upsert_messages(inserted)
    return len(new_rows), total - len(new_rows)


def _row(upload_id: str, workspace_id: str | None, parsed: dict, before: str, after: str) -> dict:
    return {
        "upload_id": upload_id,
        "workspace_id": workspace_id,
        "sender": parsed["sender"],
        "timestamp": parsed["timestamp"],
        "raw_text": parsed["raw_text"],
        "type": parsed["type"],
        "extracted_url": parsed["extracted_url"],
        "extracted_filename": parsed["extracted_filename"],
        "context_before": before or None,
        "context_after": after or None,
        "content_hash": message_hash(parsed["sender"], parsed["timestamp"], parsed["raw_text"]),
        "chat_name": parsed["chat_name"],
        "tags": auto_tags(parsed["raw_text"], parsed["type"]),
        "link_preview": parsed.get("link_preview"),
    }


def _ingest_chat(
    db, upload_id: str, workspace_id: str | None, txt_path: Path, media_index: dict[str, Path]
) -> tuple[str | None, int, int]:
    pending: list[dict] = []
    previous_text = ""
    previous_parsed: dict | None = None
    chat_name = None
    inserted_total = 0
    duplicate_total = 0

    for parsed in iter_messages(txt_path):
        parsed = _attach_local_file(parsed, upload_id, media_index)
        chat_name = parsed["chat_name"]
        if previous_parsed is not None:
            pending.append(_row(upload_id, workspace_id, previous_parsed, previous_text, parsed["raw_text"]))
            if len(pending) >= BATCH:
                inserted, duplicates = _flush(db, pending)
                inserted_total += inserted
                duplicate_total += duplicates
                pending = []
            previous_text = previous_parsed["raw_text"]
        previous_parsed = parsed

    if previous_parsed is not None:
        pending.append(_row(upload_id, workspace_id, previous_parsed, previous_text, ""))
    inserted, duplicates = _flush(db, pending)
    inserted_total += inserted
    duplicate_total += duplicates
    return chat_name, inserted_total, duplicate_total


def process_upload(upload_id: str, saved_path: str) -> None:
    db = SessionLocal()
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        db.close()
        return
    path = Path(saved_path)
    try:
        chat_files = [path]
        media_index: dict[str, Path] = {}

        if looks_like_zip(path):
            upload.status = "extracting"
            db.commit()
            extract_root = EXTRACT_DIR / upload.id
            extract_zip(path, extract_root)
            chat_files = find_chat_exports(extract_root)
            media_index = index_media(extract_root)
            if not chat_files:
                upload.status = "failed"
                upload.error_message = "No WhatsApp .txt chat export was found inside the zip."
                db.commit()
                return

        upload.status = "processing"
        db.commit()

        names: list[str] = []
        duplicate_total = 0
        for chat_path in chat_files:
            name, _inserted, duplicates = _ingest_chat(db, upload.id, upload.workspace_id, chat_path, media_index)
            duplicate_total += duplicates
            if name:
                names.append(name)

        upload.chat_name = ", ".join(dict.fromkeys(names))[:240] or None
        upload.message_count = db.query(Message).filter(Message.upload_id == upload.id).count()
        upload.duplicate_count = duplicate_total
        backfill_message_types(db, upload_id=upload.id)
        upload.status = "completed"
        upload.error_message = None
        db.commit()
        threading.Thread(target=hydrate_link_previews, kwargs={"upload_id": upload.id}, daemon=True).start()
    except zipfile.BadZipFile:
        db.rollback()
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            upload.status = "failed"
            upload.error_message = "That file is not a valid zip archive."
            db.commit()
    except Exception as exc:
        db.rollback()
        upload = db.query(Upload).filter(Upload.id == upload_id).first()
        if upload:
            upload.status = "failed"
            upload.error_message = str(exc)
            db.commit()
    finally:
        db.close()


def backfill_message_types(db, upload_id: str | None = None) -> int:
    query = db.query(Message)
    if upload_id:
        query = query.filter(Message.upload_id == upload_id)
    updated = 0
    for msg in query.yield_per(200):
        urls = normalize_urls(msg.raw_text or "")
        extra = msg.extracted_url
        if extra and str(extra).startswith("http") and extra not in urls:
            urls = [extra, *urls]
        new_type, url, filename = classify_message(msg.raw_text or "", msg.extracted_filename, urls)
        changed = False
        if filename and not msg.extracted_filename:
            msg.extracted_filename = filename
            changed = True
        if url and (not msg.extracted_url or str(msg.extracted_url).startswith("/api/files/")):
            if url.startswith("http"):
                if not msg.extracted_url or str(msg.extracted_url).startswith("/api/files/"):
                    if msg.type in {"chat", "link", "reel"} or not msg.extracted_url:
                        msg.extracted_url = url
                        changed = True
        elif url and not msg.extracted_url:
            msg.extracted_url = url
            changed = True
        if new_type != (msg.type or "") and not (
            msg.extracted_filename and new_type == "link" and msg.type in {"image", "document", "reel"}
        ):
            if msg.type == "chat" and new_type in {"link", "reel"}:
                msg.type = new_type
                changed = True
            elif msg.type not in {"image", "document"}:
                msg.type = new_type
                changed = True
        preview_url = primary_url(msg.raw_text, msg.extracted_url if str(msg.extracted_url or "").startswith("http") else url)
        if preview_url and not msg.link_preview:
            msg.link_preview = instant_preview(preview_url)
            changed = True
        if changed:
            updated += 1
    if updated:
        db.commit()
    return updated


def hydrate_link_previews(upload_id: str | None = None, limit: int = 80) -> None:
    from sqlalchemy import or_

    db = SessionLocal()
    try:
        query = db.query(Message)
        if upload_id:
            query = query.filter(Message.upload_id == upload_id)
        query = query.filter(
            or_(
                Message.type.in_(["link", "reel"]),
                Message.extracted_url.ilike("http%"),
                Message.raw_text.ilike("%http://%"),
                Message.raw_text.ilike("%https://%"),
            )
        )
        count = 0
        for msg in query.order_by(Message.timestamp.desc()).limit(limit):
            stored = msg.link_preview if isinstance(msg.link_preview, dict) else {}
            if stored.get("fetched"):
                continue
            url = primary_url(msg.raw_text, msg.extracted_url if str(msg.extracted_url or "").startswith("http") else None)
            if not url or not is_fetchable_url(url):
                continue
            data = fetch_preview(url)
            data["fetched"] = True
            msg.link_preview = data
            if not msg.extracted_url or str(msg.extracted_url).startswith("/api/files/"):
                if msg.type in {"link", "reel", "chat"}:
                    msg.extracted_url = url
            count += 1
        if count:
            db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()
