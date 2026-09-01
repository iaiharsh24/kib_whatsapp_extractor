"""baseline: capture the full current schema under Alembic.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-09-01

This is the adoption revision. Before it, schema evolution was a set of hand-rolled
ALTER TABLE / CREATE TABLE blocks that ran on every boot (`_ensure_columns` and
the `_migrate_*` family in db/__init__.py), with no version stamp and no rollback.
That meant every restart re-scanned every row and re-issued no-op UPDATEs, and a
bug in that logic would silently re-fire on every deploy.

This baseline delegates to Base.metadata.create_all so the migration always
matches the ORM models exactly (no drift between Alembic and the models). Existing
databases are *stamped* to this revision on first boot (see db/__init__.py
create_tables), so the create_all here only ever runs against a genuinely empty
database (a fresh dev clone or a brand-new prod volume). New schema changes from
here on are separate Alembic revisions building on top of this one.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

# Import Base lazily inside upgrade()/downgrade() so `alembic` CLI invocations
# that don't need the app still work, and so import order is predictable.
revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    from db.models import Base

    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    from db.models import Base

    Base.metadata.drop_all(bind=op.get_bind())
