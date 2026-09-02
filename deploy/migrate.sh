#!/usr/bin/env bash
# Explicit schema migration only. The API does NOT migrate on boot (WA_AUTO_MIGRATE=0).
#
# Run this ONLY when an operator has explicitly requested a schema migration.
# Usage (on the VPS, from the app directory):
#   ./deploy/migrate.sh
#   ./deploy/migrate.sh head
#   ./deploy/migrate.sh <revision>
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/kib_whatsapp_extractor}"
cd "$APP_DIR"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.postgres.yml)
TARGET="${1:-head}"
BACKUP_HOST_DIR="$(grep '^BACKUP_HOST_DIR=' .env 2>/dev/null | cut -d= -f2- || true)"
BACKUP_HOST_DIR="${BACKUP_HOST_DIR:-/var/backups/kib_whatsapp}"
STAMP="$(date +%Y%m%d_%H%M%S)"

echo "==> Pre-migration safety dump"
mkdir -p "$BACKUP_HOST_DIR/db"
DB_NAME="$(grep '^POSTGRES_DB=' .env | cut -d= -f2-)"
DB_USER="$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)"
docker exec kib_whatsapp_extractor-postgres-1 \
  pg_dump -U "${DB_USER:-whatsapp}" -d "${DB_NAME:-whatsapp}" --clean --if-exists --no-owner \
  | gzip > "$BACKUP_HOST_DIR/db/premigrate_${STAMP}.sql.gz"
echo "  wrote $BACKUP_HOST_DIR/db/premigrate_${STAMP}.sql.gz"

echo "==> Alembic upgrade -> $TARGET (explicit only)"
"${COMPOSE[@]}" exec -T api python - <<PY
from alembic import command
from db import _alembic_config
cfg = _alembic_config()
command.upgrade(cfg, "${TARGET}")
print("migration complete: ${TARGET}")
PY

echo "==> Done. WA_AUTO_MIGRATE remains off for normal boots."
