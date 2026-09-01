"""Scheduled database + media backups with tiered retention.

Layout under WA_BACKUP_DIR (a host bind-mount in production, so it survives
`docker compose down -v` and volume loss):

    <WA_BACKUP_DIR>/db/     gzipped pg_dump (.sql.gz) or SQLite copies (.db)
    <WA_BACKUP_DIR>/files/  append-only mirror of uploads/ and extracted/

The file mirror never deletes, so removing an upload through the API still
leaves its media recoverable. Every DB snapshot is recorded in db_snapshots
with summary stats, and failures are tracked so /health can report them.
"""
from __future__ import annotations

import gzip
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
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
_DEFAULT_BACKUP_DIR = os.path.join(_PROJECT_ROOT, "..", "local_data", "backups")

BACKUP_DIR = os.getenv("WA_BACKUP_DIR", _DEFAULT_BACKUP_DIR)
BACKUP_INTERVAL_SECONDS = int(os.getenv("WA_BACKUP_INTERVAL_SECONDS", str(60 * 60)))
DATA_DIR = os.getenv("WA_DATA_DIR", os.path.join(_PROJECT_ROOT, "..", "local_data"))
MIRROR_FILES = (os.getenv("WA_BACKUP_MIRROR_FILES", "1") or "1").lower() not in {"0", "false", "no"}
MIRRORED_DIRS = ("uploads", "extracted")

# A destructive request reuses a snapshot this fresh instead of taking a new one.
PRE_DELETE_MAX_AGE_SECONDS = int(os.getenv("WA_PRE_DELETE_SNAPSHOT_MAX_AGE", "120"))
REQUIRE_BACKUP_BEFORE_DELETE = (
    os.getenv("WA_REQUIRE_BACKUP_BEFORE_DELETE", "1") or "1"
).lower() not in {"0", "false", "no"}

_scheduler_started = False
_scheduler_lock = threading.Lock()
_backup_lock = threading.RLock()

_status: dict = {
    "last_success_at": None,
    "last_success_file": None,
    "last_error": None,
    "last_error_at": None,
    "consecutive_failures": 0,
}


class BackupError(RuntimeError):
    """Raised when a snapshot could not be produced."""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _db_dir() -> Path:
    path = Path(BACKUP_DIR) / "db"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _files_dir() -> Path:
    path = Path(BACKUP_DIR) / "files"
    path.mkdir(parents=True, exist_ok=True)
    return path


def backup_status() -> dict:
    """Snapshot-system health, surfaced by /health and the control center."""
    with _backup_lock:
        status = dict(_status)
    last = status.get("last_success_at")
    age = None
    if last:
        age = int((_utcnow() - datetime.fromisoformat(last)).total_seconds())
    # Two missed cycles means something is wrong.
    stale = age is None or age > BACKUP_INTERVAL_SECONDS * 2 + 300
    status["last_success_age_seconds"] = age
    status["interval_seconds"] = BACKUP_INTERVAL_SECONDS
    status["directory"] = BACKUP_DIR
    status["healthy"] = bool(last) and not stale and status["consecutive_failures"] == 0
    return status


def _record_success(file_name: str) -> None:
    with _backup_lock:
        _status.update(
            last_success_at=_utcnow().isoformat(),
            last_success_file=file_name,
            last_error=None,
            consecutive_failures=0,
        )


def _record_failure(error: str) -> None:
    with _backup_lock:
        _status["last_error"] = error
        _status["last_error_at"] = _utcnow().isoformat()
        _status["consecutive_failures"] = int(_status.get("consecutive_failures") or 0) + 1


def _collect_stats(db) -> dict:
    return {
        "users": db.query(User).count(),
        "workspaces": db.query(Workspace).count(),
        "projects": db.query(Project).count(),
        "uploads": db.query(Upload).count(),
        "messages": db.query(Message).count(),
        "canvases": db.query(ProjectCanvas).count(),
        "members": db.query(WorkspaceMember).count(),
        "uploads_by_status": {
            status: count
            for status, count in db.query(Upload.status, func.count(Upload.id)).group_by(Upload.status).all()
            if status
        },
    }


def _snapshot_sqlite(target: Path) -> None:
    """Copy the live SQLite DB. VACUUM INTO gives a consistent copy under load."""
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql(f"VACUUM INTO {str(target)!r}")
        return
    except Exception:
        pass
    shutil.copy2(DB_PATH, target)


def _pg_dump_url() -> str:
    """pg_dump speaks libpq URLs, not SQLAlchemy's `postgresql+psycopg2://` form."""
    url = DATABASE_URL
    if "+" in url.split("://", 1)[0]:
        scheme, rest = url.split("://", 1)
        url = f"{scheme.split('+', 1)[0]}://{rest}"
    return url


def _snapshot_postgres(target: Path) -> None:
    """Dump Postgres to a gzipped, restore-ready plain SQL file."""
    raw = target.with_suffix("")  # strip .gz -> .sql
    cmd = [
        "pg_dump",
        _pg_dump_url(),
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--file",
        str(raw),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=1800)
    except FileNotFoundError as exc:
        raise BackupError(
            "pg_dump is not installed in the API image — rebuild with postgresql-client"
        ) from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise BackupError(f"pg_dump failed: {detail[:500]}") from exc

    # A truncated dump is worse than no dump: verify before we trust it.
    if not raw.is_file() or raw.stat().st_size == 0:
        raise BackupError("pg_dump produced an empty file")
    tail = raw.read_bytes()[-4096:].decode("utf-8", errors="replace")
    if "PostgreSQL database dump complete" not in tail:
        raw.unlink(missing_ok=True)
        raise BackupError("pg_dump output is truncated (missing completion marker)")

    with raw.open("rb") as src, gzip.open(target, "wb", compresslevel=6) as dst:
        shutil.copyfileobj(src, dst)
    raw.unlink(missing_ok=True)


