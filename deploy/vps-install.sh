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

echo "==> Writing .env (secrets stay on this server only)..."
cat > .env <<EOF
APP_DOMAIN=$APP_DOMAIN
ACME_EMAIL=$ACME_EMAIL
JWT_SECRET=$JWT_SECRET
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
ADMIN_USERNAME=$ADMIN_USERNAME
EOF
chmod 600 .env

echo "==> Building and starting containers..."
docker compose build
docker compose up -d

echo "==> Waiting for API..."
for i in $(seq 1 30); do
  if docker compose exec -T api python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')" >/dev/null 2>&1; then
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
echo " Database: Docker volume app_data -> /app/local_data/strategy.db"
echo " Logs:     docker compose logs -f"
echo " Backup:   docker compose exec api tar -czf - -C /app local_data > backup.tar.gz"
echo "=============================================="
