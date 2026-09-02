"""Upload size limits and per-workspace storage quotas."""
from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy.orm import Session

from db.models import Upload

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
UPLOAD_DIR = _PROJECT_ROOT / "local_data" / "uploads"
EXTRACT_DIR = _PROJECT_ROOT / "local_data" / "extracted"

# Per-file cap (WhatsApp zips can be large, but 2 GB is reckless on a small VPS).
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))
# Total extracted + raw uploads per workspace.
MAX_WORKSPACE_STORAGE_BYTES = int(
    os.getenv("MAX_WORKSPACE_STORAGE_BYTES", str(15 * 1024 * 1024 * 1024))
)


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for child in path.rglob("*"):
        if child.is_file():
            try:
                total += child.stat().st_size
            except OSError:
                pass
    return total


def workspace_storage_bytes(workspace_id: str, db: Session) -> int:
    """Bytes on disk for all uploads in this workspace (raw zips + extracted media)."""
    upload_ids = [
        row[0]
        for row in db.query(Upload.id).filter(Upload.workspace_id == workspace_id).all()
    ]
    total = 0
    for upload_id in upload_ids:
        for path in UPLOAD_DIR.glob(f"{upload_id}_*"):
            try:
                total += path.stat().st_size
            except OSError:
                pass
        total += _dir_size(EXTRACT_DIR / upload_id)
    return total


def format_bytes(num: int) -> str:
    if num < 1024:
        return f"{num} B"
    if num < 1024 * 1024:
        return f"{num / 1024:.1f} KB"
    if num < 1024 * 1024 * 1024:
        return f"{num / (1024 * 1024):.1f} MB"
    return f"{num / (1024 * 1024 * 1024):.2f} GB"