def mirror_data_files() -> dict:
    """Append-only copy of uploads/extracted into the backup dir.

    Never deletes: a file removed from the live volume stays in the mirror, so
    deleting an upload through the API is recoverable alongside the DB snapshot.
    """
    if not MIRROR_FILES:
        return {"enabled": False}

    copied = 0
    skipped = 0
    failed = 0
    root = Path(DATA_DIR)
    dest_root = _files_dir()

    for name in MIRRORED_DIRS:
        source = root / name
        if not source.is_dir():
            continue
        for src in source.rglob("*"):
            if not src.is_file():
                continue
            dest = dest_root / name / src.relative_to(source)
            try:
                if dest.is_file():
                    src_stat = src.stat()
                    dest_stat = dest.stat()
                    if src_stat.st_size == dest_stat.st_size and int(src_stat.st_mtime) <= int(
                        dest_stat.st_mtime
                    ):
                        skipped += 1
                        continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
                copied += 1
            except Exception:
                failed += 1

    return {"enabled": True, "copied": copied, "skipped": skipped, "failed": failed}


def run_backup(kind: str = "scheduled", notes: str | None = None, mirror: bool = True) -> DbSnapshot:
    """Create one snapshot now and record it. Raises BackupError on failure."""
    with _backup_lock:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        ext = "db" if DB_BACKEND == "sqlite" else "sql.gz"
        file_name = f"snapshot_{stamp}_{kind}.{ext}"
        target = _db_dir() / file_name

        try:
            if DB_BACKEND == "sqlite":
                _snapshot_sqlite(target)
            else:
                _snapshot_postgres(target)
        except BackupError as exc:
            _record_failure(str(exc))
            raise
        except Exception as exc:
            _record_failure(f"{type(exc).__name__}: {exc}")
            raise BackupError(str(exc)) from exc

        size = target.stat().st_size if target.is_file() else 0
        file_stats = mirror_data_files() if mirror else {"enabled": False}

        db = SessionLocal()
        try:
            stats = _collect_stats(db)
            stats["files"] = file_stats
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
            _record_success(file_name)
            return snapshot
        finally:
            db.close()


def snapshot_before_destructive(action: str, actor: str | None = None) -> DbSnapshot | None:
    """Guarantee a recent snapshot exists before a destructive operation.

    Reuses a snapshot taken in the last PRE_DELETE_MAX_AGE_SECONDS so a burst of
    deletes doesn't dump the database repeatedly.
    """
    db = SessionLocal()
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=PRE_DELETE_MAX_AGE_SECONDS)
        recent = (
            db.query(DbSnapshot)
            .order_by(DbSnapshot.created_at.desc())
            .first()
        )
        if recent and recent.created_at:
            created = recent.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            if created >= cutoff and Path(recent.file_path).is_file():
                return recent
    finally:
        db.close()

    note = f"Before {action}" + (f" by {actor}" if actor else "")
    # Skip the file mirror here: it can walk ~1GB and the DB dump is what protects rows.
    return run_backup(kind="pre-delete", notes=note, mirror=False)


def _keep_ids_for_retention(rows: list[DbSnapshot]) -> set[str]:
    """Tiered retention: 48h of everything, then daily for 30d, weekly for 26w."""
    now = _utcnow()
    keep: set[str] = set()
    seen_days: set[str] = set()
    seen_weeks: set[str] = set()

    for row in rows:
        created = row.created_at
        if created is None:
            keep.add(row.id)
            continue
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        age = now - created

        if row.kind in {"manual", "pre-delete"} and age <= timedelta(days=30):
            keep.add(row.id)
            continue
        if age <= timedelta(hours=48):
            keep.add(row.id)
            continue
        if age <= timedelta(days=30):
            day = created.strftime("%Y-%m-%d")
            if day not in seen_days:
                seen_days.add(day)
                keep.add(row.id)
            continue
        if age <= timedelta(weeks=26):
            week = created.strftime("%Y-%W")
            if week not in seen_weeks:
                seen_weeks.add(week)
                keep.add(row.id)

    return keep


def prune_old_snapshots() -> int:
    db = SessionLocal()
    removed = 0
    try:
        rows = db.query(DbSnapshot).order_by(DbSnapshot.created_at.desc()).all()
        keep = _keep_ids_for_retention(rows)
        for row in rows:
            if row.id in keep:
                continue
            try:
                path = Path(row.file_path)
                if path.is_file():
                    path.unlink()
            except Exception:
                pass
            db.delete(row)
            removed += 1
        if removed:
            db.commit()
        return removed
    finally:
        db.close()


def _scheduler_loop() -> None:
    # Back up shortly after startup so a fresh deploy is never left unprotected.
    time.sleep(20)
    while True:
        try:
            snap = run_backup(kind="scheduled")
            removed = prune_old_snapshots()
            print(
                f"[backups] ok: {snap.file_name} ({snap.size_bytes} bytes), pruned {removed}",
                flush=True,
            )
        except Exception as exc:
            print(f"[backups] FAILED: {exc}", flush=True)
        time.sleep(BACKUP_INTERVAL_SECONDS)


def start_backup_scheduler() -> None:
    global _scheduler_started
    with _scheduler_lock:
        if _scheduler_started:
            return
        _scheduler_started = True
    threading.Thread(target=_scheduler_loop, daemon=True).start()
    print(f"[backups] scheduler started (every {BACKUP_INTERVAL_SECONDS}s) -> {BACKUP_DIR}", flush=True)


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
