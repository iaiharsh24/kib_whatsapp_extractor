"""SQLite session, schema create, and default admin seed."""
import os
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from .models import Base, Message, Project, ProjectCanvas, Upload, User, Workspace, WorkspaceMember

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.getenv(
    "WA_DATA_DB_PATH",
    os.path.join(_PROJECT_ROOT, "local_data", "strategy.db"),
)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

engine = create_engine(
    f"sqlite+pysqlite:///{DB_PATH}",
    echo=False,
    future=True,
    connect_args={"check_same_thread": False},
)


def _enable_sqlite_foreign_keys(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


event.listen(engine, "connect", _enable_sqlite_foreign_keys)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_tables():
    Base.metadata.create_all(bind=engine)
    _ensure_columns()
    print(f"Tables created at: {DB_PATH}")


def _ensure_columns():
    from sqlalchemy import text

    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(messages)")).fetchall()
        names = {row[1] for row in rows}
        if "link_preview" not in names:
            conn.execute(text("ALTER TABLE messages ADD COLUMN link_preview JSON"))
        if "workspace_id" not in names:
            conn.execute(text("ALTER TABLE messages ADD COLUMN workspace_id VARCHAR"))

        canvas_rows = conn.execute(text("PRAGMA table_info(project_canvas)")).fetchall()
        canvas_names = {row[1] for row in canvas_rows}
        if "viewport" not in canvas_names:
            conn.execute(text("ALTER TABLE project_canvas ADD COLUMN viewport JSON"))

        user_rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        user_names = {row[1] for row in user_rows}
        if "email" not in user_names:
            conn.execute(text("ALTER TABLE users ADD COLUMN email VARCHAR"))

        upload_rows = conn.execute(text("PRAGMA table_info(uploads)")).fetchall()
        upload_names = {row[1] for row in upload_rows}
        if "workspace_id" not in upload_names:
            conn.execute(text("ALTER TABLE uploads ADD COLUMN workspace_id VARCHAR"))
        if "duplicate_count" not in upload_names:
            conn.execute(text("ALTER TABLE uploads ADD COLUMN duplicate_count INTEGER DEFAULT 0"))

        project_rows = conn.execute(text("PRAGMA table_info(projects)")).fetchall()
        project_names = {row[1] for row in project_rows}
        if "workspace_id" not in project_names:
            conn.execute(text("ALTER TABLE projects ADD COLUMN workspace_id VARCHAR"))


def seed_local_defaults():
    from app.auth import hash_password

    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.username == "admin").first()
        if not admin:
            admin = User(
                id="user_admin",
                username="admin",
                email="admin@local",
                password_hash=hash_password("admin123"),
                role="admin",
            )
            db.add(admin)
            db.commit()
        elif not admin.email:
            admin.email = "admin@local"
            db.commit()

        if not db.query(Project).first():
            project = Project(name="Shared workspace", created_by=admin.id)
            db.add(project)
            db.flush()
            db.add(ProjectCanvas(project_id=project.id, nodes=[], edges=[], frames=[]))
            db.commit()

        _migrate_default_workspace(db, admin)
    finally:
        db.close()


def _migrate_default_workspace(db, admin: User):
    """Wrap any pre-workspace data into a default workspace so nothing existing
    becomes orphaned/inaccessible after the multi-workspace upgrade."""
    workspace = db.query(Workspace).first()
    if not workspace:
        workspace = Workspace(name="Shared workspace", owner_id=admin.id)
        db.add(workspace)
        db.flush()

    existing_member_ids = {
        m.user_id for m in db.query(WorkspaceMember).filter(WorkspaceMember.workspace_id == workspace.id)
    }
    for user in db.query(User).all():
        if user.id in existing_member_ids:
            continue
        role = "owner" if user.id == workspace.owner_id else "member"
        db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=role))
    db.commit()

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
