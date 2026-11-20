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
- Targets:
  - `repeatUnit: 'year'`
  - the cycle start clamped to `startMonth`
  - an overdue `set_aside` target
- Auto-assign: the 12-month average window and half-away-from-zero rounding of averages.
- `transferBases` foreign → base with a `null` rate on the foreign side.

## Validation and behaviour
- `autoAssign` should throw when `month` isn't in the computed budget instead of treating it as empty.
- Validate the schedule anchor date (`nextOccurrence` returns an anchor ahead of `after` unchecked).
- Build a month-view adapter that creates `TargetContext` (carry, assigned, available, `assignedIn`, debt data incl.
  escrow) from a `BudgetResult`.
- Validate the sign of `TargetDef.amount`. Make a `null` spending `mode` default to `set_aside` explicitly.
- Document the sign conventions for each loan and target function. For example, `balanceAtMonthStart` and `debt`
  are negative for debt, and `projectPayoff` ignores the sign.
- Exclude the Uncategorized category, and any system category, from the auto-assign scope. The `spent_last_month`
  and `reset_available` strategies can produce an assignment for Uncategorized, which `computeBudget` rejects.
- Validate `TargetContext.debt` numbers (`minPayment`, `balanceAtMonthStart`, `escrow`) as safe integers at the
  server boundary or in `evaluateTarget`.

## Resolved in P2a
- Engine purity lint now also blocks dynamic `import()`, `globalThis.*`, `Date.now()`, `new Date()` and `Math.random()`.

## From P2a final review
- P2b2: v_ledger_line month is 'YYYY-MM-01' and the engine uses 'YYYY-MM' (adapter); any migration touching view
  columns must drop/recreate the view.
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
- P2b2: hide a credit card payment category automatically when its account is closed with Available = 0 (spec §10);
  it needs the budget read model. Closing currently only sets `account.closed`.
- P2b2: a paired loan category's `debt/min_payment` target reads `account.min_payment`, which PATCH can clear (null);
  the month view must treat null as 0.
- P2b2: reuse `budgetStartMonth()` and `MONTHS_AHEAD` from `src/server/budget/assignments.ts` for the month view and
  auto-assign, and `setAssigned`/`addAssigned` for auto-assign writes.
- P2c: deleting an account is refused while soft-deleted transactions still reference it; decide whether account
  deletion should purge soft-deleted history.
- P2c: undo/redo replays row by row (two queries per changed row); bulk operations over thousands of rows may need
  batching.
- P2d: foreign keys have no ON DELETE actions. Deleting a scheduled transaction must delete its
  `scheduled_subtransaction` rows and clear `transaction.scheduled_id` through the ChangeRecorder.
- P2d: the scheduled-transaction job writes outside `runCommand` (no undo entry, redo kept) but should hold
  `lockCommands()` (advisory key 727274002) so it can't interleave with an undo replay.
- P2d: `fxRate` is required to create a foreign-currency account; make it optional once the NBP lookup exists.
