#!/usr/bin/env bash
# Restore the production database from a snapshot produced by the backup system.
#
#   ./deploy/restore-postgres.sh /var/backups/kib_whatsapp/db/snapshot_..._scheduled.sql.gz
#
# Takes a safety dump of the current state first, so a wrong restore is undoable.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/kib_whatsapp_extractor}"
DUMP="${1:-}"

if [ -z "$DUMP" ]; then
  echo "Usage: $0 <dump.sql.gz|dump.sql>"
  echo ""
  echo "Available snapshots:"
  ls -lh "${BACKUP_HOST_DIR:-/var/backups/kib_whatsapp}/db" 2>/dev/null || echo "  (none)"
  exit 1
fi

if [ ! -f "$DUMP" ]; then
  echo "No such file: $DUMP"
  exit 1
fi

cd "$APP_DIR"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.postgres.yml)
DB_NAME="$(grep '^POSTGRES_DB=' .env | cut -d= -f2-)"; DB_NAME="${DB_NAME:-whatsapp}"
DB_USER="$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)"; DB_USER="${DB_USER:-whatsapp}"
BACKUP_HOST_DIR="$(grep '^BACKUP_HOST_DIR=' .env | cut -d= -f2-)"
BACKUP_HOST_DIR="${BACKUP_HOST_DIR:-/var/backups/kib_whatsapp}"

echo "About to OVERWRITE database '$DB_NAME' with:"
echo "  $DUMP  ($(du -h "$DUMP" | cut -f1))"
read -r -p "Type RESTORE to continue: " CONFIRM
if [ "$CONFIRM" != "RESTORE" ]; then
  echo "Aborted."
  exit 1
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
SAFETY="$BACKUP_HOST_DIR/db/prerestore_${STAMP}.sql.gz"
mkdir -p "$BACKUP_HOST_DIR/db"
echo "==> Safety dump of current state -> $SAFETY"
docker exec kib_whatsapp_extractor-postgres-1 \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner | gzip > "$SAFETY"

echo "==> Stopping the API so nothing writes during the restore"
"${COMPOSE[@]}" stop api web

echo "==> Restoring"
if [[ "$DUMP" == *.gz ]]; then
  gunzip -c "$DUMP" | docker exec -i kib_whatsapp_extractor-postgres-1 psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=0
else
  docker exec -i kib_whatsapp_extractor-postgres-1 psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=0 < "$DUMP"
fi

echo "==> Restarting the application"
"${COMPOSE[@]}" start api web

echo "==> Row counts after restore"
docker exec kib_whatsapp_extractor-postgres-1 psql -U "$DB_USER" -d "$DB_NAME" -c \
  "select 'users' t, count(*) from users
   union all select 'workspaces', count(*) from workspaces
   union all select 'projects', count(*) from projects
   union all select 'uploads', count(*) from uploads
   union all select 'messages', count(*) from messages;"

echo ""
echo "Restore complete. Previous state saved at: $SAFETY"
echo "Media files were untouched. Recover deleted media from: $BACKUP_HOST_DIR/files"
