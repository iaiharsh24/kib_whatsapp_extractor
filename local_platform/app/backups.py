"""Scheduled database + media backups with tiered retention.

Layout under WA_BACKUP_DIR (a host bind-mount in production, so it survives
`docker compose down -v` and volume loss):

    <WA_BACKUP_DIR>/db/     gzipped pg_dump (.sql.gz) or SQLite copies (.db)
    <WA_BACKUP_DIR>/files/  append-only mirror of uploads/ and extracted/

After each successful Postgres dump, the same dump is restored into a second
Postgres instance (postgres_mirror) so a full DB copy always exists separately
from the primary volume.

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
from urllib.parse import urlparse, unquote

from sqlalchemy import func

from db import DB_BACKEND, DB_PATH, DATABASE_URL, SessionLocal, engine
from db.models import (
    BackupEvent,
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

# Second Postgres that always holds the latest dump (separate Docker volume).
DATABASE_MIRROR_URL = (os.getenv("DATABASE_MIRROR_URL") or "").strip()
DB_MIRROR_ENABLED = (os.getenv("WA_DB_MIRROR_ENABLED", "1") or "1").lower() not in {
    "0",
    "false",
    "no",
} and bool(DATABASE_MIRROR_URL)

# Optional alert webhook (Slack/Discord/healthchecks.io/Teams all accept a POST).
# No-op when unset, so this is safe by default. On failure (and on first success
# after failures) we POST a small JSON payload so silent backup death can't recur.
ALERT_WEBHOOK_URL = (os.getenv("WA_BACKUP_ALERT_WEBHOOK") or "").strip()
ALERT_MIN_FAILURES = int(os.getenv("WA_BACKUP_ALERT_MIN_FAILURES", "1"))

# A destructive request reuses a snapshot this fresh instead of taking a new one.
PRE_DELETE_MAX_AGE_SECONDS = int(os.getenv("WA_PRE_DELETE_SNAPSHOT_MAX_AGE", "120"))
REQUIRE_BACKUP_BEFORE_DELETE = (
    os.getenv("WA_REQUIRE_BACKUP_BEFORE_DELETE", "1") or "1"
).lower() not in {"0", "false", "no"}

_scheduler_started = False
_scheduler_lock = threading.Lock()
_backup_lock = threading.RLock()

# In-memory mirror of the latest BackupEvent, so /health stays fast and still
# works before the first event is persisted. The DB table is the source of truth.
_latest_event: dict | None = None
_mirror_state: dict = {
    "enabled": DB_MIRROR_ENABLED,
    "healthy": None,
    "last_success_at": None,
    "last_error": None,
    "last_error_at": None,
    "target": DATABASE_MIRROR_URL.split("@")[-1] if DATABASE_MIRROR_URL else None,
}


def _mirror_status_path() -> Path:
    return Path(BACKUP_DIR) / "db_mirror_status.json"


def _load_mirror_state() -> dict:
    """Cross-worker mirror status (uvicorn runs multiple processes)."""
    state = {
        "enabled": DB_MIRROR_ENABLED,
        "healthy": None,
        "last_success_at": None,
        "last_error": None,
        "last_error_at": None,
        "target": DATABASE_MIRROR_URL.split("@")[-1] if DATABASE_MIRROR_URL else None,
    }
    path = _mirror_status_path()
    try:
        if path.is_file():
            import json

            disk = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(disk, dict):
                state.update(disk)
    except Exception:
        pass
    state["enabled"] = DB_MIRROR_ENABLED
    state["target"] = DATABASE_MIRROR_URL.split("@")[-1] if DATABASE_MIRROR_URL else None
    return state


def _save_mirror_state(**updates) -> None:
    state = _load_mirror_state()
    state.update(updates)
    _mirror_state.clear()
    _mirror_state.update(state)
    path = _mirror_status_path()
    try:
        import json

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception as exc:
        print(f"[backups] could not persist mirror status: {exc}", flush=True)


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


def _persist_event(
    outcome: str,
    *,
    kind: str,
    file_name: str | None,
    size_bytes: int | None,
    error: str | None,
    consecutive_failures: int,
) -> None:
    """Record one backup attempt durably. Survives restarts."""
    global _latest_event
    db = SessionLocal()
    try:
        event = BackupEvent(
            id=new_id("bevt"),
            outcome=outcome,
            kind=kind,
            file_name=file_name,
            size_bytes=size_bytes,
            error=(error[:2000] if error else None),
            consecutive_failures=consecutive_failures,
        )
        db.add(event)
        db.commit()
        db.refresh(event)
        _latest_event = {
            "id": event.id,
            "created_at": (event.created_at.replace(tzinfo=timezone.utc) if event.created_at and event.created_at.tzinfo is None else event.created_at),
            "outcome": outcome,
            "kind": kind,
            "file_name": file_name,
            "size_bytes": size_bytes,
            "error": error,
            "consecutive_failures": consecutive_failures,
        }
    except Exception as exc:
        # Never let alerting/audit take down a backup. Log and continue.
        print(f"[backups] could not persist event: {exc}", flush=True)
    finally:
        db.close()


def _fire_alert(payload: dict, *, force: bool = False) -> None:
    """POST an alert to the configured webhook. Best-effort, never raises."""
    if not ALERT_WEBHOOK_URL:
        return
    try:
        import httpx

        with httpx.Client(timeout=10.0) as client:
            client.post(ALERT_WEBHOOK_URL, json=payload)
    except Exception as exc:
        print(f"[backups] alert webhook failed: {exc}", flush=True)


def backup_status() -> dict:
    """Snapshot-system health, sourced from the durable backup_events table."""
    db = SessionLocal()
    try:
        latest = db.query(BackupEvent).order_by(BackupEvent.created_at.desc()).first()
    finally:
        db.close()

    if not latest:
        return {
            "healthy": False,
            "directory": BACKUP_DIR,
            "interval_seconds": BACKUP_INTERVAL_SECONDS,
            "last_success_at": None,
            "last_success_file": None,
            "last_success_age_seconds": None,
            "last_error": None,
            "last_error_at": None,
            "consecutive_failures": 0,
            "db_mirror": _load_mirror_state(),
        }

    created = latest.created_at
    if created and created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    age = int((_utcnow() - created).total_seconds()) if created else None

    # Find the most recent success for the "last successful backup" fields.
    db = SessionLocal()
    try:
        last_success = (
            db.query(BackupEvent)
            .filter(BackupEvent.outcome == "success")
            .order_by(BackupEvent.created_at.desc())
            .first()
        )
    finally:
        db.close()
    if last_success and last_success.created_at:
        ls_at = last_success.created_at
        if ls_at.tzinfo is None:
            ls_at = ls_at.replace(tzinfo=timezone.utc)
        last_success_at = ls_at.isoformat()
        last_success_age = int((_utcnow() - ls_at).total_seconds())
    else:
        last_success_at = None
        last_success_age = None

    cf = latest.consecutive_failures or 0
    stale = last_success_age is None or last_success_age > BACKUP_INTERVAL_SECONDS * 2 + 300
    mirror_state = _load_mirror_state()
    mirror_ok = (not DB_MIRROR_ENABLED) or (mirror_state.get("healthy") is not False)
    return {
        "healthy": bool(last_success_at) and not stale and cf == 0 and mirror_ok,
        "directory": BACKUP_DIR,
        "interval_seconds": BACKUP_INTERVAL_SECONDS,
        "last_success_at": last_success_at,
        "last_success_file": last_success.file_name if last_success else None,
        "last_success_age_seconds": last_success_age,
        "last_error": latest.error if latest.outcome == "failure" else None,
        "last_error_at": created.isoformat() if latest.outcome == "failure" else None,
        "consecutive_failures": cf,
        "db_mirror": _load_mirror_state(),
    }


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


def _libpq_url(url: str) -> str:
    """Convert SQLAlchemy URLs to libpq form for psql/pg_dump."""
    if "+" in url.split("://", 1)[0]:
        scheme, rest = url.split("://", 1)
        return f"{scheme.split('+', 1)[0]}://{rest}"
    return url


def _mirror_psql_env() -> dict:
    """Build env for psql against the snapshot database (never the primary)."""
    parsed = urlparse(_libpq_url(DATABASE_MIRROR_URL))
    if parsed.scheme not in {"postgresql", "postgres"}:
        raise BackupError(f"unsupported DATABASE_MIRROR_URL scheme: {parsed.scheme}")
    dbname = (parsed.path or "/whatsapp").lstrip("/") or "whatsapp"
    env = os.environ.copy()
    env["PGHOST"] = parsed.hostname or "postgres_mirror"
    env["PGPORT"] = str(parsed.port or 5432)
    env["PGUSER"] = unquote(parsed.username or "whatsapp")
    env["PGPASSWORD"] = unquote(parsed.password or "")
    env["PGDATABASE"] = dbname
    return env


def refresh_mirror_database(dump_path: Path) -> None:
    """Replace the snapshot Postgres DB with the contents of a verified dump.

    This never touches the primary DATABASE_URL — only DATABASE_MIRROR_URL.
    Uses a cross-process lock because uvicorn runs multiple workers.
    """
    if not DB_MIRROR_ENABLED:
        return
    if DB_BACKEND != "postgresql":
        return
    if not dump_path.is_file():
        raise BackupError(f"mirror refresh missing dump: {dump_path}")

    import fcntl

    lock_path = Path(BACKUP_DIR) / ".mirror_refresh.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_fd = open(lock_path, "a+", encoding="utf-8")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        _refresh_mirror_database_locked(dump_path)
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        except Exception:
            pass
        lock_fd.close()


def _refresh_mirror_database_locked(dump_path: Path) -> None:
    env = _mirror_psql_env()
    dbname = env["PGDATABASE"]
    owner = env["PGUSER"]
    admin_env = env.copy()
    admin_env["PGDATABASE"] = "postgres"
    tmp_sql = Path(BACKUP_DIR) / f".mirror_restore_{os.getpid()}.sql"

    # Recreate an empty snapshot DB so restore never fights leftover locks/sessions.
    # DROP DATABASE cannot run inside a multi-statement transaction block.
    try:
        subprocess.run(
            [
                "psql",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                (
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    f"WHERE datname = '{dbname}' AND pid <> pg_backend_pid();"
                ),
            ],
            check=True,
            capture_output=True,
            timeout=60,
            env=admin_env,
        )
        subprocess.run(
            ["psql", "-v", "ON_ERROR_STOP=1", "-c", f'DROP DATABASE IF EXISTS "{dbname}";'],
            check=True,
            capture_output=True,
            timeout=60,
            env=admin_env,
        )
        subprocess.run(
            [
                "psql",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                f'CREATE DATABASE "{dbname}" OWNER "{owner}";',
            ],
            check=True,
            capture_output=True,
            timeout=60,
            env=admin_env,
        )
        with gzip.open(dump_path, "rb") as src, tmp_sql.open("wb") as dst:
            shutil.copyfileobj(src, dst)
        subprocess.run(
            ["psql", "-v", "ON_ERROR_STOP=1", "--quiet", "-f", str(tmp_sql)],
            check=True,
            capture_output=True,
            timeout=1800,
            env=env,
        )
        check = subprocess.run(
            ["psql", "-v", "ON_ERROR_STOP=1", "-tAc", "SELECT count(*) FROM users"],
            check=True,
            capture_output=True,
            timeout=30,
            env=env,
            text=True,
        )
        if not (check.stdout or "").strip().isdigit():
            raise BackupError("mirror refresh verification failed (users table)")
    except FileNotFoundError as exc:
        raise BackupError("psql is not installed in the API image") from exc
    except subprocess.CalledProcessError as exc:
        err = exc.stderr
        if isinstance(err, bytes):
            detail = err.decode("utf-8", errors="replace").strip()
        else:
            detail = (err or str(exc)).strip()
        _save_mirror_state(
            healthy=False,
            last_error=detail[:500] or str(exc),
            last_error_at=_utcnow().isoformat(),
        )
        raise BackupError(f"mirror refresh failed: {detail[:500]}") from exc
    finally:
        tmp_sql.unlink(missing_ok=True)

    _save_mirror_state(
        enabled=True,
        healthy=True,
        last_success_at=_utcnow().isoformat(),
        last_error=None,
        last_error_at=None,
        target=DATABASE_MIRROR_URL.split("@")[-1],
    )


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


def _current_consecutive_failures() -> int:
    db = SessionLocal()
    try:
        latest = db.query(BackupEvent).order_by(BackupEvent.created_at.desc()).first()
        return (latest.consecutive_failures or 0) if latest and latest.outcome == "failure" else 0
    finally:
        db.close()


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
            cf = _current_consecutive_failures() + 1
            _persist_event(
                "failure", kind=kind, file_name=None, size_bytes=None,
                error=str(exc), consecutive_failures=cf,
            )
            if cf >= ALERT_MIN_FAILURES:
                _fire_alert({
                    "source": "whatsapp-strategy-canvas",
                    "severity": "critical",
                    "event": "backup_failed",
                    "consecutive_failures": cf,
                    "error": str(exc),
                    "backend": DB_BACKEND,
                    "directory": BACKUP_DIR,
                })
            raise
        except Exception as exc:
            cf = _current_consecutive_failures() + 1
            msg = f"{type(exc).__name__}: {exc}"
            _persist_event(
                "failure", kind=kind, file_name=None, size_bytes=None,
                error=msg, consecutive_failures=cf,
            )
            if cf >= ALERT_MIN_FAILURES:
                _fire_alert({
                    "source": "whatsapp-strategy-canvas",
                    "severity": "critical",
                    "event": "backup_failed",
                    "consecutive_failures": cf,
                    "error": msg,
                    "backend": DB_BACKEND,
                    "directory": BACKUP_DIR,
                })
            raise BackupError(msg) from exc

        size = target.stat().st_size if target.is_file() else 0
        file_stats = mirror_data_files() if mirror else {"enabled": False}

        # Keep a second live Postgres copy in sync with every successful dump.
        if DB_BACKEND == "postgresql" and DB_MIRROR_ENABLED:
            try:
                refresh_mirror_database(target)
                file_stats = {**(file_stats or {}), "db_mirror": "ok"}
            except BackupError as exc:
                # Dump file is still valid; mark overall backup unhealthy via mirror state.
                print(f"[backups] dump ok but mirror refresh failed: {exc}", flush=True)
                file_stats = {**(file_stats or {}), "db_mirror": f"failed: {exc}"}
                cf = _current_consecutive_failures() + 1
                _persist_event(
                    "failure",
                    kind=kind,
                    file_name=file_name,
                    size_bytes=size,
                    error=f"mirror refresh failed: {exc}",
                    consecutive_failures=cf,
                )
                if cf >= ALERT_MIN_FAILURES:
                    _fire_alert({
                        "source": "whatsapp-strategy-canvas",
                        "severity": "critical",
                        "event": "backup_mirror_failed",
                        "consecutive_failures": cf,
                        "error": str(exc),
                        "backend": DB_BACKEND,
                        "directory": BACKUP_DIR,
                    })
                raise

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
        finally:
            db.close()

        # Success. If we were in a failure streak, this is the recovery — alert it.
        prev_failures = _current_consecutive_failures()
        _persist_event(
            "success", kind=kind, file_name=file_name, size_bytes=size,
            error=None, consecutive_failures=0,
        )
        if prev_failures >= ALERT_MIN_FAILURES:
            _fire_alert({
                "source": "whatsapp-strategy-canvas",
                "severity": "info",
                "event": "backup_recovered",
                "previous_failures": prev_failures,
                "file_name": file_name,
                "size_bytes": size,
            })
        return snapshot


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
    import fcntl

    # Uvicorn --workers 2 would otherwise start two schedulers and race the mirror.
    lock_path = Path(BACKUP_DIR) / ".backup_scheduler.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_fd = open(lock_path, "a+", encoding="utf-8")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("[backups] scheduler already running in another worker — skipping", flush=True)
        lock_fd.close()
        return

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
