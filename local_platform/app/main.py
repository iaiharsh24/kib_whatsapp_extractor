"""Internal WhatsApp Strategy Canvas API."""
from __future__ import annotations

import copy
import os
import secrets
import sys
import threading
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import unquote

import httpx
from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel
from sqlalchemy import String, and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload
import logging

_LOCAL_PLATFORM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _LOCAL_PLATFORM not in sys.path:
    sys.path.insert(0, _LOCAL_PLATFORM)

from app.activity import activity_visible_to_viewer, log_activity, serialize_activity_log
from app.auth import (
    assert_user_manageable,
    bearer,
    get_current_user,
    hash_password,
    is_super_admin,
    make_token,
    require_admin,
    require_super_admin,
    serialize_user,
    super_admin_user_ids,
    user_from_token,
    verify_password,
    SUPER_ADMIN_EMAILS,
    visible_users_for_admin,
)
from app.admin_control import build_control_overview, build_control_tables, export_user_backup_json
from app.backups import (
    REQUIRE_BACKUP_BEFORE_DELETE,
    BackupError,
    backup_status,
    run_backup,
    serialize_snapshot,
    snapshot_before_destructive,
    start_backup_scheduler,
)
from app.ingest import backfill_message_types, hydrate_link_previews, process_upload
from app.llm import build_prompt, complete
from app.previews import fetch_preview, is_fetchable_url, preview_for_message
from app.vectors import delete_upload_vectors
from app.zip_extract import delete_upload_files, find_extracted_file
from db import DB_BACKEND, DB_PATH, DATABASE_URL, create_tables, get_db, seed_local_defaults
from db.workspaces import ensure_personal_workspace
from db.models import (
    ActivityLog,
    CanvasVersion,
    DbSnapshot,
    Message,
    Project,
    ProjectCanvas,
    ProjectChatMessage,
    ProjectItem,
    Tag,
    Upload,
    User,
    UserPreference,
    Workspace,
    WorkspaceInvite,
    WorkspaceMember,
    SignupCode,
)

PROJECT_ROOT = os.path.dirname(_LOCAL_PLATFORM)
UPLOAD_DIR = os.path.join(PROJECT_ROOT, "local_data", "uploads")

app = FastAPI(
    title="Internal WhatsApp Strategy Canvas",
    description="Local monolith for a 5-6 person team.",
    version="2.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger("wa.api")


def guard_destructive(action: str, actor: User) -> None:
    """Ensure a restorable snapshot exists before an irreversible delete.

    Blocks the delete when no backup can be produced, so the platform can never
    lose rows that were never captured.
    """
    try:
        snapshot_before_destructive(action, getattr(actor, "email", None) or getattr(actor, "username", None))
    except BackupError as exc:
        logger.error("pre-delete backup failed for %s: %s", action, exc)
        if REQUIRE_BACKUP_BEFORE_DELETE:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Delete blocked: the safety backup could not be created, so this "
                    f"change would be unrecoverable. ({exc})"
                ),
            ) from exc


@app.exception_handler(IntegrityError)
async def integrity_error_handler(_request: Request, exc: IntegrityError):
    message = str(exc.orig) if getattr(exc, "orig", None) else str(exc)
    if "project_canvas.project_id" in message or "project_canvas" in message:
        detail = "This project cannot add another canvas until the database migration finishes. Restart the API or contact support."
        return JSONResponse(status_code=409, content={"detail": detail})
    return JSONResponse(status_code=409, content={"detail": "That record already exists or conflicts with existing data."})


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Something went wrong on the server. Please try again."},
    )


class LoginBody(BaseModel):
    email: str
    password: str


class SignupBody(BaseModel):
    code: str
    email: str
    password: str
    username: Optional[str] = None


class SignupCodeCreate(BaseModel):
    note: Optional[str] = None
    max_uses: int = 1
    workspace_id: Optional[str] = None
    workspace_role: str = "member"


class UserCreate(BaseModel):
    email: str
    username: Optional[str] = None
    role: str = "member"
    password: Optional[str] = None


class WorkspaceCreate(BaseModel):
    name: str


class WorkspacePatch(BaseModel):
    name: str


class InviteCreate(BaseModel):
    role: str = "member"


class InviteAccept(BaseModel):
    email: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None


class TagCreate(BaseModel):
    name: str


class TagPatch(BaseModel):
    name: str


class PasswordReset(BaseModel):
    password: Optional[str] = None


class RolePatch(BaseModel):
    role: str


class ProjectCreate(BaseModel):
    name: str
    workspace_id: str


class ProjectPatch(BaseModel):
    name: str


class CanvasSave(BaseModel):
    nodes: list = []
    edges: list = []
    frames: list = []
    viewport: Optional[dict] = None


class CanvasCreate(BaseModel):
    name: str = "New canvas"


class PreferenceBody(BaseModel):
    value: object = None


class ChatBody(BaseModel):
    question: str


class MessageTagsBody(BaseModel):
    tags: list[str] = []


class ItemAdd(BaseModel):
    message_id: str


def workspace_name(db: Session, workspace_id: str | None) -> str | None:
    if not workspace_id:
        return None
    row = db.query(Workspace).filter(Workspace.id == workspace_id).first()
    return row.name if row else None


def serialize_message(message: Message) -> dict:
    http_url = message.extracted_url if str(message.extracted_url or "").startswith("http") else None
    stored = message.link_preview if isinstance(getattr(message, "link_preview", None), dict) else None
    preview = preview_for_message(message.raw_text, http_url, stored)
    return {
        "id": message.id,
        "upload_id": message.upload_id,
        "sender": message.sender,
        "timestamp": message.timestamp.isoformat() if message.timestamp else None,
        "raw_text": message.raw_text,
        "type": message.type,
        "extracted_url": message.extracted_url,
        "extracted_filename": message.extracted_filename,
        "context_before": message.context_before,
        "context_after": message.context_after,
        "chat_name": message.chat_name,
        "tags": message.tags or [],
        "link_preview": preview,
        "urls": (preview or {}).get("urls") or [],
    }


def external_link_filter():
    return and_(
        Message.type != "reel",
        or_(
            Message.type == "link",
            Message.extracted_url.ilike("http%"),
            Message.raw_text.ilike("%http://%"),
            Message.raw_text.ilike("%https://%"),
            Message.raw_text.ilike("%www.%"),
        ),
    )


def serialize_upload(upload: Upload, username: str | None = None) -> dict:
    return {
        "id": upload.id,
        "workspace_id": upload.workspace_id,
        "project_id": upload.project_id,
        "file_name": upload.file_name,
        "uploaded_by": upload.uploaded_by,
        "uploaded_by_username": username,
        "uploaded_at": upload.uploaded_at.isoformat() if upload.uploaded_at else None,
        "status": upload.status,
        "message_count": upload.message_count or 0,
        "duplicate_count": upload.duplicate_count or 0,
        "error_message": upload.error_message,
        "chat_name": upload.chat_name,
    }


def serialize_project(project: Project) -> dict:
    return {
        "id": project.id,
        "workspace_id": project.workspace_id,
        "name": project.name,
        "created_by": project.created_by,
        "created_at": project.created_at.isoformat() if project.created_at else None,
    }


def serialize_workspace(workspace: Workspace, role: str | None = None, counts: dict | None = None) -> dict:
    return {
        "id": workspace.id,
        "name": workspace.name,
        "owner_id": workspace.owner_id,
        "created_at": workspace.created_at.isoformat() if workspace.created_at else None,
        "role": role,
        "project_count": (counts or {}).get("projects", 0),
        "upload_count": (counts or {}).get("uploads", 0),
        "message_count": (counts or {}).get("messages", 0),
    }


def serialize_invite(invite: WorkspaceInvite) -> dict:
    return {
        "id": invite.id,
        "workspace_id": invite.workspace_id,
        "code": invite.code,
        "role": invite.role,
        "created_by": invite.created_by,
        "created_at": invite.created_at.isoformat() if invite.created_at else None,
        "used_count": invite.used_count or 0,
        "revoked": bool(invite.revoked),
        "link": f"/invite/{invite.code}",
    }


