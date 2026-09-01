"""Internal WhatsApp Strategy Canvas API."""
from __future__ import annotations

import copy
import os
import secrets
import sys
import threading
from datetime import datetime
from typing import Optional
from urllib.parse import unquote

import httpx
from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel
from sqlalchemy import String, and_, func, or_
from sqlalchemy.orm import Session, joinedload

_LOCAL_PLATFORM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _LOCAL_PLATFORM not in sys.path:
    sys.path.insert(0, _LOCAL_PLATFORM)

from app.auth import bearer, get_current_user, hash_password, make_token, require_admin, serialize_user, user_from_token, verify_password
from app.ingest import backfill_message_types, hydrate_link_previews, process_upload
from app.llm import build_prompt, complete
from app.previews import fetch_preview, is_fetchable_url, preview_for_message
from app.vectors import delete_upload_vectors
from app.zip_extract import delete_upload_files, find_extracted_file
from db import DB_PATH, create_tables, get_db, seed_local_defaults
from db.models import (
    CanvasVersion,
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


class LoginBody(BaseModel):
    email: str
    password: str


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


class PreferenceBody(BaseModel):
    value: object = None


class ChatBody(BaseModel):
    question: str


class MessageTagsBody(BaseModel):
    tags: list[str] = []


class ItemAdd(BaseModel):
    message_id: str


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


def serialize_workspace(workspace: Workspace, role: str | None = None) -> dict:
    return {
        "id": workspace.id,
        "name": workspace.name,
        "owner_id": workspace.owner_id,
        "created_at": workspace.created_at.isoformat() if workspace.created_at else None,
        "role": role,
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
        return {"nodes": [], "edges": [], "frames": [], "viewport": None}
    return {
        "nodes": canvas.nodes or [],
        "edges": canvas.edges or [],
        "frames": canvas.frames or [],
        "viewport": canvas.viewport if isinstance(canvas.viewport, dict) else None,
    }


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
    return {"status": "healthy", "mode": "local", "db": "sqlite", "db_path": DB_PATH}


@app.post("/api/auth/login")
async def login(body: LoginBody, db: Session = Depends(get_db)):
    identifier = (body.email or "").strip()
    user = (
        db.query(User)
        .filter(or_(User.email == identifier, User.username == identifier))
        .first()
    )
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
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
    rows = (
        db.query(Workspace, WorkspaceMember)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .filter(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.created_at.asc())
        .all()
    )
    return [serialize_workspace(workspace, member.role) for workspace, member in rows]


@app.post("/api/workspaces", status_code=201)
async def create_workspace(body: WorkspaceCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    workspace = Workspace(name=name, owner_id=user.id)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
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
    db.commit()
    db.refresh(workspace)
    return serialize_workspace(workspace, "owner")


@app.delete("/api/workspaces/{workspace_id}")
async def delete_workspace(workspace_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    workspace = require_workspace_owner(workspace_id, user, db)
    member_workspaces = db.query(WorkspaceMember).filter(WorkspaceMember.user_id == user.id).count()
    if member_workspaces <= 1:
        raise HTTPException(status_code=400, detail="You must keep at least one workspace")
    upload_ids = [row[0] for row in db.query(Upload.id).filter(Upload.workspace_id == workspace_id).all()]
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
    db.commit()
    db.refresh(user)
    role = get_workspace_role(workspace.id, user.id, db) or invite.role
    return {
        "token": make_token(user),
        "user": serialize_user(user),
        "workspace": serialize_workspace(workspace, role),
    }


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
    workspace_id: str = Query(...),
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
    require_workspace_member(workspace_id, user, db)
    query = db.query(Message).filter(Message.workspace_id == workspace_id)
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
        .filter(Message.workspace_id == workspace_id)
        .group_by(Message.type)
        .all()
    )
    by_type = {row[0]: row[1] for row in type_rows if row[0]}
    link_count = (
        db.query(Message)
        .filter(Message.workspace_id == workspace_id)
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


@app.get("/api/library/filters")
async def library_filters(
    workspace_id: str = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_workspace_member(workspace_id, user, db)
    base = db.query(Message).filter(Message.workspace_id == workspace_id)
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
    kept = [item for item in (message.tags or []) if isinstance(item, str) and item.lower() in TYPE_TAGS]
    message.tags = kept + clean_user_tags(body.tags)
    db.commit()
    db.refresh(message)
    return serialize_message(message)


@app.post("/api/uploads/file", status_code=201)
async def upload_txt(
    workspace_id: str = Query(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_workspace_member(workspace_id, user, db)
    saved_name = file.filename or "chat.txt"
    if not saved_name.lower().endswith((".txt", ".zip")):
        raise HTTPException(status_code=400, detail="Upload a WhatsApp .txt export (or a zip that contains one).")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    upload = Upload(
        workspace_id=workspace_id,
        file_name=saved_name,
        uploaded_by=user.id,
        status="extracting" if saved_name.lower().endswith(".zip") else "processing",
    )
    db.add(upload)
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
    workspace_id: str = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_workspace_member(workspace_id, user, db)
    uploads = (
        db.query(Upload)
        .filter(Upload.workspace_id == workspace_id)
        .order_by(Upload.uploaded_at.desc())
        .all()
    )
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
    if upload.workspace_id:
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
    db.add(ProjectCanvas(project_id=project.id, nodes=[], edges=[], frames=[]))
    db.commit()
    db.refresh(project)
    return serialize_project(project)


def require_project_access(project_id: str, user: User, db: Session) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
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
            nodes=copy.deepcopy(canvas.nodes or []) if canvas else [],
            edges=copy.deepcopy(canvas.edges or []) if canvas else [],
            frames=copy.deepcopy(canvas.frames or []) if canvas else [],
        )
    )
    for item in items:
        db.add(ProjectItem(project_id=project.id, message_id=item.message_id))
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
    db.commit()
    db.refresh(project)
    return serialize_project(project)


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = require_project_access(project_id, user, db)
    db.query(ProjectItem).filter(ProjectItem.project_id == project_id).delete()
    db.query(ProjectCanvas).filter(ProjectCanvas.project_id == project_id).delete()
    db.delete(project)
    db.commit()
    return {"deleted": True, "id": project_id}


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = require_project_access(project_id, user, db)
    canvas = db.query(ProjectCanvas).filter(ProjectCanvas.project_id == project_id).first()
    items = (
        db.query(ProjectItem)
        .options(joinedload(ProjectItem.message))
        .filter(ProjectItem.project_id == project_id)
        .all()
    )
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
        "items": serialized_items,
    }


@app.put("/api/projects/{project_id}/canvas")
async def save_canvas(
    project_id: str,
    body: CanvasSave,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = require_project_access(project_id, user, db)
    canvas = db.query(ProjectCanvas).filter(ProjectCanvas.project_id == project_id).first()
    if not canvas:
        canvas = ProjectCanvas(project_id=project_id)
        db.add(canvas)
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
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_project_access(project_id, user, db)
    canvas = db.query(ProjectCanvas).filter(ProjectCanvas.project_id == project_id).first()
    if not canvas:
        return []
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
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_project_access(project_id, user, db)
    canvas = db.query(ProjectCanvas).filter(ProjectCanvas.project_id == project_id).first()
    if not canvas:
        raise HTTPException(status_code=404, detail="Canvas not found")
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


@app.get("/api/admin/users")
async def list_users(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    return [serialize_user(item) for item in db.query(User).order_by(User.username.asc()).all()]


@app.post("/api/admin/users", status_code=201)
async def add_user(body: UserCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    if body.role not in {"admin", "member"}:
        raise HTTPException(status_code=400, detail="Role must be admin or member")
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
    db.commit()
    db.refresh(user)
    data = serialize_user(user)
    data["temporary_password"] = temp
    return data


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
    temp = body.password or secrets.token_urlsafe(8)
    user.password_hash = hash_password(temp)
    db.commit()
    return {"id": user.id, "username": user.username, "temporary_password": temp}


@app.patch("/api/admin/users/{user_id}")
async def change_role(
    user_id: str,
    body: RolePatch,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    if body.role not in {"admin", "member"}:
        raise HTTPException(status_code=400, detail="Role must be admin or member")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.role = body.role
    db.commit()
    return serialize_user(user)


@app.delete("/api/admin/users/{user_id}")
async def remove_user(user_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot remove your own admin account")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    db.query(Upload).filter(Upload.uploaded_by == user_id).update({"uploaded_by": admin.id})
    db.query(Project).filter(Project.created_by == user_id).update({"created_by": admin.id})
    db.query(Workspace).filter(Workspace.owner_id == user_id).update({"owner_id": admin.id})
    db.query(WorkspaceInvite).filter(WorkspaceInvite.created_by == user_id).update({"created_by": admin.id})
    db.query(WorkspaceMember).filter(WorkspaceMember.user_id == user_id).delete(synchronize_session=False)
    db.query(UserPreference).filter(UserPreference.user_id == user_id).delete(synchronize_session=False)
    db.delete(user)
    db.commit()
    return {"deleted": True, "id": user_id}
