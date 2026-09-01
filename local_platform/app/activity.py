"""Persist user activity for the admin audit log."""
from __future__ import annotations

from sqlalchemy.orm import Session

from db.models import ActivityLog, User


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


def serialize_activity_log(row: ActivityLog) -> dict:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "username": row.username,
        "user_role": row.user_role,
        "action": row.action,
        "resource_type": row.resource_type,
        "resource_id": row.resource_id,
        "resource_name": row.resource_name,
        "workspace_id": row.workspace_id,
        "details": row.details or {},
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }
