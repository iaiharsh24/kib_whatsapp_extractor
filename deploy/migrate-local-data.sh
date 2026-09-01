#!/usr/bin/env bash
# Restore local SQLite + uploads into the running Docker volume.
# Run on VPS after copying local_data/ into this repo directory.
set -euo pipefail

if [ ! -d local_data ]; then
  echo "Put your local_data folder in $(pwd) first."
  exit 1
fi

docker compose up -d api
docker compose exec -T api mkdir -p /app/local_data
docker compose cp local_data/. api:/app/local_data/
docker compose restart api web
echo "Data restored. Restart complete."
