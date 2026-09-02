FROM python:3.11-slim

WORKDIR /app/local_platform

# pg_dump must match the Postgres server major version, and Debian's own repos
# track a different one, so take it from PGDG. The suite is derived from the base
# image rather than hardcoded, because the python:3.11-slim base changes releases.
# `pg_dump --version` fails the build if the client is ever missing, which is how
# backups silently broke before.
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends gcc ca-certificates curl gnupg; \
  . /etc/os-release; \
  install -d /usr/share/postgresql-common/pgdg; \
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends postgresql-client-16; \
  pg_dump --version; \
  rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1
ENV WA_DATA_DB_PATH=/app/local_data/strategy.db

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
