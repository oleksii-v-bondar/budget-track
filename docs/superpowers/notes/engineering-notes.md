# Engineering notes (for plan authors and implementers)

Lessons from P1–P2a, so later plans start from what works on this machine and stack.

## Process conventions

Plans live in `docs/superpowers/plans/`, follow the superpowers *writing-plans* format, and use
`docs/superpowers/plans/2026-11-20-p2a-server-foundation.md` as the reference layout:
- a header with Goal/Architecture/Tech Stack, then Global Constraints and File Structure;
- tasks, each with Files / Interfaces (Consumes/Produces) and TDD steps;
- complete code in every step, exact commands with the expected output (including the running test total), and a commit
  step whose message ends with `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

Verify every code block before it goes into a plan:
- Prototype the whole plan in a scratch copy of the repo, outside the repo:
  `git archive HEAD | tar -x -C <scratch>` and `cp -R node_modules`.
- Run each task's tests, `npm run typecheck` and `npm run lint` there.
- Generate the plan from a template plus a small script that inlines the verified files, so code is never hand-copied.
- When a file changes across tasks, snapshot each task's version (`stages/taskN/...`) and inline the right one.

Keep each plan to about 8–10 tasks. A task is one reviewable unit with its own tests.

## Stack facts

### Node and Testcontainers
- Node is 22.14 locally. Keep `@testcontainers/postgresql` on `^11.14`: v12 pulls undici 8, which needs Node ≥ 22.19.
- Docker Desktop's Enhanced Container Isolation blocks Ryuk. `src/server/test/global-setup.ts` sets
  `TESTCONTAINERS_RYUK_DISABLED` and stops the container itself, including when setup fails.
- Server tests: `createTestDatabase()` clones a migrated template DB for each call (`{ empty: true }` gives an
  unmigrated one); `createTestApp(db, { now })` returns `{ db, app, client, clock, config }`; `setUpBudget(testApp)`
  creates the budget (`ensureBudget`) and signs `client` in with `TEST_USERNAME` / `TEST_PASSWORD`
  (`src/server/test/config.ts`); `TestClient(app)` keeps cookies and sends the CSRF header.

### Drizzle / postgres.js
- Driver errors are wrapped: the message is `Failed query: …`, and the original error is in `cause`. Use
  `isUniqueViolation(err)` from `src/server/db/errors.ts`, which walks the `cause` chain. In tests, assert on the cause
  or on the constraint name. `isIntegrityViolation(err)` matches any SQLSTATE class 23 error (FK, unique, not-null,
  check); undo/redo maps those to 409 `undo_conflict`.
- int8 is parsed to a safe JS integer, and a value outside the safe range throws. `sum()` returns `numeric`, which arrives
  as a string, so always cast in SQL: `sum(x)::bigint`. Never use `.mapWith(Number)`.
- `date` columns use `mode: 'string'` (`'YYYY-MM-DD'`). Months are stored as `'YYYY-MM-01'`; the engine uses `'YYYY-MM'`,
  so convert at the boundary.
- `numeric` arrives as a string (e.g. `'4.250000'`).
- The `v_ledger_line` view is declared `.existing()`. drizzle-kit never manages it, so any migration that alters a column
  it uses must drop and recreate the view in custom SQL (`npx drizzle-kit generate --custom --name …`).
- `npm run db:generate -- --name <name>` writes a migration. Nothing is deployed yet, but never rewrite committed
  migrations from now on: add new ones.
- Undo history is cleared whenever a migration is applied: `runMigrations` deletes every `undo_entry` row, because the
  row images describe the old schema. A migration never needs to rewrite `undo_entry.changes`.
- Transactions: `db.transaction(async (tx) => …)`. Helpers should accept `Executor` (`Db | Tx`).

### Hono / zod
- Build routers by chaining (`new Hono<AppEnv>().get(...).post(...)`) so the `App` type carries every route for the P3
  `hc` RPC client.
- Guard routes with a session either per route (`.post('/x', requireSession(deps), …)`) or with
  `.use('*', requireSession(deps))` on a router mounted under its **own** prefix. Never `.use` on a router that shares
  its prefix with other routers: the middleware leaks onto later routes there.
- `validate(target, schema)` in `src/server/http/validate.ts` gives 400 `validation` with `fieldErrors`/`formErrors`.
  zod 4 hooks pass `z.core.$ZodError`. `ValidationError` keys `fieldErrors` by the dotted issue path
  (`lines.1.amount`), so nested bodies keep their paths (`z.flattenError` would report only `lines`).
- Error classes: `AppError(status, code, message, extra?, headers?)` and `DomainError(code, message, field?)` (422) in
  `src/server/http/errors.ts`. A `DomainError` about one field (a dotted path) also returns
  `fieldErrors: { [field]: [message] }`.
- Query strings arrive as strings: parse numbers with a regex + `transform(Number)` + `pipe(...)` (not
  `z.coerce`, which turns `''` into 0).
- Request bodies are limited to 64 KiB on `/api/*`. Every `/api` response has `Cache-Control: no-store`.
- The logger's `err` serializer strips Drizzle query params. Always log with a message string:
  `logger.error({ err }, 'msg')`.

### Auth
- One user, credentials from the environment: `POST /api/auth/login` compares `{ username, password }` with
  `config.appUsername` / `config.appPassword` (`APP_USERNAME`, `APP_PASSWORD`) in constant time (SHA-256 of each side,
  then `timingSafeEqual`) and starts a session with `createSession`. There is no setup, second factor, rate limit or
  lockout (`src/server/auth/login-routes.ts`).
- `refreshSession(c, deps)` (`src/server/auth/sessions.ts`) is the one way to read the session cookie: it slides the
  session, refreshes the cookie and clears a stale one; `requireSession` builds on it.
- `app_user` holds only the budget's settings. `ensureBudget(db, month)` (`src/server/db/seed.ts`) creates it, and
  seeds the budget, when it is missing; `main.ts` runs it after the migrations. The owner edits one of them, the
  expected monthly income (`GET`/`PUT /api/budget/settings`, `src/server/budget/budget-settings.ts`); setting it is an
  undoable command, so `app_user` is a recorded table.
- Advisory lock keys in use (a new lock needs a different key; list it here): `727274002`, user commands and
  undo/redo (`COMMAND_LOCK_KEY` in `src/server/commands/run-command.ts`).

### Transactions (P2c)
- Every transaction write is planned first: build a `Draft` (what the user describes) and call
  `planTransaction(db, draft, context)` in `src/server/transactions/plan.ts`. It applies spec §5.5 and §9 and returns
  the rows (`Plan`); `insertPlan` writes a new transaction and `syncPlan` brings a saved one in line. P2d's schedule
  job and reconcile adjustments build drafts too, so they get the same rules (an adjustment's system payee needs
  `PlanContext.systemPayee`). An FX revaluation (amount 0, a PLN difference) can't be planned and is inserted
  directly, like an account's starting balance; edits keep its amounts.
- `loadAggregate(db, id)` returns a transaction with its transfer side, live split lines with their counterparts, or,
  for a split line's counterpart, its owning split and line (`owner`).
- Rows that point at each other (the two sides of a transfer, a line and its counterpart) are inserted first and then
  linked with `rec.update`, because foreign keys are checked immediately; undo replays the steps in reverse.
- The category of a budget↔tracking transfer lives on the budget-side row; `draftOf` reads it from either side.
- Amount caps (spec §4.4): request money that becomes a ledger row uses `boundedMoneySchema` (|x| ≤ `MAX_AMOUNT`,
  1e13); every computed PLN amount goes through `assertBaseAmount` (|x| ≤ `MAX_BASE_AMOUNT`, 1e14) in
  `transactions/rules.ts`. P2d's writes (schedules, revaluation, reconcile) must stay within the same caps; P2d1's do:
  the reconcile `statementBalance` and the interest override `amount` (≥ 0) use `boundedMoneySchema`; the reconcile
  adjustment's base, the revalue difference and bases converted at an NBP rate (starting balances, transactions) are
  checked, 422 `amount_too_large`. The error must name a field of the request (`statementBalance`, `fxRate`,
  `startingBalance`, `amount`), so reconcile remaps the planner's `amount` to `statementBalance`.
- `fx_rate` holds the rate a base amount was computed with; `fx_rate_manual` says whether the user entered it (NBP
  rates from P2d1 on are not manual; rows without a rate store false). Sides whose base is derived from the other
  side of a transfer store null. `effectiveRate` in the DTOs shows the rate, and `fxRateManual` the flag.

### FX and loans (P2d1)
- NBP quotes come from `deps.fx.quote(currency, date)` (`FxRates`, `src/server/fx/fx-rates.ts`). It never throws and
  must never run inside a DB transaction or under the command lock: quote first, then call `runCommand` or open the
  read transaction. `latestRates(fx, currencies, today)` quotes several currencies at once, once each. Account
  creation, Revalue and the reconcile adjustment know their currency and date up front, so their routes quote
  directly (only when no `fxRate` is sent and the account is foreign).
- Transaction writes learn which rates they need from a dry run (`createDefaultRates` / `editDefaultRates` in
  `src/server/transactions/default-rates.ts`): it plans the draft read-only with `PlanContext.unknownRates`, quotes
  what is missing, and the command plans again with `PlanContext.defaults` (`DefaultRates { date, rates }`: the
  planner uses them only for a draft of that date, so a date changed in between ends in `fx_rate_required`). A rate
  is a `Rate { rate, manual }`; `storedRates(db, agg, sameDate)` drops NBP rates when the date changes. A future-dated
  create skips the dry run's quotes and stores the sent rate or none.
- Account DTOs for responses come from `readAccounts` / `readAccount` (they quote the latest rates for "≈ X zł",
  except currencies in `quoted`: today's quotes the route already holds, e.g. Revalue's); `listAccounts` /
  `getAccount` inside commands leave `latestRate` null. The month view and auto-assign quote
  `latestRates(deps.fx, await linkedForeignCurrencies(deps.db), today)` before their transaction and pass the rates to
  `loadBudgetMonth` / `autoAssignMonth`.
- An FX revaluation is inserted directly (`revalueAccount`, `src/server/accounts/revalue.ts`); `updateTransaction`
  sends it to `updateRevaluation`, which takes only memo, flag, cleared and approved (422 `revaluation_fixed`).
- Tests: `createTestApp(db, { fx: stubFx({ EUR: '4.3' }) })` (or rates by date); `stub.calls` records the quotes, and
  mutating the rates object changes later answers. The NBP client itself is tested against a `node:http` server on
  port 0 with a short `timeoutMs`. Real table A rates are below 10 zł, so only a stub (e.g. `KWD: '13.2'`) can cross
  `MAX_BASE_AMOUNT` in cap tests.
- Loan balances: `loanBalances(db, accountIds)` (`src/server/loans/loan-balances.ts`) runs `computeLoanMonths` for
  loan accounts and `loanCharges(loan, before?)` sums the synthetic interest and escrow; every balance of a loan goes
  through them (accounts list, register header, reconcile, close, Revalue, debt targets, the loan schedule and panel).
  - A payment is `amount > 0` with no system payee (`payee.system_kind is null`): the starting balance,
    reconciliation adjustments and FX revaluations count in a month's total but never as payments, so they never
    charge interest or escrow.
  - A month's charges follow its payments' cleared status: they are cleared with the month's first cleared payment.
    `LoanBalances.unclearedMonths` lists months whose payments are all uncleared, `loanCharges` returns the total plus
    its `cleared` and `uncleared` parts, and `listAccounts` adds each part to its bucket, so an uncleared payment
    never moves the cleared balance. The working balance, close, Revalue and debt targets use the total.
    `GET /api/accounts/:id/loan` reports the same rule per month as `chargesCleared`.
  - The loan panel's "paid this month" is the current month's `chargedOn` from `loanBalances`, so it uses the same
    payment definition.
  - A loan's first month has no interest (its start balance is 0); users add an interest override for it.
  - A foreign loan's charges are converted at Σ payment base / Σ payment amount of the month, with no NBP call.

### Bank sync (Enable Banking)
- `src/server/bank/`: `enable-banking.ts` is the HTTP client (RS256 JWT from `node:crypto`, `kid` = app id, cached
  until 5 minutes before its hour is up; 30 s timeout; permissive zod schemas that log only the keys of an unexpected
  answer; the PL bank list cached 24 h), `bank-sync.ts` connects, links, syncs and runs the 6-hourly auto-sync (started
  in `main.ts` when `config.enableBanking` is set), `bank-routes.ts` is `/api/bank`. `loadConfig` reads the key file
  (`ENABLE_BANKING_KEY_FILE`, injectable `readFile` for tests); a missing or bad key means "not configured". Never log
  the key or a JWT. Tests run against a `node:http` stub on port 0 that verifies the JWT with the public key of a
  `generateKeyPairSync` pair.
- One `bank_connection` per bank (unique ASPSP name + country); a reconnect replaces it and carries account links over
  by IBAN + currency. A session past `valid_until`, or a 401/403/422 `EXPIRED_SESSION` / `REVOKED_SESSION` /
  `CLOSED_SESSION`, sets `reconnect_needed`; the sync skips that bank and reports it.
- A sync quotes NBP rates first, then imports through `createTransaction` in one `runCommand` ("Bank sync") and marks
  the rows `approved = false` with `import_id = <uid>:<entry_reference ?? transaction_id ?? sha256>`; `last_synced_at`
  is written after the command (not recorded for undo). `bank_connection` / `bank_account` aren't recorded tables.
- De-duplication: `bank_import` (a recorded table) holds every bank transaction ever imported or matched, keyed
  `<account id>:<ref>` (the import id after `<uid>:`, as account uids change with every session), with the row that
  holds it now. The sync skips what it holds, so matching and pairing may delete or move rows freely.
  `transaction.import_id` stays for display and debugging (unique per account, deleted rows included).
- Per bank transaction, booked ones first (`bank-sync.ts`; the sync reports
  `{ imported, pending, matched, paired, dropped }`):
  0. A booked one books the account's pending row it belongs to (below), if any.
  1. `matchExisting` (YNAB-like): a live row of the account with the same amount, ±4 days, that no `bank_import` holds
     and isn't pending (an entry made by hand, a transfer's other side, an entered schedule), the closest date first,
     takes the import and is cleared (a pending import leaves it uncleared and makes it pending); payee, category, date
     and approval stay.
  2. `importNew`: a new unapproved, cleared row. A `payee_alias` to a transfer payee makes it a transfer (its side in
     the other account unapproved too) when that is another open account in the same currency on the same side of
     the budget; otherwise the alias is ignored. Its `bank_import` stores the category the payee gave it
     (`auto_category_id`).
  3. `pairTransfer` (booked rows only, on both sides): a new or newly booked row pairs with exactly one imported row in
     another account (a learned transfer's: its account) that is plain, unapproved, not pending, uncategorized or
     still in its `auto_category_id`, of the opposite sign: same
     currency, the opposite amount ±3 days; else PLN amounts within 2%, ±1 day. A plain row becomes a transfer through
     the planner and `syncPlan` (`transferAmount` = the other native amount; no category unless budget↔tracking, which
     takes the budget side's or doesn't pair); the transfer's side replaces the candidate: the candidate is
     soft-deleted and its `import_id` and `bank_import`s move to that side, unapproved.
- Pending transactions (status PDNG, YNAB-like): imported like booked ones, but uncleared, with
  `transaction.bank_pending`, dated by `transaction_date`. Each sync fetches far enough back to cover them (the oldest
  pending row − 2 days, if earlier than the usual window) and reconciles them per account:
  - A booked import books a pending row (`bookingOf`, `bookPending`): the row holding its `bank_import` (the bank kept
    the id), else one dated −2…+7 days from the booking with the same amount, or within 10% when its bank text has the
    same `payeeKey` (plain rows only), the closest date first; never one whose id the bank still lists (as pending, or
    booked under that id), so a same-amount payment can't take a row whose own booking comes later. The row is
    cleared and un-pended and takes the booked id; a plain row takes the booking date and amount through
    `updateTransaction` (so PLN amounts follow); payee, category, memo and approval stay. Both ids stay in
    `bank_import`, pointing at the row. An untouched booked row then tries `pairTransfer`.
  - A pending row whose ids the bank no longer lists as pending was dropped (`dropPending`), judged only from complete
    lists (no fetch failure, no missing NBP rate) of every bank account linked to its account: soft-deleted, or, when
    the owner touched it (approved, cleared, categorized, memo, flag, transfer, split), kept and un-pended. Either way
    its `import_id` is cleared and its `bank_import`s deleted, so a later copy of it imports again (or matches the
    kept row).
  - "Add to budget" subtracts this month's pending transactions too when the balance it starts from counts them
    (XPCD, ITAV).
- Marking a transaction as a transfer (the sheet's "This is a transfer", Review's "Transfer…", bulk Set payee): an
  edit that gives a plain, non-split row a transfer payee links it to its other side when that is already in the
  other account (`transferMatch` in `transaction-commands.ts`): a live, plain row of the opposite sign (not a transfer,
  split, starting balance or system-payee row); same currency: the opposite amount ±5 days; else PLN amounts within
  3%, ±3 days, and the amount of `transferAmount` if one was sent (none sent: the row's amount becomes it, and the dry
  run sees the same draft). The closest date wins, then a row a `bank_import` holds, then the oldest. `linkPlan`
  writes the plan's side over that row and links both (no new row): it keeps its id, cleared, approved, flag,
  `import_id` and `bank_import`, so a re-sync skips it; a reconciled one needs `confirmReconciled`. Without a match
  the side is created as before, and the bank's copy matches it later (`matchExisting`). `PATCH` answers
  `{ …TransactionDto, linkedTo }` and the web app toasts "Linked with the matching transaction in <B>" or
  "Transfer to <B> created".
- Payee memory (YNAB-like): `bank/payee-match.ts` turns a bank text into a comparison key (`payeeKey`: no diacritics,
  card masks, numbers, boilerplate, legal forms or trailing cities: "ZAKUP PRZY UŻYCIU KARTY … BIEDRONKA 1234" →
  "biedronka") and a name for a new payee (`payeeDisplayName`). An import's payee is a learned `payee_alias` (key →
  payee), else a live user payee whose name has the key, else a similar one (`bestMatch`), else a new one; it gets that
  payee's `last_category_id`. Imports keep the bank text in `transaction.imported_payee`; giving such a transaction
  another user or transfer payee (edit, bulk, review) upserts the alias in the same command, so undo removes it. Merging a payee
  re-points its aliases (and adds its name's key), renaming adds the old name's key, deleting drops its aliases.
- Revolut round-ups (`transactions/round-ups.ts`): Revolut moves each card purchase's round-up to a whole 5 PLN
  (`ROUNDUP_UNIT`) to a vault as its own transaction (bank text `To PLN MB:…`). The sync's last step, in its command,
  `linkRoundUps` sets the round-up's `transaction.roundup_of` to its purchase (same account, ±1 day, the sum a multiple
  of 5 PLN; the same date, then the closest `created_at`; a tie links nothing) and gives it the purchase's category
  and approval; it unlinks a round-up whose purchase the sync deleted or paired. Edits keep it in step
  (`followPurchase` in `updateTransaction`: category, approval; a transfer, split or move unlinks it), deleting the
  purchase deletes it. The register queries leave round-ups out and give the purchase `roundUp`; the unapproved
  counts leave them out; balances and the budget count both rows. The web rows show the sum with "incl. … round-up".
- The session cookie is SameSite=Lax so the bank's redirect back to `/api/bank/callback` carries it; the callback
  checks the state cookie `/api/bank/connect` set. The web app reaches `/connect` with plain links (top-level
  navigations); the service worker never serves `/api/*`. Bank logos are not shown, so the CSP keeps no other origins.

### Budget read model
- `loadBudgetInput(db, { throughMonth, today })` (`src/server/budget/budget-input.ts`) is the only place that turns
  the ledger into `computeBudget` input; it starts at `firstEditableMonth()`, the lower bound `assertBudgetMonth()`
  allows, so every allowed month is in the result. `loadBudgetMonth(db, month, today, rates?)` checks the month range,
  runs `computeBudget` once and builds the month view (`rates` are the latest NBP rates of foreign linked accounts,
  quoted before the transaction, see "FX and loans"). Read routes run it in
  `db.transaction(fn, { isolationLevel: 'repeatable read', accessMode: 'read only' })` so every query sees one
  snapshot. Auto-assign calls it with `rec.tx` inside `runCommand`; closing a card calls `loadBudgetInput` and
  `computeBudget` directly with `rec.tx`.
- `uncategorizedActivity` (`budget-input.ts`) is the one predicate for Uncategorized activity on `v_ledger_line`. The
  register (`GET /api/transactions?categoryId=<Uncategorized>`) uses it too, so the Budget screen's Activity tab lists
  exactly the lines the budget counts. Like the budget read routes, the register reads its balances and rows in one
  read-only repeatable-read transaction.
- `setAssigned`/`addAssigned` don't check the category; callers go through `assignableCategory` or the month view,
  which never lists Ready to Assign or Uncategorized.
- Auto-assign passes the month view's `underfunded` amounts to the engine only for the `underfunded` strategy, clamped
  to `Number.MAX_SAFE_INTEGER`. Target `need`/`underfunded` are not bounded yet (a target amount cap is carried over).
- "Today" for the budget is `todayIn(config.timeZone, clock.now())`; lines dated later are left out.
- zod 4 discriminated unions nest (`kind` → `cadence` / `debtMode`), and refined objects can be options.
  `z.flattenError` reports an unknown discriminator under its key, e.g. `fieldErrors.cadence`.

### Web app
- **Layout.** `src/web/`: `main.tsx` (entry), `app.tsx` (query client, toasts, router), `router.tsx` (route tree and
  guards), `shell/` (app shell, tab bar, "+ Transaction", each screen's top bar with the "…" menu (Undo/Redo, Settings, Sign
  out), offline banner, not-found and error screens), `lib/` (API
  client, query cache, commands, form errors, `useOnline`, formatting, the keypad's calculator, NBP rate lookup,
  today's date), `ui/` (the component kit), the screens (`home/`, `budget/` (the Plan), `register/` (Spending and the account registers), `accounts/`, `reflect/`,
  `transactions/`),
  `auth/`, `settings/`, `test/` (test helpers). `index.html` and `public/` (generated icons) are Vite's root.
- **Boundaries** (ESLint; `src/server/lint-boundaries.test.ts` pins them): `src/web` imports only types from
  `src/server` (`import type`), and no Node modules or globals; `src/server` and `src/shared` never import `src/web`;
  `src/shared` never imports `src/server`. The web app may use the pure engine (`roundDiv`). The root tsconfig covers
  everything but `src/web`, which has its own (`src/web/tsconfig.json`: DOM lib, JSX); `npm run typecheck` runs both.
- **API.** Call the server only through `api` (`hc<App>`, `src/web/lib/api.ts`), wrapped in `unwrap(...)`: it returns
  the typed 2xx body and throws `ApiError` (`status`, `code`, `message`, `fieldErrors` by dotted path, `formErrors`,
  `retryAfter`; status 0 / `network` without a response, `http_<status>` for a non-JSON error page). `api` sends the
  CSRF header on every request. The server's `App` type has only the chained `/api` routes: keep chaining routers,
  and keep `app.get('*', serveWeb(…))` outside the chain.
- **Query cache** (`src/web/lib/query.ts`). Keys are `[area, ...params]` (`['budget', '2026-11']`, `['accounts']`);
  the `auth` area holds only the auth status (`{ authenticated }`), which the route guards read (`authStatusQuery`,
  never stale). Sign-in and sign-out set it with `setAuthStatus(queryClient, status)`; `useEnterApp()(href)` records
  a new session. Reads are fresh for 30 s and retry twice after network and 5xx errors.
- **Commands.** No optimistic updates: run every undoable command through `useCommand(fn)`
  (`src/web/lib/commands.ts`). It waits for the server, invalidates every non-auth query (`invalidateData`), reads
  `GET /api/undo` and shows a toast with the command's undo label and Undo (if that read fails, there is no toast, but
  the command still succeeded: never let a follow-up read fail a committed command); a network or 5xx failure gets a
  Retry toast, other errors stay on the mutation for the form. `useUndoRedo()` backs the header and the toasts; a
  refused undo or redo (409) re-reads the undo state. Auth and settings calls are plain `useMutation`s (not
  undoable). A 401 `unauthorized` from any query or mutation forgets the cached data and opens `/login?redirect=…`
  (`app.tsx`).
- **Forms.** `formErrorsOf(mutation.error, ['name', 'lines.0.amount'])` gives `{ fields, form }`: pass
  `fields[path]` to the field's `error` and `form` to `<FormError>` above the submit button (it adds "You can try
  again in …" from `Retry-After`). Check input early with the shared zod schema and `zodFormErrors`. Forms are
  `noValidate`; `Button` is `type="button"` unless it is the submit button.
- **Offline.** Every control that sends a request is disabled while offline: `<Button mutating>`, or `useOnline()`.
  Keyboard shortcuts that submit (the keypad's Enter) follow the same rules as their button (busy, offline).
- **Display and input.** Amounts: `formatMoney(minor, currency?)` / `formatAmount` (no-break space groups, decimal
  comma, `zł` for PLN, the code otherwise); dates `formatDate` / `parseDate` (dd.MM.yyyy ↔ ISO); months
  `formatMonth` / `formatMonthShort` (`'2026-11'`). Amount entry: `AmountKeypad` or `AmountField` (`evaluateAmount`:
  + − × ÷ exactly, result rounded half away from zero, at most `MAX_AMOUNT` from `src/shared/api/common.ts`).
- **Kit** (`src/web/ui`): `Button` (`variant`, `mutating`, `busy`, `block`), `TextField`, `TextAreaField`,
  `SelectField`, `AmountField`, `Checkbox`, `SegmentedControl`, `Tabs`, `FormError`, `Loading` / `LoadError`, `Pill`
  (spec §6 tones), `Sheet` (bottom sheet; its children unmount on close, so forms in it start empty; Tab and
  Shift+Tab wrap inside it), `ToastProvider` / `useToast`, icons and `cx`.
  Tailwind v4, dark only; theme tokens in `styles.css`: `page`, `header` (darker than `page`), `surface` (cards and
  rows), `raised` (buttons, inputs), `line` (dividers), `zero` (grey pills), `muted` (secondary text), `lime` /
  `lime-dark` (money that's fine, spent), `income`, and `brand` / `brand-dark` / `brand-light` (indigo: links, the
  active tab, primary buttons). Top bars use `ScreenHeader` (`shell/screen-header.tsx`) with `ROUND_BUTTON` /
  `PILL_BUTTON`.
- **CSP.** No inline scripts or `<style>` elements, no `eval` (zod runs `jitless`: `zod-jitless.ts` is imported
  first), no `data:`/`blob:` images (draw inline SVG), no other origins. React's `style` prop is
  fine. `npm run test:e2e` fails on any violation.
- **Screens.** Routes live under `appLayout` in `router.tsx`; each screen renders its own `ScreenHeader` (top bar and
  large title). `/home` (where sign-in and `/` land), `/budget?month=&filter=` (the Plan; `filter` is one of
  `BUDGET_FILTERS`), `/transactions` (Spending: every account; filters in the search params, `?unapproved=true` is the
  review), `/accounts`, `/accounts/$accountId` (a register), `/reflect`, `/transactions/new?accountId=`, `/settings`
  (from the "…" menu). The tab bar is Home · Plan · Spending · Accounts · Reflect; "+ Transaction" opens the new
  transaction in a `Sheet` (in a register it starts in that account). Editing a transaction, a category or an account
  happens in a `Sheet` on its screen. The transaction sheet's "This is a transfer" switch (`role="switch"`) swaps the
  payee for a "To account" / "From account" picker of the other open accounts (choosing a "Transfer : <Account>"
  payee turns it on; turning it off gives the payee back; without another open account it says to add one); the payee list shows a "Transfers" section as soon as the
  field has the focus. In the review, unapproved rows have Approve and "Transfer…" (`register/mark-transfer.tsx`: tap
  an account to save the row as a transfer and approve it). The Plan's edit icon opens Edit Plan (`budget/edit-plan.tsx`), a full-screen
  view over the Plan, like YNAB's: Cost to Be Me (`budget/plan-targets.ts` turns each target into what it costs a
  month), the month's targets against the expected monthly income (`/api/budget/settings`), and every group and
  category to add, rename, move, hide, delete and give a target; its Reorder mode drags them with `@dnd-kit`. Home's counts (`useAttention`,
  `home/attention.ts`) and Reflect (`reflect/reflect-model.ts`) read the month views (`GET /api/budget/:month`):
  spending is the categories' net outflows (card payment categories left out), income `rta.income`. There are no
  Scheduled, Payees or loan screens: a future-dated transaction becomes a one-time schedule on the server and the
  sheet only toasts "Scheduled for <date>". A route whose guard or loader throws shows `ErrorScreen` (the router's
  `defaultErrorComponent`), whose Try again runs `router.invalidate()`. Whatever makes a guard's cached auth status
  wrong must set it, or the guards send the user to the wrong place.
- **Tests.** The Vitest `web` project (jsdom) runs `src/web/**/*.test.{ts,tsx}`. Fake the server with
  `fakeApi({ 'GET /api/x': { body }, 'POST /api/y': (req) => json(body, 422) })` (it records `requests`), then
  render the whole app with `renderApp(path)` (memory history; spread `SIGNED_IN` into the routes) or a component
  with `renderWithProviders(ui)`; drive it with `userEvent.setup()`. A route key may use `:param` segments
  (`'GET /api/budget/:month'`); `undoStack()` fakes the undo label a command's toast shows and `writes(requests)`
  lists the non-GET requests. Fixtures: `test/budget-fixtures.ts`, `test/ledger-fixtures.ts`. Fake offline with
  `vi.spyOn(navigator, 'onLine', 'get')`. `src/web/test/setup.ts` restores mocks and stubbed globals after each test.
- **End to end.** `npm run test:e2e` builds, then `e2e/global-setup.ts` starts Postgres (Testcontainers, Ryuk off)
  and `dist/server/main.js` on a free port, and Playwright runs chromium at 390×844 (install it once with
  `npx playwright install chromium`). The server runs with `APP_USERNAME` / `APP_PASSWORD` from `e2e/env.ts`; the
  smoke test (`e2e/smoke.spec.ts`) signs in, adds a checking account, a group and a category, assigns with a keypad
  expression, adds a transaction with a new payee from "+ Transaction", checks Spending, the register, Reflect and
  the Plan, and undoes it from the "…" menu.
- **Serving and assets.** `serveWeb(webDir)` (`src/server/http/web.ts`) serves the build; `testConfig` points
  `webDir` at `src/server/test/web-fixture`. The icons are generated by `npm run icons` (`scripts/generate-icons.ts`)
  and committed. The service worker activates at once and claims open pages (`skipWaiting`, `clientsClaim` in
  `vite.config.ts`; `e2e/service-worker.spec.ts` checks the build). `npm run dev:web` runs Vite on port 5173 and
  proxies `/api` and `/healthz` to `npm run dev` on port 3080 (`PORT=3080` in `.env`; `API_PROXY_TARGET`
  overrides).

### Engine
- `src/engine` is pure: no I/O, no Node modules, no `Date.now()` / `new Date()` / `Math.random()`. ESLint enforces this.
- `computeBudget` throws on unknown or duplicate categories, assignments to RTA or Uncategorized, lines categorised to a
  card payment category, and credit lines without a payment category. Build its input exactly as
  `src/engine/budget/types.ts` documents.
- Deferred items for the server phases are listed in `docs/superpowers/notes/p2-carry-over.md`.
