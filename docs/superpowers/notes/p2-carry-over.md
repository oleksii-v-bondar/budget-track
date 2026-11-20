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
