# Deploying to the Oracle VM (next to progress-dashboard)

Budget Track runs on the same Always Free OCI VM as progress-dashboard, at **https://budget-track.duckdns.org**:

```
Internet ─443─▶ nginx container (progress-dashboard, owns 80/443, Let's Encrypt certs)
                 ├── progress-dashboard.duckdns.org ─▶ progress frontend / backend
                 └── budget-track.duckdns.org ───────▶ "budget" (this app) on the shared "edge" network
```

- Own stack (compose project `budget-track`) with its own Postgres; data in `/data/budget-track/pgdata` on the block
  volume, daily `pg_dump` to `/data/budget-track/backups` (14 kept).
- Code in `/opt/budget-track` (a git clone); `.env` and `secrets/` live there too and are git-ignored.
- `deploy.sh` copies `nginx-budget.conf` into the **running** nginx container and connects it to `edge`. If
  progress-dashboard ever recreates its nginx container, the budget site disappears until you run `deploy.sh` again.
  Its upstream resolves per request, so nginx starts fine even while the budget app is down.

## Before the first deploy

1. **DuckDNS**: add the subdomain `budget-track` (same account as progress-dashboard). `deploy.sh` points it at the VM.
2. **Enable Banking**: add `https://budget-track.duckdns.org/api/bank/callback` to the application's redirect URLs.

## First deploy (on the VM)

```bash
ssh ubuntu@<VM_IP>

# 1. A read-only deploy key, so the VM can clone the private repo
ssh-keygen -t ed25519 -N "" -C "budget-track VM" -f ~/.ssh/budget_track_deploy
cat >> ~/.ssh/config <<'EOF'
Host github-budget-track
  HostName github.com
  User git
  IdentityFile ~/.ssh/budget_track_deploy
  IdentitiesOnly yes
EOF
cat ~/.ssh/budget_track_deploy.pub
#    → GitHub: budget-track → Settings → Deploy keys → Add deploy key (read-only), paste it

# 2. Clone
sudo mkdir -p /opt/budget-track && sudo chown ubuntu:ubuntu /opt/budget-track
git clone github-budget-track:oleksii-v-bondar/budget-track.git /opt/budget-track

# 3. The Enable Banking key: paste the .pem contents, save (Ctrl+O, Enter, Ctrl+X)
mkdir -p /opt/budget-track/secrets && nano /opt/budget-track/secrets/enablebanking.pem

# 4. Deploy (asks for the sign-in username/password and the Enable Banking app id the first time)
cd /opt/budget-track && sudo bash deploy/oracle/deploy.sh
```

The first run takes a few minutes (it builds the image on the VM, issues the TLS certificate, wires nginx) and ends
with `=== Live at https://budget-track.duckdns.org ===`.

## Update

```bash
cd /opt/budget-track && git pull && sudo bash deploy/oracle/deploy.sh
```

Change the password later with `sudo APP_PASSWORD='…' bash deploy/oracle/deploy.sh` (it rewrites `.env` and
restarts the app).

## Operations

```bash
cd /opt/budget-track
sudo docker compose -f deploy/oracle/docker-compose.yml --env-file .env ps
sudo docker compose -f deploy/oracle/docker-compose.yml --env-file .env logs -f app
sudo /usr/local/bin/budget-backup.sh                      # backup now
gunzip -c /data/budget-track/backups/<file>.sql.gz | \
  sudo docker compose -f deploy/oracle/docker-compose.yml --env-file .env exec -T db psql -U budget budget   # restore
```
