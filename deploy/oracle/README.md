# Deploying to the Oracle VM (next to progress-dashboard)

Budget Track runs on the same Always Free OCI VM as progress-dashboard, at **https://budget-track.duckdns.org**:

```
Internet ─443─▶ nginx container (progress-dashboard, owns 80/443, Let's Encrypt certs)
                 ├── progress-dashboard.duckdns.org ─▶ progress frontend / backend
                 └── budget-track.duckdns.org ───────▶ "budget" (this app) on the shared "edge" network
```

- Own stack (compose project `budget-track`) with its own Postgres; data in `/data/budget-track/pgdata` on the block
  volume, daily `pg_dump` to `/data/budget-track/backups` (14 kept).
- Code and config in `/opt/budget-track` (`.env` and `secrets/` are created there and never overwritten by deploys).
- `deploy.sh` copies `nginx-budget.conf` into the **running** nginx container and connects it to `edge`. If
  progress-dashboard ever recreates its nginx container, the budget site disappears until the next budget deploy
  (re-run the workflow). Its upstream resolves per request, so nginx starts fine even while the budget app is down.

## One-time setup

1. **DuckDNS**: add the subdomain `budget-track` (same account as progress-dashboard). `deploy.sh` points it at the VM.
2. **Enable Banking**: add `https://budget-track.duckdns.org/api/bank/callback` to the application's redirect URLs.
3. **GitHub secrets** (repo → Settings → Secrets and variables → Actions):

   | Secret | Value |
   |---|---|
   | `SERVER_IP` | the VM's public IP (same as progress-dashboard) |
   | `SSH_PRIVATE_KEY` | the private SSH key for `ubuntu@VM` (same as progress-dashboard) |
   | `APP_USERNAME`, `APP_PASSWORD` | the app's sign-in |
   | `ENABLE_BANKING_APP_ID` | the Enable Banking application id |
   | `ENABLE_BANKING_KEY` | the full contents of the application's `.pem` file |

## Deploy

Every push to `main` deploys (or run **Actions → Deploy → Run workflow**). The workflow copies the code to the VM and
runs `deploy/oracle/deploy.sh`, which (idempotently) writes `.env`/`secrets/`, starts the stack, updates DuckDNS,
issues the TLS certificate on first run, wires nginx, installs the backup cron and checks `/healthz`.

### By hand (SSH from a network that allows it)

```bash
# from your machine, in the repo
git archive --format=tar.gz -o /tmp/budget-track.tgz HEAD
scp /tmp/budget-track.tgz ubuntu@<VM_IP>:/tmp/
ssh ubuntu@<VM_IP>
# on the VM
sudo mkdir -p /opt/budget-track && sudo tar -xzf /tmp/budget-track.tgz -C /opt/budget-track
sudo APP_USERNAME=admin APP_PASSWORD='…' ENABLE_BANKING_APP_ID='…' \
  ENABLE_BANKING_KEY="$(cat /path/to/enablebanking.pem)" bash /opt/budget-track/deploy/oracle/deploy.sh
```

## Operations

```bash
cd /opt/budget-track
sudo docker compose -f deploy/oracle/docker-compose.yml --env-file .env ps
sudo docker compose -f deploy/oracle/docker-compose.yml --env-file .env logs -f app
sudo /usr/local/bin/budget-backup.sh                      # backup now
gunzip -c /data/budget-track/backups/<file>.sql.gz | \
  sudo docker compose -f deploy/oracle/docker-compose.yml --env-file .env exec -T db psql -U budget budget   # restore
```
