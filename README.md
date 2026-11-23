# Budget Track

A personal, single-user budgeting app that follows YNAB's rules, with PLN as the budget currency. The design is in
[`docs/superpowers/specs/2026-11-19-core-budgeting-design.md`](docs/superpowers/specs/2026-11-19-core-budgeting-design.md).

Status: the budget engine (`src/engine`), the server API and the web app's foundation are done. The server covers
sign-in, accounts (with NBP exchange rates, revaluation, reconciliation and loans), categories, the budget with
targets and auto-assign, payees and transactions. The web app is an installable phone web app with sign-in and
Settings (sign out). The budget, accounts and transaction screens are next.

## Requirements

- Node.js 22 and npm
- Docker. The server tests start Postgres 16 through Testcontainers, and `docker compose` runs the app.
- For the end-to-end test only: Playwright's Chromium (`npx playwright install chromium`).

## Run with Docker

```bash
cp .env.example .env   # set APP_USERNAME, APP_PASSWORD and POSTGRES_PASSWORD
docker compose up -d --build
```

Then open http://localhost:3000 and sign in with `APP_USERNAME` and `APP_PASSWORD`. Set `APP_PORT` in `.env` if
port 3000 is already taken.

The port is bound to 127.0.0.1 only. For remote access, put an HTTPS reverse proxy (e.g. Caddy) in front.

## Develop

```bash
npm install
npm test               # all tests (engine + server + web)
npm run test:engine    # pure engine tests only (no Docker needed)
npm run test:server    # server tests against a throwaway Postgres container
npm run test:web       # web app component tests (jsdom, no Docker needed)
npm run test:e2e       # builds, then runs the Playwright smoke test against the built app and a throwaway Postgres
npm run typecheck      # server and web
npm run lint
npm run build          # dist/web (the PWA) and dist/server
npm run dev            # server with reload; reads .env, which then also needs DATABASE_URL
npm run dev:web        # the web app with hot reload on http://localhost:5173; /api goes to `npm run dev`
npm run db:generate    # after editing src/server/db/schema.ts: writes a new SQL migration to drizzle/
npm run icons          # after editing scripts/generate-icons.ts: writes the app icons to src/web/public
```

For the web app, run `npm run dev` with `PORT=3080` in `.env` (the port `npm run dev:web` forwards `/api` to; set
`API_PROXY_TARGET` for another one) and open http://localhost:5173. A built server (`npm run build && npm start`)
serves the web app itself from `dist/web`.

`npm run dev` needs your own Postgres 16, e.g.
`docker run -d -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=dev postgres:16-alpine` and
`DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres`.

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
| `APP_USERNAME` | yes | | The username you sign in with |
| `APP_PASSWORD` | yes | | The password you sign in with |
| `PORT` | no | `3000` | HTTP port |
| `TZ` | no | `Europe/Warsaw` | Time zone for "today" and month boundaries |
| `COOKIE_SECURE` | no | `true` | Secure flag on the session cookie |
| `LOG_LEVEL` | no | `info` | pino log level |
| `MIGRATIONS_DIR` | no | `drizzle` | Folder with SQL migrations |
| `NBP_BASE_URL` | no | `https://api.nbp.pl` | NBP exchange-rate API for foreign-currency accounts (outbound HTTPS) |
| `WEB_DIR` | no | `dist/web` | Folder with the built web app (`npm run build:web`); without it only the API is served |
