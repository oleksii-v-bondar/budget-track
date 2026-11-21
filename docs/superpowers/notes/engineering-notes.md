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
  unmigrated one); `createTestApp(db, { now })` returns `{ app, client, clock, config }`; `setUpBudget(testApp)`
  performs first-run setup and leaves `client` signed in; `TestClient(app, ip)` keeps cookies and sends the CSRF
  header.

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
- Error classes: `AppError(status, code, message, extra?)` and `DomainError(code, message, field?)` (422) in
  `src/server/http/errors.ts`. A `DomainError` about one field (a dotted path) also returns
  `fieldErrors: { [field]: [message] }`.
- Query strings arrive as strings: parse numbers with a regex + `transform(Number)` + `pipe(...)` (not
  `z.coerce`, which turns `''` into 0).
- Request bodies are limited to 64 KiB on `/api/*`. Every `/api` response has `Cache-Control: no-store`.
- The logger's `err` serializer strips Drizzle query params. Always log with a message string:
  `logger.error({ err }, 'msg')`.

### Auth
- `withLoginLock(db, fn)` in `src/server/auth/rate-limit.ts` serialises sign-in and re-auth with
  `pg_advisory_xact_lock(727274001)`. Any new advisory lock needs a different key; list keys in this file:
  - `727274001`: login and re-authentication.
  - `727274002`: user commands and undo/redo (`COMMAND_LOCK_KEY` in `src/server/commands/run-command.ts`).

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

### Engine
- `src/engine` is pure: no I/O, no Node modules, no `Date.now()` / `new Date()` / `Math.random()`. ESLint enforces this.
- `computeBudget` throws on unknown or duplicate categories, assignments to RTA or Uncategorized, lines categorised to a
  card payment category, and credit lines without a payment category. Build its input exactly as
  `src/engine/budget/types.ts` documents.
- Deferred items for the server phases are listed in `docs/superpowers/notes/p2-carry-over.md`.
