#!/usr/bin/env bash
# Upgrade an existing VPS deployment (pull latest + rebuild).
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/kib_whatsapp_extractor}"
cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing .env in $APP_DIR"
  exit 1
fi

if ! grep -q '^POSTGRES_PASSWORD=.' .env; then
  POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" >> .env
  echo "Added POSTGRES_PASSWORD to .env (save it): $POSTGRES_PASSWORD"
fi

if ! grep -q '^POSTGRES_DB=' .env; then
  echo "POSTGRES_DB=whatsapp" >> .env
fi
if ! grep -q '^POSTGRES_USER=' .env; then
  echo "POSTGRES_USER=whatsapp" >> .env
fi

git pull --ff-only
docker compose -f docker-compose.yml -f docker-compose.postgres.yml build
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
docker compose ps

echo ""
echo "Upgrade complete. PostgreSQL stores users, workspaces, projects, and messages."
echo "Upload files remain in the app_data volume."
