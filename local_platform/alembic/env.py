"""Alembic environment.

Reuses the application's engine and metadata so migrations target the exact same
database the app runs against (SQLite locally, Postgres in production) and the
exact same model definitions the ORM uses. This keeps Alembic and the models from
drifting apart.
"""
from __future__ import annotations

import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# Make `db` and `app` importable when alembic runs from local_platform/.
_LOCAL_PLATFORM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _LOCAL_PLATFORM not in sys.path:
    sys.path.insert(0, _LOCAL_PLATFORM)

from db import DB_BACKEND, DATABASE_URL, DB_PATH, engine  # noqa: E402
from db.models import Base  # noqa: E402

config = context.config

# Render the URL Alembic should connect with. For Postgres use the DATABASE_URL
# as-is (SQLAlchemy form). For SQLite, build the sqlite URL from WA_DATA_DB_PATH.
if DATABASE_URL:
    config.set_main_option("sqlalchemy.url", DATABASE_URL)
else:
    config.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{DB_PATH}")

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            render_as_batch=(DB_BACKEND == "sqlite"),  # safer ALTERs on SQLite
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
