#!/usr/bin/env bash
# Recover a broken VPS deployment (restore SQLite-backed API).
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/kib_whatsapp_extractor}"
cd "$APP_DIR"

echo "==> Pulling latest code..."
git pull --ff-only

if [ -f .env ]; then
  # Stop API from pointing at a missing/broken Postgres instance.
  sed -i '/^DATABASE_URL=/d' .env || true
fi

echo "==> Stopping containers..."
docker compose down || true
docker compose -f docker-compose.yml -f docker-compose.postgres.yml down 2>/dev/null || true

echo "==> Rebuilding with SQLite (default)..."
docker compose build
docker compose up -d
docker compose ps

echo ""
echo "==> Waiting for API..."
for i in $(seq 1 30); do
  if docker compose exec -T api python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')" >/dev/null 2>&1; then
    echo "API is healthy."
    exit 0
  fi
  sleep 2
done

echo "API did not become healthy. Check: docker compose logs api"
exit 1
