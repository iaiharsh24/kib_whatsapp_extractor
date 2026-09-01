"""Workspace helpers for per-user data isolation."""
from sqlalchemy.orm import Session

from db.models import Workspace, WorkspaceMember, User


def user_has_workspace(db: Session, user_id: str) -> bool:
    return (
        db.query(WorkspaceMember.id)
        .filter(WorkspaceMember.user_id == user_id)
        .first()
        is not None
    )


def ensure_personal_workspace(db: Session, user: User, *, name: str | None = None) -> Workspace:
    """Create a private workspace for a user when they have none."""
    member = db.query(WorkspaceMember).filter(WorkspaceMember.user_id == user.id).first()
    if member:
        workspace = db.query(Workspace).filter(Workspace.id == member.workspace_id).first()
        if workspace:
            return workspace

    label = (name or "").strip() or f"{user.username}'s workspace"
    workspace = Workspace(name=label, owner_id=user.id)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    db.flush()
    return workspace
