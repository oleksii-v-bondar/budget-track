# P2 carry-over from P1 (budget engine)

These items were found in the P1 final review and deferred. Fold them into the P2 plan.

## Public API
- Consider named exports in `src/engine/index.ts` instead of `export *`. Internals such as `roundDiv` and
  `allocate` have preconditions that they don't validate and shouldn't be part of the public surface.
- `allocate` and `splitOverspending` don't reject negative weights. Today only callers that clamp to ≥ 0 exist.

## Test gaps
- A refund larger than the payment category's Available (the §5.3 simplification).
- The budget property generator should also produce rows outside `[startMonth, throughMonth]`.
- The loan 1200-month cap (`amortizedPayment` horizon and `projectPayoff` "never").
- `transferBases` foreign → base with a `null` rate on the foreign side.

## Validation and behaviour
- Validate the schedule anchor date (`nextOccurrence` returns an anchor ahead of `after` unchecked).

## Resolved in P2a
- Engine purity lint now also blocks dynamic `import()`, `globalThis.*`, `Date.now()`, `new Date()` and `Math.random()`.

## From P2a final review
- Any migration touching `v_ledger_line` columns must drop/recreate the view.
- P2c: enforce date ≤ today on transaction writes (§5.6); the view does not filter future dates. (Starting balances
  already enforce it.)
- P2c: nested validation errors lose paths in z.flattenError; return issue paths for nested bodies (split lines).
- P2c: shutdown hardening (SIGTERM during migrations, close timeout, exit code on db close failure, `init: true` in
  compose).
- P3: TOTP replay protection (store the last used timeStep).
- P3: /status should refresh the cookie; clear stale cookie on 401; Retry-After on 429; friendly .max messages.
- P3: global lockout DoS — amend spec (device cookies, count failures since last success/lockout) before internet
  exposure.
- P3: login-lock waiters hold pool connections — in-process mutex + lock_timeout.
- P3: rate-limit setup-token attempts.
- P3: CSP img-src blocks data: QR → render SVG; web tsconfig DOM lib; SPA fallback for non-/api paths; document single
  trusted proxy.

## Resolved in P2b1
- Every router outside /api/auth is mounted on its own prefix behind `.use('*', requireSession)`; `app.test.ts`
  walks `app.routes` and expects 401 for each one.
- Migration 0002: `payee_name_live` skips transfer/system payees; partial unique indexes on `payee.system_kind`, live
  `category.linked_account_id` and non-normal `category_group.kind`; `category_group.deleted_at`; FK indexes on
  `transaction.category_id`/`payee_id` and `subtransaction.category_id`; timestamps are `timestamptz(3)`; no FK has an
  ON DELETE action any more; the three system payees are inserted (idempotent). `.$type<AccountClass>()` on
  `account.accountClass` and the view's class columns.
- Undo conflict checks ignore `created_at`/`updated_at`.
- `todayIn` builds the date from `formatToParts`; ledger view tests cover a deleted split parent and amount ≠
  amount_base; spec §4 lists the tables without UUIDs or timestamps.
- Assignment months are capped server-side to [first editable month, current month + 24]. The first editable month is
  the earliest of the budget start, the earliest assignment month and the earliest month-note month, so rows left
  before a budget start that moved later can still be changed or cleared.
- Advisory-lock keys are listed in `engineering-notes.md` (727274001 login, 727274002 commands and undo/redo).
- Credit card payment (and paired loan) categories can't be deleted on their own, so `computeBudget` never sees card
  lines without a payment category.

## From P2b1
- P2c: deleting an account is refused while soft-deleted transactions still reference it; decide whether account
  deletion should purge soft-deleted history.
- P2c: undo/redo replays row by row (two queries per changed row); bulk operations over thousands of rows may need
  batching.
- P2d: foreign keys have no ON DELETE actions. Deleting a scheduled transaction must delete its
  `scheduled_subtransaction` rows and clear `transaction.scheduled_id` through the ChangeRecorder.
