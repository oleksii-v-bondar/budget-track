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

## From P2b1 final review
- P2b2: a snapshot round-trip (undo/redo) test matrix for every command: PATCH account with its rename cascade,
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
- P2c: the Budget screen's Activity tab needs the register API (transactions behind a category's monthly activity).
- P2c: transaction writes must keep a split parent's `amount_base` equal to the sum of its live lines: debt balances
  and "Need X to pay in full" read `transaction` (like account balances), while the budget reads `v_ledger_line`.
- P2d: a loan's `balanceAtMonthStart` (pay-off-by-date targets) is the PLN sum of its transactions; it ignores the
  synthetic interest and escrow rows of §8 until the loan engine (`computeLoanMonths`, interest overrides) is wired in.
- P2d: the loan panel of a paired category (balance, APR, minimum payment, projected payoff, Record payment); the month
  view only gives `linkedAccountId`.
- P2d: foreign-currency cards and loans: debt targets use `min_payment` and `escrow_amount` as PLN amounts, which is
  right only for PLN accounts.
- P2d / final review: cap target amounts (e.g. ≤ 1e13) in the targets API. `evaluateTarget` only checks that the
  amount is a safe integer, so a huge weekly target (2e15 on a weekday that occurs 5 times) makes `GET
  /api/budget/:month` return a raw `need`/`underfunded` above 2^53. Auto-assign already clamps it (see above).
- Later: `GET /api/budget/:month` takes ≈ 80 ms for 10 years × 150 categories (26k transactions) and ≈ 175 ms in a
  dense worst case (36k activity rows) on an M3 Max. If it matters, read the activity aggregate with `db.execute`
  (Drizzle's row mapping costs ≈ 30 ms per 36k rows) and profile `computeBudget`.
