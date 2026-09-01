#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .env ]; then
  echo "Missing .env — copy deploy/.env.example to .env and edit it."
  exit 1
fi

docker compose build
docker compose up -d
docker compose ps
echo ""
echo "App should be live at: https://${APP_DOMAIN:-$(grep ^APP_DOMAIN= .env | cut -d= -f2)}"
