"""SQLite models for the internal WhatsApp strategy canvas."""
import uuid
from sqlalchemy import Column, String, DateTime, Text, Integer, Index, JSON, ForeignKey, UniqueConstraint
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship, declarative_base

Base = declarative_base()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=lambda: new_id("user"))
    username = Column(String, unique=True, nullable=False, index=True)
    email = Column(String, unique=True, nullable=True, index=True)
    password_hash = Column(String, nullable=False)
    role = Column(String, nullable=False, default="member")  # admin | member (system-wide)
    created_at = Column(DateTime, server_default=func.now())

    uploads = relationship("Upload", back_populates="uploader")
    projects = relationship("Project", back_populates="creator")


class Workspace(Base):
    __tablename__ = "workspaces"

    id = Column(String, primary_key=True, default=lambda: new_id("ws"))
    name = Column(String, nullable=False)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    owner = relationship("User")
    members = relationship("WorkspaceMember", back_populates="workspace", cascade="all, delete-orphan")
    invites = relationship("WorkspaceInvite", back_populates="workspace", cascade="all, delete-orphan")
    projects = relationship("Project", back_populates="workspace", cascade="all, delete-orphan")
    uploads = relationship("Upload", back_populates="workspace", cascade="all, delete-orphan")
    tags = relationship("Tag", back_populates="workspace", cascade="all, delete-orphan")


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"

    id = Column(String, primary_key=True, default=lambda: new_id("wsm"))
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    role = Column(String, nullable=False, default="member")  # owner | member
    created_at = Column(DateTime, server_default=func.now())

    workspace = relationship("Workspace", back_populates="members")
    user = relationship("User")

    __table_args__ = (
        UniqueConstraint("workspace_id", "user_id", name="uq_workspace_member"),
    )


class WorkspaceInvite(Base):
    __tablename__ = "workspace_invites"

    id = Column(String, primary_key=True, default=lambda: new_id("inv"))
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False, index=True)
    code = Column(String, unique=True, nullable=False, index=True)
    role = Column(String, nullable=False, default="member")
    created_by = Column(String, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    used_count = Column(Integer, default=0)
    revoked = Column(Integer, default=0)  # 0/1 boolean (sqlite-friendly)

    workspace = relationship("Workspace", back_populates="invites")
    creator = relationship("User")


class SignupCode(Base):
    __tablename__ = "signup_codes"

    id = Column(String, primary_key=True, default=lambda: new_id("signup"))
    code = Column(String, unique=True, nullable=False, index=True)
    created_by = Column(String, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    note = Column(String, nullable=True)
    max_uses = Column(Integer, default=1)
    used_count = Column(Integer, default=0)
    revoked = Column(Integer, default=0)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True, index=True)
    workspace_role = Column(String, nullable=False, default="member")

    creator = relationship("User", foreign_keys=[created_by])
    workspace = relationship("Workspace")


class Tag(Base):
    __tablename__ = "tags"

    id = Column(String, primary_key=True, default=lambda: new_id("tag"))
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    workspace = relationship("Workspace", back_populates="tags")

    __table_args__ = (
        UniqueConstraint("workspace_id", "name", name="uq_workspace_tag_name"),
    )


class Upload(Base):
    __tablename__ = "uploads"

    id = Column(String, primary_key=True, default=lambda: new_id("upload"))
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True, index=True)
    project_id = Column(String, ForeignKey("projects.id"), nullable=True, index=True)
    file_name = Column(String, nullable=False)
    uploaded_by = Column(String, ForeignKey("users.id"), nullable=False)
    uploaded_at = Column(DateTime, server_default=func.now())
    status = Column(String, nullable=False, default="processing")
    message_count = Column(Integer, default=0)
    duplicate_count = Column(Integer, default=0)
    error_message = Column(Text, nullable=True)
    chat_name = Column(String, nullable=True)

    uploader = relationship("User", back_populates="uploads")
    workspace = relationship("Workspace", back_populates="uploads")
    project = relationship("Project", back_populates="uploads")
    messages = relationship("Message", back_populates="upload", cascade="all, delete-orphan")


class Message(Base):
    __tablename__ = "messages"

    id = Column(String, primary_key=True, default=lambda: new_id("msg"))
    upload_id = Column(String, ForeignKey("uploads.id"), nullable=False)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True, index=True)
    project_id = Column(String, ForeignKey("projects.id"), nullable=True, index=True)
    sender = Column(String, nullable=False, index=True)
    timestamp = Column(DateTime, nullable=False, index=True)
    raw_text = Column(Text, nullable=False)
    type = Column(String, nullable=False, index=True)  # chat | link | document | reel | media_omitted
    extracted_url = Column(String, nullable=True)
    extracted_filename = Column(String, nullable=True)
    context_before = Column(Text, nullable=True)
    context_after = Column(Text, nullable=True)
    content_hash = Column(String, nullable=False, index=True)
    chat_name = Column(String, nullable=True, index=True)
    tags = Column(JSON, nullable=True)
    link_preview = Column(JSON, nullable=True)

    upload = relationship("Upload", back_populates="messages")

    __table_args__ = (
        Index("ix_messages_sender_timestamp", "sender", "timestamp"),
        Index("ix_messages_type_timestamp", "type", "timestamp"),
        UniqueConstraint("upload_id", "content_hash", name="uq_message_upload_hash"),
    )


