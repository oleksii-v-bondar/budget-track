# Budget Track

A personal, single-user budgeting app that follows YNAB's rules, with PLN as the budget currency. The design is in
[`docs/superpowers/specs/2026-11-19-core-budgeting-design.md`](docs/superpowers/specs/2026-11-19-core-budgeting-design.md).

Status: the budget engine (`src/engine`), the server API and the web app's YNAB screens are done. The web app is an
installable phone web app, dark and laid out like YNAB's iOS app (tabs Home · Plan · Spending · Accounts · Reflect,
"+ Transaction" above them, and a "…" menu with Undo, Redo, Settings and Sign out):

- **Home**: Ready to Assign; what needs attention (transactions to review, overspent and underfunded categories);
  this month's spending against income; net worth. The Home tab's badge counts reviews and overspent categories.
- **Plan**: month picker; Ready to Assign with its breakdown and Auto-assign; filters (overspent, underfunded, ...);
  category groups with Available pills, a progress bar and a status line ("Funded. Spent X of Y", "Fully Spent", "X
  more needed this month", "Overspent") and a hidden section; a note per month. A category's sheet assigns with a
  calculator keypad, moves money, sets a target, lists the activity, keeps a note and hides the category. Credit card
  payment categories show what paying the card in full needs. Edit mode adds, renames, reorders, hides and deletes
  groups and categories.
- **Spending**: every account's transactions by date, with search, filters, bulk changes, and a review of new
  (imported) transactions to approve one by one or all at once.
- **Accounts**: cash, credit and tracking accounts in PLN or another currency (shown also as ≈ PLN at the latest NBP
  rate), grouped with totals; add, edit, close (with an adjustment), reopen and delete. Each account's register has
  its balances, rows by date, search, filters, bulk changes, reconcile, and revalue for foreign accounts.
- **Reflect**: a month's spending breakdown by category, and income against spending over the last six months.
- **Transactions**: outflow/inflow with a keypad, payee autocomplete (new payees and transfers), category, date, memo,
  flag, cleared, FX rate and splits. A date after today saves it as a one-time scheduled transaction.
- **Bank connections** (optional): PKO BP, Revolut and other Polish banks through Enable Banking; imported
  transactions wait for approval (Spending → Review).
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

## Bank connections (Enable Banking)

Optional. Budget Track imports booked transactions through [Enable Banking](https://enablebanking.com), whose
restricted production mode is free for your own accounts.

1. Sign up at https://enablebanking.com/sign-in/ (it emails you a sign-in link).
2. In the Control Panel, register a **Production** application with the redirect URL
   `http://localhost:3080/api/bank/callback` and let the browser generate the key: it downloads `<app-id>.pem`. The
   redirect URL is this server's `/api/bank/callback` as your browser reaches it, so it assumes `APP_PORT=3080`;
   otherwise set `BANK_REDIRECT_URI` in `.env` to the URL you registered.
3. Save the key as `./secrets/enablebanking.pem` (`mkdir -p secrets`; `secrets/` is git-ignored and mounted read-only
   into the container at `/app/secrets`) and set `ENABLE_BANKING_APP_ID=<app-id>` in `.env`. On Linux the file must be
   readable by uid 1000, the container's `node` user.
4. Activate the application by linking your own PKO BP and Revolut accounts in the Control Panel (restricted mode: it
   can only read the accounts linked there).
5. Restart: `docker compose up -d`. Without the app id or a readable key, Settings doesn't show bank connections.
6. In the app: "…" → Settings → Bank connections → **Connect bank**, pick the bank and sign in there. Back in Settings,
   **link** each bank account to a Budget Track account in the same currency, then **Sync now**.

How it works:
- Each bank is its own connection. Its consent lasts as long as the bank allows, at most 180 days ("Valid until");
  then Settings shows "Reconnect needed". Reconnecting a bank replaces its connection and keeps the account links (by
  IBAN). Disconnect ends the consent; imported transactions stay.
- The server also syncs every 6 hours by itself. The first sync of an account goes back 90 days, but never before its
  starting balance; later ones re-read the last 5 days and skip what was imported before. Only booked transactions
  are imported (pending ones once they are booked); the counterparty (or the first line of the payment details)
  becomes the payee, with the payee's last category. A sync is one Undo.
- **Approve** in the register: imported transactions are cleared and unapproved (a blue dot; Accounts and the
  register header show "N to approve"). Open one, fix its payee or category and tap Approve, or select several and
  use Approve.
- The database stores only the session ids; every API call is signed with the private key, so keep `secrets/`
  private and never commit it.

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
| `ENABLE_BANKING_APP_ID` | no | | Enable Banking application id; bank connections are off without it |
| `ENABLE_BANKING_KEY_FILE` | no | `./secrets/enablebanking.pem` | The application's private key (PEM); bank connections are off if it can't be read |
| `BANK_REDIRECT_URI` | no | `http://localhost:3080/api/bank/callback` | This server's `/api/bank/callback`, registered as the application's redirect URL |
