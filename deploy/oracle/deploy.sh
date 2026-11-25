#!/usr/bin/env bash
# Deploys Budget Track on the Oracle VM next to progress-dashboard (deploy/oracle/README.md). Idempotent: safe to
# re-run on every deploy. Run as root from anywhere inside the app directory (normally /opt/budget-track):
#
#   sudo DOMAIN=budget-track.duckdns.org APP_USERNAME=... APP_PASSWORD=... bash deploy/oracle/deploy.sh
#
# Optional env: ENABLE_BANKING_APP_ID, ENABLE_BANKING_KEY (the .pem contents). Values given here are written to
# .env / secrets/; values left empty keep what is already there.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"
DOMAIN="${DOMAIN:-budget-track.duckdns.org}"
SUBDOMAIN="${DOMAIN%%.duckdns.org}"
COMPOSE=(docker compose -f deploy/oracle/docker-compose.yml --env-file .env)

log() { echo "=== $* ==="; }

# ── 1. .env (generated once; secrets from the environment override) ──────────────────────────────────────────────
set_kv() { # set_kv KEY VALUE: replace or append KEY=VALUE in .env
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" .env > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}
touch .env
chmod 600 .env
grep -q '^POSTGRES_PASSWORD=' .env || set_kv POSTGRES_PASSWORD "$(openssl rand -hex 24)"
set_kv DOMAIN "$DOMAIN"
[ -n "${APP_USERNAME:-}" ] && set_kv APP_USERNAME "$APP_USERNAME"
[ -n "${APP_PASSWORD:-}" ] && set_kv APP_PASSWORD "$APP_PASSWORD"
[ -n "${ENABLE_BANKING_APP_ID:-}" ] && set_kv ENABLE_BANKING_APP_ID "$ENABLE_BANKING_APP_ID"
for key in APP_USERNAME APP_PASSWORD; do
  grep -q "^${key}=." .env || { echo "error: $key is not set (pass it in the environment once)" >&2; exit 1; }
done

# ── 2. Enable Banking key (read by the container's node user, uid 1000) ──────────────────────────────────────────
mkdir -p secrets
if [ -n "${ENABLE_BANKING_KEY:-}" ]; then
  printf '%s\n' "$ENABLE_BANKING_KEY" > secrets/enablebanking.pem
fi
chown -R 1000:1000 secrets
chmod 700 secrets
[ -f secrets/enablebanking.pem ] && chmod 600 secrets/enablebanking.pem

# ── 3. Start the stack ──────────────────────────────────────────────────────────────────────────────────────────
log "Starting the stack"
mkdir -p /data/budget-track/pgdata
docker network create edge >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build --remove-orphans

# ── 4. DuckDNS: point the subdomain here (the token is the one progress-dashboard's certbot uses) ─────────────────
TOKEN="$(sed -n 's/^dns_duckdns_token *= *//p' /etc/duckdns-certbot.ini)"
[ -n "$TOKEN" ] || { echo "error: no DuckDNS token in /etc/duckdns-certbot.ini" >&2; exit 1; }
log "DuckDNS update for $SUBDOMAIN: $(curl -s "https://www.duckdns.org/update?domains=${SUBDOMAIN}&token=${TOKEN}&ip=")"
if [ -f /usr/local/bin/duckdns-update.sh ] && ! grep -q "$SUBDOMAIN" /usr/local/bin/duckdns-update.sh; then
  sed -i "s/^SUBDOMAIN=\"\(.*\)\"/SUBDOMAIN=\"\1,${SUBDOMAIN}\"/" /usr/local/bin/duckdns-update.sh
fi

# ── 5. TLS certificate (renewed by the existing certbot cron) ───────────────────────────────────────────────────
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  log "Issuing a certificate for $DOMAIN"
  certbot certonly --authenticator dns-duckdns \
    --dns-duckdns-credentials /etc/duckdns-certbot.ini --dns-duckdns-propagation-seconds 60 \
    -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" --no-eff-email
fi

# ── 6. Route the domain through progress-dashboard's nginx ──────────────────────────────────────────────────────
NGINX="$(docker ps -q --filter label=com.docker.compose.service=nginx | head -n 1)"
[ -n "$NGINX" ] || { echo "error: progress-dashboard's nginx container is not running" >&2; exit 1; }
docker network connect edge "$NGINX" >/dev/null 2>&1 || true
CONF="$(mktemp)"
sed "s/DOMAIN_PLACEHOLDER/${DOMAIN}/g" deploy/oracle/nginx-budget.conf > "$CONF"
docker cp "$CONF" "$NGINX:/etc/nginx/conf.d/budget.conf"
rm -f "$CONF"
if docker exec "$NGINX" nginx -t; then
  docker exec "$NGINX" nginx -s reload
else
  # Never leave a config behind that would stop nginx (and progress-dashboard) from starting.
  docker exec "$NGINX" rm -f /etc/nginx/conf.d/budget.conf
  echo "error: nginx rejected the budget site config; removed it" >&2
  exit 1
fi

# ── 7. Daily database backup on the block volume (14 kept) ──────────────────────────────────────────────────────
cat > /usr/local/bin/budget-backup.sh <<BACKUP
#!/bin/bash
set -euo pipefail
mkdir -p /data/budget-track/backups
cd "$APP_DIR"
docker compose -f deploy/oracle/docker-compose.yml --env-file .env exec -T db pg_dump -U budget budget \\
  | gzip > "/data/budget-track/backups/budget-\$(date +%Y%m%d-%H%M%S).sql.gz"
ls -1t /data/budget-track/backups/budget-*.sql.gz | tail -n +15 | xargs -r rm -f
BACKUP
chmod +x /usr/local/bin/budget-backup.sh
if ! crontab -l 2>/dev/null | grep -q budget-backup.sh; then
  (crontab -l 2>/dev/null || true; echo "30 2 * * * /usr/local/bin/budget-backup.sh >> /var/log/budget-backup.log 2>&1") | crontab -
fi

# ── 8. Check ────────────────────────────────────────────────────────────────────────────────────────────────────
log "Waiting for the app"
for _ in $(seq 1 60); do
  if curl -skf --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" >/dev/null; then
    log "Live at https://$DOMAIN"
    exit 0
  fi
  sleep 5
done
"${COMPOSE[@]}" ps
"${COMPOSE[@]}" logs --tail 50 app
echo "error: https://$DOMAIN/healthz did not answer" >&2
exit 1
