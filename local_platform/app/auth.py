"""JWT auth for the internal team (admin / member)."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from db import get_db
from db.models import User

SECRET = os.getenv("JWT_SECRET", "whatsapp-strategy-local-secret-key")
ALGO = "HS256"
TOKEN_HOURS = 72
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)


def hash_password(plain: str) -> str:
    return pwd.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd.verify(plain, hashed)


SUPER_ADMIN_EMAILS = {
    email.strip().lower()
    for email in os.getenv("SUPER_ADMIN_EMAILS", "harsh.jaiswal@anibrain.com").split(",")
    if email.strip()
}


def is_super_admin(user: User | None) -> bool:
    if not user:
        return False
    if user.role == "superadmin":
        return True
    return user.role == "admin" and bool(user.email and user.email.lower() in SUPER_ADMIN_EMAILS)


def make_token(user: User) -> str:
    # Never put superadmin in the JWT payload — role is always resolved from the DB.
    role = "admin" if is_super_admin(user) else user.role
    payload = {
        "sub": user.id,
        "username": user.username,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_HOURS),
    }
    return jwt.encode(payload, SECRET, algorithm=ALGO)


def user_from_token(token: str | None, db: Session) -> User:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in required")
    try:
        payload = jwt.decode(token, SECRET, algorithms=[ALGO])
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    user = db.query(User).filter(User.id == payload.get("sub")).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    return user_from_token(creds.credentials if creds else None, db)


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role not in {"admin", "superadmin"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return user


def super_admin_user_ids(db: Session) -> set[str]:
    return {item.id for item in db.query(User).all() if is_super_admin(item)}


def require_super_admin(user: User = Depends(get_current_user)) -> User:
    if not is_super_admin(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")
    return user


def serialize_user(user: User, *, viewer: User | None = None) -> dict:
    """Serialize a user for API responses.

    Super-admin identity is only exposed to the account owner or other super admins.
    Everyone else sees super admins as regular admins, or not at all in list endpoints.
    """
    subject = viewer or user
    viewer_super = is_super_admin(subject)
    target_super = is_super_admin(user)
    expose_super = viewer_super and (subject.id == user.id or target_super)

    role = user.role
    if target_super and not expose_super:
        role = "admin"

    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "role": role,
        "is_super_admin": bool(target_super and expose_super),
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


def visible_users_for_admin(db: Session, viewer: User) -> list[User]:
    users = db.query(User).order_by(User.username.asc()).all()
    if is_super_admin(viewer):
        return users
    return [item for item in users if not is_super_admin(item)]


def assert_user_manageable(target: User, viewer: User) -> None:
    """Hide super-admin accounts from non-super viewers (404, not 403)."""
    if is_super_admin(target) and not is_super_admin(viewer):
        raise HTTPException(status_code=404, detail="User not found")