- P2d: the scheduled-transaction job writes outside `runCommand` (no undo entry, redo kept) but should hold
  `lockCommands()` (advisory key 727274002) so it can't interleave with an undo replay.
- P2d: `fxRate` is required to create a foreign-currency account; make it optional once the NBP lookup exists.
  (Resolved in P2d1.)

## From P2b1 final review
- P2d2 (not done in P2b2): a snapshot round-trip (undo/redo) test matrix for every command: PATCH account with its rename cascade,
  close/reopen, the reorders, group/category create/edit/move, month note, and the redo legs; plus a parallel
  duplicate-create test. A catalog test that every timestamptz column has precision 3. Tests for malformed
  `fxRate`/`interestRate`/date inputs.
- P2c: transfers and splits must insert one side with a null link and then update it (replay is row by row, and there
  is an FK self-reference and a transaction ↔ subtransaction cycle), with a round-trip test. Never run commands above
  READ COMMITTED. Refuse soft-deleted and credit card payment categories on all writes. `isAccountInUse` should check
  transfer-payee usage and not block on `payee.lastCategoryId` (clear it instead). Add indexes on
  `transaction.transfer_txn_id`/`transfer_account_id`/`scheduled_id`, `subtransaction.transfer_txn_id` and
  `scheduled_subtransaction.scheduled_id`. Batch large bulk operations (bind-parameter limit). Add a multi-row conflict
  rollback test.
- P2d: the scheduled job must take `lockCommands()`; add a `lock_timeout`. Mapping FK/unique violations during replay
  to 409 `undo_conflict` now exists (P2b1 final review A1).
- P3: build mutation responses inside the command (`rec.tx`), not after commit; consider returning the touched table
  names from undo/redo for query invalidation; a zod abort skips `superRefine` (form UX); unify 404 vs 422 for unknown
  ids in bodies; a lint rule forbidding direct `rec.tx` writes in command files.

## Resolved in P2b2
- `loadBudgetInput` converts `v_ledger_line` months ('YYYY-MM-01') to engine months ('YYYY-MM') and casts every sum
  `::bigint`.
- `evaluateTarget` validates `TargetDef.amount` (safe integer ≥ 0) and the `TargetContext.debt` numbers (safe
  integers; `minPayment` and `escrow` ≥ 0); a `null` spending mode is `set_aside` explicitly; the sign conventions of
  the loan and target functions are documented.
- `autoAssign` throws for a month outside the computed budget. The server never puts Ready to Assign or Uncategorized
  in an auto-assign scope.
- Auto-assign passes `underfunded` amounts to the engine only for the `underfunded` strategy, each clamped to
  `Number.MAX_SAFE_INTEGER` (the engine caps every amount at Ready to Assign), so a huge target can't make a run fail.
- `targetContext` / `evaluateCategoryTarget` (`src/server/targets/target-model.ts`) build `TargetContext` from a
  `BudgetResult` plus the linked account (minimum payment, APR, escrow for loans, PLN balance before the month).
- A cleared `min_payment` (or APR) counts as 0 and flags the debt target `incomplete`.
- Closing a credit account hides its payment category when Available = 0 in the current month.
- The month view and auto-assign reuse `budgetStartMonth()`, `firstEditableMonth()`, `assertBudgetMonth()`/
  `MONTHS_AHEAD` and `setAssigned`; the budget is computed from `firstEditableMonth()`, which is also the month view's
  `firstMonth`.
- Test gaps closed: `repeatUnit: 'year'`, the cycle start clamped to `startMonth`, an overdue `set_aside` target, and
  the auto-assign 12-month window with half-away-from-zero rounding.
- `app.test.ts` lists the new budget and target routes among those the deny-by-default walk covers.

## From P2b2
- P2c: transaction writes must keep a split parent's `amount_base` equal to the sum of its live lines: debt balances
  and "Need X to pay in full" read `transaction` (like account balances), while the budget reads `v_ledger_line`.
