"""Scheduled database snapshots every 6 hours + on-demand backups.

Backups are stored under local_data/backups/. For SQLite the DB file is copied
(byte-for-byte via VACUUM INTO when possible, else shutil.copy2). For PostgreSQL a
plain-text pg_dump is written. Each snapshot is recorded in the db_snapshots table
with summary stats so the super admin can audit and restore.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

from sqlalchemy import func

from db import DB_BACKEND, DB_PATH, DATABASE_URL, SessionLocal, engine
from db.models import (
    DbSnapshot,
    Message,
    Project,
    ProjectCanvas,
    Upload,
    User,
    Workspace,
    WorkspaceMember,
    new_id,
)

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP_DIR = os.getenv("WA_BACKUP_DIR", os.path.join(_PROJECT_ROOT, "..", "local_data", "backups"))
BACKUP_INTERVAL_SECONDS = int(os.getenv("WA_BACKUP_INTERVAL_SECONDS", str(6 * 60 * 60)))

_scheduler_started = False
_scheduler_lock = threading.Lock()


def _backup_dir() -> Path:
    path = Path(BACKUP_DIR)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _collect_stats(db) -> dict:
    return {
        "users": db.query(User).count(),
        "workspaces": db.query(Workspace).count(),
        "projects": db.query(Project).count(),
        "uploads": db.query(Upload).count(),
        "messages": db.query(Message).count(),
        "canvases": db.query(ProjectCanvas).count(),
        "uploads_by_status": {
            status: count
            for status, count in db.query(Upload.status, func.count(Upload.id)).group_by(Upload.status).all()
            if status
        },
    }


def _snapshot_sqlite(target: Path) -> None:
    """Copy the live SQLite DB to target. Prefer VACUUM INTO for a consistent copy."""
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql(f"VACUUM INTO {str(target)!r}")
        return
    except Exception:
        pass
    shutil.copy2(DB_PATH, target)


def _snapshot_postgres(target: Path) -> None:
    """Dump the Postgres DB to a plain-text file via pg_dump."""
    env = os.environ.copy()
    env["PGPASSWORD"] = env.get("POSTGRES_PASSWORD", "")
    cmd = ["pg_dump", DATABASE_URL, "-f", str(target)]
    subprocess.run(cmd, check=True, env=env, capture_output=True)


def run_backup(kind: str = "scheduled", notes: str | None = None) -> DbSnapshot:
    """Create one snapshot now and record it. Returns the DbSnapshot row."""
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    ext = "db" if DB_BACKEND == "sqlite" else "sql"
    file_name = f"snapshot_{stamp}_{kind}.{ext}"
    target = _backup_dir() / file_name

    if DB_BACKEND == "sqlite":
        _snapshot_sqlite(target)
    else:
        _snapshot_postgres(target)

    size = target.stat().st_size if target.is_file() else 0

    db = SessionLocal()
    try:
        stats = _collect_stats(db)
        snapshot = DbSnapshot(
            id=new_id("snap"),
            kind=kind,
            backend=DB_BACKEND,
            file_name=file_name,
            file_path=str(target),
            size_bytes=size,
            stats=stats,
            notes=notes,
        )
        db.add(snapshot)
        db.commit()
        db.refresh(snapshot)
        return snapshot
    finally:
        db.close()


def _prune_old_snapshots(db, keep: int = 60) -> None:
    """Keep only the most recent `keep` snapshots; delete older rows + files."""
    rows = (
        db.query(DbSnapshot)
        .order_by(DbSnapshot.created_at.desc())
        .offset(keep)
        .all()
    )
    for row in rows:
        try:
            p = Path(row.file_path)
            if p.is_file():
                p.unlink()
        except Exception:
            pass
        db.delete(row)
    if rows:
        db.commit()


def _scheduler_loop() -> None:
    # Run an initial backup shortly after startup so there's always a fresh one.
    time.sleep(30)
    while True:
        try:
            snap = run_backup(kind="scheduled")
            db = SessionLocal()
            try:
                _prune_old_snapshots(db)
            finally:
                db.close()
            print(f"[backups] snapshot created: {snap.file_name} ({snap.size_bytes} bytes)")
        except Exception as exc:
            print(f"[backups] scheduled backup failed: {exc}")
        time.sleep(BACKUP_INTERVAL_SECONDS)


def start_backup_scheduler() -> None:
    global _scheduler_started
    with _scheduler_lock:
        if _scheduler_started:
            return
        _scheduler_started = True
    threading.Thread(target=_scheduler_loop, daemon=True).start()
    print(f"[backups] scheduler started (every {BACKUP_INTERVAL_SECONDS}s) -> {BACKUP_DIR}")


def serialize_snapshot(row: DbSnapshot) -> dict:
    return {
        "id": row.id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "kind": row.kind,
        "backend": row.backend,
        "file_name": row.file_name,
        "size_bytes": row.size_bytes,
        "stats": row.stats or {},
        "notes": row.notes,
    }
