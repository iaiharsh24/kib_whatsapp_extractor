"""Database session, schema migrations (Alembic), and default admin seed."""
import os
from pathlib import Path

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import sessionmaker

from .models import Base, Project, ProjectCanvas, User, Workspace, WorkspaceMember

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.getenv(
    "WA_DATA_DB_PATH",
    os.path.join(_PROJECT_ROOT, "local_data", "strategy.db"),
)
DATABASE_URL = (os.getenv("DATABASE_URL") or "").strip()

if DATABASE_URL:
    engine = create_engine(
        DATABASE_URL,
        echo=False,
        future=True,
        pool_pre_ping=True,
        connect_args={"connect_timeout": 5},
    )
    DB_BACKEND = "postgresql"
else:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    engine = create_engine(
        f"sqlite+pysqlite:///{DB_PATH}",
        echo=False,
        future=True,
        connect_args={"check_same_thread": False},
    )
    DB_BACKEND = "sqlite"


def _enable_sqlite_foreign_keys(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


if DB_BACKEND == "sqlite":
    event.listen(engine, "connect", _enable_sqlite_foreign_keys)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def wait_for_database(max_attempts: int = 15, delay_seconds: float = 2.0) -> None:
    if DB_BACKEND == "sqlite":
        return
    import time

    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return
        except Exception as exc:
            last_error = exc
            print(f"Database not ready (attempt {attempt}/{max_attempts}): {exc}")
            time.sleep(delay_seconds)
    raise RuntimeError(f"Database unavailable after {max_attempts} attempts") from last_error


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _run_alembic_on_startup() -> None:
    """Bring the database schema up to the latest Alembic revision.

    - Existing pre-Alembic databases (tables present, no alembic_version row) are
      stamped to the baseline revision once. They are already at the current
      schema because the legacy boot migrations ran on them before; stamping
      means we never re-run those scans/UPDATEs on every restart.
    - Fresh empty databases get `upgrade head`, which runs the baseline revision
      (Base.metadata.create_all) and any newer revisions.
    - Already-versioned databases get `upgrade head` to apply pending revisions.
    """
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(_PROJECT_ROOT) / "local_platform" / "alembic.ini"))
    # script_location in alembic.ini is relative to cwd, which differs between the
    # Docker WORKDIR (/app/local_platform) and local dev. Pin it to the absolute path.
    cfg.set_main_option("script_location", str(Path(_PROJECT_ROOT) / "local_platform" / "alembic"))
    # env.py reads the app engine directly; this URL is only used for offline mode.
    cfg.set_main_option(
        "sqlalchemy.url", DATABASE_URL or f"sqlite+pysqlite:///{DB_PATH}"
    )

    insp = inspect(engine)
    existing_tables = set(insp.get_table_names())
    has_alembic_row = False
    if "alembic_version" in existing_tables:
        with engine.connect() as conn:
            has_alembic_row = conn.execute(text("SELECT count(*) FROM alembic_version")).scalar() > 0

    if not has_alembic_row and "users" in existing_tables:
        # Pre-Alembic database already at the current schema: stamp, don't recreate.
        print("[db] stamping existing database to Alembic baseline (0001_baseline)")
        command.stamp(cfg, "0001_baseline")
    else:
        command.upgrade(cfg, "head")


def create_tables():
    """Create/upgrade the schema via Alembic, then report the backend location."""
    wait_for_database()
    _run_alembic_on_startup()
    location = DATABASE_URL.split("@")[-1] if DATABASE_URL else DB_PATH
    print(f"Schema ready ({DB_BACKEND}) at: {location}")


def seed_local_defaults():
    from app.auth import hash_password
    from db.workspaces import ensure_personal_workspace

    admin_email = (os.getenv("ADMIN_EMAIL") or "admin@local").strip().lower()
    admin_password = os.getenv("ADMIN_PASSWORD") or "admin123"
    admin_username = (os.getenv("ADMIN_USERNAME") or admin_email.split("@")[0] or "admin").strip()
    from app.auth import SUPER_ADMIN_EMAILS
    admin_role = "superadmin" if admin_email in SUPER_ADMIN_EMAILS else "admin"

    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.username == "admin").first()
        if not admin:
            admin = db.query(User).filter(User.email == admin_email).first()
        if not admin:
            admin = User(
                id="user_admin",
                username=admin_username,
                email=admin_email,
                password_hash=hash_password(admin_password),
                role=admin_role,
            )
            db.add(admin)
            db.commit()
            db.refresh(admin)
        else:
            if not admin.email:
                admin.email = admin_email
            if admin_username and admin.username != admin_username:
                admin.username = admin_username
            # Promote the seeded admin to superadmin if their email is allowlisted.
            if admin.email and admin.email.lower() in SUPER_ADMIN_EMAILS and admin.role != "superadmin":
                admin.role = "superadmin"
            db.commit()

        ensure_personal_workspace(db, admin, name="Admin workspace")
        if not db.query(Project).filter(Project.created_by == admin.id).first():
            workspace = (
                db.query(Workspace)
                .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
                .filter(WorkspaceMember.user_id == admin.id, WorkspaceMember.role == "owner")
                .first()
            )
            if workspace:
                project = Project(name="My canvas", created_by=admin.id, workspace_id=workspace.id)
                db.add(project)
                db.flush()
                db.add(ProjectCanvas(project_id=project.id, name="Main canvas", nodes=[], edges=[], frames=[]))
        db.commit()
    finally:
        db.close()