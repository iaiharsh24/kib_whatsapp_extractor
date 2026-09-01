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
    engine = create_engine(DATABASE_URL, echo=False, future=True, pool_pre_ping=True)
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

        if "project_canvas" in existing_tables:
            canvas_names = _table_columns(conn, "project_canvas")
            if "viewport" not in canvas_names:
                conn.execute(text("ALTER TABLE project_canvas ADD COLUMN viewport JSON"))

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

        if "projects" in existing_tables:
            project_names = _table_columns(conn, "projects")
            if "workspace_id" not in project_names:
                conn.execute(text("ALTER TABLE projects ADD COLUMN workspace_id VARCHAR"))

    _ensure_message_hash_index()


def _ensure_message_hash_index():
    """Move dedupe from global content_hash to per-workspace (workspace_id, content_hash)."""
    inspector = inspect(engine)
    if "messages" not in inspector.get_table_names():
        return

    indexes = {item["name"]: item for item in inspector.get_indexes("messages")}
    uniques = {item["name"]: item for item in inspector.get_unique_constraints("messages")}
    has_workspace_hash = any(
        set(item.get("column_names") or []) == {"workspace_id", "content_hash"}
        for item in (*indexes.values(), *uniques.values())
    )
    if has_workspace_hash:
        return

    with engine.begin() as conn:
        if DB_BACKEND == "sqlite":
            for name, meta in indexes.items():
                if meta.get("unique") and set(meta.get("column_names") or []) == {"content_hash"}:
                    conn.execute(text(f'DROP INDEX IF EXISTS "{name}"'))
            conn.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_message_workspace_hash "
                    "ON messages (workspace_id, content_hash)"
                )
            )
        else:
            conn.execute(text("ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_hash_key"))
            conn.execute(text("DROP INDEX IF EXISTS ix_messages_content_hash"))
            conn.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_message_workspace_hash "
                    "ON messages (workspace_id, content_hash)"
                )
            )


def create_tables():
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
                role="admin",
            )
            db.add(admin)
            db.commit()
            db.refresh(admin)
        else:
            if not admin.email:
                admin.email = admin_email
            if admin_username and admin.username != admin_username:
                admin.username = admin_username
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
                db.add(ProjectCanvas(project_id=project.id, nodes=[], edges=[], frames=[]))
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
