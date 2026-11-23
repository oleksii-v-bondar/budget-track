# Budget Track

A personal, single-user budgeting app that follows YNAB's rules, with PLN as the budget currency. The design is in
[`docs/superpowers/specs/2026-11-19-core-budgeting-design.md`](docs/superpowers/specs/2026-11-19-core-budgeting-design.md).

Status: the budget engine (`src/engine`), the server API and the web app's YNAB screens are done. The web app is an
installable phone web app (Budget · Accounts · ＋ · Settings):

- **Budget**: month switcher; Ready to Assign with its breakdown and Auto-assign; filter chips; category groups with
  Available pills and a hidden section; a note per month. A category's sheet assigns with a calculator keypad, moves
  money, sets a target, lists the activity, keeps a note and hides the category. Credit card payment categories show
  what paying the card in full needs. Edit mode adds, renames, reorders, hides and deletes groups and categories.
- **Accounts**: cash, credit and tracking accounts in PLN or another currency (shown also as ≈ PLN at the latest NBP
  rate), grouped with totals; add, edit, close (with an adjustment), reopen and delete.
- **Register**: per account or all accounts, with balances, rows by date, search, filters, bulk changes, reconcile,
  and revalue for foreign accounts.
- **Transactions**: outflow/inflow with a keypad, payee autocomplete (new payees and transfers), category, date, memo,
  flag, cleared, FX rate and splits. A date after today saves it as a one-time scheduled transaction.
- **Bank connections** (optional): Revolut, PKO BP and other banks through Mastercard Open Banking; imported
  transactions wait for approval in the register.
- Undo and redo of every change; sign-in with a username and password.

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

## Bank connections (Mastercard Open Banking / Aiia)

Optional. Budget Track imports booked transactions through the Aiia Data API.

1. Create an app in the Aiia (Mastercard Open Banking) console and register its redirect URL: the value of
   `AIIA_REDIRECT_URI`, this server's `/api/bank/callback` as your browser reaches it (e.g.
   `http://localhost:3000/api/bank/callback` with Docker). Production apps may need a public HTTPS URL: serve the app
   through your HTTPS reverse proxy and register e.g. `https://budget.example.com/api/bank/callback`.
2. Set `AIIA_CLIENT_ID`, `AIIA_CLIENT_SECRET` and `AIIA_REDIRECT_URI` in `.env` (`AIIA_BASE_URL` defaults to
   production, `https://api.aiia.eu`; the sandbox is `https://api-sandbox.aiia.eu`), then restart the app. Without the
   client id and secret, Settings doesn't show bank connections.
3. **Connect**: Settings → Bank connections → Connect bank, then connect every bank (e.g. Revolut and PKO BP) in that
   one Aiia session. Connecting again replaces the connection and keeps the links of accounts it still covers.
4. **Link** each bank account to a Budget Track account in the same currency.
5. **Sync**: Sync now, and the server syncs every 6 hours by itself. The first sync of an account goes back 90 days,
   but never before its starting balance; later ones re-read the last 5 days and skip what was imported before. Only
   booked transactions are imported (pending ones once they are booked); the bank's text becomes the payee, with the
   payee's last category. A sync is one Undo.
6. **Approve** in the register: imported transactions are cleared and unapproved (a blue dot; Accounts and the
   register header show "N to approve"). Open one, fix its payee or category and tap Approve, or select several and
   use Approve.

The access and refresh tokens are stored in plain text in the database: this is a single-user, self-hosted app, so
protect the database and its backups. Aiia's refresh token lasts 14 days: when the app hasn't synced for that long,
Settings asks you to Reconnect.

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
| `AIIA_CLIENT_ID` | no | | Aiia (Mastercard Open Banking) client id; bank connections are off without it |
| `AIIA_CLIENT_SECRET` | no | | Aiia client secret; bank connections are off without it |
| `AIIA_BASE_URL` | no | `https://api.aiia.eu` | Aiia Data API (sandbox: `https://api-sandbox.aiia.eu`) |
| `AIIA_REDIRECT_URI` | no | `http://localhost:3080/api/bank/callback` | This server's `/api/bank/callback`, registered in the Aiia console |