class Project(Base):
    __tablename__ = "projects"

    id = Column(String, primary_key=True, default=lambda: new_id("proj"))
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True, index=True)
    name = Column(String, nullable=False)
    created_by = Column(String, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    creator = relationship("User", back_populates="projects")
    workspace = relationship("Workspace", back_populates="projects")
    uploads = relationship("Upload", back_populates="project", cascade="all, delete-orphan")
    canvases = relationship("ProjectCanvas", back_populates="project", cascade="all, delete-orphan")
    items = relationship("ProjectItem", back_populates="project", cascade="all, delete-orphan")


class ProjectCanvas(Base):
    __tablename__ = "project_canvas"

    id = Column(String, primary_key=True, default=lambda: new_id("cvs"))
    project_id = Column(String, ForeignKey("projects.id"), nullable=False, index=True)
    name = Column(String, nullable=False, default="Main canvas")
    nodes = Column(JSON, nullable=False, default=list)
    edges = Column(JSON, nullable=False, default=list)
    frames = Column(JSON, nullable=False, default=list)
    viewport = Column(JSON, nullable=True)
    created_at = Column(DateTime, server_default=func.now())

    project = relationship("Project", back_populates="canvases")
    versions = relationship("CanvasVersion", back_populates="canvas", cascade="all, delete-orphan")


class CanvasVersion(Base):
    __tablename__ = "canvas_versions"

    id = Column(String, primary_key=True, default=lambda: new_id("cver"))
    canvas_id = Column(String, ForeignKey("project_canvas.id"), nullable=False, index=True)
    created_at = Column(DateTime, server_default=func.now(), index=True)
    nodes = Column(JSON, nullable=False, default=list)
    edges = Column(JSON, nullable=False, default=list)
    frames = Column(JSON, nullable=False, default=list)

    canvas = relationship("ProjectCanvas", back_populates="versions")


class ProjectChatMessage(Base):
    __tablename__ = "project_chat_messages"

    id = Column(String, primary_key=True, default=lambda: new_id("chat"))
    project_id = Column(String, ForeignKey("projects.id"), nullable=False, index=True)
    role = Column(String, nullable=False)  # user | assistant
    text = Column(Text, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), index=True)

    project = relationship("Project")


class UserPreference(Base):
    __tablename__ = "user_preferences"

    id = Column(String, primary_key=True, default=lambda: new_id("pref"))
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    key = Column(String, nullable=False)
    value = Column(JSON, nullable=True)

    user = relationship("User")

    __table_args__ = (
        UniqueConstraint("user_id", "key", name="uq_user_pref_key"),
    )


class ProjectItem(Base):
    __tablename__ = "project_items"

    id = Column(String, primary_key=True, default=lambda: new_id("item"))
    project_id = Column(String, ForeignKey("projects.id"), nullable=False)
    message_id = Column(String, ForeignKey("messages.id"), nullable=False)

    project = relationship("Project", back_populates="items")
    message = relationship("Message")

    __table_args__ = (
        UniqueConstraint("project_id", "message_id", name="uq_project_message"),
    )


class ActivityLog(Base):
    __tablename__ = "activity_logs"

    id = Column(String, primary_key=True, default=lambda: new_id("log"))
    user_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    username = Column(String, nullable=False)
    user_role = Column(String, nullable=True)
    action = Column(String, nullable=False, index=True)
    resource_type = Column(String, nullable=True)
    resource_id = Column(String, nullable=True)
    resource_name = Column(String, nullable=True)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True, index=True)
    details = Column(JSON, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), index=True)

    user = relationship("User")
    workspace = relationship("Workspace")


class DbSnapshot(Base):
    __tablename__ = "db_snapshots"

    id = Column(String, primary_key=True, default=lambda: new_id("snap"))
    created_at = Column(DateTime, server_default=func.now(), index=True)
    kind = Column(String, nullable=False, default="scheduled")  # scheduled | manual
    backend = Column(String, nullable=False)  # sqlite | postgresql
    file_name = Column(String, nullable=False)
    file_path = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False, default=0)
    stats = Column(JSON, nullable=True)
    notes = Column(Text, nullable=True)


class BackupEvent(Base):
    """Durable record of every backup attempt — successes AND failures.

    Failures don't produce a DbSnapshot row (run_backup raises before recording),
    so without this table a failed backup leaves no trace and the in-memory
    status is wiped on the next container restart. This table is the source of
    truth for /health and the control-center banner.
    """

    __tablename__ = "backup_events"

    id = Column(String, primary_key=True, default=lambda: new_id("bevt"))
    created_at = Column(DateTime, server_default=func.now(), index=True)
    outcome = Column(String, nullable=False)  # success | failure
    kind = Column(String, nullable=False)  # scheduled | manual | pre-delete
    file_name = Column(String, nullable=True)
    size_bytes = Column(Integer, nullable=True)
    error = Column(Text, nullable=True)
    consecutive_failures = Column(Integer, nullable=False, default=0)
