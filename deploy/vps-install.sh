#!/usr/bin/env bash
# One-shot VPS install for Hostinger / Ubuntu.
# Usage (on VPS):
#   curl -fsSL https://raw.githubusercontent.com/iaiharsh24/kib_whatsapp_extractor/main/deploy/vps-install.sh | bash
# Or after cloning:
#   chmod +x deploy/vps-install.sh && ./deploy/vps-install.sh

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/iaiharsh24/kib_whatsapp_extractor.git}"
APP_DIR="${APP_DIR:-$HOME/kib_whatsapp_extractor}"
APP_DOMAIN="${APP_DOMAIN:-app.kibookal.tech}"
ACME_EMAIL="${ACME_EMAIL:-admin@kibookal.tech}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@kibookal.tech}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"

if [ -z "${ADMIN_PASSWORD:-}" ]; then
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 16)"
  GENERATED_PASSWORD=1
fi

if [ -z "${JWT_SECRET:-}" ]; then
  JWT_SECRET="$(openssl rand -hex 32)"
fi

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  GENERATED_DB_PASSWORD=1
fi

POSTGRES_DB="${POSTGRES_DB:-whatsapp}"
POSTGRES_USER="${POSTGRES_USER:-whatsapp}"

echo "==> Installing Docker (if needed)..."
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y git ca-certificates curl
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi

if ! docker compose version >/dev/null 2>&1; then
  sudo apt-get install -y docker-compose-plugin || true
fi

echo "==> Fetching application..."
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

BACKUP_HOST_DIR="${BACKUP_HOST_DIR:-/var/backups/kib_whatsapp}"

echo "==> Writing .env (secrets stay on this server only)..."
cat > .env <<EOF
APP_DOMAIN=$APP_DOMAIN
ACME_EMAIL=$ACME_EMAIL
JWT_SECRET=$JWT_SECRET
POSTGRES_DB=$POSTGRES_DB
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
ADMIN_USERNAME=$ADMIN_USERNAME
BACKUP_HOST_DIR=$BACKUP_HOST_DIR
WA_AUTO_MIGRATE=0
WA_DB_MIRROR_ENABLED=1
EOF
chmod 600 .env

echo "==> Preparing backup directory outside Docker volumes..."
mkdir -p "$BACKUP_HOST_DIR/db" "$BACKUP_HOST_DIR/files"
chmod 700 "$BACKUP_HOST_DIR"

# External volumes survive `docker compose down -v`.
echo "==> Ensuring data volumes exist..."
docker volume create kib_whatsapp_extractor_postgres_data >/dev/null
docker volume create kib_whatsapp_extractor_postgres_mirror_data >/dev/null
docker volume create kib_whatsapp_extractor_app_data >/dev/null

echo "==> Building and starting containers..."
docker compose -f docker-compose.yml -f docker-compose.postgres.yml build
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d

echo "==> Waiting for API..."
for i in $(seq 1 30); do
  if docker compose -f docker-compose.yml -f docker-compose.postgres.yml exec -T api python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo ""
echo "=============================================="
echo " Deploy complete"
echo "=============================================="
echo " URL:      https://$APP_DOMAIN"
echo " Email:    $ADMIN_EMAIL"
if [ "${GENERATED_PASSWORD:-0}" = "1" ]; then
  echo " Password: $ADMIN_PASSWORD  (save this now)"
else
  echo " Password: (value from ADMIN_PASSWORD)"
fi
echo ""
echo " Database: PostgreSQL (Docker volume postgres_data)"
if [ "${GENERATED_DB_PASSWORD:-0}" = "1" ]; then
  echo " DB pass:  $POSTGRES_PASSWORD  (save this now)"
fi
echo " Files:    Docker volume app_data -> uploads + extracted media"
echo " Logs:     docker compose logs -f"
echo " Backups:  $BACKUP_HOST_DIR (hourly DB dumps + append-only media mirror)"
echo " Restore:  ./deploy/restore-postgres.sh <dump.sql.gz>"
echo "=============================================="
