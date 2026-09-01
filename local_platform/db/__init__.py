"""Database session, schema create, and default admin seed."""
import os
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import sessionmaker

from .models import Base, Message, Project, ProjectCanvas, Upload, User, Workspace, WorkspaceMember

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


def _table_columns(conn, table_name: str) -> set[str]:
    return {column["name"] for column in inspect(conn).get_columns(table_name)}


def _ensure_columns():
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    if not existing_tables:
        return

    with engine.begin() as conn:
        if "messages" in existing_tables:
            names = _table_columns(conn, "messages")
            if "link_preview" not in names:
                conn.execute(text("ALTER TABLE messages ADD COLUMN link_preview JSON"))
            if "workspace_id" not in names:
                conn.execute(text("ALTER TABLE messages ADD COLUMN workspace_id VARCHAR"))
            if "project_id" not in names:
                conn.execute(text("ALTER TABLE messages ADD COLUMN project_id VARCHAR"))

        if "project_canvas" in existing_tables:
            canvas_names = _table_columns(conn, "project_canvas")
            if "viewport" not in canvas_names:
                conn.execute(text("ALTER TABLE project_canvas ADD COLUMN viewport JSON"))
            if "name" not in canvas_names:
                conn.execute(text("ALTER TABLE project_canvas ADD COLUMN name VARCHAR DEFAULT 'Main canvas'"))
            if "created_at" not in canvas_names:
                conn.execute(text("ALTER TABLE project_canvas ADD COLUMN created_at DATETIME"))

        if "users" in existing_tables:
            user_names = _table_columns(conn, "users")
            if "email" not in user_names:
                conn.execute(text("ALTER TABLE users ADD COLUMN email VARCHAR"))

        if "uploads" in existing_tables:
            upload_names = _table_columns(conn, "uploads")
            if "workspace_id" not in upload_names:
                conn.execute(text("ALTER TABLE uploads ADD COLUMN workspace_id VARCHAR"))
            if "duplicate_count" not in upload_names:
                conn.execute(text("ALTER TABLE uploads ADD COLUMN duplicate_count INTEGER DEFAULT 0"))
            if "project_id" not in upload_names:
                conn.execute(text("ALTER TABLE uploads ADD COLUMN project_id VARCHAR"))

        if "projects" in existing_tables:
            project_names = _table_columns(conn, "projects")
            if "workspace_id" not in project_names:
                conn.execute(text("ALTER TABLE projects ADD COLUMN workspace_id VARCHAR"))

    _migrate_project_canvas_multi()
    _ensure_message_hash_index()
    _migrate_project_data()


def _project_canvas_has_unique_project_id(conn) -> bool:
    if DB_BACKEND == "sqlite":
        row = conn.execute(text("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_canvas'")).fetchone()
        if not row or not row[0]:
            return False
        ddl = str(row[0])
        return "UNIQUE (project_id)" in ddl or "UNIQUE(project_id)" in ddl

    uniques = inspect(conn).get_unique_constraints("project_canvas")
    return any(set(item.get("column_names") or []) == {"project_id"} for item in uniques)


