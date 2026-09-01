"""Super-admin control center: user/project/canvas overview and per-user exports."""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import is_super_admin, serialize_user
from db.models import (
    ActivityLog,
    Message,
    Project,
    ProjectCanvas,
    SignupCode,
    Tag,
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

    project_ids: set[str] = {
        item.id for item in db.query(Project).filter(Project.created_by == user.id).all()
    }
    ws_ids = [ws.id for ws in workspaces]
    if ws_ids:
        for item in db.query(Project).filter(Project.workspace_id.in_(ws_ids)).all():
            project_ids.add(item.id)

    project_ids_list = sorted(project_ids)
    projects_by_id = {
        item.id: item
        for item in db.query(Project).filter(Project.id.in_(project_ids_list)).all()
    } if project_ids_list else {}

    canvases_by_project: dict[str, list[ProjectCanvas]] = defaultdict(list)
    for canvas in db.query(ProjectCanvas).filter(ProjectCanvas.project_id.in_(project_ids_list)).all():
        canvases_by_project[canvas.project_id].append(canvas)

    uploads_by_project: dict[str, list[Upload]] = defaultdict(list)
    for upload in db.query(Upload).filter(Upload.project_id.in_(project_ids_list)).all():
        uploads_by_project[upload.project_id].append(upload)

    messages_by_project: dict[str, list[Message]] = defaultdict(list)
    message_counts: dict[str, int] = {}
    if include_messages and project_ids_list:
        for msg in db.query(Message).filter(Message.project_id.in_(project_ids_list)).all():
            messages_by_project[msg.project_id].append(msg)
    elif project_ids_list:
        message_counts = {
            pid: int(cnt)
            for pid, cnt in db.query(Message.project_id, func.count(Message.id))
            .filter(Message.project_id.in_(project_ids_list))
            .group_by(Message.project_id)
            .all()
            if pid
        }

    projects_payload = []
    for project_id in project_ids_list:
        project = projects_by_id.get(project_id)
        if not project:
            continue
        canvases = canvases_by_project.get(project_id, [])
        uploads = uploads_by_project.get(project_id, [])
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
            messages = messages_by_project.get(project_id, [])
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
            block["message_count"] = message_counts.get(project_id, 0)
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


def build_control_tables(db: Session, viewer: User, *, message_limit: int = 100, message_offset: int = 0) -> dict:
    users = db.query(User).order_by(User.username.asc()).all()
    user_map = {item.id: item for item in users}
    username_map = {item.id: item.username for item in users}
    email_map = {item.id: item.email for item in users}

    workspaces = db.query(Workspace).order_by(Workspace.created_at.asc()).all()
    ws_map = {item.id: item for item in workspaces}

    members = db.query(WorkspaceMember).order_by(WorkspaceMember.created_at.asc()).all()
    projects = db.query(Project).order_by(Project.created_at.desc()).all()
    canvases = db.query(ProjectCanvas).order_by(ProjectCanvas.created_at.asc()).all()
    uploads = db.query(Upload).order_by(Upload.uploaded_at.desc()).all()
    tags = db.query(Tag).order_by(Tag.name.asc()).all()
    signup_codes = db.query(SignupCode).order_by(SignupCode.created_at.desc()).all()

    message_total = db.query(Message).count()
    messages = (
        db.query(Message)
        .order_by(Message.timestamp.desc())
        .offset(max(message_offset, 0))
        .limit(min(message_limit, 500))
        .all()
    )

    activity_total = db.query(ActivityLog).count()
    activity_logs = (
        db.query(ActivityLog)
        .order_by(ActivityLog.created_at.desc())
        .limit(200)
        .all()
    )

    upload_map = {item.id: item for item in uploads}
    project_map = {item.id: item for item in projects}

    member_counts: dict[str, int] = defaultdict(int)
    members_by_user: dict[str, int] = defaultdict(int)
    for member in members:
        member_counts[member.workspace_id] += 1
        members_by_user[member.user_id] += 1

    projects_by_creator: dict[str, int] = defaultdict(int)
    projects_by_workspace: dict[str, int] = defaultdict(int)
    for project in projects:
        projects_by_creator[project.created_by] += 1
        if project.workspace_id:
            projects_by_workspace[project.workspace_id] += 1

    uploads_by_user: dict[str, int] = defaultdict(int)
    uploads_by_workspace: dict[str, int] = defaultdict(int)
    uploads_by_project: dict[str, int] = defaultdict(int)
    for upload in uploads:
        uploads_by_user[upload.uploaded_by] += 1
        if upload.workspace_id:
            uploads_by_workspace[upload.workspace_id] += 1
        if upload.project_id:
            uploads_by_project[upload.project_id] += 1

    canvases_by_project: dict[str, int] = defaultdict(int)
    for canvas in canvases:
        canvases_by_project[canvas.project_id] += 1

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "users": [
            {
                "id": user.id,
                "username": user.username,
                "email": user.email,
                "role": user.role,
                "is_super_admin": is_super_admin(user),
                "created_at": user.created_at.isoformat() if user.created_at else None,
                "workspace_count": members_by_user.get(user.id, 0),
                "projects_created": projects_by_creator.get(user.id, 0),
                "uploads_count": uploads_by_user.get(user.id, 0),
            }
            for user in users
        ],
        "workspaces": [
            {
                "id": ws.id,
                "name": ws.name,
                "owner_id": ws.owner_id,
                "owner_username": username_map.get(ws.owner_id),
                "owner_email": email_map.get(ws.owner_id),
                "member_count": member_counts.get(ws.id, 0),
                "project_count": projects_by_workspace.get(ws.id, 0),
                "upload_count": uploads_by_workspace.get(ws.id, 0),
                "created_at": ws.created_at.isoformat() if ws.created_at else None,
            }
            for ws in workspaces
        ],
        "workspace_members": [
            {
                "id": member.id,
                "workspace_id": member.workspace_id,
                "workspace_name": ws_map.get(member.workspace_id).name if ws_map.get(member.workspace_id) else None,
                "user_id": member.user_id,
                "username": username_map.get(member.user_id),
                "email": email_map.get(member.user_id),
                "role": member.role,
                "created_at": member.created_at.isoformat() if member.created_at else None,
            }
            for member in members
        ],
        "projects": [
            {
                "id": project.id,
                "name": project.name,
                "workspace_id": project.workspace_id,
                "workspace_name": ws_map.get(project.workspace_id or "").name if project.workspace_id and ws_map.get(project.workspace_id) else None,
                "created_by": project.created_by,
                "created_by_username": username_map.get(project.created_by),
                "created_at": project.created_at.isoformat() if project.created_at else None,
                "canvas_count": canvases_by_project.get(project.id, 0),
                "upload_count": uploads_by_project.get(project.id, 0),
            }
            for project in projects
        ],
        "canvases": [
            {
                **_canvas_summary(canvas),
                "project_name": project_map.get(canvas.project_id).name if project_map.get(canvas.project_id) else None,
                "workspace_id": project_map.get(canvas.project_id).workspace_id if project_map.get(canvas.project_id) else None,
            }
            for canvas in canvases
        ],
        "uploads": [_upload_row(item, username_map) for item in uploads],
        "messages": {
            "total": message_total,
            "offset": message_offset,
            "limit": message_limit,
            "items": [
                {
                    "id": msg.id,
                    "upload_id": msg.upload_id,
                    "upload_file": upload_map.get(msg.upload_id).file_name if upload_map.get(msg.upload_id) else None,
                    "project_id": msg.project_id,
                    "project_name": project_map.get(msg.project_id or "").name if msg.project_id and project_map.get(msg.project_id) else None,
                    "workspace_id": msg.workspace_id,
                    "sender": msg.sender,
                    "timestamp": msg.timestamp.isoformat() if msg.timestamp else None,
                    "type": msg.type,
                    "chat_name": msg.chat_name,
                    "preview": (msg.raw_text or "")[:120],
                    "has_media": bool(msg.extracted_filename or msg.extracted_url),
                }
                for msg in messages
            ],
        },
        "tags": [
            {
                "id": tag.id,
                "workspace_id": tag.workspace_id,
                "workspace_name": ws_map.get(tag.workspace_id).name if ws_map.get(tag.workspace_id) else None,
                "name": tag.name,
                "created_at": tag.created_at.isoformat() if tag.created_at else None,
            }
            for tag in tags
        ],
        "signup_codes": [
            {
                "id": code.id,
                "code": code.code,
                "note": code.note,
                "max_uses": code.max_uses,
                "used_count": code.used_count,
                "revoked": bool(code.revoked),
                "workspace_id": code.workspace_id,
                "workspace_name": ws_map.get(code.workspace_id or "").name if code.workspace_id and ws_map.get(code.workspace_id) else None,
                "created_by": username_map.get(code.created_by),
                "created_at": code.created_at.isoformat() if code.created_at else None,
            }
            for code in signup_codes
        ],
        "activity_logs": {
            "total": activity_total,
            "items": [
                {
                    "id": log.id,
                    "username": log.username,
                    "user_role": log.user_role,
                    "action": log.action,
                    "resource_type": log.resource_type,
                    "resource_name": log.resource_name,
                    "workspace_id": log.workspace_id,
                    "created_at": log.created_at.isoformat() if log.created_at else None,
                }
                for log in activity_logs
            ],
        },
    }