- P2d: a loan's `balanceAtMonthStart` (pay-off-by-date targets) is the PLN sum of its transactions; it ignores the
  synthetic interest and escrow rows of §8 until the loan engine (`computeLoanMonths`, interest overrides) is wired in.
  (Resolved in P2d1.)
- P2d: the loan panel of a paired category (balance, APR, minimum payment, projected payoff, Record payment); the month
  view only gives `linkedAccountId`. (Resolved in P2d1.)
- P2d: foreign-currency cards and loans: debt targets use `min_payment` and `escrow_amount` as PLN amounts, which is
  right only for PLN accounts. (Resolved in P2d1.)
- P2d / final review: cap target amounts (e.g. ≤ 1e13) in the targets API. `evaluateTarget` only checks that the
  amount is a safe integer, so a huge weekly target (2e15 on a weekday that occurs 5 times) makes `GET
  /api/budget/:month` return a raw `need`/`underfunded` above 2^53. Auto-assign already clamps it (see above).
- Later: `GET /api/budget/:month` takes ≈ 80 ms for 10 years × 150 categories (26k transactions) and ≈ 175 ms in a
  dense worst case (36k activity rows) on an M3 Max. If it matters, read the activity aggregate with `db.execute`
  (Drizzle's row mapping costs ≈ 30 ms per 36k rows) and profile `computeBudget`.

## Resolved in P2c
- Date ≤ today on transaction writes (§5.6): a new transaction dated after today becomes a one-time scheduled
  transaction; an edit can't move a transaction past today. Transaction dates start at 1970-01-01, like starting
  balances.
- Nested validation paths: `fieldErrors` are keyed by the dotted issue path (`lines.1.amount`); `DomainError` takes
  an optional field, used for split lines (`lines.2.categoryId`) and bulk rows (`ids.3`).
- The ledger view is checked through the API: split lines instead of their split, both sides of transfers, a deleted
  split whose lines stay live, and foreign lines with amount ≠ amount_base.
- Transfers, transfer lines and their counterparts are inserted with a null link and linked by an update; undo/redo
  round trips are tested for transfers, splits, replaced lines and bulk operations. Commands stay at READ COMMITTED.
- Soft-deleted and credit card payment categories are refused on every transaction write (`assertUsableCategory`).
- Account deletion: `isAccountInUse` also checks rows that use the account's transfer payee, and a payee that
  remembers a linked category no longer blocks the delete (the delete clears `last_category_id`). Soft-deleted
  transactions still block it (`account_in_use`): they are history that undo can bring back, so the account is closed
  instead.
- Indexes on `transaction.transfer_txn_id`, `transfer_account_id` and `scheduled_id`,
  `subtransaction.transfer_txn_id` and `scheduled_subtransaction.scheduled_id` (migration 0003).
- Bulk operations run row by row (no large IN lists) and take at most 500 ids. Categorizing 500 rows took about
  1.4 s and its undo about 0.5 s against the Testcontainers database. A test shows that an undo conflict on one row of
  a bulk command rolls back the rows already replayed.
- `transferBases` foreign → PLN with a `null` rate on the foreign side has a test.
- The Budget screen's Activity tab has its register API (moved from "From P2b2"): `GET /api/transactions?categoryId=`
  lists the transactions behind a category's activity, split lines included, and `categoryId=<Uncategorized>` lists
  exactly the Uncategorized activity the budget counts (the shared `uncategorizedActivity` predicate).

## From P2c
- P2d: shutdown hardening, moved from P2c (SIGTERM during migrations, close timeout, exit code on db close failure,
  `init: true` in compose).
- P2d: entering a scheduled transaction must build a `Draft` and use `planTransaction` + `insertPlan`. Schedules keep
  the category of a transfer as entered (the plan puts it on the budget side), the `fx_rate` of a foreign ↔ foreign
  transfer schedule is the sending side's rate, and schedule lines keep their payee and `transfer_account_id`.
- P2d: `scheduled_transaction` has no column for the other side's amount, so future-dated transfers between currencies
  are refused (`future_transfer_currency`). Add a column (and allow them) with the scheduled-transaction CRUD.
- P2d: NBP rates. Until then `fxRate` is required for foreign-currency transactions and stored with
  `fx_rate_manual = true`; edits keep the stored rate unless a new one is sent. With NBP, a date change should
  re-fetch a non-manual rate. (Resolved in P2d1.)
- P2d: only the reconcile flow sets `reconciled`; users switch between `uncleared` and `cleared`. (The flow exists
  since P2d1.)
- Later: `ChangeRecorder.update` re-selects the rows it changed with one IN list, so a single update of more than about
  65 000 rows (merging a payee with that many transactions, or P2b1's category delete) would exceed Postgres'
  bind-parameter limit. Batch it there if that ever matters.
- P3: changing a categorized transaction's payee to the transfer payee of a budget account needs `categoryId: null`
  in the same request (`category_not_allowed` otherwise). For a budget↔tracking transfer only the budget side's DTO
  shows the category.
- P3: register rows of the same date are ordered by id (spec: date desc, id), not by entry time.
- P3: unknown ids in transaction bodies are 422 with a field (`invalid_account`, `invalid_payee`, `invalid_category`);
  the "unify 404 vs 422" item from the P2b1 final review stays open for the older endpoints.
- P2c final fix pass, code (minors from the task reviews; the fixed ones are listed under "Resolved in the P2c final
  fix pass" below):
  - A future-dated same-currency foreign transfer entered from the receiving side loses its `fxRate` on the schedule
    (`insertSchedule` stores the main row's rate). Use `draft.fxRate`; the P2d2 prototype reportedly does.
  - PATCH clears a memo only with `''` (`memo: null` is a 400); decide whether to accept `null`.
- P2c final fix pass, tests (minors from the task reviews; the ones still open after the fix pass):
  - Transfers: a successful tracking↔tracking transfer, and an undo round trip of a transfer between currencies.
  - Splits: a transfer line to a closed account; the 100-line cap; the category of a future-dated budget↔tracking
    transfer line.
  - Edits: edits of a foreign↔foreign transfer; a no-op split edit records no undo entry; editing a transaction whose
    own account is closed (only the closed other side is tested).
  - Reconciled rows: a move and `lines` in one request.

### Resolved in the P2c final fix pass
- Amount caps (spec §4.4, §13): every amount that becomes a ledger row (`amount`, `transferAmount` and
  `lines[].amount` of transactions, on create and edit, and an account's `startingBalance`) uses `boundedMoneySchema`
  (|amount| ≤ `MAX_AMOUNT` = 1e13, 100 bn zł; 400 "Amount is too large."). Computed PLN amounts (`toBase`, the
  sending side of a transfer, split line bases, foreign starting balances) must stay within `MAX_BASE_AMOUNT` = 1e14
  (rates up to 10), otherwise 422 `amount_too_large` with the field (`amount`, `transferAmount`, `lines.<n>.amount`,
  `startingBalance`). Before, two rows near 2^53 in one account made `GET /api/accounts`, the register and the budget
  answer 500 (the int8 parser throws on their sum). The caps keep sums of up to ≈ 90 maximal rows exact; assignments,
  targets and loan fields are not capped.
- `planLines` sums split lines with BigInt and checks each line's base (`lines.<n>.amount`).
- `POST /api/transactions` accepts `payeeId: null` (no payee, like omitting it; a `payeeName` may go with it).
- Editing a starting balance with `lines` reports `fieldErrors.lines` (`assertStartingBalanceKept` checks `lines`
  before `categoryId`).
- Bulk edits skip rows that an earlier row of the same command soft-deleted (`updateTransaction` returns
  `deletedIds`), e.g. `setPayee` on both sides of a transfer no longer answers 404 for the side the first row ended.
- Tests added for the review gaps: a payee merge keeps the target's own `lastCategoryId`; a refused create (closed or
  unknown account) leaves no inline payee behind; undo/redo round trips of a split with a transfer line, of
  retargeting and of ending a transfer, and of an EUR↔EUR transfer; editing a transfer whose other account is closed,
  editing from the foreign side of a PLN↔EUR transfer, and a no-op transfer edit (no undo entry); `confirm_reconciled`
  for replacing or removing a reconciled split's lines, moving a transfer whose other side is reconciled and deleting
  a split whose line counterpart is reconciled; `account_in_use` for each of the four tables that can use the
  transfer payee (`it.each`).

## Resolved in P2d1
- NBP rates (spec §9): `src/server/fx/fx-rates.ts` implements `FxRates.quote` (fx_rate cache, 7-day fallback, 5 s
  timeout, null on any failure) and `AppDeps.fx`; `NBP_BASE_URL` configures it. Tests use `stubFx` or a local
  `node:http` stub server.
- `fxRate` is optional when creating a foreign-currency account: the starting balance takes the NBP rate of its date.
- Foreign transactions, splits and transfers without `fxRate` are booked at the NBP rate of their date
  (`fx_rate_manual = false`); a sent rate is manual. A date change re-fetches a non-manual rate and rebooks the base
  amounts, the split lines and the other side of a transfer. A future-dated transaction stores the rate sent or none.
- "≈ X zł" on accounts (`latestRate`, `balanceAtLatestRate`) and Revalue (`POST /api/accounts/:id/revalue`); an FX
  revaluation keeps its amounts on edit (`revaluation_fixed`).
- The reconcile flow exists (`GET`/`POST /api/accounts/:id/reconcile`); it is still the only way to set `reconciled`.
  Its adjustment is planned with `PlanContext.systemPayee`.
- Amount caps on P2d1's inputs (the P2c rule): the reconcile `statementBalance` and the interest override `amount`
  (0 … 1e13) use `boundedMoneySchema` (400 "Amount is too large."). The reconcile adjustment's PLN amount
  (`statementBalance`), the revalue difference (`fxRate`) and bases converted at an NBP rate (a foreign starting
  balance's `startingBalance`, a transaction's `amount`) stay within `MAX_BASE_AMOUNT`, otherwise 422
  `amount_too_large` with that field.
- A loan's balances include the synthetic interest and escrow everywhere (`loanBalances` / `loanCharges` in
  `src/server/loans/loan-balances.ts`), so debt targets' `balanceAtMonthStart` counts them.
  - The charges follow their payments' cleared status: a month's interest and escrow are cleared once every payment
    of the month is, so entering an uncleared payment never moves the cleared balance. The loan schedule reports it
    per month as `chargesCleared`.
  - Reconciliation adjustments, FX revaluations and the starting balance (rows with a system payee) never count as
    loan payments, so they never charge interest or escrow.
  - A loan's first month has no interest, even with a payment in it (its start balance is 0); the user can add an
    interest override for that month. Spec §8 says so.
- The loan schedule and interest overrides: `GET /api/accounts/:id/loan`, and `PUT` / `DELETE` on
  `/api/accounts/:id/interest-overrides/:month`.
- The loan panel of a paired category (`BudgetCategoryDto.loan`): balance, APR, minimum payment, escrow, projected
  payoff and the Record-payment prefill. Its "paid this month" uses the `loanBalances` payment definition (the current
  month's `chargedOn`), so a reconciliation adjustment doesn't move the projection to next month.
- Foreign-currency cards and loans: debt targets convert `min_payment` and `escrow_amount` to PLN at the latest NBP
  rate (0 and `incomplete` without one, except for `fixed` targets).

## From P2d1
- P2d2: entering a schedule whose `fx_rate` is null quotes the NBP rate of the occurrence date before the job's
  transaction and lock (`deps.fx.quote`), and books it with `fx_rate_manual = false`; a schedule's manual rate stays.
  `planTransaction` takes it as `PlanContext.defaults`.
- P2d2: a future-dated same-currency foreign transfer entered from the receiving side still loses its `fxRate` on the
  schedule (see "From P2c"); the P2d2 plan fixes `insertSchedule`.
- NBP has no negative cache: a currency outside table A costs 8 requests (within the 5 s timeout) on every quote, and
  today's rate is fetched on every read until NBP publishes it (around noon on working days).
- `GET /api/accounts`, `GET /api/budget/:month` and auto-assign can wait up to 5 s per foreign currency for NBP when
  the cache can't answer; the quotes run in parallel.
- Bulk edits don't fetch NBP rates; they never change dates, so stored rates cover them.
- Accepted limitation: `fx_rate` is `numeric(14,6)`, so a currency quoted far below 1 zł loses precision. IDR's NBP mid
  0.00022236 is stored as 0.000222 (≈ 0.2 % off). This stays unless the rate scale is widened later (e.g. to 8
  decimals, with a migration of the three rate columns).
- P3: the transaction sheet pre-fills the rate from `GET /api/fx/rates/:currency/:date`, shows `fxRateManual`, and
  interleaves a loan's synthetic rows from `GET /api/accounts/:id/loan` by `chargedOn` (cleared per
  `chargesCleared`). The Record-payment amount is PLN; when the suggested cash account isn't PLN the sheet has to
  convert it.
- A loan with interest overrides counts as in use, so it can't be deleted (close it instead), like an account with
  transactions.
- FX revaluations and the account's starting balance are the only transactions written outside `planTransaction`
  (an amount of 0 with a PLN difference can't be planned); reconciliation adjustments go through it with
  `PlanContext.systemPayee`.
- P2d1 final fix pass, code (minors from the task reviews):
  - FINAL FIX PASS: the NBP answer is barely checked. Its `code` should equal the currency asked for, its
    `effectiveDate` the day requested (not just one on or before the date), and a mid that rounds to 0 at 6 decimals
    should mean "no rate".
  - FINAL FIX PASS: the default rates of a transaction write are keyed by currency only, so a race between the dry run
    and the command can book an NBP rate quoted for another date. Carry the quoted date and ignore defaults whose date
    isn't the draft's (→ `fx_rate_required`).
  - FINAL FIX PASS: Revalue and a same-day foreign account create quote today's rate twice (in the route and again in
    `readAccount`). Pass the fetched rate into `readAccount`.
  - FINAL FIX PASS: an interest override in a month without a payment is kept but unused, yet the month shows
    `interestOverridden: true` with `interest: 0`. Report it only when `chargedOn` is set, and refuse a new `PUT` for
    a month without a payment (422).
  - FINAL FIX PASS: a foreign loan's `interestBase` (interest × Σ payment base / Σ payments) isn't capped; a 1e13
    override with an extreme manual payment rate can pass `MAX_BASE_AMOUNT` (even 2^53). Recheck after the write and
    answer 422 `amount_too_large`.
  - FINAL FIX PASS: `loadLoanInfo` runs one query per loan for the last-used cash account (use `selectDistinct on`),
    and `loanBalances` runs three times per month view.
- P2d1 final fix pass, tests (minors from the task reviews):
  - FINAL FIX PASS: the NBP client's timeout budget shared by all fallback steps, and the weekend branch of
    `isFinal`.
  - FINAL FIX PASS: `fx.calls` on Revalue.
  - FINAL FIX PASS: later months' interest follows an overridden balance; an undo round trip of an override update;
    `GET /api/accounts/:id/loan` for a foreign loan.
  - FINAL FIX PASS: the panel of a foreign loan (the projected payment converted back from PLN, the minimum-payment
    fallback without a rate, `balanceBase`); a `fixed` debt target stays complete without a rate; a foreign card's
    minimum payment converted to PLN.
  - Reconcile: a transfer side and a split line's counterpart among the rows it marks reconciled; no NBP quote when
    no adjustment is made.
  - Loan payments: a positive starting balance and an FX revaluation don't count as payments (only the reconciliation
    adjustment has a test).
