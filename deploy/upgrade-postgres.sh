#!/usr/bin/env bash
# Upgrade an existing VPS deployment (pull latest + rebuild), keeping data safe.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/kib_whatsapp_extractor}"
cd "$APP_DIR"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.postgres.yml)
BACKUP_HOST_DIR_DEFAULT="/var/backups/kib_whatsapp"

if [ ! -f .env ]; then
  echo "Missing .env in $APP_DIR"
  exit 1
fi

env_set() {
  # env_set KEY VALUE — append only if the key has no non-empty value yet.
  if ! grep -q "^$1=." .env; then
    echo "$1=$2" >> .env
    echo "  added $1 to .env"
  fi
}

echo "==> Checking .env"
if ! grep -q '^POSTGRES_PASSWORD=.' .env; then
  POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" >> .env
  echo "  Added POSTGRES_PASSWORD to .env (save it): $POSTGRES_PASSWORD"
fi
env_set POSTGRES_DB whatsapp
env_set POSTGRES_USER whatsapp
env_set BACKUP_HOST_DIR "$BACKUP_HOST_DIR_DEFAULT"
chmod 600 .env

BACKUP_HOST_DIR="$(grep '^BACKUP_HOST_DIR=' .env | cut -d= -f2-)"
BACKUP_HOST_DIR="${BACKUP_HOST_DIR:-$BACKUP_HOST_DIR_DEFAULT}"

echo "==> Preparing backup directory: $BACKUP_HOST_DIR"
mkdir -p "$BACKUP_HOST_DIR/db" "$BACKUP_HOST_DIR/files"
chmod 700 "$BACKUP_HOST_DIR"

# Declared `external: true` in docker-compose.postgres.yml so that
# `docker compose down -v` cannot delete them. Creating is a no-op if present.
echo "==> Ensuring data volumes exist"
docker volume create kib_whatsapp_extractor_postgres_data >/dev/null
docker volume create kib_whatsapp_extractor_postgres_mirror_data >/dev/null
docker volume create kib_whatsapp_extractor_app_data >/dev/null

env_set WA_AUTO_MIGRATE 0
env_set WA_DB_MIRROR_ENABLED 1

echo "==> Taking a pre-upgrade safety dump"
if docker ps --format '{{.Names}}' | grep -q '^kib_whatsapp_extractor-postgres-1$'; then
  STAMP="$(date +%Y%m%d_%H%M%S)"
  # shellcheck disable=SC1091
  DB_NAME="$(grep '^POSTGRES_DB=' .env | cut -d= -f2-)"
  DB_USER="$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)"
  docker exec kib_whatsapp_extractor-postgres-1 \
    pg_dump -U "${DB_USER:-whatsapp}" -d "${DB_NAME:-whatsapp}" --clean --if-exists --no-owner \
    | gzip > "$BACKUP_HOST_DIR/db/preupgrade_${STAMP}.sql.gz"
  echo "  wrote $BACKUP_HOST_DIR/db/preupgrade_${STAMP}.sql.gz"
else
  echo "  postgres container not running — skipping"
fi

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Validating compose configuration"
"${COMPOSE[@]}" config >/dev/null

echo "==> Building and starting"
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d
"${COMPOSE[@]}" ps

echo "==> Waiting for the API to report a healthy backup subsystem"
for _ in $(seq 1 45); do
  if "${COMPOSE[@]}" exec -T api python -c "
import json,sys,urllib.request
d=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health'))
sys.exit(0 if d.get('backups',{}).get('healthy') else 1)
" >/dev/null 2>&1; then
    echo "  backups healthy"
    break
  fi
  sleep 4
done

echo ""
echo "Upgrade complete."
echo "  Database : PostgreSQL (external volume kib_whatsapp_extractor_postgres_data)"
echo "  Mirror DB: PostgreSQL snapshot (kib_whatsapp_extractor_postgres_mirror_data)"
echo "  Media    : external volume kib_whatsapp_extractor_app_data"
echo "  Backups  : $BACKUP_HOST_DIR (on the host, outside Docker volumes)"
echo "  Migrate  : ./deploy/migrate.sh  (only when explicitly requested — never on boot)"
echo "  Restore  : ./deploy/restore-postgres.sh <dump.sql.gz>"
