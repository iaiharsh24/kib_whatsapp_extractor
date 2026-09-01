"""Persist user activity for the admin audit log."""
from __future__ import annotations

from sqlalchemy.orm import Session

from db.models import ActivityLog, User

SUPER_ADMIN_ONLY_ACTIONS = frozenset(
    {
        "db.snapshot.create",
        "admin.user.export",
    }
)


def log_activity(
    db: Session,
    user: User | None,
    action: str,
    *,
    resource_type: str | None = None,
    resource_id: str | None = None,
    resource_name: str | None = None,
    workspace_id: str | None = None,
    details: dict | None = None,
) -> ActivityLog | None:
    try:
        row = ActivityLog(
            user_id=user.id if user else None,
            username=(user.email or user.username) if user else "system",
            user_role=user.role if user else None,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            resource_name=resource_name,
            workspace_id=workspace_id,
            details=details or {},
        )
        db.add(row)
        return row
    except Exception as exc:
        print(f"[activity] could not log {action}: {exc}")
        return None


def serialize_activity_log(row: ActivityLog, *, viewer_super: bool = False) -> dict:
    user_role = row.user_role
    if user_role == "superadmin" and not viewer_super:
        user_role = "admin"
    details = dict(row.details or {})
    if not viewer_super:
        if details.get("role") == "superadmin":
            details["role"] = "admin"
    return {
        "id": row.id,
        "user_id": row.user_id,
        "username": row.username,
        "user_role": user_role,
        "action": row.action,
        "resource_type": row.resource_type,
        "resource_id": row.resource_id,
        "resource_name": row.resource_name,
        "workspace_id": row.workspace_id,
        "details": details,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def activity_visible_to_viewer(row: ActivityLog, viewer: User | None, actor: User | None) -> bool:
    from app.auth import is_super_admin

    if viewer and is_super_admin(viewer):
        return True
    if row.action in SUPER_ADMIN_ONLY_ACTIONS or str(row.action or "").startswith("db."):
        return False
    if row.user_role == "superadmin":
        return False
    details = row.details if isinstance(row.details, dict) else {}
    if details.get("role") == "superadmin":
        return False
    if actor and is_super_admin(actor):
        return False
    return True
