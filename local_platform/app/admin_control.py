"""Super-admin control center: user/project/canvas overview and per-user exports."""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import is_super_admin, serialize_user
from db.models import (
    Message,
    Project,
    ProjectCanvas,
    Upload,
    User,
    Workspace,
    WorkspaceMember,
)


def _canvas_summary(canvas: ProjectCanvas) -> dict:
    nodes = canvas.nodes or []
    edges = canvas.edges or []
    frames = canvas.frames or []
    return {
        "id": canvas.id,
        "name": canvas.name or "Main canvas",
        "project_id": canvas.project_id,
        "created_at": canvas.created_at.isoformat() if canvas.created_at else None,
        "node_count": len(nodes) if isinstance(nodes, list) else 0,
        "edge_count": len(edges) if isinstance(edges, list) else 0,
        "frame_count": len(frames) if isinstance(frames, list) else 0,
    }


def _upload_row(upload: Upload, uploaders: dict[str, str]) -> dict:
    return {
        "id": upload.id,
        "file_name": upload.file_name,
        "project_id": upload.project_id,
        "workspace_id": upload.workspace_id,
        "status": upload.status,
        "message_count": upload.message_count or 0,
        "duplicate_count": upload.duplicate_count or 0,
        "uploaded_by": upload.uploaded_by,
        "uploaded_by_username": uploaders.get(upload.uploaded_by),
        "uploaded_at": upload.uploaded_at.isoformat() if upload.uploaded_at else None,
        "chat_name": upload.chat_name,
    }


def build_control_overview(db: Session, viewer: User) -> dict:
    users = db.query(User).order_by(User.username.asc()).all()
    workspaces = db.query(Workspace).order_by(Workspace.created_at.asc()).all()
    workspace_by_id = {item.id: item for item in workspaces}
    uploaders = {item.id: item.username for item in users}
    email_by_id = {item.id: item.email for item in users}

    members_by_user: dict[str, list[WorkspaceMember]] = defaultdict(list)
    for member in db.query(WorkspaceMember).all():
        members_by_user[member.user_id].append(member)

    projects = db.query(Project).order_by(Project.created_at.desc()).all()
    projects_by_creator: dict[str, list[Project]] = defaultdict(list)
    projects_by_workspace: dict[str, list[Project]] = defaultdict(list)
    for project in projects:
        projects_by_creator[project.created_by].append(project)
        if project.workspace_id:
            projects_by_workspace[project.workspace_id].append(project)

    canvases_by_project: dict[str, list[ProjectCanvas]] = defaultdict(list)
    for canvas in db.query(ProjectCanvas).order_by(ProjectCanvas.created_at.asc()).all():
        canvases_by_project[canvas.project_id].append(canvas)

    uploads_by_project: dict[str, list[Upload]] = defaultdict(list)
    uploads_by_user: dict[str, list[Upload]] = defaultdict(list)
    for upload in db.query(Upload).order_by(Upload.uploaded_at.desc()).all():
        uploads_by_user[upload.uploaded_by].append(upload)
        if upload.project_id:
            uploads_by_project[upload.project_id].append(upload)

    message_counts = dict(
        db.query(Message.project_id, func.count(Message.id)).group_by(Message.project_id).all()
    )

    def project_payload(project: Project) -> dict:
        ws = workspace_by_id.get(project.workspace_id or "")
        canvases = canvases_by_project.get(project.id, [])
        uploads = uploads_by_project.get(project.id, [])
        return {
            "id": project.id,
            "name": project.name,
            "workspace_id": project.workspace_id,
            "workspace_name": ws.name if ws else None,
            "created_by": project.created_by,
            "created_by_username": uploaders.get(project.created_by),
            "created_at": project.created_at.isoformat() if project.created_at else None,
            "message_count": int(message_counts.get(project.id, 0)),
            "upload_count": len(uploads),
            "canvas_count": len(canvases),
            "canvases": [_canvas_summary(item) for item in canvases],
            "uploads": [_upload_row(item, uploaders) for item in uploads],
        }

    user_rows = []
    for user in users:
        created_projects = [project_payload(item) for item in projects_by_creator.get(user.id, [])]
        owned_workspaces = [
            {
                "id": ws.id,
                "name": ws.name,
                "role": "owner",
                "project_count": len(projects_by_workspace.get(ws.id, [])),
                "created_at": ws.created_at.isoformat() if ws.created_at else None,
            }
            for ws in workspaces
            if ws.owner_id == user.id
        ]
        member_workspaces = []
        for member in members_by_user.get(user.id, []):
            ws = workspace_by_id.get(member.workspace_id)
            if not ws or ws.owner_id == user.id:
                continue
            member_workspaces.append(
                {
                    "id": ws.id,
                    "name": ws.name,
                    "role": member.role,
                    "project_count": len(projects_by_workspace.get(ws.id, [])),
                    "created_at": ws.created_at.isoformat() if ws.created_at else None,
                }
            )
        user_uploads = [_upload_row(item, uploaders) for item in uploads_by_user.get(user.id, [])]
        user_rows.append(
            {
                "user": serialize_user(user, viewer=viewer),
                "email": user.email,
                "owned_workspaces": owned_workspaces,
                "member_workspaces": member_workspaces,
                "projects_created": created_projects,
                "uploads": user_uploads,
                "totals": {
                    "projects_created": len(created_projects),
                    "canvases": sum(item["canvas_count"] for item in created_projects),
                    "uploads": len(user_uploads),
                    "messages_in_projects": sum(item["message_count"] for item in created_projects),
                },
            }
        )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "totals": {
            "users": len(users),
            "workspaces": len(workspaces),
            "projects": len(projects),
            "canvases": db.query(ProjectCanvas).count(),
            "uploads": db.query(Upload).count(),
            "messages": db.query(Message).count(),
        },
        "users": user_rows,
    }