def require_workspace_member(workspace_id: str, user: User, db: Session) -> Workspace:
    workspace = db.query(Workspace).filter(Workspace.id == workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if is_super_admin(user):
        return workspace
    member = (
        db.query(WorkspaceMember)
        .filter(WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user.id)
        .first()
    )
    if not member:
        raise HTTPException(status_code=403, detail="You are not a member of this workspace")
    return workspace


def get_workspace_role(workspace_id: str, user_id: str, db: Session) -> str | None:
    member = (
        db.query(WorkspaceMember)
        .filter(WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id)
        .first()
    )
    return member.role if member else None


def require_workspace_owner(workspace_id: str, user: User, db: Session) -> Workspace:
    workspace = require_workspace_member(workspace_id, user, db)
    role = get_workspace_role(workspace_id, user.id, db)
    if role != "owner" and workspace.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Only the workspace owner can do this")
    return workspace


def unique_username(db: Session, base: str) -> str:
    base = (base or "user").strip().lower().replace(" ", ".") or "user"
    candidate = base
    suffix = 1
    while db.query(User).filter(User.username == candidate).first():
        suffix += 1
        candidate = f"{base}{suffix}"
    return candidate


def normalize_signup_code(raw: str) -> str:
    return (raw or "").strip().upper().replace("-", "").replace(" ", "")


def generate_signup_code(db: Session) -> str:
    while True:
        candidate = secrets.token_hex(4).upper()
        if not db.query(SignupCode).filter(SignupCode.code == candidate).first():
            return candidate


def get_signup_code(db: Session, raw_code: str) -> SignupCode | None:
    normalized = normalize_signup_code(raw_code)
    if not normalized:
        return None
    return db.query(SignupCode).filter(SignupCode.code == normalized).first()


def signup_code_is_valid(signup_code: SignupCode | None) -> bool:
    if not signup_code or signup_code.revoked:
        return False
    max_uses = signup_code.max_uses or 1
    return (signup_code.used_count or 0) < max_uses


def serialize_signup_code(signup_code: SignupCode) -> dict:
    return {
        "id": signup_code.id,
        "code": signup_code.code,
        "note": signup_code.note,
        "max_uses": signup_code.max_uses or 1,
        "used_count": signup_code.used_count or 0,
        "revoked": bool(signup_code.revoked),
        "workspace_id": signup_code.workspace_id,
        "workspace_role": signup_code.workspace_role,
        "created_by": signup_code.created_by,
        "created_at": signup_code.created_at.isoformat() if signup_code.created_at else None,
        "link": f"/signup/{signup_code.code}",
    }


def hydrate_canvas_nodes(nodes: list, messages: dict[str, dict]) -> list:
    hydrated = []
    for node in nodes or []:
        if not isinstance(node, dict):
            hydrated.append(node)
            continue
        cloned = dict(node)
        data = dict(cloned.get("data") or {})
        message = messages.get(str(data.get("messageId") or ""))
        if message:
            preview = message.get("link_preview") or {}
            data["url"] = message.get("extracted_url")
            data["previewImage"] = preview.get("image")
            data["previewTitle"] = preview.get("title")
            data["embed"] = preview.get("embed")
            data["type"] = message.get("type") or data.get("type")
            data["sender"] = message.get("sender") or data.get("sender")
            data["text"] = message.get("raw_text") or data.get("text")
            data["timestamp"] = message.get("timestamp") or data.get("timestamp")
            data["tags"] = message.get("tags") or data.get("tags") or []
        cloned["data"] = data
        hydrated.append(cloned)
    return hydrated


def serialize_canvas(canvas: ProjectCanvas | None) -> dict:
    if not canvas:
        return {"id": None, "name": "Main canvas", "nodes": [], "edges": [], "frames": [], "viewport": None}
    return {
        "id": canvas.id,
        "name": canvas.name or "Main canvas",
        "nodes": canvas.nodes or [],
        "edges": canvas.edges or [],
        "frames": canvas.frames or [],
        "viewport": canvas.viewport if isinstance(canvas.viewport, dict) else None,
    }


def serialize_canvas_summary(canvas: ProjectCanvas) -> dict:
    return {
        "id": canvas.id,
        "name": canvas.name or "Main canvas",
        "project_id": canvas.project_id,
        "created_at": canvas.created_at.isoformat() if canvas.created_at else None,
    }


def get_project_canvas(db: Session, project_id: str, canvas_id: str | None = None) -> ProjectCanvas:
    query = db.query(ProjectCanvas).filter(ProjectCanvas.project_id == project_id)
    if canvas_id:
        canvas = query.filter(ProjectCanvas.id == canvas_id).first()
    else:
        canvas = query.order_by(ProjectCanvas.created_at.asc()).first()
    if not canvas:
        canvas = ProjectCanvas(project_id=project_id, name="Main canvas", nodes=[], edges=[], frames=[])
        db.add(canvas)
        db.flush()
    return canvas


def save_canvas_version(db: Session, canvas: ProjectCanvas, nodes: list, edges: list, frames: list) -> None:
    latest = (
        db.query(CanvasVersion)
        .filter(CanvasVersion.canvas_id == canvas.id)
        .order_by(CanvasVersion.created_at.desc())
        .first()
    )
    if latest and latest.nodes == nodes and latest.edges == edges and latest.frames == frames:
        return
    if latest and latest.created_at:
        age = (datetime.utcnow() - latest.created_at.replace(tzinfo=None)).total_seconds()
        if age < 8:
            return
    db.add(
        CanvasVersion(
            canvas_id=canvas.id,
            nodes=copy.deepcopy(nodes),
            edges=copy.deepcopy(edges),
            frames=copy.deepcopy(frames),
        )
    )
    keep = (
        db.query(CanvasVersion)
        .filter(CanvasVersion.canvas_id == canvas.id)
        .order_by(CanvasVersion.created_at.desc())
        .offset(8)
        .all()
    )
    for row in keep:
        db.delete(row)


def get_user_pref(db: Session, user_id: str, key: str, default=None):
    row = db.query(UserPreference).filter(UserPreference.user_id == user_id, UserPreference.key == key).first()
    if not row:
        return default
    return row.value


def set_user_pref(db: Session, user_id: str, key: str, value) -> None:
    row = db.query(UserPreference).filter(UserPreference.user_id == user_id, UserPreference.key == key).first()
    if row:
        row.value = value
    else:
        db.add(UserPreference(user_id=user_id, key=key, value=value))


@app.on_event("startup")
async def startup():
    create_tables()
    seed_local_defaults()
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    start_backup_scheduler()
    def _background_jobs():
        from db import SessionLocal
        db = SessionLocal()
        try:
            backfill_message_types(db)
        finally:
            db.close()
        hydrate_link_previews(limit=200)

    threading.Thread(target=_background_jobs, daemon=True).start()


@app.get("/health")
async def health():
    backups = backup_status()
    return {
        "status": "healthy" if backups["healthy"] else "degraded",
        "mode": "local",
        "db": DB_BACKEND,
        "db_path": DB_PATH if DB_BACKEND == "sqlite" else None,
        "database_url": DATABASE_URL.split("@")[-1] if DATABASE_URL else None,
        "backups": backups,
    }


@app.post("/api/auth/login")
async def login(body: LoginBody, db: Session = Depends(get_db)):
    try:
        identifier = (body.email or "").strip()
        user = (
            db.query(User)
            .filter(or_(User.email == identifier, User.username == identifier))
            .first()
        )
        if not user or not verify_password(body.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Invalid email or password")
        ensure_personal_workspace(db, user)
        log_activity(db, user, "auth.login")
        db.commit()
        return {"token": make_token(user), "user": serialize_user(user)}
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        print(f"Login failed: {exc}")
        raise HTTPException(status_code=503, detail="Server is starting up. Please try again in a few seconds.")


@app.get("/api/auth/signup/{code}")
async def preview_signup_code(code: str, db: Session = Depends(get_db)):
    signup_code = get_signup_code(db, code)
    if not signup_code_is_valid(signup_code):
        raise HTTPException(status_code=404, detail="This signup code is invalid or has been used")
    workspace_name = None
    if signup_code.workspace_id:
        workspace = db.query(Workspace).filter(Workspace.id == signup_code.workspace_id).first()
        workspace_name = workspace.name if workspace else None
    return {
        "code": signup_code.code,
        "note": signup_code.note,
        "workspace_name": workspace_name,
        "uses_remaining": max(0, (signup_code.max_uses or 1) - (signup_code.used_count or 0)),
    }


@app.post("/api/auth/signup", status_code=201)
async def signup(body: SignupBody, db: Session = Depends(get_db)):
    signup_code = get_signup_code(db, body.code)
    if not signup_code_is_valid(signup_code):
        raise HTTPException(status_code=400, detail="This signup code is invalid or has been used")

    email = (body.email or "").strip().lower()
    password = (body.password or "").strip()
    if not email:
        raise HTTPException(status_code=400, detail="Email is required")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=400, detail="An account with this email already exists. Sign in instead.")

    username = unique_username(db, body.username or email.split("@")[0])
    user = User(
        username=username,
        email=email,
        password_hash=hash_password(password),
        role="member",
    )
    db.add(user)
    db.flush()
    ensure_personal_workspace(db, user)

    if signup_code.workspace_id:
        workspace = db.query(Workspace).filter(Workspace.id == signup_code.workspace_id).first()
        if workspace:
            member = (
                db.query(WorkspaceMember)
                .filter(WorkspaceMember.workspace_id == workspace.id, WorkspaceMember.user_id == user.id)
                .first()
            )
            if not member:
                db.add(
                    WorkspaceMember(
                        workspace_id=workspace.id,
                        user_id=user.id,
                        role=signup_code.workspace_role or "member",
                    )
                )

    signup_code.used_count = (signup_code.used_count or 0) + 1
    ws_name = workspace_name(db, signup_code.workspace_id)
    log_activity(
        db,
        user,
        "auth.signup",
        workspace_id=signup_code.workspace_id,
        details={"workspace_name": ws_name, "signup_code": signup_code.code},
    )
    db.commit()
    db.refresh(user)
    return {"token": make_token(user), "user": serialize_user(user)}


@app.get("/api/auth/me")
async def me(user: User = Depends(get_current_user)):
    return serialize_user(user)


@app.get("/api/preferences")
async def list_preferences(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(UserPreference).filter(UserPreference.user_id == user.id).all()
    return {row.key: row.value for row in rows}


@app.put("/api/preferences/{key}")
async def put_preference(
    key: str,
    body: PreferenceBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    set_user_pref(db, user.id, key, body.value)
    db.commit()
    return {"key": key, "value": body.value}


@app.get("/api/workspaces")
async def list_workspaces(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if is_super_admin(user):
        workspaces = db.query(Workspace).order_by(Workspace.created_at.asc()).all()
        ws_ids = [workspace.id for workspace in workspaces]
        counts_by_ws: dict[str, dict] = {}
        if ws_ids:
            project_counts = dict(
                db.query(Project.workspace_id, func.count(Project.id))
                .filter(Project.workspace_id.in_(ws_ids))
                .group_by(Project.workspace_id)
                .all()
            )
            upload_counts = dict(
                db.query(Upload.workspace_id, func.count(Upload.id))
                .filter(Upload.workspace_id.in_(ws_ids))
                .group_by(Upload.workspace_id)
                .all()
            )
            message_counts = dict(
                db.query(Message.workspace_id, func.count(Message.id))
                .filter(Message.workspace_id.in_(ws_ids))
                .group_by(Message.workspace_id)
                .all()
            )
            for wid in ws_ids:
                counts_by_ws[wid] = {
                    "projects": project_counts.get(wid, 0),
                    "uploads": upload_counts.get(wid, 0),
                    "messages": message_counts.get(wid, 0),
                }
        return [
            serialize_workspace(
                workspace,
                role="owner" if workspace.owner_id == user.id else "member",
                counts=counts_by_ws.get(workspace.id),
            )
            for workspace in workspaces
        ]
    rows = (
        db.query(Workspace, WorkspaceMember)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .filter(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.created_at.asc())
        .all()
    )
    ws_ids = [workspace.id for workspace, _ in rows]
    counts_by_ws: dict[str, dict] = {}
    if ws_ids:
        project_counts = dict(
            db.query(Project.workspace_id, func.count(Project.id))
            .filter(Project.workspace_id.in_(ws_ids))
            .group_by(Project.workspace_id)
            .all()
        )
        upload_counts = dict(
            db.query(Upload.workspace_id, func.count(Upload.id))
            .filter(Upload.workspace_id.in_(ws_ids))
            .group_by(Upload.workspace_id)
            .all()
        )
        message_counts = dict(
            db.query(Message.workspace_id, func.count(Message.id))
            .filter(Message.workspace_id.in_(ws_ids))
            .group_by(Message.workspace_id)
            .all()
        )
        for wid in ws_ids:
            counts_by_ws[wid] = {
                "projects": project_counts.get(wid, 0),
                "uploads": upload_counts.get(wid, 0),
                "messages": message_counts.get(wid, 0),
            }
    return [
        serialize_workspace(workspace, member.role, counts_by_ws.get(workspace.id))
        for workspace, member in rows
    ]


@app.post("/api/workspaces", status_code=201)
async def create_workspace(body: WorkspaceCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    workspace = Workspace(name=name, owner_id=user.id)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    log_activity(
        db,
        user,
        "workspace.create",
        resource_type="workspace",
        resource_id=workspace.id,
        resource_name=workspace.name,
        workspace_id=workspace.id,
    )
    db.commit()
    db.refresh(workspace)
    return serialize_workspace(workspace, "owner")


@app.patch("/api/workspaces/{workspace_id}")
async def rename_workspace(
    workspace_id: str,
    body: WorkspacePatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    workspace = require_workspace_owner(workspace_id, user, db)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    workspace.name = name
    log_activity(
        db,
        user,
        "workspace.rename",
        resource_type="workspace",
        resource_id=workspace.id,
        resource_name=name,
        workspace_id=workspace.id,
    )
    db.commit()
    db.refresh(workspace)
    return serialize_workspace(workspace, "owner")


@app.delete("/api/workspaces/{workspace_id}")
async def delete_workspace(workspace_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    workspace = require_workspace_owner(workspace_id, user, db)
    member_workspaces = db.query(WorkspaceMember).filter(WorkspaceMember.user_id == user.id).count()
    if member_workspaces <= 1:
        raise HTTPException(status_code=400, detail="You must keep at least one workspace")
    workspace_name_value = workspace.name
    guard_destructive(f"workspace delete ({workspace_name_value})", user)
    upload_ids = [row[0] for row in db.query(Upload.id).filter(Upload.workspace_id == workspace_id).all()]
    log_activity(
        db,
        user,
        "workspace.delete",
        resource_type="workspace",
        resource_id=workspace_id,
        resource_name=workspace_name_value,
        workspace_id=workspace_id,
    )
    db.delete(workspace)
    db.commit()
    for upload_id in upload_ids:
        delete_upload_vectors(upload_id)
        delete_upload_files(upload_id)
    return {"deleted": True, "id": workspace_id}


@app.get("/api/workspaces/{workspace_id}/members")
async def list_workspace_members(workspace_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_workspace_member(workspace_id, user, db)
    rows = (
        db.query(WorkspaceMember, User)
        .join(User, User.id == WorkspaceMember.user_id)
        .filter(WorkspaceMember.workspace_id == workspace_id)
        .order_by(WorkspaceMember.created_at.asc())
        .all()
    )
    return [
        {
            "user_id": member.user_id,
            "username": member_user.username,
            "email": member_user.email,
            "role": member.role,
            "joined_at": member.created_at.isoformat() if member.created_at else None,
        }
        for member, member_user in rows
    ]


@app.delete("/api/workspaces/{workspace_id}/members/{user_id}")
async def remove_workspace_member(
    workspace_id: str,
    user_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    workspace = require_workspace_member(workspace_id, user, db)
    role = get_workspace_role(workspace_id, user.id, db)
    is_owner = role == "owner" or workspace.owner_id == user.id
    if user_id != user.id and not is_owner:
        raise HTTPException(status_code=403, detail="Only the owner can remove other members")
    if user_id == workspace.owner_id:
        raise HTTPException(status_code=400, detail="The workspace owner cannot be removed")
    member = (
        db.query(WorkspaceMember)
        .filter(WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id)
        .first()
    )
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    removed = db.query(User).filter(User.id == user_id).first()
    log_activity(
        db,
        user,
        "workspace.member.remove",
        resource_type="user",
        resource_id=user_id,
        resource_name=(removed.email or removed.username) if removed else user_id,
        workspace_id=workspace_id,
        details={"workspace_name": workspace.name},
    )
    db.delete(member)
    db.commit()
    return {"deleted": True, "user_id": user_id}


@app.post("/api/workspaces/{workspace_id}/invites", status_code=201)
async def create_invite(
    workspace_id: str,
    body: InviteCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_workspace_member(workspace_id, user, db)
    role = body.role if body.role in {"member", "owner"} else "member"
    invite = WorkspaceInvite(
        workspace_id=workspace_id,
        code=secrets.token_urlsafe(9),
        role=role,
        created_by=user.id,
    )
    db.add(invite)
    db.flush()
    log_activity(
        db,
        user,
        "workspace.invite.create",
        resource_type="invite",
        resource_id=invite.id,
        workspace_id=workspace_id,
        details={"workspace_name": workspace_name(db, workspace_id), "role": role},
    )
    db.commit()
    db.refresh(invite)
    return serialize_invite(invite)


@app.get("/api/workspaces/{workspace_id}/invites")
async def list_invites(workspace_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_workspace_member(workspace_id, user, db)
    rows = (
        db.query(WorkspaceInvite)
        .filter(WorkspaceInvite.workspace_id == workspace_id)
        .order_by(WorkspaceInvite.created_at.desc())
        .all()
    )
    return [serialize_invite(row) for row in rows]


@app.delete("/api/workspaces/{workspace_id}/invites/{invite_id}")
async def revoke_invite(
    workspace_id: str,
    invite_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    workspace = require_workspace_member(workspace_id, user, db)
    invite = (
        db.query(WorkspaceInvite)
        .filter(WorkspaceInvite.id == invite_id, WorkspaceInvite.workspace_id == workspace_id)
        .first()
    )
    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found")
    is_owner = workspace.owner_id == user.id or get_workspace_role(workspace_id, user.id, db) == "owner"
    if invite.created_by != user.id and not is_owner:
        raise HTTPException(status_code=403, detail="Only the invite creator or the owner can revoke this invite")
    invite.revoked = 1
    log_activity(
        db,
        user,
        "workspace.invite.revoke",
        resource_type="invite",
        resource_id=invite_id,
        workspace_id=workspace_id,
        details={"workspace_name": workspace.name},
    )
    db.commit()
    return {"revoked": True, "id": invite_id}


@app.get("/api/invites/{code}")
async def preview_invite(code: str, db: Session = Depends(get_db)):
    invite = db.query(WorkspaceInvite).filter(WorkspaceInvite.code == code).first()
    if not invite or invite.revoked:
        raise HTTPException(status_code=404, detail="This invite link is invalid or has been revoked")
    workspace = db.query(Workspace).filter(Workspace.id == invite.workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="This invite link is invalid")
    inviter = db.query(User).filter(User.id == invite.created_by).first()
    return {
        "workspace_name": workspace.name,
        "invited_by": inviter.username if inviter else "a member",
        "role": invite.role,
    }


@app.post("/api/invites/{code}/accept")
async def accept_invite(
    code: str,
    body: InviteAccept,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
):
    invite = db.query(WorkspaceInvite).filter(WorkspaceInvite.code == code).first()
    if not invite or invite.revoked:
        raise HTTPException(status_code=404, detail="This invite link is invalid or has been revoked")
    workspace = db.query(Workspace).filter(Workspace.id == invite.workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="This invite link is invalid")

    user: User | None = None
    if creds and creds.credentials:
        try:
            user = user_from_token(creds.credentials, db)
        except HTTPException:
            user = None

    if not user:
        email = (body.email or "").strip().lower()
        if not email or not body.password:
            raise HTTPException(status_code=400, detail="Email and password are required to join")
        existing = db.query(User).filter(User.email == email).first()
        if existing:
            if not verify_password(body.password, existing.password_hash):
                raise HTTPException(status_code=401, detail="An account with this email already exists. Log in instead.")
            user = existing
        else:
            username = unique_username(db, body.username or email.split("@")[0])
            user = User(username=username, email=email, password_hash=hash_password(body.password), role="member")
            db.add(user)
            db.flush()

    member = (
        db.query(WorkspaceMember)
        .filter(WorkspaceMember.workspace_id == workspace.id, WorkspaceMember.user_id == user.id)
        .first()
    )
    if not member:
        db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=invite.role))
        invite.used_count = (invite.used_count or 0) + 1
    ensure_personal_workspace(db, user)
    log_activity(
        db,
        user,
        "workspace.invite.accept",
        resource_type="workspace",
        resource_id=workspace.id,
        resource_name=workspace.name,
        workspace_id=workspace.id,
    )
    db.commit()
    db.refresh(user)
    role = get_workspace_role(workspace.id, user.id, db) or invite.role
    return {
        "token": make_token(user),
        "user": serialize_user(user),
        "workspace": serialize_workspace(workspace, role),
    }


def _ensure_tags_in_registry(db: Session, workspace_id: str | None, tag_names: list[str]) -> None:
    if not workspace_id:
        return
    existing = {tag.name.lower() for tag in db.query(Tag).filter(Tag.workspace_id == workspace_id).all()}
    changed = False
    for raw in tag_names:
        name = " ".join(str(raw or "").split())[:40]
        if not name or name.lower() in TYPE_TAGS or name.lower() in existing:
            continue
        db.add(Tag(workspace_id=workspace_id, name=name))
        existing.add(name.lower())
        changed = True
    if changed:
        db.commit()


def _sync_tag_registry(db: Session, workspace_id: str) -> dict[str, int]:
    """Scan free-form tags on messages + canvas nodes for this workspace, bootstrap the
    Tag registry with any names not seen yet, and return usage counts by tag name (lowercase)."""
    counts: dict[str, int] = {}
    display: dict[str, str] = {}

    def note(name: str):
        name = " ".join(str(name or "").split())
        if not name or name.lower() in TYPE_TAGS:
            return
        key = name.lower()
        counts[key] = counts.get(key, 0) + 1
        display.setdefault(key, name)

    for row in db.query(Message.tags).filter(Message.workspace_id == workspace_id).all():
        if isinstance(row[0], list):
            for item in row[0]:
                note(str(item))

    project_ids = [row[0] for row in db.query(Project.id).filter(Project.workspace_id == workspace_id).all()]
    if project_ids:
        for row in db.query(ProjectCanvas.nodes).filter(ProjectCanvas.project_id.in_(project_ids)).all():
            for node in row[0] or []:
                if not isinstance(node, dict):
                    continue
                for item in (node.get("data") or {}).get("tags") or []:
                    note(str(item))

    existing = {tag.name.lower(): tag for tag in db.query(Tag).filter(Tag.workspace_id == workspace_id).all()}
    changed = False
    for key, name in display.items():
        if key not in existing:
            db.add(Tag(workspace_id=workspace_id, name=name))
            changed = True
    if changed:
        db.commit()
    return counts


@app.get("/api/workspaces/{workspace_id}/tags")
async def list_workspace_tags(workspace_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_workspace_member(workspace_id, user, db)
    counts = _sync_tag_registry(db, workspace_id)
    rows = db.query(Tag).filter(Tag.workspace_id == workspace_id).order_by(Tag.name.asc()).all()
    return [
        {
            "id": row.id,
            "name": row.name,
            "count": counts.get(row.name.lower(), 0),
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
        for row in rows
    ]


@app.post("/api/workspaces/{workspace_id}/tags", status_code=201)
async def create_workspace_tag(
    workspace_id: str,
    body: TagCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_workspace_member(workspace_id, user, db)
    name = " ".join((body.name or "").split())[:40]
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if name.lower() in TYPE_TAGS:
        raise HTTPException(status_code=400, detail="That name is reserved")
    existing = (
        db.query(Tag)
        .filter(Tag.workspace_id == workspace_id, func.lower(Tag.name) == name.lower())
        .first()
    )
    if existing:
        return {"id": existing.id, "name": existing.name, "count": 0, "created_at": existing.created_at.isoformat() if existing.created_at else None}
    tag = Tag(workspace_id=workspace_id, name=name)
    db.add(tag)
    db.flush()
    log_activity(
        db,
        user,
        "tag.create",
        resource_type="tag",
        resource_id=tag.id,
        resource_name=name,
        workspace_id=workspace_id,
        details={"workspace_name": workspace_name(db, workspace_id)},
    )
    db.commit()
    db.refresh(tag)
    return {"id": tag.id, "name": tag.name, "count": 0, "created_at": tag.created_at.isoformat() if tag.created_at else None}


def _rewrite_tags_in_workspace(db: Session, workspace_id: str, old_name: str, new_name: str | None) -> None:
    """Rename (new_name set) or delete (new_name=None) a tag name across every message and
    canvas node in the workspace."""
    old_key = old_name.lower()
    messages = db.query(Message).filter(Message.workspace_id == workspace_id).all()
    for message in messages:
        if not isinstance(message.tags, list):
            continue
        if not any(str(item).lower() == old_key for item in message.tags):
            continue
        next_tags = []
        seen = set()
        for item in message.tags:
            if str(item).lower() == old_key:
                if new_name is None:
                    continue
                item = new_name
            key = str(item).lower()
            if key in seen:
                continue
            seen.add(key)
            next_tags.append(item)
        message.tags = next_tags

    project_ids = [row[0] for row in db.query(Project.id).filter(Project.workspace_id == workspace_id).all()]
    if project_ids:
        canvases = db.query(ProjectCanvas).filter(ProjectCanvas.project_id.in_(project_ids)).all()
        for canvas in canvases:
            nodes = canvas.nodes or []
            touched = False
            next_nodes = []
            for node in nodes:
                if not isinstance(node, dict):
                    next_nodes.append(node)
                    continue
                data = node.get("data") or {}
                tags = data.get("tags")
                if not isinstance(tags, list) or not any(str(item).lower() == old_key for item in tags):
                    next_nodes.append(node)
                    continue
                next_tags = []
                seen = set()
                for item in tags:
                    if str(item).lower() == old_key:
                        if new_name is None:
                            continue
                        item = new_name
                    key = str(item).lower()
                    if key in seen:
                        continue
                    seen.add(key)
                    next_tags.append(item)
                node = dict(node)
                node["data"] = {**data, "tags": next_tags}
                next_nodes.append(node)
                touched = True
            if touched:
                canvas.nodes = next_nodes
    db.commit()


@app.patch("/api/workspaces/{workspace_id}/tags/{tag_id}")
async def rename_workspace_tag(
    workspace_id: str,
    tag_id: str,
    body: TagPatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_workspace_member(workspace_id, user, db)
    tag = db.query(Tag).filter(Tag.id == tag_id, Tag.workspace_id == workspace_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    new_name = " ".join((body.name or "").split())[:40]
    if not new_name:
        raise HTTPException(status_code=400, detail="Name is required")
    if new_name.lower() in TYPE_TAGS:
        raise HTTPException(status_code=400, detail="That name is reserved")
    old_name = tag.name
    if old_name.lower() != new_name.lower():
        clash = (
            db.query(Tag)
            .filter(Tag.workspace_id == workspace_id, func.lower(Tag.name) == new_name.lower(), Tag.id != tag_id)
            .first()
        )
        if clash:
            raise HTTPException(status_code=400, detail="A tag with that name already exists")
    tag.name = new_name
    log_activity(
        db,
        user,
        "tag.rename",
        resource_type="tag",
        resource_id=tag.id,
        resource_name=new_name,
        workspace_id=workspace_id,
        details={"workspace_name": workspace_name(db, workspace_id), "old_name": old_name},
    )
    db.commit()
    _rewrite_tags_in_workspace(db, workspace_id, old_name, new_name)
    return {"id": tag.id, "name": tag.name}


@app.delete("/api/workspaces/{workspace_id}/tags/{tag_id}")
async def delete_workspace_tag(
    workspace_id: str,
    tag_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_workspace_member(workspace_id, user, db)
    tag = db.query(Tag).filter(Tag.id == tag_id, Tag.workspace_id == workspace_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    old_name = tag.name
    db.delete(tag)
    log_activity(
        db,
        user,
        "tag.delete",
        resource_type="tag",
        resource_id=tag_id,
        resource_name=old_name,
        workspace_id=workspace_id,
        details={"workspace_name": workspace_name(db, workspace_id)},
    )
    db.commit()
    _rewrite_tags_in_workspace(db, workspace_id, old_name, None)
    return {"deleted": True, "id": tag_id}


@app.get("/api/stats")
async def stats(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    type_rows = db.query(Message.type, func.count(Message.id)).group_by(Message.type).all()
    return {
        "users": db.query(User).count(),
        "uploads": db.query(Upload).count(),
        "messages": db.query(Message).count(),
        "projects": db.query(Project).count(),
        "by_type": {row[0]: row[1] for row in type_rows if row[0]},
    }


TYPE_TAGS = {"chat", "link", "document", "reel", "image", "media_omitted"}


def clean_user_tags(tags: list) -> list[str]:
    seen = set()
    out = []
    for item in tags or []:
        name = " ".join(str(item or "").split())[:40]
        if not name or name.lower() in TYPE_TAGS:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(name)
    return out


@app.get("/api/library")
async def library(
    project_id: str = Query(...),
    tab: str = Query("chat"),
    sender: Optional[str] = None,
    q: Optional[str] = None,
    tag: Optional[str] = None,
    chat: Optional[str] = None,
    site: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    upload_id: Optional[str] = None,
    offset: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = require_project_access(project_id, user, db)
    query = db.query(Message).filter(Message.project_id == project_id)
    if upload_id:
        query = query.filter(Message.upload_id == upload_id)
    tab_types = {
        "chats": ["chat"],
        "chat": ["chat"],
        "documents": ["document"],
        "document": ["document"],
        "images": ["image", "media_omitted"],
        "image": ["image", "media_omitted"],
        "media": ["image", "media_omitted"],
        "media_omitted": ["image", "media_omitted"],
        "reels": ["reel"],
        "reel": ["reel"],
    }
    if tab in {"link", "links"}:
        query = query.filter(external_link_filter())
    elif tab != "all" and tab in tab_types:
        query = query.filter(Message.type.in_(tab_types[tab]))
    if sender:
        query = query.filter(Message.sender == sender)
    if chat:
        query = query.filter(Message.chat_name == chat)
    if site:
        site_col = func.json_extract(Message.link_preview, "$.site")
        domain_col = func.json_extract(Message.link_preview, "$.domain")
        query = query.filter(or_(site_col == site, domain_col == site))
    if q:
        like = f"%{q}%"
        query = query.filter(
            or_(
                Message.raw_text.ilike(like),
                Message.extracted_filename.ilike(like),
                Message.extracted_url.ilike(like),
                Message.sender.ilike(like),
                Message.chat_name.ilike(like),
            )
        )
    if tag:
        query = query.filter(func.cast(Message.tags, String).ilike(f"%{tag}%"))
    if date_from:
        query = query.filter(Message.timestamp >= datetime.fromisoformat(date_from))
    if date_to:
        query = query.filter(Message.timestamp <= datetime.fromisoformat(date_to + "T23:59:59"))
    total = query.count()
    rows = (
        query.order_by(Message.timestamp.desc())
        .offset(max(offset, 0))
        .limit(min(limit, 100))
        .all()
    )
    type_rows = (
        db.query(Message.type, func.count(Message.id))
        .filter(Message.project_id == project_id)
        .group_by(Message.type)
        .all()
    )
    by_type = {row[0]: row[1] for row in type_rows if row[0]}
    link_count = (
        db.query(Message)
        .filter(Message.project_id == project_id)
        .filter(external_link_filter())
        .count()
    )
    counts = {
        "chat": by_type.get("chat", 0),
        "link": link_count,
        "document": by_type.get("document", 0),
        "image": by_type.get("image", 0) + by_type.get("media_omitted", 0),
        "reel": by_type.get("reel", 0),
    }
    return {
        "total": total,
        "offset": offset,
        "items": [serialize_message(row) for row in rows],
        "counts": counts,
    }


@app.get("/api/projects/{project_id}/library/uploads")
async def library_uploads(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Per-zip library breakdown for a project (message counts by media type)."""
    require_project_access(project_id, user, db)
    uploads = (
        db.query(Upload)
        .filter(Upload.project_id == project_id)
        .order_by(Upload.uploaded_at.desc())
        .all()
    )
    uploaders = {item.id: item.username for item in db.query(User).all()}
    type_rows = (
        db.query(Message.upload_id, Message.type, func.count(Message.id))
        .filter(Message.project_id == project_id)
        .group_by(Message.upload_id, Message.type)
        .all()
    )
    by_upload: dict[str, dict[str, int]] = {}
    for upload_id, msg_type, count in type_rows:
        if not upload_id:
            continue
        bucket = by_upload.setdefault(upload_id, {})
        bucket[msg_type] = int(count or 0)

    summaries = []
    for upload in uploads:
        types = by_upload.get(upload.id, {})
        image_count = types.get("image", 0) + types.get("media_omitted", 0)
        link_count = types.get("link", 0)
        summaries.append(
            {
                "upload": serialize_upload(upload, uploaders.get(upload.uploaded_by)),
                "counts": {
                    "chat": types.get("chat", 0),
                    "link": link_count,
                    "document": types.get("document", 0),
                    "image": image_count,
                    "reel": types.get("reel", 0),
                    "total": sum(types.values()),
                },
            }
        )
    return summaries


@app.get("/api/library/filters")
async def library_filters(
    project_id: str = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = require_project_access(project_id, user, db)
    base = db.query(Message).filter(Message.project_id == project_id)
    senders = [
        row[0]
        for row in base.with_entities(Message.sender).distinct().order_by(Message.sender.asc()).all()
        if row[0] and row[0] != "<system>"
    ]
    chats = [
        row[0]
        for row in base.with_entities(Message.chat_name).distinct().order_by(Message.chat_name.asc()).all()
        if row[0]
    ]
    tags = set()
    sites = set()
    for row in base.with_entities(Message.tags, Message.link_preview).limit(4000).all():
        if isinstance(row[0], list):
            tags.update(item for item in row[0] if item and str(item).lower() not in TYPE_TAGS)
        preview = row[1]
        if isinstance(preview, dict):
            label = preview.get("site") or preview.get("domain")
            if label:
                sites.add(label)
    for row in db.query(Tag.name).filter(Tag.workspace_id == project.workspace_id).all():
        if row[0]:
            tags.add(row[0])
    return {
        "senders": senders,
        "tags": sorted(tags),
        "chats": chats,
        "sites": sorted(sites),
    }


@app.get("/api/previews")
async def get_link_preview(url: str, user: User = Depends(get_current_user)):
    if not url or not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="A valid http(s) url is required")
    return fetch_preview(url)


@app.get("/api/previews/image")
async def proxy_preview_image(url: str, user: User = Depends(get_current_user)):
    if not is_fetchable_url(url):
        raise HTTPException(status_code=400, detail="Image url is not allowed")
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    try:
        with httpx.Client(timeout=8.0, follow_redirects=True, headers=headers) as client:
            res = client.get(url)
        if res.status_code >= 400:
            raise HTTPException(status_code=404, detail="Preview image not found")
        ctype = (res.headers.get("content-type") or "application/octet-stream").split(";")[0].strip()
        if not ctype.startswith("image/"):
            raise HTTPException(status_code=404, detail="Not an image")
        body = res.content[: 2 * 1024 * 1024]
        return Response(content=body, media_type=ctype)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=404, detail="Preview image unavailable")


@app.get("/api/messages/{message_id}")
async def get_message(message_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    message = db.query(Message).filter(Message.id == message_id).first()
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    if message.project_id:
        require_project_access(message.project_id, user, db)
    elif message.workspace_id:
        require_workspace_member(message.workspace_id, user, db)
    return serialize_message(message)


@app.patch("/api/messages/{message_id}/tags")
async def patch_message_tags(
    message_id: str,
    body: MessageTagsBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    message = db.query(Message).filter(Message.id == message_id).first()
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    if message.project_id:
        require_project_access(message.project_id, user, db)
    elif message.workspace_id:
        require_workspace_member(message.workspace_id, user, db)
    kept = [item for item in (message.tags or []) if isinstance(item, str) and item.lower() in TYPE_TAGS]
    user_tags = clean_user_tags(body.tags)
    message.tags = kept + user_tags
    _ensure_tags_in_registry(db, message.workspace_id, user_tags)
    db.commit()
    db.refresh(message)
    return serialize_message(message)


@app.post("/api/uploads/file", status_code=201)
async def upload_txt(
    project_id: str = Query(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = require_project_access(project_id, user, db)
    saved_name = file.filename or "chat.txt"
    if not saved_name.lower().endswith((".txt", ".zip")):
        raise HTTPException(status_code=400, detail="Upload a WhatsApp .txt export (or a zip that contains one).")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    upload = Upload(
        workspace_id=project.workspace_id,
        project_id=project.id,
        file_name=saved_name,
        uploaded_by=user.id,
        status="extracting" if saved_name.lower().endswith(".zip") else "processing",
    )
    db.add(upload)
    db.flush()
    ws_name = workspace_name(db, project.workspace_id)
    log_activity(
        db,
        user,
        "upload.start",
        resource_type="upload",
        resource_id=upload.id,
        resource_name=saved_name,
        workspace_id=project.workspace_id,
        details={"workspace_name": ws_name, "project_name": project.name, "project_id": project.id},
    )
    db.commit()
    db.refresh(upload)
    dest = os.path.join(UPLOAD_DIR, f"{upload.id}_{os.path.basename(saved_name)}")
    with open(dest, "wb") as handle:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)

    threading.Thread(target=process_upload, args=(upload.id, dest), daemon=True).start()
    return serialize_upload(upload, user.username)


@app.get("/api/files/{upload_id}/{filename:path}")
async def serve_extracted_file(
    upload_id: str,
    filename: str,
    token: Optional[str] = Query(None),
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
):
    user_from_token(creds.credentials if creds else token, db)
    path = find_extracted_file(upload_id, unquote(filename))
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Extracted file not found")
    return FileResponse(path, filename=path.name)


@app.get("/api/uploads")
async def list_uploads(
    project_id: Optional[str] = Query(None),
    workspace_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if project_id:
        require_project_access(project_id, user, db)
        uploads = (
            db.query(Upload)
            .filter(Upload.project_id == project_id)
            .order_by(Upload.uploaded_at.desc())
            .all()
        )
    elif workspace_id:
        require_workspace_member(workspace_id, user, db)
        uploads = (
            db.query(Upload)
            .filter(Upload.workspace_id == workspace_id)
            .order_by(Upload.uploaded_at.desc())
            .all()
        )
    else:
        raise HTTPException(status_code=400, detail="project_id or workspace_id is required")
    users = {item.id: item.username for item in db.query(User).all()}
    return [serialize_upload(item, users.get(item.uploaded_by)) for item in uploads]


@app.get("/api/uploads/{upload_id}")
async def get_upload(
    upload_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(status_code=404, detail="Upload not found")
    if upload.project_id:
        require_project_access(upload.project_id, user, db)
    elif upload.workspace_id:
        require_workspace_member(upload.workspace_id, user, db)
    uploader = db.query(User).filter(User.id == upload.uploaded_by).first()
    return serialize_upload(upload, uploader.username if uploader else None)


@app.delete("/api/uploads/{upload_id}")
async def delete_upload(
    upload_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    upload = db.query(Upload).filter(Upload.id == upload_id).first()
    if not upload:
        raise HTTPException(status_code=404, detail="Upload not found")
    file_name = upload.file_name
    guard_destructive(f"upload delete ({file_name})", admin)
    log_activity(
        db,
        admin,
        "upload.delete",
        resource_type="upload",
        resource_id=upload_id,
        resource_name=file_name,
        workspace_id=upload.workspace_id,
        details={"workspace_name": workspace_name(db, upload.workspace_id)},
    )
    message_ids = [row[0] for row in db.query(Message.id).filter(Message.upload_id == upload_id).all()]
    if message_ids:
        db.query(ProjectItem).filter(ProjectItem.message_id.in_(message_ids)).delete(synchronize_session=False)
    db.query(Message).filter(Message.upload_id == upload_id).delete(synchronize_session=False)
    db.delete(upload)
    db.commit()
    delete_upload_vectors(upload_id)
    delete_upload_files(upload_id)
    return {"deleted": True, "id": upload_id}


@app.get("/api/projects")
async def list_projects(
    workspace_id: str = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_workspace_member(workspace_id, user, db)
    projects = (
        db.query(Project)
        .filter(Project.workspace_id == workspace_id)
        .order_by(Project.created_at.desc())
        .all()
    )
    return [serialize_project(item) for item in projects]


@app.post("/api/projects", status_code=201)
async def create_project(body: ProjectCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_workspace_member(body.workspace_id, user, db)
    project = Project(name=body.name, created_by=user.id, workspace_id=body.workspace_id)
    db.add(project)
    db.flush()
    db.add(ProjectCanvas(project_id=project.id, name="Main canvas", nodes=[], edges=[], frames=[]))
    ws_name = workspace_name(db, body.workspace_id)
    log_activity(
        db,
        user,
        "project.create",
        resource_type="project",
        resource_id=project.id,
        resource_name=project.name,
        workspace_id=body.workspace_id,
        details={"workspace_name": ws_name},
    )
    db.commit()
    db.refresh(project)
    return serialize_project(project)


def require_project_access(project_id: str, user: User, db: Session) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if is_super_admin(user):
        return project
    if project.workspace_id:
        require_workspace_member(project.workspace_id, user, db)
    return project


@app.post("/api/projects/{project_id}/duplicate", status_code=201)
async def duplicate_project(project_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    source = require_project_access(project_id, user, db)
    canvas = db.query(ProjectCanvas).filter(ProjectCanvas.project_id == project_id).first()
    items = db.query(ProjectItem).filter(ProjectItem.project_id == project_id).all()
    project = Project(name=f"{source.name} copy", created_by=user.id, workspace_id=source.workspace_id)
    db.add(project)
    db.flush()
    db.add(
        ProjectCanvas(
            project_id=project.id,
            name="Main canvas",
            nodes=copy.deepcopy(canvas.nodes or []) if canvas else [],
            edges=copy.deepcopy(canvas.edges or []) if canvas else [],
            frames=copy.deepcopy(canvas.frames or []) if canvas else [],
        )
    )
    for item in items:
        db.add(ProjectItem(project_id=project.id, message_id=item.message_id))
    log_activity(
        db,
        user,
        "project.duplicate",
        resource_type="project",
        resource_id=project.id,
        resource_name=project.name,
        workspace_id=source.workspace_id,
        details={"workspace_name": workspace_name(db, source.workspace_id), "source_project": source.name},
    )
    db.commit()
    db.refresh(project)
    return serialize_project(project)


@app.patch("/api/projects/{project_id}")
async def rename_project(project_id: str, body: ProjectPatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = require_project_access(project_id, user, db)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    project.name = name
    log_activity(
        db,
        user,
        "project.rename",
        resource_type="project",
        resource_id=project.id,
        resource_name=name,
        workspace_id=project.workspace_id,
        details={"workspace_name": workspace_name(db, project.workspace_id)},
    )
    db.commit()
    db.refresh(project)
    return serialize_project(project)


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = require_project_access(project_id, user, db)
    project_name = project.name
    ws_id = project.workspace_id
    guard_destructive(f"project delete ({project_name})", user)
    db.query(ProjectItem).filter(ProjectItem.project_id == project_id).delete()
    db.query(ProjectCanvas).filter(ProjectCanvas.project_id == project_id).delete()
    log_activity(
        db,
        user,
        "project.delete",
        resource_type="project",
        resource_id=project_id,
        resource_name=project_name,
        workspace_id=ws_id,
        details={"workspace_name": workspace_name(db, ws_id)},
    )
    db.delete(project)
    db.commit()
    return {"deleted": True, "id": project_id}


@app.get("/api/projects/{project_id}")
async def get_project(
    project_id: str,
    canvas_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = require_project_access(project_id, user, db)
    canvases = (
        db.query(ProjectCanvas)
        .filter(ProjectCanvas.project_id == project_id)
        .order_by(ProjectCanvas.created_at.asc())
        .all()
    )
    canvas = get_project_canvas(db, project_id, canvas_id)
    if canvas not in canvases:
        canvases.append(canvas)
    items = (
        db.query(ProjectItem)
        .options(joinedload(ProjectItem.message))
        .filter(ProjectItem.project_id == project_id)
        .all()
    )
    uploads = (
        db.query(Upload)
        .filter(Upload.project_id == project_id)
        .order_by(Upload.uploaded_at.desc())
        .all()
    )
    uploaders = {item.id: item.username for item in db.query(User).all()}
    serialized_items = [serialize_message(item.message) for item in items if item.message]
    by_id = {item["id"]: item for item in serialized_items}
    canvas_json = serialize_canvas(canvas)
    missing_ids = []
    for node in canvas_json.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        message_id = str(((node.get("data") or {}).get("messageId") or ""))
        if message_id and message_id not in by_id:
            missing_ids.append(message_id)
    if missing_ids:
        extra = db.query(Message).filter(Message.id.in_(missing_ids)).all()
        for message in extra:
            by_id[message.id] = serialize_message(message)
    canvas_json["nodes"] = hydrate_canvas_nodes(canvas_json.get("nodes") or [], by_id)
    return {
        "project": serialize_project(project),
        "canvas": canvas_json,
        "canvas_id": canvas.id,
        "canvases": [serialize_canvas_summary(item) for item in canvases],
        "uploads": [serialize_upload(item, uploaders.get(item.uploaded_by)) for item in uploads],
        "items": serialized_items,
    }


@app.post("/api/projects/{project_id}/canvases", status_code=201)
async def create_project_canvas(
    project_id: str,
    body: CanvasCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = require_project_access(project_id, user, db)
    name = (body.name or "").strip() or "New canvas"
    canvas = ProjectCanvas(project_id=project_id, name=name, nodes=[], edges=[], frames=[])
    db.add(canvas)
    db.flush()
    log_activity(
        db,
        user,
        "canvas.create",
        resource_type="canvas",
        resource_id=canvas.id,
        resource_name=name,
        workspace_id=project.workspace_id,
        details={
            "workspace_name": workspace_name(db, project.workspace_id),
            "project_name": project.name,
        },
    )
    db.commit()
    db.refresh(canvas)
    return serialize_canvas_summary(canvas)


@app.put("/api/projects/{project_id}/canvas")
async def save_canvas(
    project_id: str,
    body: CanvasSave,
    canvas_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_project_access(project_id, user, db)
    canvas = get_project_canvas(db, project_id, canvas_id)
    canvas.nodes = body.nodes
    canvas.edges = body.edges
    canvas.frames = body.frames
    if body.viewport is not None:
        canvas.viewport = body.viewport
    db.flush()
    save_canvas_version(db, canvas, canvas.nodes or [], canvas.edges or [], canvas.frames or [])
    db.commit()
    db.refresh(canvas)
    return serialize_canvas(canvas)


@app.get("/api/projects/{project_id}/canvas/history")
async def list_canvas_history(
    project_id: str,
    canvas_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_project_access(project_id, user, db)
    canvas = get_project_canvas(db, project_id, canvas_id)
    rows = (
        db.query(CanvasVersion)
        .filter(CanvasVersion.canvas_id == canvas.id)
        .order_by(CanvasVersion.created_at.desc())
        .limit(8)
        .all()
    )
    return [{"id": row.id, "at": row.created_at.isoformat() if row.created_at else None} for row in rows]


@app.get("/api/projects/{project_id}/canvas/history/{version_id}")
async def get_canvas_history_version(
    project_id: str,
    version_id: str,
    canvas_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_project_access(project_id, user, db)
    canvas = get_project_canvas(db, project_id, canvas_id)
    row = (
        db.query(CanvasVersion)
        .filter(CanvasVersion.id == version_id, CanvasVersion.canvas_id == canvas.id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Version not found")
    return {
        "id": row.id,
        "at": row.created_at.isoformat() if row.created_at else None,
        "nodes": row.nodes or [],
        "edges": row.edges or [],
        "frames": row.frames or [],
    }


@app.post("/api/projects/{project_id}/items", status_code=201)
async def add_project_item(
    project_id: str,
    body: ItemAdd,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_project_access(project_id, user, db)
    if not db.query(Message).filter(Message.id == body.message_id).first():
        raise HTTPException(status_code=404, detail="Message not found")
    existing = (
        db.query(ProjectItem)
        .filter(ProjectItem.project_id == project_id, ProjectItem.message_id == body.message_id)
        .first()
    )
    if existing:
        return {"id": existing.id, "message_id": existing.message_id}
    item = ProjectItem(project_id=project_id, message_id=body.message_id)
    db.add(item)
    db.commit()
    db.refresh(item)
    return {"id": item.id, "message_id": item.message_id}


@app.get("/api/projects/{project_id}/chat")
async def list_project_chat(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_project_access(project_id, user, db)
    rows = (
        db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.project_id == project_id)
        .order_by(ProjectChatMessage.created_at.asc())
        .all()
    )
    return [{"role": row.role, "text": row.text, "at": row.created_at.isoformat() if row.created_at else None} for row in rows]


@app.post("/api/projects/{project_id}/chat")
async def project_chat(
    project_id: str,
    body: ChatBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = require_project_access(project_id, user, db)
    canvas = db.query(ProjectCanvas).filter(ProjectCanvas.project_id == project_id).first()
    canvas_json = serialize_canvas(canvas)
    items = (
        db.query(ProjectItem)
        .options(joinedload(ProjectItem.message))
        .filter(ProjectItem.project_id == project_id)
        .all()
    )
    sources = [serialize_message(item.message) for item in items if item.message]
    silent_context = []
    for edge in canvas_json.get("edges") or []:
        silent_context.append(
            {
                "type": "connection",
                "from": edge.get("source"),
                "to": edge.get("target"),
                "user_note": (edge.get("data") or {}).get("note") or edge.get("label") or "",
            }
        )
    for frame in canvas_json.get("frames") or []:
        silent_context.append({"type": "frame", "label": frame.get("data", {}).get("label") or frame.get("id")})
    payload = {
        "project": project.name,
        "nodes": canvas_json.get("nodes") or [],
        "edges": canvas_json.get("edges") or [],
        "frames": canvas_json.get("frames") or [],
        "silent_context": silent_context,
    }
    system, prompt = build_prompt(payload, sources, body.question)
    answer = complete(system, prompt, payload, sources, body.question)
    db.add(ProjectChatMessage(project_id=project_id, role="user", text=body.question))
    db.add(ProjectChatMessage(project_id=project_id, role="assistant", text=answer))
    db.commit()
    return {"answer": answer, "sources_used": len(sources)}


@app.get("/api/admin/activity-logs")
async def list_activity_logs(
    workspace_id: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    viewer_super = is_super_admin(admin)
    query = db.query(ActivityLog)
    if workspace_id:
        query = query.filter(ActivityLog.workspace_id == workspace_id)
    if not viewer_super:
        hidden_ids = super_admin_user_ids(db)
        query = query.filter(ActivityLog.user_role != "superadmin")
        query = query.filter(~ActivityLog.action.like("db.%"))
        if hidden_ids:
            query = query.filter(~ActivityLog.user_id.in_(hidden_ids))
    total = query.count()
    rows = query.order_by(ActivityLog.created_at.desc()).offset(offset).limit(limit).all()
    if viewer_super:
        visible_rows = rows
    else:
        actor_ids = {row.user_id for row in rows if row.user_id}
        actors = (
            {item.id: item for item in db.query(User).filter(User.id.in_(actor_ids)).all()}
            if actor_ids
            else {}
        )
        visible_rows = [
            row for row in rows if activity_visible_to_viewer(row, admin, actors.get(row.user_id))
        ]
    return {
        "total": total,
        "items": [serialize_activity_log(row, viewer_super=viewer_super) for row in visible_rows],
    }


# ---------- Super-admin: Control center + database snapshots ----------


@app.get("/api/admin/control/overview")
async def control_overview(db: Session = Depends(get_db), admin: User = Depends(require_super_admin)):
    """User-centric view of every account, project, canvas, and upload."""
    return build_control_overview(db, admin)


@app.get("/api/admin/control/tables")
async def control_tables(
    message_limit: int = Query(100, ge=1, le=500),
    message_offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    admin: User = Depends(require_super_admin),
):
    """Flat tabular dump of all platform data for the super-admin control center."""
    return build_control_tables(db, admin, message_limit=message_limit, message_offset=message_offset)


@app.get("/api/admin/control/users/{user_id}/export")
async def export_user_control_backup(
    user_id: str,
    include_messages: bool = Query(False),
    db: Session = Depends(get_db),
    admin: User = Depends(require_super_admin),
):
    from fastapi.responses import Response as _Response

    try:
        payload = export_user_backup_json(db, user_id, include_messages=include_messages)
    except ValueError:
        raise HTTPException(status_code=404, detail="User not found")
    user = db.query(User).filter(User.id == user_id).first()
    label = (user.email or user.username or user_id).replace("@", "_at_")
    filename = f"backup_{label}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.json"
    log_activity(
        db,
        admin,
        "admin.user.export",
        resource_type="user",
        resource_id=user_id,
        resource_name=user.email or user.username if user else user_id,
        details={"include_messages": include_messages},
    )
    db.commit()
    return _Response(
        content=payload,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _serialize_upload_for_db(upload: Upload, uploader_name: str | None) -> dict:
    return {
        "id": upload.id,
        "file_name": upload.file_name,
        "status": upload.status,
        "message_count": upload.message_count or 0,
        "duplicate_count": upload.duplicate_count or 0,
        "uploaded_by_username": uploader_name,
        "uploaded_at": upload.uploaded_at.isoformat() if upload.uploaded_at else None,
        "chat_name": upload.chat_name,
        "error_message": upload.error_message,
    }


@app.get("/api/admin/db/overview")
async def db_overview(db: Session = Depends(get_db), admin: User = Depends(require_super_admin)):
    """All zip uploads organized by workspace -> project, plus global counts."""
    workspaces = db.query(Workspace).order_by(Workspace.created_at.asc()).all()
    projects = db.query(Project).order_by(Project.created_at.desc()).all()
    uploads = db.query(Upload).order_by(Upload.uploaded_at.desc()).all()
    users = {item.id: item.username for item in db.query(User).all()}

    uploads_by_project: dict[str, list] = {}
    for upload in uploads:
        key = upload.project_id or "_orphan"
        uploads_by_project.setdefault(key, []).append(
            _serialize_upload_for_db(upload, users.get(upload.uploaded_by))
        )

    projects_by_workspace: dict[str, list] = {}
    for project in projects:
        projects_by_workspace.setdefault(project.workspace_id or "_none", []).append({
            "id": project.id,
            "name": project.name,
            "created_at": project.created_at.isoformat() if project.created_at else None,
            "uploads": uploads_by_project.get(project.id, []),
            "message_count": db.query(Message).filter(Message.project_id == project.id).count(),
            "canvas_count": db.query(ProjectCanvas).filter(ProjectCanvas.project_id == project.id).count(),
        })

    workspace_rows = []
    for ws in workspaces:
        ws_projects = projects_by_workspace.get(ws.id, [])
        ws_uploads = sum(len(p["uploads"]) for p in ws_projects)
        ws_messages = sum(p["message_count"] for p in ws_projects)
        workspace_rows.append({
            "id": ws.id,
            "name": ws.name,
            "owner_id": ws.owner_id,
            "owner_username": users.get(ws.owner_id),
            "created_at": ws.created_at.isoformat() if ws.created_at else None,
            "project_count": len(ws_projects),
            "upload_count": ws_uploads,
            "message_count": ws_messages,
            "projects": ws_projects,
        })

    return {
        "backend": DB_BACKEND,
        "totals": {
            "workspaces": len(workspaces),
            "projects": len(projects),
            "uploads": len(uploads),
            "messages": db.query(Message).count(),
            "users": db.query(User).count(),
            "members": db.query(WorkspaceMember).count(),
        },
        "workspaces": workspace_rows,
    }


@app.get("/api/admin/db/snapshots")
async def list_db_snapshots(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    admin: User = Depends(require_super_admin),
):
    total = db.query(DbSnapshot).count()
    rows = (
        db.query(DbSnapshot)
        .order_by(DbSnapshot.created_at.desc())
        .limit(limit)
        .all()
    )
    return {"total": total, "items": [serialize_snapshot(row) for row in rows]}


@app.post("/api/admin/db/snapshots", status_code=201)
async def create_db_snapshot(
    db: Session = Depends(get_db),
    admin: User = Depends(require_super_admin),
):
    try:
        snapshot = run_backup(kind="manual", notes=f"Triggered by {admin.email or admin.username}")
    except BackupError as exc:
        raise HTTPException(status_code=503, detail=f"Backup failed: {exc}") from exc
    log_activity(
        db,
        admin,
        "db.snapshot.create",
        resource_type="db_snapshot",
        resource_id=snapshot.id,
        resource_name=snapshot.file_name,
        details={"size_bytes": snapshot.size_bytes, "backend": snapshot.backend},
    )
    db.commit()
    return serialize_snapshot(snapshot)


@app.get("/api/admin/db/backup-status")
async def get_backup_status(admin: User = Depends(require_super_admin)):
    return backup_status()


@app.get("/api/admin/db/snapshots/{snapshot_id}/download")
async def download_db_snapshot(
    snapshot_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_super_admin),
):
    from fastapi.responses import FileResponse as _FileResponse
    snapshot = db.query(DbSnapshot).filter(DbSnapshot.id == snapshot_id).first()
    if not snapshot:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    path = os.path.abspath(snapshot.file_path)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Snapshot file missing from disk")
    return _FileResponse(path, filename=snapshot.file_name)


@app.delete("/api/admin/db/snapshots/{snapshot_id}")
async def delete_db_snapshot(
    snapshot_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_super_admin),
):
    snapshot = db.query(DbSnapshot).filter(DbSnapshot.id == snapshot_id).first()
    if not snapshot:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    newest = db.query(DbSnapshot).order_by(DbSnapshot.created_at.desc()).first()
    if newest and newest.id == snapshot.id:
        raise HTTPException(
            status_code=400,
            detail="The most recent snapshot cannot be deleted — it is the current restore point.",
        )
    try:
        if os.path.isfile(snapshot.file_path):
            os.remove(snapshot.file_path)
    except Exception:
        pass
    db.delete(snapshot)
    db.commit()
    return {"deleted": True, "id": snapshot_id}


@app.get("/api/admin/users")
async def list_users(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    return [serialize_user(item, viewer=admin) for item in visible_users_for_admin(db, admin)]


@app.post("/api/admin/users", status_code=201)
async def add_user(body: UserCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    allowed_roles = {"superadmin", "admin", "member"} if is_super_admin(admin) else {"admin", "member"}
    if body.role not in allowed_roles:
        raise HTTPException(status_code=400, detail="Invalid role")
    email = (body.email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email is required")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=400, detail="Email already exists")
    username = (body.username or "").strip() or email.split("@")[0]
    username = unique_username(db, username)
    temp = body.password or secrets.token_urlsafe(8)
    user = User(username=username, email=email, password_hash=hash_password(temp), role=body.role)
    db.add(user)
    db.flush()
    ensure_personal_workspace(db, user)
    log_activity(
        db,
        admin,
        "admin.user.create",
        resource_type="user",
        resource_id=user.id,
        resource_name=user.email or user.username,
        details={"role": user.role},
    )
    db.commit()
    db.refresh(user)
    data = serialize_user(user, viewer=admin)
    data["temporary_password"] = temp
    return data


@app.get("/api/admin/signup-codes")
async def list_signup_codes(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    rows = db.query(SignupCode).order_by(SignupCode.created_at.desc()).all()
    return [serialize_signup_code(row) for row in rows]


@app.post("/api/admin/signup-codes", status_code=201)
async def create_signup_code(
    body: SignupCodeCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    max_uses = body.max_uses if body.max_uses and body.max_uses > 0 else 1
    if body.workspace_id:
        require_workspace_member(body.workspace_id, admin, db)
    if body.workspace_role not in {"owner", "member"}:
        raise HTTPException(status_code=400, detail="Workspace role must be owner or member")
    signup_code = SignupCode(
        code=generate_signup_code(db),
        created_by=admin.id,
        note=(body.note or "").strip() or None,
        max_uses=max_uses,
        workspace_id=body.workspace_id,
        workspace_role=body.workspace_role,
    )
    db.add(signup_code)
    log_activity(
        db,
        admin,
        "admin.signup_code.create",
        resource_type="signup_code",
        resource_id=signup_code.id,
        resource_name=signup_code.code,
        workspace_id=body.workspace_id,
        details={"workspace_name": workspace_name(db, body.workspace_id), "note": signup_code.note},
    )
    db.commit()
    db.refresh(signup_code)
    return serialize_signup_code(signup_code)


@app.delete("/api/admin/signup-codes/{code_id}")
async def revoke_signup_code(
    code_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    signup_code = db.query(SignupCode).filter(SignupCode.id == code_id).first()
    if not signup_code:
        raise HTTPException(status_code=404, detail="Signup code not found")
    signup_code.revoked = 1
    log_activity(
        db,
        admin,
        "admin.signup_code.revoke",
        resource_type="signup_code",
        resource_id=code_id,
        resource_name=signup_code.code,
        workspace_id=signup_code.workspace_id,
        details={"workspace_name": workspace_name(db, signup_code.workspace_id)},
    )
    db.commit()
    return {"revoked": True, "id": code_id}


@app.post("/api/admin/users/{user_id}/reset-password")
async def reset_password(
    user_id: str,
    body: PasswordReset,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    assert_user_manageable(user, admin)
    temp = body.password or secrets.token_urlsafe(8)
    user.password_hash = hash_password(temp)
    log_activity(
        db,
        admin,
        "admin.user.reset_password",
        resource_type="user",
        resource_id=user.id,
        resource_name=user.email or user.username,
    )
    db.commit()
    return {"id": user.id, "username": user.username, "temporary_password": temp}


@app.patch("/api/admin/users/{user_id}")
async def change_role(
    user_id: str,
    body: RolePatch,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    allowed_roles = {"superadmin", "admin", "member"} if is_super_admin(admin) else {"admin", "member"}
    if body.role not in allowed_roles:
        raise HTTPException(status_code=400, detail="Invalid role")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    assert_user_manageable(user, admin)
    if is_super_admin(user) and body.role != "superadmin" and user.id == admin.id:
        super_count = db.query(User).filter(User.role == "superadmin").count()
        email_super = sum(
            1 for u in db.query(User).filter(User.role == "admin").all()
            if u.email and u.email.lower() in SUPER_ADMIN_EMAILS
        )
        if super_count + email_super <= 1:
            raise HTTPException(status_code=400, detail="You cannot change your own role right now")
    user.role = body.role
    log_activity(
        db,
        admin,
        "admin.user.role_change",
        resource_type="user",
        resource_id=user.id,
        resource_name=user.email or user.username,
        details={"role": body.role},
    )
    db.commit()
    return serialize_user(user, viewer=admin)


@app.delete("/api/admin/users/{user_id}")
async def remove_user(user_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot remove your own admin account")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    assert_user_manageable(user, admin)
    if is_super_admin(user):
        raise HTTPException(status_code=400, detail="This account cannot be removed")
    removed_name = user.email or user.username
    guard_destructive(f"user delete ({removed_name})", admin)
    log_activity(
        db,
        admin,
        "admin.user.delete",
        resource_type="user",
        resource_id=user_id,
        resource_name=removed_name,
    )
    db.query(Upload).filter(Upload.uploaded_by == user_id).update({"uploaded_by": admin.id})
    db.query(Project).filter(Project.created_by == user_id).update({"created_by": admin.id})
    db.query(Workspace).filter(Workspace.owner_id == user_id).update({"owner_id": admin.id})
    db.query(WorkspaceInvite).filter(WorkspaceInvite.created_by == user_id).update({"created_by": admin.id})
    db.query(WorkspaceMember).filter(WorkspaceMember.user_id == user_id).delete(synchronize_session=False)
    db.query(UserPreference).filter(UserPreference.user_id == user_id).delete(synchronize_session=False)
    db.delete(user)
    db.commit()
    return {"deleted": True, "id": user_id}
