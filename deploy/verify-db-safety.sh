#!/usr/bin/env bash
set -euo pipefail
cd /root/kib_whatsapp_extractor
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.postgres.yml)

echo "==> seed mirror via backup"
"${COMPOSE[@]}" exec -T api python - <<'PY'
from app.backups import run_backup
s = run_backup(kind="manual", notes="seed mirror db")
print(s.file_name, s.size_bytes)
PY

echo "==> health"
"${COMPOSE[@]}" exec -T api python - <<'PY'
import json, urllib.request
print(json.dumps(json.load(urllib.request.urlopen("http://127.0.0.1:8000/health")), indent=2))
PY

echo "==> ports (5432 must NOT be on host)"
ss -tlnp | grep -E ':5432|:80|:443' || true

echo "==> user counts primary vs mirror"
docker exec kib_whatsapp_extractor-postgres-1 psql -U whatsapp -d whatsapp -tAc 'SELECT count(*) FROM users'
docker exec kib_whatsapp_extractor-postgres_mirror-1 psql -U whatsapp -d whatsapp -tAc 'SELECT count(*) FROM users'

echo "==> flags / boot logs"
grep -E 'WA_AUTO_MIGRATE|WA_DB_MIRROR' .env
"${COMPOSE[@]}" logs api --tail 40 | grep -E '\[db\]|\[backups\]|Schema ready|alembic|migrate|mirror' || true