def _migrate_project_canvas_multi():
    """Allow multiple canvases per project (drop legacy UNIQUE(project_id))."""
    inspector = inspect(engine)
    if "project_canvas" not in inspector.get_table_names():
        return

    with engine.begin() as conn:
        if not _project_canvas_has_unique_project_id(conn):
            return

        print("[db] Migrating project_canvas: removing UNIQUE(project_id) for multi-canvas support")
        if DB_BACKEND == "sqlite":
            conn.execute(text("PRAGMA foreign_keys=OFF"))
            conn.execute(
                text(
                    """
                    CREATE TABLE project_canvas_new (
                        id VARCHAR NOT NULL PRIMARY KEY,
                        project_id VARCHAR NOT NULL,
                        name VARCHAR NOT NULL DEFAULT 'Main canvas',
                        nodes JSON NOT NULL,
                        edges JSON NOT NULL,
                        frames JSON NOT NULL,
                        viewport JSON,
                        created_at DATETIME,
                        FOREIGN KEY(project_id) REFERENCES projects (id)
                    )
                    """
                )
            )
            conn.execute(
                text(
                    """
                    INSERT INTO project_canvas_new (id, project_id, name, nodes, edges, frames, viewport, created_at)
                    SELECT id, project_id, COALESCE(name, 'Main canvas'), nodes, edges, frames, viewport, created_at
                    FROM project_canvas
                    """
                )
            )
            conn.execute(text("DROP TABLE project_canvas"))
            conn.execute(text("ALTER TABLE project_canvas_new RENAME TO project_canvas"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_project_canvas_project_id ON project_canvas (project_id)"))
            conn.execute(text("PRAGMA foreign_keys=ON"))
        else:
            for item in inspect(conn).get_unique_constraints("project_canvas"):
                if set(item.get("column_names") or []) == {"project_id"}:
                    name = item.get("name")
                    if name:
                        conn.execute(text(f'ALTER TABLE project_canvas DROP CONSTRAINT IF EXISTS "{name}"'))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_project_canvas_project_id ON project_canvas (project_id)"))


def _migrate_project_data():
    """Backfill project_id on uploads/messages and attach orphan uploads to a project."""
    db = SessionLocal()
    try:
        for upload in db.query(Upload).filter(Upload.project_id.isnot(None)).all():
            db.query(Message).filter(Message.upload_id == upload.id, Message.project_id.is_(None)).update(
                {Message.project_id: upload.project_id}, synchronize_session=False
            )

        for workspace in db.query(Workspace).all():
            default_project = (
                db.query(Project)
                .filter(Project.workspace_id == workspace.id)
                .order_by(Project.created_at.asc())
                .first()
            )
            if not default_project:
                owner = db.query(WorkspaceMember).filter(WorkspaceMember.workspace_id == workspace.id).first()
                if not owner:
                    continue
                default_project = Project(
                    name="Imported media",
                    created_by=owner.user_id,
                    workspace_id=workspace.id,
                )
                db.add(default_project)
                db.flush()
                db.add(ProjectCanvas(project_id=default_project.id, name="Main canvas", nodes=[], edges=[], frames=[]))

            db.query(Upload).filter(
                Upload.workspace_id == workspace.id,
                Upload.project_id.is_(None),
            ).update({Upload.project_id: default_project.id}, synchronize_session=False)
            db.query(Message).filter(
                Message.workspace_id == workspace.id,
                Message.project_id.is_(None),
            ).update({Message.project_id: default_project.id}, synchronize_session=False)

        db.commit()
    finally:
        db.close()


def _ensure_message_hash_index():
    """Ensure per-project dedupe index on (project_id, content_hash)."""
    inspector = inspect(engine)
    if "messages" not in inspector.get_table_names():
        return

    indexes = {item["name"]: item for item in inspector.get_indexes("messages")}
    uniques = {item["name"]: item for item in inspector.get_unique_constraints("messages")}
    has_project_hash = any(
        set(item.get("column_names") or []) == {"project_id", "content_hash"}
        for item in (*indexes.values(), *uniques.values())
    )
    if has_project_hash:
        return

    with engine.begin() as conn:
        if DB_BACKEND == "sqlite":
            for name, meta in indexes.items():
                cols = set(meta.get("column_names") or [])
                if meta.get("unique") and cols in ({"content_hash"}, {"workspace_id", "content_hash"}):
                    conn.execute(text(f'DROP INDEX IF EXISTS "{name}"'))
            conn.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_message_project_hash "
                    "ON messages (project_id, content_hash)"
                )
            )
        else:
            conn.execute(text("ALTER TABLE messages DROP CONSTRAINT IF EXISTS uq_message_workspace_hash"))
            conn.execute(text("DROP INDEX IF EXISTS uq_message_workspace_hash"))
            conn.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_message_project_hash "
                    "ON messages (project_id, content_hash)"
                )
            )


def create_tables():
    wait_for_database()
    Base.metadata.create_all(bind=engine)
    _ensure_columns()
    location = DATABASE_URL.split("@")[-1] if DATABASE_URL else DB_PATH
    print(f"Tables created ({DB_BACKEND}) at: {location}")


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
        _migrate_legacy_workspace_ids(db)
    finally:
        db.close()


def _migrate_legacy_workspace_ids(db):
    """Backfill workspace_id on rows created before multi-workspace support."""
    workspace = db.query(Workspace).order_by(Workspace.created_at.asc()).first()
    if not workspace:
        return

    db.query(Project).filter(Project.workspace_id.is_(None)).update(
        {Project.workspace_id: workspace.id}, synchronize_session=False
    )
    db.query(Upload).filter(Upload.workspace_id.is_(None)).update(
        {Upload.workspace_id: workspace.id}, synchronize_session=False
    )
    db.query(Message).filter(Message.workspace_id.is_(None)).update(
        {Message.workspace_id: workspace.id}, synchronize_session=False
    )
    db.commit()
