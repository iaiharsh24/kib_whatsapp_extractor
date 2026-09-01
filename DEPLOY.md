# VPS deployment (Docker)

Deploy the WhatsApp Strategy Canvas to a Hostinger KVM VPS with Docker Compose, Caddy (HTTPS), and persistent SQLite storage.

## Stack summary

| Item | Value |
|------|--------|
| Tool type | Internal web app (library + strategy canvas) |
| Backend | Python 3.11, FastAPI, Uvicorn |
| Frontend | Next.js 16 (React) |
| Database | PostgreSQL 16 (`postgres_data` volume) + files in `app_data` |
| API port (internal) | 8000 |
| Web port (internal) | 3000 |
| Public ports | 80, 443 (Caddy) |
| Suggested domain | `app.kibookal.tech` |

Default login after first deploy: `admin@local` / `admin123` — change the password immediately.

## 1. DNS

In your domain DNS (kibookal.tech), add an **A record**:

```
app  →  <your VPS public IP>
```

Wait a few minutes for propagation before starting HTTPS.

## 2. VPS prerequisites

On the VPS (Web Terminal or SSH):

```bash
sudo apt update
sudo apt install -y git docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

Log out and back in so the `docker` group applies.

## 3. Get the code (GitHub — recommended)

Create a **private** GitHub repository, push this project from your PC, then clone on the VPS. Do **not** commit `.env`, passwords, API keys, `node_modules`, `.venv`, or `local_data/`.

### On your PC (first time)

```bash
cd whatsapp-platform-local1
git init -b main
git add .
git status   # confirm no .env, local_data, or node_modules are staged
git commit -m "Initial commit: WhatsApp Strategy Canvas"
gh repo create whatsapp-strategy-canvas --private --source=. --remote=origin --push
```

If you prefer the GitHub website: create an empty private repo, then:

```bash
git remote add origin git@github.com:<your-user>/whatsapp-strategy-canvas.git
git push -u origin main
```

### Deploy key (private repo on VPS)

On the **VPS only** (read-only access to this one repo):

```bash
ssh-keygen -t ed25519 -C "vps-deploy-whatsapp" -f ~/.ssh/github_whatsapp_deploy -N ""
cat ~/.ssh/github_whatsapp_deploy.pub
```

Copy the public key → GitHub repo → **Settings → Deploy keys → Add deploy key** (read-only, no write access).

Then on the VPS:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-whatsapp
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_whatsapp_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

cd ~
git clone git@github-whatsapp:<your-user>/whatsapp-strategy-canvas.git whatsapp-platform
cd whatsapp-platform
```

### Redeploy after updates

```bash
cd ~/whatsapp-platform
git pull
docker compose build
docker compose up -d
```

**Option B — Zip archive** (not recommended; use only if Git is unavailable)

Upload a zip of the project to the VPS, then:

```bash
cd ~
unzip whatsapp-platform.zip -d whatsapp-platform
cd whatsapp-platform
```

Do not include `node_modules`, `.venv`, `.env`, or `local_data` in the zip.

## 4. Environment file (create only on the VPS)

Never copy `.env` from your PC. Create it fresh on the server:

```bash
cp deploy/.env.example .env
nano .env
```

Set:

```env
APP_DOMAIN=app.kibookal.tech
ACME_EMAIL=you@kibookal.tech
JWT_SECRET=<long-random-secret>
POSTGRES_PASSWORD=<strong-db-password>
ADMIN_EMAIL=admin@kibookal.tech
ADMIN_PASSWORD=<strong-app-password>
ADMIN_USERNAME=admin
```

Generate a secret:

```bash
openssl rand -hex 32
```

## 5. Build and start

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f caddy
```

First HTTPS certificate issuance can take 1–2 minutes. Open:

```
https://app.kibookal.tech
```

Health check (via proxy):

```
https://app.kibookal.tech/health
```

## 6. Migrate existing local data (optional)

If you already have a local SQLite DB and uploads:

```bash
# On your PC, copy local_data to the VPS
scp -r local_data user@<vps-ip>:~/whatsapp-platform/

# On the VPS, seed the Docker volume once
docker compose up -d api
docker compose cp local_data/. api:/app/local_data/
docker compose restart api web
```

## 7. Operations

```bash
# View logs
docker compose logs -f api
docker compose logs -f web

# Restart after code update (existing VPS)
git pull
chmod +x deploy/upgrade-postgres.sh
./deploy/upgrade-postgres.sh

# Backup PostgreSQL + uploads (run on VPS)
docker compose exec -T postgres pg_dump -U whatsapp whatsapp > db-backup-$(date +%F).sql
docker compose exec api tar -czf - -C /app local_data > files-backup-$(date +%F).tar.gz
```

Enable **daily** backups in hPanel: VPS → Backups → Backup schedule → Daily.

## 8. Firewall

Allow only what you need:

- TCP 22 (SSH)
- TCP 80, 443 (web)

Do not expose 8000 or 3000 publicly; Caddy is the only public entry point.

## Data model (per user)

- Each **user** gets a private workspace on first login (or when an admin creates their account).
- **Workspaces** isolate uploads, messages, projects, tags, and canvas data.
- Users can also join shared workspaces via **invite links**.
- PostgreSQL stores relational data; uploaded files and extracted media stay in the `app_data` volume.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Certificate error | Confirm DNS A record points to VPS; ports 80/443 open |
| 502 from Caddy | `docker compose logs web api` — wait for API healthcheck |
| Upload fails | Large zips supported (2GB proxy limit); check disk space on VPS |
| Empty library | Ensure `app_data` volume is mounted; check `docker compose exec api ls -la /app/local_data` |

## Hostinger Docker Manager

If using hPanel Docker Manager instead of CLI:

1. Upload project or connect Git.
2. Use the root `docker-compose.yml`.
3. Set environment variables from `.env`.
4. Map ports 80 and 443 to the `caddy` service only.