def export_user_backup(db: Session, user_id: str, *, include_messages: bool = False) -> dict:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise ValueError("User not found")

    uploaders = {item.id: item.username for item in db.query(User).all()}
    workspaces = db.query(Workspace).filter(Workspace.owner_id == user.id).all()
    member_rows = (
        db.query(WorkspaceMember, Workspace)
        .join(Workspace, Workspace.id == WorkspaceMember.workspace_id)
        .filter(WorkspaceMember.user_id == user.id)
        .all()
    )

    project_ids = {
        item.id
        for item in db.query(Project).filter(Project.created_by == user.id).all()
    }
    for ws in workspaces:
        for item in db.query(Project).filter(Project.workspace_id == ws.id).all():
            project_ids.add(item.id)

    projects_payload = []
    for project_id in sorted(project_ids):
        project = db.query(Project).filter(Project.id == project_id).first()
        if not project:
            continue
        canvases = db.query(ProjectCanvas).filter(ProjectCanvas.project_id == project_id).all()
        uploads = db.query(Upload).filter(Upload.project_id == project_id).all()
        block: dict = {
            "project": {
                "id": project.id,
                "name": project.name,
                "workspace_id": project.workspace_id,
                "created_by": project.created_by,
                "created_at": project.created_at.isoformat() if project.created_at else None,
            },
            "canvases": [
                {
                    "id": canvas.id,
                    "name": canvas.name,
                    "created_at": canvas.created_at.isoformat() if canvas.created_at else None,
                    "nodes": canvas.nodes or [],
                    "edges": canvas.edges or [],
                    "frames": canvas.frames or [],
                    "viewport": canvas.viewport,
                }
                for canvas in canvases
            ],
            "uploads": [_upload_row(item, uploaders) for item in uploads],
        }
        if include_messages:
            messages = db.query(Message).filter(Message.project_id == project_id).all()
            block["messages"] = [
                {
                    "id": msg.id,
                    "upload_id": msg.upload_id,
                    "sender": msg.sender,
                    "timestamp": msg.timestamp.isoformat() if msg.timestamp else None,
                    "type": msg.type,
                    "raw_text": msg.raw_text,
                    "extracted_url": msg.extracted_url,
                    "extracted_filename": msg.extracted_filename,
                    "chat_name": msg.chat_name,
                    "tags": msg.tags,
                }
                for msg in messages
            ]
        else:
            block["message_count"] = db.query(Message).filter(Message.project_id == project_id).count()
        projects_payload.append(block)

    return {
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "include_messages": include_messages,
        "user": {
            "id": user.id,
            "username": user.username,
            "email": user.email,
            "role": user.role,
            "created_at": user.created_at.isoformat() if user.created_at else None,
        },
        "owned_workspaces": [
            {"id": ws.id, "name": ws.name, "created_at": ws.created_at.isoformat() if ws.created_at else None}
            for ws in workspaces
        ],
        "member_workspaces": [
            {
                "id": ws.id,
                "name": ws.name,
                "role": member.role,
                "created_at": ws.created_at.isoformat() if ws.created_at else None,
            }
            for member, ws in member_rows
        ],
        "projects": projects_payload,
    }


def export_user_backup_json(db: Session, user_id: str, *, include_messages: bool = False) -> str:
    payload = export_user_backup(db, user_id, include_messages=include_messages)
    return json.dumps(payload, ensure_ascii=False, indent=2)
