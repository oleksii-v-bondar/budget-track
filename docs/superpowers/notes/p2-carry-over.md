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
- Cap the assignment month range server-side (e.g. no more than 24 months ahead). `computeBudget` widens its range
  to the latest assignment.
- Spec §10 allows deleting a closed card's payment category, but its historic card lines then make `computeBudget`
  throw ("has no payment category"). Either forbid the deletion or keep soft-deleted payment categories in the
  engine input.
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
- P2b first task: make every new router deny-by-default (`.use('*', requireSession)` on its own prefix) + a test
  walking `app.routes` expecting 401 for every /api route outside /api/auth.
- P2b: cast SQL sums `::bigint` (never `.mapWith(Number)`).
- P2b: DB cascades (scheduled_subtransaction ON DELETE CASCADE, transaction.scheduled_id SET NULL) bypass the undo
  ChangeRecorder; record children explicitly or remove the cascades.
- P2b: timestamps come from two clocks; exclude timestamps from undo conflict checks.
- P2b: exclude transfer/system payees from `payee_name_live`; add partial unique indexes on payee.system_kind, live
  category.linked_account_id, non-normal category_group.kind; seed system payees.
- P2b: category_group has no deleted_at but soft-deleted categories reference it; decide group deletion.
- P2b: v_ledger_line month is 'YYYY-MM-01' and the engine uses 'YYYY-MM' (adapter); any migration touching view
  columns must drop/recreate the view.
- P2b: enforce date ≤ today on write (§5.6); the view does not filter future dates.
- P2b: nested validation errors lose paths in z.flattenError; return issue paths for nested bodies (split lines).
- P2b: FK indexes on transaction.category_id/payee_id; `.$type<AccountClass>()` on account.accountClass and the view
  class columns.
- P2b: todayIn should use formatToParts instead of the en-CA format.
- P2b: ledger view test gaps (deleted split parent with live lines; amount ≠ amount_base).
- P2b: amend spec §4 "unless noted" for tables without timestamps.
- P2c: shutdown hardening (SIGTERM during migrations, close timeout, exit code on db close failure, `init: true` in
  compose).
- P2c: keep a registry of advisory-lock keys (login uses 727274001).
- P3: TOTP replay protection (store the last used timeStep).
- P3: /status should refresh the cookie; clear stale cookie on 401; Retry-After on 429; friendly .max messages.
- P3: global lockout DoS — amend spec (device cookies, count failures since last success/lockout) before internet
  exposure.
- P3: login-lock waiters hold pool connections — in-process mutex + lock_timeout.
- P3: rate-limit setup-token attempts.
- P3: CSP img-src blocks data: QR → render SVG; web tsconfig DOM lib; SPA fallback for non-/api paths; document single
  trusted proxy.
