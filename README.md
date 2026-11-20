# Budget Track

A personal, single-user budgeting app that follows YNAB's rules, with PLN as the budget currency. The design is in
[`docs/superpowers/specs/2026-11-19-core-budgeting-design.md`](docs/superpowers/specs/2026-11-19-core-budgeting-design.md).

Status: the budget engine (`src/engine`) and the server foundation are done: database schema, first-run setup, and
sign-in with password + authenticator app. The budgeting API and the phone UI are next.

## Requirements

- Node.js 22 and npm
- Docker. The server tests start Postgres 16 through Testcontainers, and `docker compose` runs the app.

## Run with Docker

```bash
cp .env.example .env   # fill in POSTGRES_PASSWORD, ENCRYPTION_KEY and SETUP_TOKEN
docker compose up -d --build
curl http://localhost:3000/healthz   # {"status":"ok"}
```

Set `APP_PORT` in `.env` if port 3000 is already taken. First-run setup (`/api/auth/setup`) needs the
`SETUP_TOKEN` from `.env`.

## Develop

```bash
npm install
npm test               # all tests (engine + server)
npm run test:engine    # pure engine tests only (no Docker needed)
npm run test:server    # server tests against a throwaway Postgres container
npm run typecheck
npm run lint
npm run dev            # server with reload; reads .env, which then also needs DATABASE_URL
npm run db:generate    # after editing src/server/db/schema.ts: writes a new SQL migration to drizzle/
```

Migrations in `drizzle/` run automatically when the server starts.

### Test containers

Docker Desktop's Enhanced Container Isolation blocks Testcontainers' Ryuk reaper, so it is disabled and the test run
stops its own container. If a run is killed part-way through, remove leftovers with:

```bash
docker rm -f $(docker ps -aq --filter label=org.testcontainers=true)
```

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection URL |
| `ENCRYPTION_KEY` | yes | | 32 random bytes, base64 (`openssl rand -base64 32`); encrypts the authenticator secret |
| `SETUP_TOKEN` | yes | | One-time token for first-run setup (16+ characters) |
| `PORT` | no | `3000` | HTTP port |
| `TZ` | no | `Europe/Warsaw` | Time zone for "today" and month boundaries |
| `COOKIE_SECURE` | no | `true` | Secure flag on the session cookie |
| `TRUST_PROXY` | no | `false` | Take the client IP from `X-Forwarded-For` (behind a reverse proxy only) |
| `LOG_LEVEL` | no | `info` | pino log level |
| `MIGRATIONS_DIR` | no | `drizzle` | Folder with SQL migrations |
