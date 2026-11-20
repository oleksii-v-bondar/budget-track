# P2b2 — Budget Read Model, Targets and Auto-assign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Budget screen and its target and auto-assign actions: build the engine input from the ledger, evaluate targets (with credit card and loan debt data), expose `GET /api/budget/:month`, add the targets API with snooze, add auto-assign as one undoable command, and hide a closed card's settled payment category.

**Architecture:** Balances are computed on read (spec §2 "Read path"). `loadBudgetInput` turns SQL aggregates over `v_ledger_line` and the `assignment` table into the engine's `BudgetInput`. `loadBudgetMonth` checks the month range, runs `computeBudget` **once**, evaluates each category's target through a `TargetContext` adapter fed by the budget result and the linked credit/loan account, and builds the month DTO. The month view runs inside one read-only repeatable-read transaction. Commands that need the budget (auto-assign, closing a card) call the same functions with `rec.tx` inside `runCommand`, so they see the state they change under the command lock. Targets are written through the P2b1 `ChangeRecorder`, so every change is undoable. Request schemas and DTOs live in `src/shared/api/`.

**Tech Stack:** Node 22, TypeScript 6, Hono 4 + @hono/zod-validator, zod 4, Drizzle ORM 0.45, postgres.js 4, Postgres 16, Vitest 5, @testcontainers/postgresql 11. No new dependencies and no migration.

**Spec:** `docs/superpowers/specs/2026-11-19-core-budgeting-design.md` (§2 "Read path", §3, §5, §6, §7, §8 as debt targets need it, §10 "Categories" and "Accounts", §11 "Budget screen", §13, §14). P2b2 is the second half of P2b. P2c adds payees, transactions and the register; P2d adds scheduled transactions, reconciliation, NBP rates, loans and export; P3 is the web app.

**Starting point:** `main` with P2b1 (`docs/superpowers/plans/2026-11-21-p2b1-budget-structure.md`) merged; branch `p2b2-…` from `main` after the merge. Every code block below was verified against the P2b1 plan's code **plus P2b1 review fix `585b6ca`** ("keep pre-start assignment months editable; 404 before range checks"), which this plan builds on:
- `src/server/budget/assignments.ts` has a private `firstEditableMonth(db)`: the earliest of `budgetStartMonth()`, the earliest `assignment.month` and the earliest `month_note.month`. `assertBudgetMonth` uses it as the lower bound. Task 2 exports it, and the budget is computed from it.
- `idSchema` (`src/shared/api/common.ts`) lowercases ids, so ids in bodies and URLs compare equal regardless of letter case. Task 6 relies on that.
- Category checks (404 `not_found` / 422 `category_not_assignable`) run before the month range check; Tasks 5 and 6 follow the same order.

**Reconcile deltas:** further review fixes made while P2b1 was executed may change P2b1 code slightly. Where a patch below doesn't apply, or a P2b1 function has changed its signature or message, reconcile the small delta by hand: keep the P2b1 behaviour that landed and apply the P2b2 intent. Then adjust the expected totals by the number of tests P2b1 gained or lost. The baseline is `Test Files  36 passed (36)`, `Tests  351 passed (351)` (the P2b1 plan's 347 tests plus the 4 that `585b6ca` added).

## Global Constraints

Inherited from P2a and P2b1:
- Node `>=22`, npm, ESM. This machine has Node 22.14, so `@testcontainers/postgresql` must stay on `^11.14` (v12 pulls undici 8, which needs Node ≥ 22.19).
- TypeScript `strict` + `noUncheckedIndexedAccess`; `npm test`, `npm run typecheck` and `npm run lint` pass at the end of every task.
- Money is integer minor units: `bigint` columns in `mode: 'number'`; int8 values outside ±2^53 must throw, never lose precision.
- Calendar dates are `date` columns in `mode: 'string'` (`'YYYY-MM-DD'`); months are stored as the first day of the month (`'YYYY-MM-01'`).
- `src/engine/**` stays pure (no I/O, no Node modules, no `Date.now()`/`new Date()`/`Math.random()`); server code may use Node APIs.
- Error responses (spec §13): validation → 400 `{ code: "validation", message, fieldErrors, formErrors }`; `DomainError` → 422 `{ code, message }`; no session → 401 `unauthorized`; rate limited/locked → 429; unexpected → 500 `{ code: "internal", message: "Something went wrong.", requestId }`.
- Every mutating `/api` request must carry `X-Requested-With: budget-track` (403 `csrf` otherwise).
- "Today" and month boundaries use the configured `TZ` (default `Europe/Warsaw`) via an injected `Clock`.
- Testcontainers runs with Ryuk disabled (Docker Desktop's Enhanced Container Isolation blocks it); the global teardown stops the container.
- Every commit message ends with the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- Every user command goes through `runCommand` and writes only through its recorder (`rec.insert` / `rec.update` / `rec.delete`); it reads through `rec.tx`. Auth and settings changes don't use `runCommand` and aren't undoable.
- Every router outside `/api/auth` is mounted on its **own** prefix and starts with `.use('*', requireSession(deps))`. Routers are built by chaining, so `App` keeps every route for the Hono RPC client.
- Request schemas and the response DTO types the web app needs live in `src/shared/api/`.
- SQL sums are cast in SQL: `sum(x)::bigint` (never `.mapWith(Number)`).
- Status codes: edit → 200 with the DTO; delete → 200 `{ id }`; unknown or deleted resource in the URL → 404 `not_found`.
- Server tests use the P2a/P2b1 harness: `createTestDatabase()` per test (`beforeEach`), `createTestApp(db, { now })`, `setUpBudget(ctx)`, the `createAccount`/`createGroup`/`createCategory` fixtures, and `snapshot(db)` for undo round trips.
- Patches in this plan are shown as `git apply <<'PATCH' … PATCH` commands; run them from the repository root. (Making the same edits by hand is equivalent.)

New in P2b2:
- `computeBudget` input is built **only** by `loadBudgetInput` (`src/server/budget/budget-input.ts`). It starts at `firstEditableMonth()`, and only lines dated today or earlier count (spec §5.6).
- A request computes the budget **once**: `loadBudgetMonth` returns both the `BudgetResult` and the month DTO.
- Read-only routes that issue several queries run them in `db.transaction(fn, { isolationLevel: 'repeatable read', accessMode: 'read only' })`.
- Ready to Assign and Uncategorized never get an assignment: auto-assign scopes come from the month view, which lists neither.
- Tests insert transactions directly with the `insertTransaction(db, values)` fixture until P2c adds the transactions API.

## File Structure

```
src/shared/api/targets.ts                target kinds, TargetDto, TargetEvaluationDto, setTargetRequestSchema, snoozeTargetRequestSchema
src/shared/api/budget.ts                 (modified) month view DTOs (BudgetMonthDto, BudgetGroupDto, BudgetCategoryDto, RtaBreakdownDto,
                                         PillColor), AUTO_ASSIGN_STRATEGIES, autoAssignRequestSchema, AutoAssignResponse
src/server/budget/budget-input.ts        loadBudgetInput: ledger aggregates → engine BudgetInput
src/server/budget/budget-month.ts        loadBudgetMonth: one computeBudget → BudgetResult + BudgetMonthDto
src/server/budget/auto-assign.ts         autoAssignMonth (scope resolution + engine autoAssign + setAssigned), STRATEGY_LABELS
src/server/targets/target-model.ts       toTargetDto, targetContext, loadLinkedAccounts, evaluateCategoryTarget
src/server/targets/target-commands.ts    getTarget, setTarget, deleteTarget, snoozeTarget

Modified: src/engine/targets.ts, src/engine/autoAssign.ts, src/engine/loans.ts (docs), src/server/budget/assignments.ts,
src/server/budget/budget-routes.ts, src/server/categories/category-routes.ts, src/server/accounts/account-commands.ts,
src/server/accounts/account-routes.ts, src/server/test/fixtures.ts, the spec, engineering-notes.md, p2-carry-over.md

Tests: src/engine/targets.test.ts, src/engine/autoAssign.test.ts, src/server/budget/budget-input.test.ts,
src/server/targets/target-model.test.ts, src/server/budget/budget-month.test.ts, src/server/targets/target-routes.test.ts,
src/server/budget/auto-assign.test.ts, src/server/accounts/account-routes.test.ts, src/server/http/app.test.ts
```

## API added in P2b2

All routes need a session. Months are `YYYY-MM`; ids are UUIDs (a malformed one is a 400).

| Method and path | Body | Response |
|---|---|---|
| `GET /api/budget/:month` | – | 200 `BudgetMonthDto`; 422 `month_out_of_range` outside `firstEditableMonth` .. current month + 24 |
| `POST /api/budget/:month/auto-assign` | `{ strategy, scope: { type: 'all' } \| { type: 'group', id } \| { type: 'category', id } }` | 200 `{ assignments: AssignmentDto[] }` (the changed ones, with new amounts) |
| `PUT /api/categories/:id/target` | `SetTargetRequest` (discriminated by `kind`, then `cadence` or `debtMode`) | 200 `TargetDto` |
| `DELETE /api/categories/:id/target` | – | 200 `{ id }` (the category id); 404 without a target |
| `POST /api/categories/:id/target/snooze` | `{ month }` | 200 `TargetDto` |
| `DELETE /api/categories/:id/target/snooze` | – | 200 `TargetDto` |
| `POST /api/accounts/:id/close` (changed) | – | 200 `AccountDto`; a credit account's payment category is hidden when its Available is 0 |

`BudgetMonthDto`:

```ts
{
  month, budgetStartMonth, firstMonth, currentMonth, lastMonth,   // 'YYYY-MM'; the month switcher runs firstMonth .. lastMonth
  note: string | null,
  rta: { leftoverPrev, income, assignedThisMonth, assignedFuture, cashOverspentPrev, leftover, readyToAssign },
  groups: [{ id, name, kind, hidden, categories: BudgetCategoryDto[] }],   // every live group except Internal, in order
  uncategorized: BudgetCategoryDto | null,            // only with activity or money in the month
}
BudgetCategoryDto = {
  id, name, kind /* normal | cc_payment | debt_payment | uncategorized */, hidden, note, linkedAccountId,
  carry, assigned, activity, available, cashOverspent, creditOverspent, pill /* red | yellow | green | grey */,
  target: TargetDto | null,
  targetEvaluation: { need, underfunded, progress, overfunded, snoozed, incomplete } | null,
  needToPayInFull: number | null,                     // credit card payment categories only
}
```

---

### Task 1: Engine — validate target inputs; auto-assign needs a computed month

P2 carry-over items for the engine functions this plan puts behind the API:
- `evaluateTarget` rejects a target amount that isn't a safe integer ≥ 0. It also checks the debt numbers: `minPayment` and `escrow` must be safe integers ≥ 0, and `balanceAtMonthStart` a safe integer.
- A `null` spending mode is `set_aside` explicitly.
- The sign conventions of the target and loan functions are documented.
- `autoAssign` throws for a month that isn't in the computed budget, instead of treating it as empty.
- Tests close the carry-over gaps for `repeatUnit: 'year'`, a cycle start clamped to `startMonth`, an overdue set-aside target, and the 12-month average window with half-away-from-zero rounding. Those four pin behaviour that already works.

**Files:**
- Modify: `src/engine/targets.ts`, `src/engine/autoAssign.ts`, `src/engine/loans.ts` (comments only)
- Test: `src/engine/targets.test.ts`, `src/engine/autoAssign.test.ts`

**Interfaces:**
- Consumes: `assertMoney` from `src/engine/money.ts`.
- Produces (signatures unchanged):
  - `evaluateTarget(t, ctx)` throws `Target amount must be a safe integer amount, got X`, `Target amount must be ≥ 0, got X`, `debt.minPayment|debt.balanceAtMonthStart|debt.escrow must be a safe integer amount, got X` and `debt.minPayment|debt.escrow must be ≥ 0, got X`.
  - `autoAssign(args)` throws `autoAssign: month YYYY-MM is not in the computed budget`.

- [ ] **Step 1: Write the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/engine/autoAssign.test.ts b/src/engine/autoAssign.test.ts
index 3bb45dd..ac3641a 100644
--- a/src/engine/autoAssign.test.ts
+++ b/src/engine/autoAssign.test.ts
@@ -2,6 +2,7 @@ import { describe, expect, it } from 'vitest';
 import { autoAssign } from './autoAssign';
 import { computeBudget } from './budget/compute';
 import { RTA, assign, budgetInput, cashLine, category } from './budget/test-helpers';
+import { monthRange } from './dates';
 
 // Jan: assigned groceries 30 000 / rent 100 000, spent groceries 25 000 / rent 100 000.
 // Feb: assigned groceries 50 000 / rent 100 000, spent groceries 45 000 / rent 100 000.
@@ -100,6 +101,33 @@ describe('autoAssign', () => {
     ]);
   });
 
+  it('averages over at most the 12 previous months and rounds half away from zero', () => {
+    // 2025-01 is outside the 12-month window of 2026-02. The window holds eleven months of 100 and one of 106:
+    // 1 206 / 12 = 100.5, which rounds to 101 for Assigned and to −101 for Activity (so 101 spent).
+    const amountIn = (m: string) => (m === '2025-01' ? 1_000_000 : m === '2025-06' ? 106 : 100);
+    const months = monthRange('2025-01', '2026-01');
+    const long = computeBudget(
+      budgetInput({
+        startMonth: '2025-01',
+        throughMonth: '2026-02',
+        categories: [category('groceries')],
+        assignments: months.map((m) => assign(m, 'groceries', amountIn(m))),
+        activity: months.map((m) => cashLine(m, 'groceries', -amountIn(m))),
+      }),
+    );
+    for (const strategy of ['average_assigned', 'average_spent'] as const) {
+      expect(autoAssign({ strategy, month: '2026-02', categoryIds: ['groceries'], budget: long })).toEqual([
+        { categoryId: 'groceries', from: 0, to: 101 },
+      ]);
+    }
+  });
+
+  it('rejects a month outside the computed budget', () => {
+    expect(() => autoAssign({ strategy: 'reset_assigned', month: '2026-04', categoryIds: all, budget })).toThrow(
+      'autoAssign: month 2026-04 is not in the computed budget',
+    );
+  });
+
   it('rejects underfunded amounts that are not safe integers', () => {
     const run = (underfunded: Record<string, number>) =>
       autoAssign({ strategy: 'underfunded', month: '2026-03', categoryIds: all, budget, underfunded });
diff --git a/src/engine/targets.test.ts b/src/engine/targets.test.ts
index 185cf7c..42d8d6a 100644
--- a/src/engine/targets.test.ts
+++ b/src/engine/targets.test.ts
@@ -88,6 +88,26 @@ describe('spending targets: yearly and custom', () => {
     expect(evaluateTarget(once, ctx({ month: '2026-05', carry: 30_000 }))?.need).toBe(20_000);
   });
 
+  it('custom: repeats every N years', () => {
+    // Due 2026-06 and every two years after: from 2026-08 the next due month is 2028-06, 23 months away.
+    const biennial = target({ cadence: 'custom', amount: 230_000, dueDate: '2026-06-15', repeatUnit: 'year', repeatEvery: 2 });
+    expect(evaluateTarget(biennial, ctx({ month: '2026-08' }))?.need).toBe(10_000);
+    const assignedIn = (m: string) => (m === '2026-07' ? 23_000 : 0);
+    expect(evaluateTarget(biennial, ctx({ month: '2026-08', assignedIn }))?.need).toBe(9_000);
+  });
+
+  it('set aside: a cycle never starts before the target start month', () => {
+    // The cycle after the 2025-12 due date would start in 2026-01, but the target only starts in 2026-06.
+    const t = target({ cadence: 'yearly', amount: 120_000, dueDate: '2025-12-15', startMonth: '2026-06' });
+    expect(evaluateTarget(t, ctx({ month: '2026-08', assignedIn: () => 10_000 }))?.need).toBe(20_000);
+  });
+
+  it('set aside: an overdue target without repeat needs what is left of the amount now', () => {
+    const once = target({ cadence: 'custom', amount: 50_000, dueDate: '2026-03-10' });
+    const assignedIn = (m: string) => (m < '2026-05' ? 10_000 : 0);
+    expect(evaluateTarget(once, ctx({ month: '2026-05', assignedIn }))).toMatchObject({ need: 10_000, underfunded: 10_000 });
+  });
+
   it.each([0, -1])('custom: rejects repeatEvery %i instead of looping forever', (repeatEvery) => {
     const t = target({ cadence: 'custom', amount: 30_000, dueDate: '2026-03-10', repeatUnit: 'month', repeatEvery });
     expect(() => evaluateTarget(t, ctx({ month: '2026-05' }))).toThrow(
@@ -175,6 +195,37 @@ describe('snooze, overfunding and inactive months', () => {
   });
 });
 
+describe('input validation', () => {
+  const debtTarget = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: 'min_payment' });
+  const debt = { minPayment: 20_000, apr: '12', balanceAtMonthStart: -1_200_000 };
+
+  it.each([1.5, '100' as unknown as number, 2 ** 53])('rejects a target amount of %s', (amount) => {
+    expect(() => evaluateTarget(target({ amount }), ctx({}))).toThrow(
+      `Target amount must be a safe integer amount, got ${amount}`,
+    );
+  });
+
+  it('rejects a negative target amount', () => {
+    expect(() => evaluateTarget(target({ amount: -1 }), ctx({}))).toThrow('Target amount must be ≥ 0, got -1');
+  });
+
+  it('rejects debt numbers that are not safe integers', () => {
+    const run = (patch: object) => () => evaluateTarget(debtTarget, ctx({ debt: { ...debt, ...patch } }));
+    expect(run({ minPayment: 1.5 })).toThrow('debt.minPayment must be a safe integer amount, got 1.5');
+    expect(run({ balanceAtMonthStart: '-5' })).toThrow('debt.balanceAtMonthStart must be a safe integer amount, got -5');
+    expect(run({ escrow: 2 ** 53 })).toThrow(`debt.escrow must be a safe integer amount, got ${2 ** 53}`);
+  });
+
+  it('rejects a negative minimum payment or escrow', () => {
+    expect(() => evaluateTarget(debtTarget, ctx({ debt: { ...debt, minPayment: -1 } }))).toThrow(
+      'debt.minPayment must be ≥ 0, got -1',
+    );
+    expect(() => evaluateTarget(debtTarget, ctx({ debt: { ...debt, escrow: -1 } }))).toThrow(
+      'debt.escrow must be ≥ 0, got -1',
+    );
+  });
+});
+
 describe('pillColor', () => {
   const cm = { available: 0, cashOverspent: 0, creditOverspent: 0 };
   const met = { need: 100, underfunded: 0, progress: 1, overfunded: false, snoozed: false };
PATCH
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/engine/targets.test.ts src/engine/autoAssign.test.ts`
Expected: FAIL with `Tests  7 failed | 43 passed (50)`. Nothing throws yet (`expected [Function] to throw an error`) in the six `input validation` tests (three come from one `it.each`) or in `rejects a month outside the computed budget`. The four carry-over gap tests already pass.

- [ ] **Step 3: Validate target inputs**

```bash
git apply <<'PATCH'
diff --git a/src/engine/targets.ts b/src/engine/targets.ts
index edf68e3..b6ea2c1 100644
--- a/src/engine/targets.ts
+++ b/src/engine/targets.ts
@@ -1,13 +1,14 @@
 import { addMonths, countWeekdayInMonth, monthDiff, monthOf, monthRange } from './dates';
 import { amortizedPayment } from './loans';
-import { ceilDiv } from './money';
+import { assertMoney, ceilDiv } from './money';
 import type { IsoDate, Money, Month } from './types';
 
 export interface TargetDef {
   kind: 'spending' | 'balance' | 'debt';
   cadence: 'weekly' | 'monthly' | 'yearly' | 'custom' | 'none';
+  /** The target amount A, ≥ 0. Debt targets use it only in `fixed` mode. */
   amount: Money;
-  /** Spending targets: "set aside another X" or "refill up to X". */
+  /** Spending targets: "set aside another X" or "refill up to X"; null means set_aside. */
   mode: 'set_aside' | 'refill' | null;
   /** 0 = Sunday … 6 = Saturday. */
   dueWeekday: number | null;
@@ -28,7 +29,13 @@ export interface TargetContext {
   available: Money;
   /** Assigned amount of this category in another month (used for set-aside cycles). */
   assignedIn: (month: Month) => Money;
-  /** Linked credit/loan account data; required for debt targets. `escrow` (loans only) defaults to 0. */
+  /**
+   * Linked credit/loan account data; required for debt targets.
+   * - `minPayment` (≥ 0): the account's minimum payment.
+   * - `apr`: the account's APR in percent, e.g. "6.5".
+   * - `balanceAtMonthStart`: the account balance before `month`, negative while money is owed.
+   * - `escrow` (≥ 0, loans only, default 0): added to pay-off-by-date payments.
+   */
   debt?: { minPayment: Money; apr: string; balanceAtMonthStart: Money; escrow?: Money };
 }
 
@@ -45,6 +52,22 @@ export type PillColor = 'red' | 'yellow' | 'green' | 'grey';
 
 const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
 
+const spendingMode = (t: TargetDef) => t.mode ?? 'set_aside';
+
+function assertNonNegativeMoney(value: Money, field: string): void {
+  assertMoney(value, field);
+  if (value < 0) throw new Error(`${field} must be ≥ 0, got ${value}`);
+}
+
+function assertInputs(t: TargetDef, ctx: TargetContext): void {
+  assertNonNegativeMoney(t.amount, 'Target amount');
+  if (ctx.debt) {
+    assertNonNegativeMoney(ctx.debt.minPayment, 'debt.minPayment');
+    assertMoney(ctx.debt.balanceAtMonthStart, 'debt.balanceAtMonthStart');
+    assertNonNegativeMoney(ctx.debt.escrow ?? 0, 'debt.escrow');
+  }
+}
+
 /** Months from `month` to `dueMonth` inclusive, at least 1 (overdue targets are due now). */
 function monthsLeft(month: Month, dueMonth: Month): number {
   return Math.max(1, monthDiff(month, dueMonth) + 1);
@@ -93,7 +116,7 @@ function computeNeed(t: TargetDef, ctx: TargetContext): Money {
     }
     const { dueMonth, cycleStart } = dueCycle(t, ctx.month);
     const fundedBefore =
-      t.mode === 'refill'
+      spendingMode(t) === 'refill'
         ? ctx.carry
         : monthRange(cycleStart, addMonths(ctx.month, -1)).reduce((s, m) => s + ctx.assignedIn(m), 0);
     return ceilDiv(Math.max(0, t.amount - fundedBefore), monthsLeft(ctx.month, dueMonth));
@@ -111,14 +134,18 @@ function computeNeed(t: TargetDef, ctx: TargetContext): Money {
   return principal === 0 ? 0 : payment + (ctx.debt.escrow ?? 0);
 }
 
-/** Evaluates a category's target for `ctx.month`; null when the target hasn't started yet. */
+/**
+ * Evaluates a category's target for `ctx.month`; null when the target hasn't started yet. Every amount is ≥ 0 except
+ * `ctx.debt.balanceAtMonthStart` (negative for debt) and the category's carry/assigned/available.
+ */
 export function evaluateTarget(t: TargetDef, ctx: TargetContext): TargetEval | null {
+  assertInputs(t, ctx);
   if (ctx.month < t.startMonth) return null;
   const need = computeNeed(t, ctx);
   let underfunded: Money;
   if (t.kind === 'balance' && !t.dueDate) {
     underfunded = Math.max(0, t.amount - ctx.available);
-  } else if (t.kind === 'spending' && t.mode === 'refill' && (t.cadence === 'weekly' || t.cadence === 'monthly')) {
+  } else if (t.kind === 'spending' && spendingMode(t) === 'refill' && (t.cadence === 'weekly' || t.cadence === 'monthly')) {
     underfunded = Math.max(0, need - ctx.carry - ctx.assigned);
   } else {
     underfunded = Math.max(0, need - ctx.assigned);
PATCH
```

- [ ] **Step 4: Require a computed month in `autoAssign` and document the loan signs**

```bash
git apply <<'PATCH'
diff --git a/src/engine/autoAssign.ts b/src/engine/autoAssign.ts
index 658968f..0c7d946 100644
--- a/src/engine/autoAssign.ts
+++ b/src/engine/autoAssign.ts
@@ -49,12 +49,17 @@ function average(values: Money[]): Money {
   return Number(roundDiv(BigInt(values.reduce((s, v) => s + v, 0)), BigInt(values.length)));
 }
 
-/** Computes new assigned amounts for `month`; returns only categories whose amount changes. */
+/**
+ * Computes new assigned amounts for `month`, which must be in `budget`; returns only categories whose amount changes.
+ * Callers leave system categories out of `categoryIds`: `computeBudget` refuses assignments to Uncategorized.
+ */
 export function autoAssign(args: AutoAssignArgs): AssignmentChange[] {
   const { budget, month, strategy } = args;
+  const current = budget.byMonth[month];
+  if (!current) throw new Error(`autoAssign: month ${month} is not in the computed budget`);
   const last = addMonths(month, -1);
   const history = previousMonths(budget, month);
-  let remaining = budget.byMonth[month]?.rta.readyToAssign ?? 0;
+  let remaining = current.rta.readyToAssign;
   if (strategy === 'underfunded' && !args.underfunded) throw new Error('The underfunded strategy needs underfunded amounts');
   for (const [categoryId, amount] of Object.entries(args.underfunded ?? {})) {
     assertMoney(amount, `underfunded.${categoryId}`);
diff --git a/src/engine/loans.ts b/src/engine/loans.ts
index 422a286..8deaca4 100644
--- a/src/engine/loans.ts
+++ b/src/engine/loans.ts
@@ -17,7 +17,10 @@ function interestAt(balance: Money, scaledApr: bigint): Money {
   return Number(roundDiv(BigInt(Math.abs(balance)) * scaledApr, MONTHLY_APR_DIVISOR));
 }
 
-/** Interest for one month: |balance| × APR / 12, rounded half away from zero. `apr` is a percentage, e.g. "6.5". */
+/**
+ * Interest for one month: |balance| × APR / 12, rounded half away from zero, so ≥ 0 whatever the balance's sign.
+ * `apr` is a percentage, e.g. "6.5".
+ */
 export function monthlyInterest(balance: Money, apr: string): Money {
   return interestAt(balance, parseApr(apr));
 }
@@ -64,6 +67,7 @@ export function amortizedPayment(principal: Money, apr: string, months: number):
 
 export interface LoanParams {
   apr: string;
+  /** ≥ 0; charged in months with a payment. */
   escrow: Money;
   interestOverrides?: Record<Month, Money>;
 }
@@ -89,6 +93,7 @@ export interface LoanMonth {
 /**
  * Rolls a loan account forward month by month (ascending; months without transactions may be omitted).
  * Interest and escrow are charged only in months with a payment; principal paid = payments − interest − escrow.
+ * Balances are negative while money is owed; interest and escrow are ≥ 0 and lower the balance.
  */
 export function computeLoanMonths(params: LoanParams, months: LoanMonthInput[]): LoanMonth[] {
   const scaledApr = parseApr(params.apr);
PATCH
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/engine/targets.test.ts src/engine/autoAssign.test.ts`
Expected: `Tests  50 passed (50)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  36 passed (36)`, `Tests  362 passed (362)`; both checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine
git commit -m "feat(engine): validate target inputs; auto-assign needs a computed month" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Engine input from the ledger

Spec §2 "Read path", §3, §5.1, §5.3–§5.6. `loadBudgetInput` builds `BudgetInput` exactly as `src/engine/budget/types.ts` documents:
- **Activity:** Σ `amount_base` per (month, category, account) of on-budget lines dated today or earlier.
  - It includes categorized lines, split lines, and categorized transfers to tracking accounts (loan payments).
  - Lines without a category that are neither transfers nor starting balances go to Uncategorized.
  - It leaves out budget↔budget transfers and credit starting balances; tracking accounts are never on-budget.
  - Rows come in account display order, because the engine splits credit-overspending ties in input order.
- **Card transfers:** the card side of transfers between a credit account and any on-budget account.
- **Assignments, categories, Ready to Assign:** assignments come from `assignment`. The categories are every live category except Ready to Assign, whose id is passed separately. Credit card payment categories carry their account; paired loan categories are `normal` to the engine.
- **Months:** months become `'YYYY-MM'` and every sum is `::bigint`.

**Start month.** The input starts at `firstEditableMonth()` (P2b1 fix `585b6ca`, exported here), not at `budgetStartMonth()`. The budget start can move later when the only early account is deleted, and in P2c when transactions are. An assignment or month note left before it keeps its month editable, and that assignment still lowers Ready to Assign. Starting the computation there keeps every month that `assertBudgetMonth` allows in the result, and so `computeBudget` never gets a `throughMonth` before its `startMonth`.

**Files:**
- Create: `src/server/budget/budget-input.ts`
- Modify: `src/server/budget/assignments.ts` (export `firstEditableMonth`), `src/server/test/fixtures.ts`
- Test: `src/server/budget/budget-input.test.ts`

**Interfaces:**
- Consumes:
  - from `src/engine`: `BudgetInput`, `BudgetCategory`, `monthOf`
  - from P2b1: `categoryKindOf`, `firstEditableMonth`, the `ledgerLine` view, the `account`, `assignment`, `category` and `categoryGroup` tables
- Produces:
  - `loadBudgetInput(db: Executor, opts: { throughMonth: Month; today: IsoDate }): Promise<BudgetInput>`: `startMonth` = `firstEditableMonth(db)`, `throughMonth` as given (the engine widens to later assignment months).
  - `export async function firstEditableMonth(db: Executor): Promise<Month>` (unchanged behaviour, now exported).
  - Test fixture `insertTransaction(db: Db, values: NewTransaction): Promise<TransactionRow>` (`amountBase` defaults to `amount`) and the type `NewTransaction`.

- [ ] **Step 1: Write the test fixture and the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/server/test/fixtures.ts b/src/server/test/fixtures.ts
index 836ef27..3ff5cbc 100644
--- a/src/server/test/fixtures.ts
+++ b/src/server/test/fixtures.ts
@@ -1,5 +1,7 @@
 import type { AccountDto, CreateAccountRequest } from '../../shared/api/accounts';
 import type { CategoryDto, CategoryGroupDto } from '../../shared/api/categories';
+import type { Db } from '../db/client';
+import { transaction } from '../db/schema';
 import type { TestClient } from './http-client';
 
 async function created<T>(res: Response, what: string): Promise<T> {
@@ -23,3 +25,15 @@ export async function createGroup(client: TestClient, name: string): Promise<Cat
 export async function createCategory(client: TestClient, groupId: string, name: string): Promise<CategoryDto> {
   return created(await client.post('/api/categories', { groupId, name }), 'createCategory');
 }
+
+export type NewTransaction = Partial<typeof transaction.$inferInsert> &
+  Pick<typeof transaction.$inferInsert, 'accountId' | 'date' | 'amount'>;
+
+/** Inserts a transaction straight into the database (the transactions API is P2c); `amountBase` defaults to `amount`. */
+export async function insertTransaction(db: Db, values: NewTransaction): Promise<typeof transaction.$inferSelect> {
+  const [row] = await db
+    .insert(transaction)
+    .values({ amountBase: values.amount, ...values })
+    .returning();
+  return row!;
+}
PATCH
```

Create `src/server/budget/budget-input.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ActivityRow, type BudgetCategory, computeBudget } from '../../engine';
import type { AccountDto } from '../../shared/api/accounts';
import type { CategoryDto } from '../../shared/api/categories';
import { systemCategoryId } from '../db/lookups';
import { subtransaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, insertTransaction, type NewTransaction } from '../test/fixtures';
import { loadBudgetInput } from './budget-input';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  // Setup on 20 November 2026 makes 2026-11 the configured budget start month.
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

const TODAY = '2026-11-20';

const txn = (values: NewTransaction) => insertTransaction(t.db, values);

/** Both sides of a transfer of `amount` from `from` to `to`, optionally categorized on either side. */
async function transfer(
  from: AccountDto,
  to: AccountDto,
  date: string,
  amount: number,
  category: { from?: string; to?: string } = {},
) {
  const out = await txn({ accountId: from.id, date, amount: -amount, transferAccountId: to.id, categoryId: category.from });
  await txn({ accountId: to.id, date, amount, transferAccountId: from.id, transferTxnId: out.id, categoryId: category.to });
}

const assign = (month: string, categoryId: string, amount: number) =>
  ctx.client.send('PUT', `/api/budget/${month}/assignments/${categoryId}`, { amount });

describe('loadBudgetInput', () => {
  it('aggregates the ledger into engine input (spec §5.1, §5.3, §5.5)', async () => {
    const checking = await createAccount(ctx.client, {
      name: 'Checking',
      startingBalance: 500_000,
      startingDate: '2026-10-01',
    });
    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
    const visa = await createAccount(ctx.client, {
      name: 'Visa',
      type: 'credit_card',
      startingBalance: -37_500,
      startingDate: '2026-10-01',
    });
    const mortgage = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      startingBalance: -10_000_000,
      minPayment: 60_000,
      createPairedCategory: true,
    });
    const brokerage = await createAccount(ctx.client, { name: 'Brokerage', type: 'other_asset', startingBalance: 90_000 });
    const group = await createGroup(ctx.client, 'Everyday');
    const groceries = await createCategory(ctx.client, group.id, 'Groceries');
    const rent = await createCategory(ctx.client, group.id, 'Rent');
    const rta = await systemCategoryId(t.db, 'rta');
    const uncategorized = await systemCategoryId(t.db, 'uncategorized');

    await txn({ accountId: checking.id, date: '2026-10-05', amount: -30_000, categoryId: groceries.id });
    await txn({ accountId: checking.id, date: '2026-11-03', amount: -8_000, categoryId: groceries.id });
    await txn({ accountId: visa.id, date: '2026-11-04', amount: -5_000, categoryId: groceries.id });
    await txn({ accountId: visa.id, date: '2026-11-06', amount: 1_500, categoryId: groceries.id, memo: 'refund' });
    const split = await txn({ accountId: checking.id, date: '2026-11-07', amount: -5_000, isSplit: true });
    await t.db.insert(subtransaction).values([
      { txnId: split.id, amount: -3_000, amountBase: -3_000, categoryId: groceries.id },
      { txnId: split.id, amount: -2_000, amountBase: -2_000, categoryId: rent.id },
    ]);
    await txn({ accountId: checking.id, date: '2026-11-08', amount: -1_000 });
    await transfer(checking, visa, '2026-11-10', 10_000);
    await transfer(checking, savings, '2026-11-11', 20_000);
    await transfer(checking, mortgage, '2026-11-12', 60_000, { from: mortgage.pairedCategoryId! });
    await transfer(brokerage, checking, '2026-11-13', 5_000, { to: rta });
    await txn({ accountId: visa.id, date: '2026-11-14', amount: 200, categoryId: rta, memo: 'cashback' });
    await txn({ accountId: checking.id, date: '2026-11-21', amount: -999, categoryId: groceries.id });
    await txn({ accountId: checking.id, date: '2026-11-15', amount: -777, categoryId: groceries.id, deletedAt: new Date() });
    await assign('2026-11', groceries.id, 40_000);
    await assign('2026-11', visa.paymentCategoryId!, 5_000);
    await assign('2026-12', rent.id, 100_000);

    const input = await loadBudgetInput(t.db, { throughMonth: '2026-11', today: TODAY });

    const names = new Map<string, string>([
      [rta, 'RTA'],
      [uncategorized, 'Uncategorized'],
      [groceries.id, 'Groceries'],
      [rent.id, 'Rent'],
      [mortgage.pairedCategoryId!, 'Mortgage (paired)'],
      [visa.paymentCategoryId!, 'Visa (payment)'],
      [checking.id, 'Checking'],
      [savings.id, 'Savings'],
      [visa.id, 'Visa'],
    ]);
    const name = (id: string) => names.get(id) ?? id;
    expect(input).toMatchObject({ startMonth: '2026-10', throughMonth: '2026-11', rtaCategoryId: rta });
    const described = (c: BudgetCategory) => `${name(c.id)} ${c.kind} ${c.linkedAccountId ? name(c.linkedAccountId) : '-'}`;
    expect(input.categories.map(described).sort()).toEqual([
      'Groceries normal -',
      'Mortgage (paired) normal -',
      'Rent normal -',
      'Uncategorized uncategorized -',
      'Visa (payment) cc_payment Visa',
    ]);
    const line = (r: ActivityRow) => `${r.month} ${name(r.categoryId)} ${name(r.accountId)} ${r.accountClass} ${r.amount}`;
    expect(input.activity.map(line).sort()).toEqual([
      // Cash starting balances are income (Savings starts at 0); the credit and tracking ones are left out.
      '2026-10 Groceries Checking cash -30000',
      '2026-10 RTA Checking cash 500000',
      // Cash spending plus the split line; card spending net of the refund.
      '2026-11 Groceries Checking cash -11000',
      '2026-11 Groceries Visa credit -3500',
      // The categorized transfer to the mortgage counts; its tracking side and checking → savings don't.
      '2026-11 Mortgage (paired) Checking cash -60000',
      '2026-11 RTA Checking cash 5000',
      '2026-11 RTA Savings cash 0',
      '2026-11 RTA Visa credit 200',
      '2026-11 Rent Checking cash -2000',
      '2026-11 Uncategorized Checking cash -1000',
    ]);
    expect(input.cardTransfers).toEqual([{ month: '2026-11', cardAccountId: visa.id, amount: 10_000 }]);
    expect(input.assignments.map((a) => `${a.month} ${name(a.categoryId)} ${a.amount}`).sort()).toEqual([
      '2026-11 Groceries 40000',
      '2026-11 Visa (payment) 5000',
      '2026-12 Rent 100000',
    ]);
    // The engine accepts it as is.
    expect(computeBudget(input).months).toEqual(['2026-10', '2026-11', '2026-12']);
  });

  it('reproduces golden scenario 1 end to end (spec §14)', async () => {
    // Available 100, cash spend 80, card spend 50 → Available −30 yellow (creditOver 30); card payment +20.
    const checking = await createAccount(ctx.client, { name: 'Checking' });
    const visa = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const group = await createGroup(ctx.client, 'Everyday');
    const groceries: CategoryDto = await createCategory(ctx.client, group.id, 'Groceries');
    await assign('2026-11', groceries.id, 10_000);
    await txn({ accountId: checking.id, date: '2026-11-05', amount: -8_000, categoryId: groceries.id });
    await txn({ accountId: visa.id, date: '2026-11-06', amount: -5_000, categoryId: groceries.id });

    const server = computeBudget(await loadBudgetInput(t.db, { throughMonth: '2026-11', today: TODAY }));
    const uncategorized = await systemCategoryId(t.db, 'uncategorized');
    const engine = computeBudget({
      startMonth: '2026-11',
      throughMonth: '2026-11',
      rtaCategoryId: await systemCategoryId(t.db, 'rta'),
      categories: [
        { id: groceries.id, kind: 'normal' },
        { id: visa.paymentCategoryId!, kind: 'cc_payment', linkedAccountId: visa.id },
        { id: uncategorized, kind: 'uncategorized' },
      ],
      assignments: [{ month: '2026-11', categoryId: groceries.id, amount: 10_000 }],
      activity: [
        { month: '2026-11', categoryId: groceries.id, accountId: checking.id, accountClass: 'cash', amount: -8_000 },
        { month: '2026-11', categoryId: groceries.id, accountId: visa.id, accountClass: 'credit', amount: -5_000 },
      ],
    });
    expect(server).toEqual(engine);
    expect(server.byMonth['2026-11']!.categories[groceries.id]).toMatchObject({
      available: -3_000,
      cashOverspent: 0,
      creditOverspent: 3_000,
      creditOverByCard: { [visa.id]: 3_000 },
    });
    expect(server.byMonth['2026-11']!.categories[visa.paymentCategoryId!]).toMatchObject({
      activity: 2_000,
      available: 2_000,
    });
  });

  it('counts lines dated up to today only', async () => {
    const checking = await createAccount(ctx.client, { name: 'Checking' });
    const group = await createGroup(ctx.client, 'Everyday');
    const groceries = await createCategory(ctx.client, group.id, 'Groceries');
    await txn({ accountId: checking.id, date: '2026-11-20', amount: -100, categoryId: groceries.id });
    await txn({ accountId: checking.id, date: '2026-11-21', amount: -200, categoryId: groceries.id });
    const amounts = async (today: string) =>
      (await loadBudgetInput(t.db, { throughMonth: '2026-11', today })).activity
        .filter((r) => r.categoryId === groceries.id)
        .map((r) => r.amount);
    expect(await amounts('2026-11-20')).toEqual([-100]);
    expect(await amounts('2026-11-21')).toEqual([-300]);
  });

  it('starts at the first editable month: an assignment or a note left before the budget start', async () => {
    const cash = await createAccount(ctx.client, { name: 'Cash', type: 'cash', startingDate: '2026-01-15' });
    const group = await createGroup(ctx.client, 'Everyday');
    const groceries = await createCategory(ctx.client, group.id, 'Groceries');
    expect((await ctx.client.send('PUT', '/api/budget/2026-01/note', { note: 'New year' })).status).toBe(200);
    expect((await assign('2026-03', groceries.id, 1_000)).status).toBe(200);
    expect((await ctx.client.send('DELETE', `/api/accounts/${cash.id}`)).status).toBe(200);
    const start = async () => (await loadBudgetInput(t.db, { throughMonth: '2026-11', today: TODAY })).startMonth;

    // The budget start is 2026-11 again, but the note and the assignment keep their months in the budget.
    expect(await start()).toBe('2026-01');
    expect((await ctx.client.send('PUT', '/api/budget/2026-01/note', { note: '' })).status).toBe(200);
    expect(await start()).toBe('2026-03');
    expect((await assign('2026-03', groceries.id, 0)).status).toBe(200);
    expect(await start()).toBe('2026-11');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/budget/budget-input.test.ts`
Expected: FAIL with `Error: Cannot find module './budget-input' imported from …/src/server/budget/budget-input.test.ts` (`Test Files  1 failed (1)`, no tests run).

- [ ] **Step 3: Export the first editable month**

```bash
git apply <<'PATCH'
diff --git a/src/server/budget/assignments.ts b/src/server/budget/assignments.ts
index 022456e..e9f6247 100644
--- a/src/server/budget/assignments.ts
+++ b/src/server/budget/assignments.ts
@@ -30,9 +30,9 @@ const earliestMonth = (dates: (IsoDate | null | undefined)[]): Month =>
 
 /**
  * The budget start can move later (e.g. when the only early account is deleted); earlier months that still hold an
- * assignment or a note stay editable so those rows can be changed or cleared.
+ * assignment or a note stay editable so those rows can be changed or cleared. The budget is computed from here.
  */
-async function firstEditableMonth(db: Executor): Promise<Month> {
+export async function firstEditableMonth(db: Executor): Promise<Month> {
   const [held] = await db.select({ date: sql<IsoDate | null>`min(${assignment.month})` }).from(assignment);
   const [noted] = await db.select({ date: sql<IsoDate | null>`min(${monthNote.month})` }).from(monthNote);
   return earliestMonth([monthStart(await budgetStartMonth(db)), held?.date, noted?.date]);
PATCH
```

- [ ] **Step 4: Write the aggregation**

Create `src/server/budget/budget-input.ts`:

```ts
import { and, asc, eq, inArray, isNotNull, isNull, lte, not, or, sql } from 'drizzle-orm';
import { type BudgetCategory, type BudgetInput, type IsoDate, type Month, monthOf } from '../../engine';
import { categoryKindOf } from '../categories/category-queries';
import type { Executor } from '../db/client';
import { account, assignment, category, categoryGroup, ledgerLine } from '../db/schema';
import { firstEditableMonth } from './assignments';

/** A transfer between two on-budget accounts (cash or credit): budget-neutral, so never activity (spec §5.5). */
const isBudgetTransfer = sql`(${ledgerLine.isTransfer} and ${ledgerLine.counterAccountClass} in ('cash', 'credit'))`;

const total = sql<number>`sum(${ledgerLine.amountBase})::bigint`;

interface BudgetCategories {
  rtaCategoryId: string;
  uncategorizedId: string;
  categories: BudgetCategory[];
}

/** Every live category except Ready to Assign, which the engine takes separately. */
async function budgetCategories(db: Executor): Promise<BudgetCategories> {
  const rows = await db
    .select({
      id: category.id,
      systemKind: category.systemKind,
      linkedAccountId: category.linkedAccountId,
      groupKind: categoryGroup.kind,
    })
    .from(category)
    .innerJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
    .where(isNull(category.deletedAt))
    .orderBy(asc(category.id));
  let rtaCategoryId: string | undefined;
  let uncategorizedId: string | undefined;
  const categories: BudgetCategory[] = [];
  for (const row of rows) {
    const kind = categoryKindOf(row, row.groupKind);
    if (kind === 'rta') {
      rtaCategoryId = row.id;
    } else if (kind === 'uncategorized') {
      uncategorizedId = row.id;
      categories.push({ id: row.id, kind: 'uncategorized' });
    } else if (kind === 'cc_payment') {
      categories.push({ id: row.id, kind: 'cc_payment', linkedAccountId: row.linkedAccountId! });
    } else {
      // Paired loan categories are regular categories to the engine.
      categories.push({ id: row.id, kind: 'normal' });
    }
  }
  if (!rtaCategoryId || !uncategorizedId) throw new Error('The system categories are missing');
  return { rtaCategoryId, uncategorizedId, categories };
}

/**
 * The engine input for every month from the first editable month (the budget start, or an earlier month that still
 * holds an assignment or a note) through `throughMonth` (spec §2 "Read path"). Built from SQL aggregates over
 * `v_ledger_line` as `src/engine/budget/types.ts` documents. Only lines dated `today` or earlier count (spec §5.6);
 * months are 'YYYY-MM-01' in the database and 'YYYY-MM' in the engine.
 */
export async function loadBudgetInput(
  db: Executor,
  { throughMonth, today }: { throughMonth: Month; today: IsoDate },
): Promise<BudgetInput> {
  const { rtaCategoryId, uncategorizedId, categories } = await budgetCategories(db);
  const booked = and(inArray(ledgerLine.accountClass, ['cash', 'credit']), lte(ledgerLine.date, today));

  const activity = await db
    .select({
      month: ledgerLine.month,
      categoryId: ledgerLine.categoryId,
      accountId: ledgerLine.accountId,
      accountClass: ledgerLine.accountClass,
      amount: total,
    })
    .from(ledgerLine)
    .innerJoin(account, eq(account.id, ledgerLine.accountId))
    .where(
      and(
        booked,
        or(
          // Categorized lines, split lines and categorized transfers to tracking accounts (spec §5.1); credit
          // starting balances stay off the budget (spec §5.3).
          and(
            isNotNull(ledgerLine.categoryId),
            not(isBudgetTransfer),
            not(and(ledgerLine.isStartingBalance, eq(ledgerLine.accountClass, 'credit'))!),
          ),
          // Spec §3: on-budget, non-transfer, non-starting-balance lines without a category are Uncategorized.
          and(isNull(ledgerLine.categoryId), not(ledgerLine.isTransfer), not(ledgerLine.isStartingBalance)),
        ),
      ),
    )
    .groupBy(
      ledgerLine.month,
      ledgerLine.categoryId,
      ledgerLine.accountId,
      ledgerLine.accountClass,
      account.sortOrder,
    )
    // The engine splits credit overspending ties in input order, so cards come in display order.
    .orderBy(ledgerLine.month, ledgerLine.categoryId, account.sortOrder, ledgerLine.accountId);

  // Card payments, cash advances and balance transfers: the card side of transfers with on-budget accounts (§5.3).
  const cardTransfers = await db
    .select({ month: ledgerLine.month, cardAccountId: ledgerLine.accountId, amount: total })
    .from(ledgerLine)
    .where(and(booked, eq(ledgerLine.accountClass, 'credit'), isBudgetTransfer))
    .groupBy(ledgerLine.month, ledgerLine.accountId)
    .orderBy(ledgerLine.month, ledgerLine.accountId);

  const assignments = await db
    .select({ month: assignment.month, categoryId: assignment.categoryId, amount: assignment.amount })
    .from(assignment)
    .orderBy(assignment.month, assignment.categoryId);

  return {
    startMonth: await firstEditableMonth(db),
    throughMonth,
    rtaCategoryId,
    categories,
    assignments: assignments.map((a) => ({ ...a, month: monthOf(a.month) })),
    activity: activity.map((row) => ({
      month: monthOf(row.month),
      categoryId: row.categoryId ?? uncategorizedId,
      accountId: row.accountId,
      // The WHERE clause keeps on-budget accounts only.
      accountClass: row.accountClass as 'cash' | 'credit',
      amount: row.amount,
    })),
    cardTransfers: cardTransfers.map((t) => ({ ...t, month: monthOf(t.month) })),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project server src/server/budget/budget-input.test.ts`
Expected: `Tests  4 passed (4)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  37 passed (37)`, `Tests  366 passed (366)`; both checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/budget src/server/test/fixtures.ts
git commit -m "feat(server): budget engine input from the ledger" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Target definitions, target context and debt data

Spec §6 and §8, and the P2 carry-over "month-view adapter". The adapter has four parts:
- `toTargetDto` maps a `target` row to its API form, which is also the engine's `TargetDef`: months become `'YYYY-MM'`.
- `targetContext` reads carry, assigned and available for a category and month from the `BudgetResult`. `assignedIn(m)` reads other months, and months before the budget start give 0.
- `loadLinkedAccounts` gives each live credit card payment and paired loan category its account data:
  - `minPayment` and `apr` come from the account; loans also take their `escrow_amount`.
  - `balanceAtMonthStart` is the account's PLN balance before the month.
  - `balanceAtMonthEnd` is the PLN balance at the end of the month, or today if that is earlier; Task 4 uses it for "Need X to pay in full".
  - Balances count live transactions dated today or earlier.
- `evaluateCategoryTarget` runs `evaluateTarget` on that context.

**Null minimum payment (P2b1 review):** `PATCH /api/accounts/:id` can clear `minPayment` or `interestRate` on an account whose category has a debt target. The adapter evaluates the missing value as 0 and flags the evaluation `incomplete: true`. That flag is set for `min_payment` targets when the minimum payment is missing, and for `payoff_by_date` targets when the APR is missing. The targets API doesn't refuse such targets, because a later PATCH could clear the field anyway; the UI shows "incomplete" and asks for the value (Decision 11).

**Files:**
- Create: `src/shared/api/targets.ts`, `src/server/targets/target-model.ts`
- Test: `src/server/targets/target-model.test.ts`

**Interfaces:**
- Consumes: `evaluateTarget`, `TargetDef`, `TargetContext`, `BudgetResult`, `dateInMonth`, `monthOf` from `src/engine`; `monthStart` from `src/server/budget/assignments.ts`; `loadBudgetInput` (Task 2, in tests).
- Produces:
  - `src/shared/api/targets.ts`:
    - types `TargetKind`, `TargetCadence`, `SpendingMode`, `DebtMode`, `RepeatUnit`
    - `TargetDto { categoryId, kind, cadence, amount, mode, dueWeekday, dueDayOfMonth, dueDate, repeatUnit, repeatEvery, startMonth, debtMode, snoozedMonth }` (months `'YYYY-MM'`)
    - `TargetEvaluationDto { need, underfunded, progress, overfunded, snoozed, incomplete }`
  - `src/server/targets/target-model.ts`:
    - types `TargetRow`, `DebtContext` (= `NonNullable<TargetContext['debt']>`), `LinkedAccount { accountId, balanceAtMonthEnd, debt, missing: { minPayment, interestRate } }`
    - `toTargetDto(row: TargetRow): TargetDto & TargetDef`
    - `targetContext(result: BudgetResult, month: Month, categoryId: string, debt?: DebtContext): TargetContext` (throws if the category or month isn't in `result`)
    - `loadLinkedAccounts(db: Executor, month: Month, today: IsoDate): Promise<Map<categoryId, LinkedAccount>>`
    - `evaluateCategoryTarget(def: TargetDef, result: BudgetResult, month: Month, categoryId: string, linked?: LinkedAccount): TargetEvaluationDto | null`

- [ ] **Step 1: Write the failing tests**

Create `src/server/targets/target-model.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeBudget } from '../../engine';
import type { AccountDto } from '../../shared/api/accounts';
import { loadBudgetInput } from '../budget/budget-input';
import { target } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, insertTransaction } from '../test/fixtures';
import { evaluateCategoryTarget, loadLinkedAccounts, targetContext, toTargetDto } from './target-model';

let t: TestDatabase;
let ctx: TestApp;
let visa: AccountDto;
let mortgage: AccountDto;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
  visa = await createAccount(ctx.client, {
    name: 'Visa',
    type: 'credit_card',
    startingBalance: -100_000,
    startingDate: '2026-10-01',
    interestRate: '24',
    minPayment: 5_000,
  });
  mortgage = await createAccount(ctx.client, {
    name: 'Mortgage',
    type: 'mortgage',
    startingBalance: -10_000_000,
    startingDate: '2026-10-01',
    interestRate: '6',
    minPayment: 60_000,
    escrowAmount: 20_000,
    createPairedCategory: true,
  });
});
afterEach(async () => {
  await t.drop();
});

const TODAY = '2026-11-20';

const txn = (accountId: string, date: string, amount: number) => insertTransaction(t.db, { accountId, date, amount });

const pairedTarget = async () =>
  toTargetDto((await t.db.select().from(target).where(eq(target.categoryId, mortgage.pairedCategoryId!)))[0]!);

describe('toTargetDto', () => {
  it('turns stored months into YYYY-MM', async () => {
    await t.db
      .update(target)
      .set({ snoozedMonth: '2026-12-01' })
      .where(eq(target.categoryId, mortgage.pairedCategoryId!));
    expect(await pairedTarget()).toEqual({
      categoryId: mortgage.pairedCategoryId,
      kind: 'debt',
      cadence: 'monthly',
      amount: 0,
      mode: null,
      dueWeekday: null,
      dueDayOfMonth: null,
      dueDate: null,
      repeatUnit: null,
      repeatEvery: null,
      startMonth: '2026-11',
      debtMode: 'min_payment',
      snoozedMonth: '2026-12',
    });
  });
});

describe('targetContext', () => {
  it('reads carry, assigned, available and other months’ assignments from the computed budget', async () => {
    const group = await createGroup(ctx.client, 'Everyday');
    const gifts = await createCategory(ctx.client, group.id, 'Gifts');
    for (const [month, amount] of [['2026-10', 10_000], ['2026-11', 4_000]] as const) {
      await ctx.client.send('PUT', `/api/budget/${month}/assignments/${gifts.id}`, { amount });
    }
    const result = computeBudget(await loadBudgetInput(t.db, { throughMonth: '2026-11', today: TODAY }));
    const debt = { minPayment: 1, apr: '0', balanceAtMonthStart: 0 };
    const context = targetContext(result, '2026-11', gifts.id, debt);
    expect(context).toMatchObject({ month: '2026-11', carry: 10_000, assigned: 4_000, available: 14_000, debt });
    expect(['2026-09', '2026-10', '2026-11', '2026-12'].map(context.assignedIn)).toEqual([0, 10_000, 4_000, 0]);
    expect(() => targetContext(result, '2026-12', gifts.id)).toThrow(
      `Category ${gifts.id} is not in the computed budget for 2026-12`,
    );
  });
});

describe('loadLinkedAccounts', () => {
  it('gives credit card and loan categories their account’s debt data and balances', async () => {
    await txn(visa.id, '2026-10-15', -20_000);
    await txn(visa.id, '2026-11-05', -5_000);
    await txn(visa.id, '2026-11-25', -1_000);
    await txn(mortgage.id, '2026-11-10', 60_000);

    const november = await loadLinkedAccounts(t.db, '2026-11', TODAY);
    expect(november).toEqual(
      new Map([
        [
          visa.paymentCategoryId!,
          {
            accountId: visa.id,
            balanceAtMonthEnd: -125_000,
            debt: { minPayment: 5_000, apr: '24.0000', balanceAtMonthStart: -120_000, escrow: 0 },
            missing: { minPayment: false, interestRate: false },
          },
        ],
        [
          mortgage.pairedCategoryId!,
          {
            accountId: mortgage.id,
            balanceAtMonthEnd: -9_940_000,
            debt: { minPayment: 60_000, apr: '6.0000', balanceAtMonthStart: -10_000_000, escrow: 20_000 },
            missing: { minPayment: false, interestRate: false },
          },
        ],
      ]),
    );

    const card = async (month: string) => (await loadLinkedAccounts(t.db, month, TODAY)).get(visa.paymentCategoryId!)!;
    expect(await card('2026-10')).toMatchObject({ balanceAtMonthEnd: -120_000, debt: { balanceAtMonthStart: 0 } });
    // Later months see today's balance: the line dated 2026-11-25 isn't booked yet.
    expect(await card('2027-01')).toMatchObject({
      balanceAtMonthEnd: -125_000,
      debt: { balanceAtMonthStart: -125_000 },
    });
  });
});

describe('evaluateCategoryTarget', () => {
  it('evaluates a missing minimum payment or APR as 0 and flags the debt target incomplete', async () => {
    await t.db.insert(target).values({
      categoryId: visa.paymentCategoryId!,
      kind: 'debt',
      cadence: 'monthly',
      debtMode: 'payoff_by_date',
      dueDate: '2027-10-31',
      startMonth: '2026-11-01',
    });
    const evaluate = async (account: AccountDto, categoryId: string) => {
      const result = computeBudget(await loadBudgetInput(t.db, { throughMonth: '2026-11', today: TODAY }));
      const linked = (await loadLinkedAccounts(t.db, '2026-11', TODAY)).get(categoryId);
      expect(linked?.accountId).toBe(account.id);
      const [row] = await t.db.select().from(target).where(eq(target.categoryId, categoryId));
      return evaluateCategoryTarget(toTargetDto(row!), result, '2026-11', categoryId, linked);
    };
    const patch = (account: AccountDto, body: object) => ctx.client.send('PATCH', `/api/accounts/${account.id}`, body);

    // The paired loan target needs the minimum payment.
    expect(await evaluate(mortgage, mortgage.pairedCategoryId!)).toMatchObject({ need: 60_000, incomplete: false });
    expect((await patch(mortgage, { minPayment: null })).status).toBe(200);
    expect(await evaluate(mortgage, mortgage.pairedCategoryId!)).toEqual({
      need: 0,
      underfunded: 0,
      progress: 1,
      overfunded: false,
      snoozed: false,
      incomplete: true,
    });

    // Paying off 1 000 zł at 24 % in 12 payments takes 94.56 zł a month; without an APR, 1 000 / 12 rounded up.
    expect(await evaluate(visa, visa.paymentCategoryId!)).toMatchObject({ need: 9_456, incomplete: false });
    expect((await patch(visa, { interestRate: null })).status).toBe(200);
    expect(await evaluate(visa, visa.paymentCategoryId!)).toMatchObject({ need: 8_334, incomplete: true });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/targets/target-model.test.ts`
Expected: FAIL with `Error: Cannot find module './target-model' imported from …/src/server/targets/target-model.test.ts` (`Test Files  1 failed (1)`, no tests run).

- [ ] **Step 3: Add the shared target types**

Create `src/shared/api/targets.ts`:

```ts
/** Spec §4.3 and §6: a category's target. */
export type TargetKind = 'spending' | 'balance' | 'debt';
export type TargetCadence = 'weekly' | 'monthly' | 'yearly' | 'custom' | 'none';
export type SpendingMode = 'set_aside' | 'refill';
export type DebtMode = 'min_payment' | 'fixed' | 'payoff_by_date';
export type RepeatUnit = 'month' | 'year';

/** A category's target; months are 'YYYY-MM', dates 'YYYY-MM-DD'. */
export interface TargetDto {
  categoryId: string;
  kind: TargetKind;
  /** Balance targets use `none`; debt targets `monthly`. */
  cadence: TargetCadence;
  /** Minor units, ≥ 0 (0 for minimum-payment and pay-off-by-date debt targets). */
  amount: number;
  /** Spending targets only. */
  mode: SpendingMode | null;
  /** Weekly targets: 0 = Sunday … 6 = Saturday. */
  dueWeekday: number | null;
  /** Monthly targets: the due day shown to the user; null = the last day of the month. */
  dueDayOfMonth: number | null;
  /** Yearly and custom spending targets, balance targets with a date, pay-off-by-date debt targets. */
  dueDate: string | null;
  /** Custom targets that repeat every `repeatEvery` months or years. */
  repeatUnit: RepeatUnit | null;
  repeatEvery: number | null;
  /** The first month the target applies to (and where the first set-aside cycle starts). */
  startMonth: string;
  debtMode: DebtMode | null;
  /** The month the target is snoozed in, if any. */
  snoozedMonth: string | null;
}

/** How a category's target stands in one month (spec §6). */
export interface TargetEvaluationDto {
  need: number;
  /** 0 while snoozed. */
  underfunded: number;
  /** 0..1; reflects the real funding even while snoozed. */
  progress: number;
  /** Assigned more than the need. */
  overfunded: boolean;
  snoozed: boolean;
  /**
   * A debt target whose account lacks a field it needs: the minimum payment (`min_payment`) or the APR
   * (`payoff_by_date`). The missing value counts as 0 until the user enters it on the account.
   */
  incomplete: boolean;
}
```

- [ ] **Step 4: Write the adapter**

Create `src/server/targets/target-model.ts`. Balances read the `transaction` table, as P2b1's account balances do: a split parent's `amount_base` is the sum of its lines, and the `(account_id, date)` index serves the query.

```ts
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  type BudgetResult,
  dateInMonth,
  evaluateTarget,
  type IsoDate,
  type Money,
  type Month,
  monthOf,
  type TargetContext,
  type TargetDef,
} from '../../engine';
import type { TargetDto, TargetEvaluationDto } from '../../shared/api/targets';
import { monthStart } from '../budget/assignments';
import type { Executor } from '../db/client';
import { account, category, type target, transaction } from '../db/schema';

export type TargetRow = typeof target.$inferSelect;
export type DebtContext = NonNullable<TargetContext['debt']>;

/** A target row in its API form, which is also the engine's `TargetDef` (spec §6): months become 'YYYY-MM'. */
export function toTargetDto(row: TargetRow): TargetDto & TargetDef {
  return {
    categoryId: row.categoryId,
    kind: row.kind,
    cadence: row.cadence,
    amount: row.amount,
    mode: row.mode,
    dueWeekday: row.dueWeekday,
    dueDayOfMonth: row.dueDayOfMonth,
    dueDate: row.dueDate,
    repeatUnit: row.repeatUnit,
    repeatEvery: row.repeatEvery,
    startMonth: monthOf(row.startMonth),
    debtMode: row.debtMode,
    snoozedMonth: row.snoozedMonth === null ? null : monthOf(row.snoozedMonth),
  };
}

/** The engine's target inputs for one category and month, read from the computed budget. */
export function targetContext(
  result: BudgetResult,
  month: Month,
  categoryId: string,
  debt?: DebtContext,
): TargetContext {
  const cell = result.byMonth[month]?.categories[categoryId];
  if (!cell) throw new Error(`Category ${categoryId} is not in the computed budget for ${month}`);
  return {
    month,
    carry: cell.carry,
    assigned: cell.assigned,
    available: cell.available,
    // Months outside the computed budget (before its start) hold no assignments.
    assignedIn: (m) => result.byMonth[m]?.categories[categoryId]?.assigned ?? 0,
    debt,
  };
}

/** The credit or loan account behind a credit card payment or paired loan category. */
export interface LinkedAccount {
  accountId: string;
  /** PLN balance at the end of the month, or today if that is earlier (negative while money is owed). */
  balanceAtMonthEnd: Money;
  /** Debt target inputs (spec §6, §8); a missing minimum payment or APR is 0 here. */
  debt: DebtContext;
  /** Account fields that are not set (PATCH /api/accounts/:id can clear them). */
  missing: { minPayment: boolean; interestRate: boolean };
}

/**
 * The linked account of every live credit card payment and paired loan category, keyed by category id. Balances are
 * PLN base sums of the account's live transactions dated `today` or earlier (a split parent carries its lines' sum).
 */
export async function loadLinkedAccounts(
  db: Executor,
  month: Month,
  today: IsoDate,
): Promise<Map<string, LinkedAccount>> {
  const monthEnd = dateInMonth(month, 31);
  const through = monthEnd < today ? monthEnd : today;
  const beforeMonth = sql`${transaction.date} < ${monthStart(month)}`;
  const rows = await db
    .select({
      categoryId: category.id,
      accountId: account.id,
      accountClass: account.accountClass,
      interestRate: account.interestRate,
      minPayment: account.minPayment,
      escrowAmount: account.escrowAmount,
      beforeMonth: sql<number>`coalesce(sum(${transaction.amountBase}) filter (where ${beforeMonth}), 0)::bigint`,
      throughMonth: sql<number>`coalesce(sum(${transaction.amountBase}), 0)::bigint`,
    })
    .from(category)
    .innerJoin(account, eq(account.id, category.linkedAccountId))
    .leftJoin(
      transaction,
      and(eq(transaction.accountId, account.id), isNull(transaction.deletedAt), lte(transaction.date, through)),
    )
    .where(isNull(category.deletedAt))
    .groupBy(category.id, account.id);
  return new Map(
    rows.map((row) => [
      row.categoryId,
      {
        accountId: row.accountId,
        balanceAtMonthEnd: row.throughMonth,
        debt: {
          minPayment: row.minPayment ?? 0,
          apr: row.interestRate ?? '0',
          balanceAtMonthStart: row.beforeMonth,
          // Spec §6: escrow is added for loans only.
          escrow: row.accountClass === 'tracking' ? (row.escrowAmount ?? 0) : 0,
        },
        missing: { minPayment: row.minPayment === null, interestRate: row.interestRate === null },
      },
    ]),
  );
}

/**
 * Evaluates a category's target for `month` (spec §6); null before the target's start month. A debt target whose
 * account lacks its minimum payment or APR is evaluated with 0 for it and flagged `incomplete`.
 */
export function evaluateCategoryTarget(
  def: TargetDef,
  result: BudgetResult,
  month: Month,
  categoryId: string,
  linked?: LinkedAccount,
): TargetEvaluationDto | null {
  const evaluation = evaluateTarget(def, targetContext(result, month, categoryId, linked?.debt));
  if (!evaluation) return null;
  const incomplete =
    def.kind === 'debt' &&
    ((def.debtMode === 'min_payment' && linked?.missing.minPayment === true) ||
      (def.debtMode === 'payoff_by_date' && linked?.missing.interestRate === true));
  return { ...evaluation, incomplete };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project server src/server/targets/target-model.test.ts`
Expected: `Tests  4 passed (4)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  38 passed (38)`, `Tests  370 passed (370)`; both checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared/api/targets.ts src/server/targets
git commit -m "feat(server): target definitions, target context and linked-account debt data" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Budget month API

Spec §5, §6 and §11 "Budget screen". `GET /api/budget/:month` returns everything the Budget screen shows for a month:
- **Month range:** the P2b1 assignment range, from `firstEditableMonth()` to the current month + 24. Any other month is a 422 `month_out_of_range`. A month before the budget start is refused, unless it still holds an assignment or a note.
- **Ready to Assign:** the full §5.4 breakdown.
- **Groups:** every live group except Internal, in display order. Each lists its live categories in order, hidden ones included; the UI moves those to "Hidden categories". Each row has:
  - Carry, Assigned, Activity, Available, and the cash/credit overspending.
  - The pill color (§6).
  - The target and its evaluation.
  - For credit card payment categories, "Need X to pay in full" from `cardPaymentShortfall(balanceAtMonthEnd, Available)`.
- **Uncategorized:** a separate `uncategorized` row, present while it has activity or a non-zero Available in the month. Spec §3 says "activity" only, but an uncategorized inflow carries over, and hiding it would hide money (spec amended in Task 7).
- **Month note**, plus `budgetStartMonth` (spec §5.1), and `firstMonth`, `currentMonth` and `lastMonth` for the month switcher. `firstMonth` is `firstEditableMonth()`, the same lower bound the range check uses.

**Cost:** one `computeBudget` per request, through the requested month (the engine adds later months with assignments, which `assignedFuture` needs). All queries run in one read-only repeatable-read transaction.

Measured on an M3 Max (Postgres 16 in Docker) for 10 years × 150 categories:
- **Typical:** 26k transactions and 7k assignments take ≈ 80 ms per request. The activity aggregate takes ≈ 30 ms and `computeBudget` ≈ 22 ms.
- **Dense worst case:** every category has cash and card spending every month (36k activity rows, 18k assignments). That takes ≈ 175 ms: the activity aggregate ≈ 80 ms, of which ≈ 30 ms is Drizzle's row mapping, and `computeBudget` ≈ 45 ms.
- **Later options:** both cases are recorded in `p2-carry-over.md` with possible optimizations.

**Files:**
- Create: `src/server/budget/budget-month.ts`
- Modify: `src/shared/api/budget.ts`, `src/server/budget/budget-routes.ts`
- Test: `src/server/budget/budget-month.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 2–3: `loadBudgetInput`, `loadLinkedAccounts`, `evaluateCategoryTarget`, `toTargetDto`
  - P2b1: `assertBudgetMonth`, `budgetStartMonth`, `MONTHS_AHEAD`, `monthStart`, `listCategoryGroups`
  - from `src/engine`: `computeBudget`, `pillColor`, `cardPaymentShortfall`, `addMonths`
- Produces:
  - `src/shared/api/budget.ts`: `PillColor`, `RtaBreakdownDto`, `BudgetCategoryDto`, `BudgetGroupDto`, `BudgetMonthDto` (shapes in "API added in P2b2").
  - `src/server/budget/budget-month.ts`:
    - `interface BudgetMonth { result: BudgetResult; view: BudgetMonthDto }`
    - `loadBudgetMonth(db: Executor, month: Month, today: IsoDate): Promise<BudgetMonth>` (422 `month_out_of_range`; `view.firstMonth` = `result.months[0]`)
  - `GET /api/budget/:month` → 200 `BudgetMonthDto`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/budget/budget-month.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import type { BudgetCategoryDto, BudgetGroupDto, BudgetMonthDto } from '../../shared/api/budget';
import type { CategoryDto, CategoryGroupDto } from '../../shared/api/categories';
import type { TargetEvaluationDto } from '../../shared/api/targets';
import { systemCategoryId } from '../db/lookups';
import { target } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, insertTransaction, type NewTransaction } from '../test/fixtures';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  // Setup on 20 November 2026: the current month is 2026-11.
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const getMonth = async (month: string) => json<BudgetMonthDto>(await ctx.client.get(`/api/budget/${month}`));
const assign = (month: string, categoryId: string, amount: number) =>
  ctx.client.send('PUT', `/api/budget/${month}/assignments/${categoryId}`, { amount });

const txn = (values: NewTransaction) => insertTransaction(t.db, values);

const zero = { carry: 0, assigned: 0, activity: 0, available: 0, cashOverspent: 0, creditOverspent: 0 };
const evaluation = (values: Partial<TargetEvaluationDto>): TargetEvaluationDto => ({
  need: 0,
  underfunded: 0,
  progress: 0,
  overfunded: false,
  snoozed: false,
  incomplete: false,
  ...values,
});
const noTarget = { target: null, targetEvaluation: null, needToPayInFull: null };

function row(c: CategoryDto, values: Partial<BudgetCategoryDto>): BudgetCategoryDto {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    hidden: c.hidden,
    note: c.note,
    linkedAccountId: c.linkedAccountId,
    ...zero,
    pill: 'grey',
    ...noTarget,
    ...values,
  };
}

describe('GET /api/budget/:month', () => {
  let checking: AccountDto;
  let visa: AccountDto;
  let mortgage: AccountDto;
  let groups: CategoryGroupDto[];
  let groceries: CategoryDto;
  let dining: CategoryDto;
  let rent: CategoryDto;
  beforeEach(async () => {
    checking = await createAccount(ctx.client, {
      name: 'Checking',
      startingBalance: 1_000_000,
      startingDate: '2026-10-01',
    });
    visa = await createAccount(ctx.client, {
      name: 'Visa',
      type: 'credit_card',
      startingBalance: -37_500,
      startingDate: '2026-10-01',
      interestRate: '24',
      minPayment: 5_000,
    });
    mortgage = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      startingBalance: -10_000_000,
      startingDate: '2026-10-01',
      interestRate: '6',
      minPayment: 60_000,
      escrowAmount: 20_000,
      createPairedCategory: true,
    });
    const everyday = await createGroup(ctx.client, 'Everyday');
    const bills = await createGroup(ctx.client, 'Bills');
    groceries = await createCategory(ctx.client, everyday.id, 'Groceries');
    dining = await createCategory(ctx.client, everyday.id, 'Dining');
    rent = await createCategory(ctx.client, bills.id, 'Rent');
    await ctx.client.send('PATCH', `/api/categories/${dining.id}`, { hidden: true });
    dining = { ...dining, hidden: true };
    await t.db.insert(target).values([
      {
        categoryId: groceries.id,
        kind: 'spending',
        cadence: 'monthly',
        amount: 50_000,
        mode: 'set_aside',
        startMonth: '2026-10-01',
      },
      {
        categoryId: visa.paymentCategoryId!,
        kind: 'debt',
        cadence: 'monthly',
        debtMode: 'min_payment',
        startMonth: '2026-10-01',
      },
    ]);

    await txn({ accountId: checking.id, date: '2026-10-05', amount: -30_000, categoryId: groceries.id });
    await txn({ accountId: visa.id, date: '2026-11-03', amount: -8_000, categoryId: groceries.id });
    await txn({ accountId: checking.id, date: '2026-11-08', amount: -1_000 });
    const payment = await txn({
      accountId: checking.id,
      date: '2026-11-12',
      amount: -60_000,
      transferAccountId: mortgage.id,
      categoryId: mortgage.pairedCategoryId,
    });
    await txn({
      accountId: mortgage.id,
      date: '2026-11-12',
      amount: 60_000,
      transferAccountId: checking.id,
      transferTxnId: payment.id,
    });
    await assign('2026-10', groceries.id, 50_000);
    await assign('2026-11', groceries.id, 20_000);
    await assign('2026-11', mortgage.pairedCategoryId!, 60_000);
    await assign('2026-12', rent.id, 100_000);
    await ctx.client.send('PUT', '/api/budget/2026-11/note', { note: 'Black Friday' });
    groups = ((await (await ctx.client.get('/api/categories')).json()) as { groups: CategoryGroupDto[] }).groups;
  });

  const category = (id: string) => groups.flatMap((g) => g.categories).find((c) => c.id === id)!;
  const group = (kind: string, name: string, categories: BudgetCategoryDto[]): BudgetGroupDto => {
    const g = groups.find((candidate) => candidate.kind === kind && candidate.name === name)!;
    return { id: g.id, name: g.name, kind: g.kind, hidden: g.hidden, categories };
  };

  it('returns the month: RTA breakdown, groups and rows with targets, pills and card debt (spec §11)', async () => {
    const debtTarget = {
      kind: 'debt',
      cadence: 'monthly',
      amount: 0,
      mode: null,
      dueWeekday: null,
      dueDayOfMonth: null,
      dueDate: null,
      repeatUnit: null,
      repeatEvery: null,
      debtMode: 'min_payment',
      snoozedMonth: null,
    } as const;
    const groceriesTarget = {
      ...debtTarget,
      categoryId: groceries.id,
      kind: 'spending',
      amount: 50_000,
      mode: 'set_aside',
      debtMode: null,
      startMonth: '2026-10',
    } as const;
    const expected: BudgetMonthDto = {
      month: '2026-11',
      budgetStartMonth: '2026-10',
      firstMonth: '2026-10',
      currentMonth: '2026-11',
      lastMonth: '2028-11',
      note: 'Black Friday',
      rta: {
        leftoverPrev: 950_000,
        income: 0,
        assignedThisMonth: 80_000,
        assignedFuture: 100_000,
        cashOverspentPrev: 0,
        leftover: 870_000,
        readyToAssign: 770_000,
      },
      groups: [
        group('cc_payments', 'Credit Card Payments', [
          // Funded card spending moves into the payment category; the minimum payment is still unassigned.
          row(category(visa.paymentCategoryId!), {
            activity: 8_000,
            available: 8_000,
            pill: 'yellow',
            target: { ...debtTarget, categoryId: visa.paymentCategoryId!, startMonth: '2026-10' },
            targetEvaluation: evaluation({ need: 5_000, underfunded: 5_000 }),
            // The card owes 375 + 80 = 455 zł, and 80 zł is set aside.
            needToPayInFull: 37_500,
          }),
        ]),
        group('debt_payments', 'Debt Payments', [
          row(category(mortgage.pairedCategoryId!), {
            assigned: 60_000,
            activity: -60_000,
            pill: 'green',
            target: { ...debtTarget, categoryId: mortgage.pairedCategoryId!, startMonth: '2026-11' },
            targetEvaluation: evaluation({ need: 60_000, progress: 1 }),
          }),
        ]),
        group('normal', 'Everyday', [
          row(groceries, {
            carry: 20_000,
            assigned: 20_000,
            activity: -8_000,
            available: 32_000,
            pill: 'yellow',
            target: groceriesTarget,
            targetEvaluation: evaluation({ need: 50_000, underfunded: 30_000, progress: 0.4 }),
          }),
          row(dining, {}),
        ]),
        group('normal', 'Bills', [row(rent, {})]),
      ],
      // Cash spending without a category is red cash overspending.
      uncategorized: row(category(await systemCategoryId(t.db, 'uncategorized')), {
        activity: -1_000,
        available: -1_000,
        cashOverspent: 1_000,
        pill: 'red',
      }),
    };
    expect(await getMonth('2026-11')).toEqual({ status: 200, body: expected });
  });

  it('shows earlier months, with targets that have not started yet left out', async () => {
    const { body } = await getMonth('2026-10');
    const rows = body.groups.flatMap((g) => g.categories);
    const find = (id: string) => rows.find((r) => r.id === id)!;
    expect(body).toMatchObject({ month: '2026-10', note: null, uncategorized: null });
    expect(body.rta).toMatchObject({ income: 1_000_000, assignedThisMonth: 50_000, readyToAssign: 770_000 });
    expect(find(groceries.id)).toMatchObject({
      available: 20_000,
      pill: 'green',
      targetEvaluation: { need: 50_000, underfunded: 0, progress: 1 },
    });
    // Golden 7: the card's starting debt is not budgeted, so all of it is still needed.
    expect(find(visa.paymentCategoryId!)).toMatchObject({ available: 0, needToPayInFull: 37_500 });
    // The paired loan target starts in 2026-11, the month the loan was added.
    expect(find(mortgage.pairedCategoryId!)).toMatchObject({
      target: { startMonth: '2026-11' },
      targetEvaluation: null,
    });
  });

  it('flags a minimum-payment target incomplete once the account has no minimum payment', async () => {
    expect((await ctx.client.send('PATCH', `/api/accounts/${mortgage.id}`, { minPayment: null })).status).toBe(200);
    const { body } = await getMonth('2026-11');
    // Nothing is needed until the minimum payment is entered again, so the target is neither underfunded nor met.
    expect(body.groups.flatMap((g) => g.categories).find((c) => c.id === mortgage.pairedCategoryId)).toMatchObject({
      available: 0,
      pill: 'grey',
      targetEvaluation: { need: 0, underfunded: 0, incomplete: true },
    });
  });

  it('allows months from the budget start to 24 months ahead', async () => {
    const outOfRange = {
      status: 422,
      body: { code: 'month_out_of_range', message: 'Pick a month from 2026-10 to 2028-11.' },
    };
    expect(await getMonth('2026-09')).toEqual(outOfRange);
    expect(await getMonth('2028-12')).toEqual(outOfRange);
    const last = await getMonth('2028-11');
    expect(last.status).toBe(200);
    // Nothing is assigned after 2026-12. The 10 zł overspent in Uncategorized in 2026-11 came off 2026-12's RTA.
    expect(last.body.rta).toMatchObject({ leftoverPrev: 769_000, readyToAssign: 769_000 });
    expect(await getMonth('2026-13')).toMatchObject({
      status: 400,
      body: { fieldErrors: { month: ['Use the format YYYY-MM.'] } },
    });
  });
});

describe('GET /api/budget/:month edge cases', () => {
  it('counts transactions up to today in the budget time zone', async () => {
    const checking = await createAccount(ctx.client, { name: 'Checking' });
    const group = await createGroup(ctx.client, 'Everyday');
    const groceries = await createCategory(ctx.client, group.id, 'Groceries');
    await txn({ accountId: checking.id, date: '2026-11-21', amount: -500, categoryId: groceries.id });
    const activity = async () =>
      (await getMonth('2026-11')).body.groups.flatMap((g) => g.categories).find((c) => c.id === groceries.id)?.activity;
    expect(await activity()).toBe(0);
    // 23:30 UTC on 20 November is already 21 November in Warsaw.
    ctx.clock.advance(13.5 * 60 * 60 * 1000);
    expect(await activity()).toBe(-500);
  });

  it('reaches an earlier month that still holds an assignment, which keeps counting', async () => {
    const cash = await createAccount(ctx.client, { name: 'Cash', type: 'cash', startingDate: '2026-03-15' });
    const group = await createGroup(ctx.client, 'Everyday');
    const groceries = await createCategory(ctx.client, group.id, 'Groceries');
    await assign('2026-03', groceries.id, 1_000);
    expect((await ctx.client.send('DELETE', `/api/accounts/${cash.id}`)).status).toBe(200);

    // The budget starts in 2026-11 again; 2026-03 stays reachable until its assignment is cleared.
    const march = (await getMonth('2026-03')).body;
    expect(march).toMatchObject({ budgetStartMonth: '2026-11', firstMonth: '2026-03', rta: { readyToAssign: -1_000 } });
    const november = (await getMonth('2026-11')).body;
    expect(november).toMatchObject({ firstMonth: '2026-03', rta: { readyToAssign: -1_000 } });
    expect(november.groups.flatMap((g) => g.categories).find((c) => c.id === groceries.id)).toMatchObject({
      carry: 1_000,
      available: 1_000,
    });
  });

  it('shows Uncategorized while it has activity or money in the month', async () => {
    const checking = await createAccount(ctx.client, { name: 'Checking', startingDate: '2026-09-01' });
    await txn({ accountId: checking.id, date: '2026-09-10', amount: 2_000 });
    await txn({ accountId: checking.id, date: '2026-10-10', amount: -500 });
    const uncategorized = async (month: string) => (await getMonth(month)).body.uncategorized;
    expect(await uncategorized('2026-09')).toMatchObject({ activity: 2_000, available: 2_000, pill: 'green' });
    expect(await uncategorized('2026-10')).toMatchObject({ carry: 2_000, activity: -500, available: 1_500 });
    expect(await uncategorized('2026-11')).toMatchObject({ carry: 1_500, activity: 0, available: 1_500 });
    await txn({ accountId: checking.id, date: '2026-11-02', amount: -1_500 });
    expect(await uncategorized('2026-11')).toMatchObject({ activity: -1_500, available: 0 });
    expect(await uncategorized('2026-12')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/budget/budget-month.test.ts`
Expected: FAIL with `Tests  7 failed (7)`. The route doesn't exist, so the requests get 404: `expected { status: 404, body: { …(2) } } to deeply equal { status: 200, body: { …(9) } }`, and `TypeError: Cannot read properties of undefined (reading 'flatMap')` where a test reads `groups`.

- [ ] **Step 3: Add the month view DTOs**

```bash
git apply <<'PATCH'
diff --git a/src/shared/api/budget.ts b/src/shared/api/budget.ts
index f0439a6..830602e 100644
--- a/src/shared/api/budget.ts
+++ b/src/shared/api/budget.ts
@@ -1,5 +1,7 @@
 import { z } from 'zod';
+import type { CategoryGroupKind, CategoryKind } from './categories';
 import { idSchema, moneySchema, monthSchema, noteSchema, positiveMoneySchema } from './common';
+import type { TargetDto, TargetEvaluationDto } from './targets';
 
 export const monthParamSchema = z.object({ month: monthSchema });
 export const assignmentParamSchema = z.object({ month: monthSchema, categoryId: idSchema });
@@ -37,3 +39,75 @@ export interface MonthNoteDto {
   month: string;
   note: string | null;
 }
+
+/** Spec §6: the color of a category's Available pill. */
+export type PillColor = 'red' | 'yellow' | 'green' | 'grey';
+
+/** Spec §5.4: how Ready to Assign comes about in a month. */
+export interface RtaBreakdownDto {
+  /** Leftover of the previous month (negative leftovers carry forward). */
+  leftoverPrev: number;
+  income: number;
+  assignedThisMonth: number;
+  assignedFuture: number;
+  cashOverspentPrev: number;
+  /** leftoverPrev + income − assignedThisMonth − cashOverspentPrev */
+  leftover: number;
+  /** The banner amount: leftover − assignedFuture. */
+  readyToAssign: number;
+}
+
+/** One budget row (spec §5, §6, §11); amounts are PLN minor units. */
+export interface BudgetCategoryDto {
+  id: string;
+  name: string;
+  /** `uncategorized` only for the Uncategorized row; Ready to Assign never appears. */
+  kind: CategoryKind;
+  hidden: boolean;
+  note: string | null;
+  /** The account of a credit card payment or paired loan category. */
+  linkedAccountId: string | null;
+  carry: number;
+  assigned: number;
+  activity: number;
+  available: number;
+  cashOverspent: number;
+  creditOverspent: number;
+  pill: PillColor;
+  target: TargetDto | null;
+  /** Null without a target, or before the target's start month. */
+  targetEvaluation: TargetEvaluationDto | null;
+  /** Credit card payment categories: "Need X to pay in full" (spec §5.3); null for every other category. */
+  needToPayInFull: number | null;
+}
+
+export interface BudgetGroupDto {
+  id: string;
+  name: string;
+  kind: CategoryGroupKind;
+  hidden: boolean;
+  /** Live categories in display order, hidden ones included (the UI lists them under "Hidden categories"). */
+  categories: BudgetCategoryDto[];
+}
+
+/** GET /api/budget/:month — everything the Budget screen shows for one month (spec §11). */
+export interface BudgetMonthDto {
+  month: string;
+  /** Spec §5.1: the earlier of the configured start month and the month of the earliest transaction. */
+  budgetStartMonth: string;
+  /**
+   * The month switcher's lower bound: the budget start, or an earlier month that still holds an assignment or a note
+   * (left behind when the budget start moved later).
+   */
+  firstMonth: string;
+  /** Today's month in the budget's time zone. */
+  currentMonth: string;
+  /** The month switcher's upper bound: the current month + 24. */
+  lastMonth: string;
+  note: string | null;
+  rta: RtaBreakdownDto;
+  /** Every live group except the internal one, in display order. */
+  groups: BudgetGroupDto[];
+  /** Spec §3: present only while Uncategorized has activity or money in this month. */
+  uncategorized: BudgetCategoryDto | null;
+}
PATCH
```

- [ ] **Step 4: Write the month view**

Create `src/server/budget/budget-month.ts`:

```ts
import { eq } from 'drizzle-orm';
import {
  addMonths,
  type BudgetResult,
  cardPaymentShortfall,
  computeBudget,
  type IsoDate,
  type Month,
  monthOf,
  pillColor,
} from '../../engine';
import type { BudgetCategoryDto, BudgetMonthDto } from '../../shared/api/budget';
import type { CategoryDto } from '../../shared/api/categories';
import { listCategoryGroups } from '../categories/category-queries';
import type { Executor } from '../db/client';
import { monthNote, target } from '../db/schema';
import { evaluateCategoryTarget, loadLinkedAccounts, toTargetDto } from '../targets/target-model';
import { assertBudgetMonth, budgetStartMonth, MONTHS_AHEAD, monthStart } from './assignments';
import { loadBudgetInput } from './budget-input';

export interface BudgetMonth {
  /** Every month from the budget start through `month`, plus later months with assignments. */
  result: BudgetResult;
  view: BudgetMonthDto;
}

/**
 * The Budget screen for `month` (spec §11) from one `computeBudget` run. Throws 422 `month_out_of_range` outside the
 * first editable month .. current month + 24. Callers run it in one transaction, so every query reads one snapshot.
 */
export async function loadBudgetMonth(db: Executor, month: Month, today: IsoDate): Promise<BudgetMonth> {
  await assertBudgetMonth(db, month, today);
  const input = await loadBudgetInput(db, { throughMonth: month, today });
  const result = computeBudget(input);
  const cells = result.byMonth[month]!;
  const groups = await listCategoryGroups(db);
  const targets = new Map((await db.select().from(target)).map((row) => [row.categoryId, toTargetDto(row)]));
  const linked = await loadLinkedAccounts(db, month, today);
  const [note] = await db
    .select({ note: monthNote.note })
    .from(monthNote)
    .where(eq(monthNote.month, monthStart(month)));

  const row = (c: CategoryDto): BudgetCategoryDto => {
    const cell = cells.categories[c.id]!;
    const def = targets.get(c.id) ?? null;
    const account = linked.get(c.id);
    const evaluation = def && evaluateCategoryTarget(def, result, month, c.id, account);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      hidden: c.hidden,
      note: c.note,
      linkedAccountId: c.linkedAccountId,
      carry: cell.carry,
      assigned: cell.assigned,
      activity: cell.activity,
      available: cell.available,
      cashOverspent: cell.cashOverspent,
      creditOverspent: cell.creditOverspent,
      pill: pillColor(cell, evaluation),
      target: def,
      targetEvaluation: evaluation,
      needToPayInFull:
        c.kind === 'cc_payment' && account ? cardPaymentShortfall(account.balanceAtMonthEnd, cell.available) : null,
    };
  };

  const internal = groups.find((g) => g.kind === 'internal');
  const uncategorized = internal?.categories.find((c) => c.kind === 'uncategorized');
  const uncategorizedRow = uncategorized && row(uncategorized);
  const currentMonth = monthOf(today);
  return {
    result,
    view: {
      month,
      budgetStartMonth: await budgetStartMonth(db),
      firstMonth: input.startMonth,
      currentMonth,
      lastMonth: addMonths(currentMonth, MONTHS_AHEAD),
      note: note?.note ?? null,
      rta: cells.rta,
      groups: groups
        .filter((g) => g.kind !== 'internal')
        .map((g) => ({ id: g.id, name: g.name, kind: g.kind, hidden: g.hidden, categories: g.categories.map(row) })),
      // Spec §3 shows Uncategorized only with activity; money carried into the month keeps it visible too.
      uncategorized:
        uncategorizedRow && (uncategorizedRow.activity !== 0 || uncategorizedRow.available !== 0)
          ? uncategorizedRow
          : null,
    },
  };
}
```

- [ ] **Step 5: Add the route**

```bash
git apply <<'PATCH'
diff --git a/src/server/budget/budget-routes.ts b/src/server/budget/budget-routes.ts
index a9e9079..3a42fbe 100644
--- a/src/server/budget/budget-routes.ts
+++ b/src/server/budget/budget-routes.ts
@@ -2,6 +2,7 @@ import { Hono } from 'hono';
 import {
   type AssignmentDto,
   assignmentParamSchema,
+  type BudgetMonthDto,
   type MonthNoteDto,
   monthNoteRequestSchema,
   monthParamSchema,
@@ -15,13 +16,26 @@ import { type Named, runCommand } from '../commands/run-command';
 import type { AppDeps } from '../http/app';
 import { validate } from '../http/validate';
 import { assertBudgetMonth, assignableCategory, assignedIn, moveMoney, setAssigned, setMonthNote } from './assignments';
+import { loadBudgetMonth } from './budget-month';
 
-/** /api/budget/:month (spec §3, §5.4): assigning, moving money and the month note; months are 'YYYY-MM'. */
+/**
+ * /api/budget/:month (spec §3, §5.4, §11): the month view, assigning, moving money and the month note; months are
+ * 'YYYY-MM'.
+ */
 export function budgetRoutes(deps: AppDeps) {
   const today = () => todayIn(deps.config.timeZone, deps.clock.now());
 
   return new Hono<AuthedEnv>()
     .use('*', requireSession(deps))
+    .get('/:month', validate('param', monthParamSchema), async (c) => {
+      const { month } = c.req.valid('param');
+      // One read-only snapshot for all the month view's queries.
+      const { view } = await deps.db.transaction((tx) => loadBudgetMonth(tx, month, today()), {
+        isolationLevel: 'repeatable read',
+        accessMode: 'read only',
+      });
+      return c.json<BudgetMonthDto>(view);
+    })
     .put(
       '/:month/assignments/:categoryId',
       validate('param', assignmentParamSchema),
PATCH
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project server src/server/budget/budget-month.test.ts`
Expected: `Tests  7 passed (7)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  39 passed (39)`, `Tests  377 passed (377)`; both checks exit 0. (The route walk in `app.test.ts` now also expects 401 from `GET /api/budget/:month`.)

- [ ] **Step 7: Commit**

```bash
git add src/shared/api/budget.ts src/server/budget
git commit -m "feat(server): budget month view API" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Targets API with snooze

Spec §4.3 and §6, and §11's Target tab.

**`PUT /api/categories/:id/target`** creates or replaces the category's single target. The body is a zod discriminated union on `kind`, then on `cadence` (spending) or `debtMode` (debt). Each variant takes only the fields it uses and must have every field the engine needs:

| Body | Required | Optional (default) |
|---|---|---|
| `{ kind: 'spending', cadence: 'weekly' }` | `amount`, `dueWeekday` 0–6 | `mode` (`set_aside`) |
| `{ kind: 'spending', cadence: 'monthly' }` | `amount` | `mode` (`set_aside`), `dueDayOfMonth` 1–31 (null = last day) |
| `{ kind: 'spending', cadence: 'yearly' }` | `amount`, `dueDate` | `mode` (`set_aside`) |
| `{ kind: 'spending', cadence: 'custom' }` | `amount`, `dueDate` | `mode` (`set_aside`); `repeatUnit` `month`/`year` and `repeatEvery` 1–120, set together (null = one-off) |
| `{ kind: 'balance' }` | `amount` | `dueDate` (null = no date) |
| `{ kind: 'debt', debtMode: 'min_payment' }` | – | – |
| `{ kind: 'debt', debtMode: 'fixed' }` | `amount` | – |
| `{ kind: 'debt', debtMode: 'payoff_by_date' }` | `dueDate` | – |

Every variant also takes an optional `startMonth`. Amounts are whole minor units ≥ 0.

Storage and domain rules:
- **Stored columns:** balance targets are stored with cadence `none`, and debt targets with `monthly` (as P2b1 does for the paired loan target); unused columns are cleared.
- **Start month and snooze:** `startMonth` defaults to the replaced target's start month, or the current month for a new target. It must lie in the budget range. A replaced target keeps its snooze.
- **Debt targets** are only for credit card payment and paired loan categories (422 `debt_target_not_allowed`). Those categories may take spending and balance targets too.
- **System categories** take no target (422 `system_category`); unknown or deleted categories are 404.

**`DELETE /api/categories/:id/target`** removes it (404 `This category has no target.` when there is none).

**Snooze:**
- `POST …/target/snooze { month }` sets `snoozed_month`; the month must lie in the budget range. `DELETE …/target/snooze` clears it.
- A snoozed target isn't underfunded in that month, but its progress still shows the real funding (§6).

Every change is one undoable command.

**Files:**
- Create: `src/server/targets/target-commands.ts`
- Modify: `src/shared/api/targets.ts`, `src/server/categories/category-routes.ts`
- Test: `src/server/targets/target-routes.test.ts`

**Interfaces:**
- Consumes: `loadCategory` (P2b1, 404 `Category not found.`, locks the row); `assertBudgetMonth`, `monthStart` (P2b1); `toTargetDto` (Task 3); `runCommand`, `Named`.
- Produces:
  - `src/shared/api/targets.ts`: `setTargetRequestSchema` / `SetTargetRequest`, `snoozeTargetRequestSchema` (`{ month }`).
  - `src/server/targets/target-commands.ts`:
    - `getTarget(db: Executor, categoryId): Promise<TargetDto>` (404)
    - `setTarget(rec, categoryId, input: SetTargetRequest, today: IsoDate): Promise<{ name }>`
    - `deleteTarget(rec, categoryId): Promise<{ name }>`
    - `snoozeTarget(rec, categoryId, month: Month | null, today: IsoDate): Promise<{ name }>`
  - Error codes: 422 `system_category`, `debt_target_not_allowed` and `month_out_of_range`; 404 `not_found` (`Category not found.` / `This category has no target.`).
  - Undo labels: `Set the target for "…"`, `Delete the target for "…"`, `Snooze the target for "…"`, `Unsnooze the target for "…"`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/targets/target-routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import type { BudgetMonthDto } from '../../shared/api/budget';
import type { CategoryDto } from '../../shared/api/categories';
import type { TargetDto } from '../../shared/api/targets';
import type { UndoState } from '../../shared/api/undo';
import { systemCategoryId } from '../db/lookups';
import { category, target } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let groceries: CategoryDto;
let visa: AccountDto;
beforeEach(async () => {
  t = await createTestDatabase();
  // Setup on 20 November 2026 makes 2026-11 the budget start and current month.
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
  const group = await createGroup(ctx.client, 'Everyday');
  groceries = await createCategory(ctx.client, group.id, 'Groceries');
  visa = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const put = (categoryId: string, body: object) => ctx.client.send('PUT', `/api/categories/${categoryId}/target`, body);
const snooze = (categoryId: string, month: string) =>
  ctx.client.post(`/api/categories/${categoryId}/target/snooze`, { month });
const unsnooze = (categoryId: string) => ctx.client.send('DELETE', `/api/categories/${categoryId}/target/snooze`);
const undoLabel = async () => ((await (await ctx.client.get('/api/undo')).json()) as UndoState).undo?.label;

function dto(categoryId: string, values: Partial<TargetDto>): TargetDto {
  return {
    categoryId,
    kind: 'spending',
    cadence: 'monthly',
    amount: 0,
    mode: null,
    dueWeekday: null,
    dueDayOfMonth: null,
    dueDate: null,
    repeatUnit: null,
    repeatEvery: null,
    startMonth: '2026-11',
    debtMode: null,
    snoozedMonth: null,
    ...values,
  };
}

describe('PUT /api/categories/:id/target', () => {
  it('sets every kind of target, each replacing the last, all undoable (spec §6)', async () => {
    const empty = await snapshot(t.db);
    const quarterly = { repeatUnit: 'month', repeatEvery: 3 } as const;
    const cases: [object, Partial<TargetDto>][] = [
      [
        { kind: 'spending', cadence: 'weekly', amount: 10_000, dueWeekday: 1 },
        { cadence: 'weekly', amount: 10_000, mode: 'set_aside', dueWeekday: 1 },
      ],
      [
        { kind: 'spending', cadence: 'monthly', amount: 50_000, mode: 'refill', dueDayOfMonth: 10 },
        { amount: 50_000, mode: 'refill', dueDayOfMonth: 10 },
      ],
      [
        { kind: 'spending', cadence: 'yearly', amount: 120_000, dueDate: '2027-06-15' },
        { cadence: 'yearly', amount: 120_000, mode: 'set_aside', dueDate: '2027-06-15' },
      ],
      [
        { kind: 'spending', cadence: 'custom', amount: 30_000, dueDate: '2027-01-10', ...quarterly },
        { cadence: 'custom', amount: 30_000, mode: 'set_aside', dueDate: '2027-01-10', ...quarterly },
      ],
      [
        { kind: 'spending', cadence: 'custom', amount: 80_000, mode: 'refill', dueDate: '2027-03-01' },
        { cadence: 'custom', amount: 80_000, mode: 'refill', dueDate: '2027-03-01' },
      ],
      [{ kind: 'balance', amount: 500_000 }, { kind: 'balance', cadence: 'none', amount: 500_000 }],
      [
        { kind: 'balance', amount: 500_000, dueDate: '2027-12-31', startMonth: '2026-12' },
        { kind: 'balance', cadence: 'none', amount: 500_000, dueDate: '2027-12-31', startMonth: '2026-12' },
      ],
    ];
    for (const [body, expected] of cases) {
      expect(await json(await put(groceries.id, body))).toEqual({ status: 200, body: dto(groceries.id, expected) });
    }
    expect(await t.db.select().from(target).where(eq(target.categoryId, groceries.id))).toHaveLength(1);
    expect(await undoLabel()).toBe('Set the target for "Groceries"');
    for (let i = 0; i < cases.length; i++) await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(empty);
  });

  it('keeps the start month and the snooze of a replaced target', async () => {
    await put(groceries.id, { kind: 'spending', cadence: 'monthly', amount: 10_000, startMonth: '2026-12' });
    await snooze(groceries.id, '2027-01');
    expect((await json(await put(groceries.id, { kind: 'balance', amount: 90_000 }))).body).toMatchObject({
      kind: 'balance',
      startMonth: '2026-12',
      snoozedMonth: '2027-01',
    });
  });

  it('takes debt targets only on credit card payment and loan categories', async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Car loan',
      type: 'auto_loan',
      startingBalance: -2_000_000,
      minPayment: 80_000,
      createPairedCategory: true,
    });
    const card = visa.paymentCategoryId!;
    expect(await json(await put(card, { kind: 'debt', debtMode: 'min_payment' }))).toEqual({
      status: 200,
      body: dto(card, { kind: 'debt', debtMode: 'min_payment' }),
    });
    expect((await json(await put(card, { kind: 'debt', debtMode: 'payoff_by_date', dueDate: '2027-11-30' }))).body)
      .toEqual(dto(card, { kind: 'debt', debtMode: 'payoff_by_date', dueDate: '2027-11-30' }));
    expect((await json(await put(loan.pairedCategoryId!, { kind: 'debt', debtMode: 'fixed', amount: 100_000 }))).body)
      .toEqual(dto(loan.pairedCategoryId!, { kind: 'debt', debtMode: 'fixed', amount: 100_000 }));
    // Other kinds work on those categories too.
    expect((await put(card, { kind: 'spending', cadence: 'monthly', amount: 10_000 })).status).toBe(200);
    expect(await json(await put(groceries.id, { kind: 'debt', debtMode: 'min_payment' }))).toEqual({
      status: 422,
      body: {
        code: 'debt_target_not_allowed',
        message: 'Only credit card payment and loan categories take debt targets.',
      },
    });
  });

  it('refuses system, deleted and unknown categories', async () => {
    const body = { kind: 'balance', amount: 1 };
    for (const kind of ['rta', 'uncategorized'] as const) {
      expect(await json(await put(await systemCategoryId(t.db, kind), body))).toEqual({
        status: 422,
        body: { code: 'system_category', message: "System categories can't have targets." },
      });
    }
    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, groceries.id));
    for (const id of [groceries.id, crypto.randomUUID()]) {
      expect(await json(await put(id, body))).toEqual({
        status: 404,
        body: { code: 'not_found', message: 'Category not found.' },
      });
    }
  });

  it('validates the fields each kind and cadence needs', async () => {
    const errors = async (body: object) => {
      const res = await json<{ code: string; fieldErrors: Record<string, string[]> }>(await put(groceries.id, body));
      expect(res.status).toBe(400);
      return res.body.fieldErrors;
    };
    const weekly = { kind: 'spending', cadence: 'weekly', amount: 1_000 };
    expect(await errors(weekly)).toEqual({ dueWeekday: ['Pick a weekday.'] });
    expect(await errors({ ...weekly, dueWeekday: 7 })).toEqual({ dueWeekday: ['Pick a weekday.'] });
    const monthly = { kind: 'spending', cadence: 'monthly', amount: 1_000 };
    expect(await errors({ ...monthly, dueDayOfMonth: 0 })).toEqual({ dueDayOfMonth: ['Pick a day from 1 to 31.'] });
    expect(await errors({ ...monthly, amount: -1 })).toEqual({ amount: ['Enter 0 or more.'] });
    expect(await errors({ ...monthly, amount: 1.5 })).toEqual({ amount: ['Enter a whole amount in minor units.'] });
    expect(await errors({ ...monthly, mode: 'later' })).toMatchObject({ mode: [expect.any(String)] });
    expect(await errors({ ...monthly, cadence: 'none' })).toEqual({
      cadence: ["Invalid discriminator value. Expected 'weekly' | 'monthly' | 'yearly' | 'custom'"],
    });
    expect(await errors({ ...monthly, startMonth: '2026-13' })).toEqual({ startMonth: ['Use the format YYYY-MM.'] });
    const yearly = { kind: 'spending', cadence: 'yearly', amount: 1_000 };
    expect(await errors(yearly)).toMatchObject({ dueDate: [expect.any(String)] });
    expect(await errors({ ...yearly, dueDate: '2027-02-30' })).toEqual({ dueDate: ['Use the format YYYY-MM-DD.'] });
    const custom = { kind: 'spending', cadence: 'custom', amount: 1_000, dueDate: '2027-01-10' };
    expect(await errors({ ...custom, repeatUnit: 'month', repeatEvery: 0 })).toEqual({
      repeatEvery: ['Enter a whole number from 1 to 120.'],
    });
    expect(await errors({ ...custom, repeatUnit: 'year' })).toEqual({
      repeatEvery: ['Set how often it repeats together with the unit, or neither.'],
    });
    expect(await errors({ kind: 'debt' })).toEqual({
      debtMode: ["Invalid discriminator value. Expected 'min_payment' | 'fixed' | 'payoff_by_date'"],
    });
    expect(await errors({ kind: 'debt', debtMode: 'fixed' })).toMatchObject({ amount: [expect.any(String)] });
    expect(await errors({ kind: 'debt', debtMode: 'payoff_by_date' })).toMatchObject({ dueDate: [expect.any(String)] });
    expect(await errors({ kind: 'goal' })).toEqual({
      kind: ["Invalid discriminator value. Expected 'spending' | 'balance' | 'debt'"],
    });
  });

  it('allows start months from the budget start to 24 months ahead', async () => {
    const body = (startMonth: string) => ({ kind: 'balance', amount: 1_000, startMonth });
    expect((await put(groceries.id, body('2028-11'))).status).toBe(200);
    expect(await json(await put(groceries.id, body('2026-10')))).toEqual({
      status: 422,
      body: { code: 'month_out_of_range', message: 'Pick a month from 2026-11 to 2028-11.' },
    });
  });
});

describe('DELETE /api/categories/:id/target', () => {
  it('deletes the target as an undoable command', async () => {
    await put(groceries.id, { kind: 'balance', amount: 1_000 });
    const before = await snapshot(t.db);
    const del = () => ctx.client.send('DELETE', `/api/categories/${groceries.id}/target`);
    expect(await json(await del())).toEqual({ status: 200, body: { id: groceries.id } });
    expect(await t.db.select().from(target).where(eq(target.categoryId, groceries.id))).toEqual([]);
    expect(await json(await del())).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'This category has no target.' },
    });
    expect(await undoLabel()).toBe('Delete the target for "Groceries"');
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });
});

describe('snoozing a target', () => {
  const groceriesRow = async (month: string) => {
    const { body } = await json<BudgetMonthDto>(await ctx.client.get(`/api/budget/${month}`));
    return body.groups.flatMap((g) => g.categories).find((c) => c.id === groceries.id)!;
  };

  it('snoozes the target for one month and unsnoozes it (spec §6)', async () => {
    await put(groceries.id, { kind: 'spending', cadence: 'monthly', amount: 40_000 });
    await ctx.client.send('PUT', `/api/budget/2026-11/assignments/${groceries.id}`, { amount: 10_000 });
    const before = await snapshot(t.db);
    expect(await json(await snooze(groceries.id, '2026-11'))).toEqual({
      status: 200,
      body: dto(groceries.id, { amount: 40_000, mode: 'set_aside', snoozedMonth: '2026-11' }),
    });
    expect(await undoLabel()).toBe('Snooze the target for "Groceries"');
    // Snoozed: nothing is underfunded, but the progress still shows the real funding.
    expect(await groceriesRow('2026-11')).toMatchObject({
      pill: 'green',
      targetEvaluation: { need: 40_000, underfunded: 0, progress: 0.25, snoozed: true },
    });
    expect(await groceriesRow('2026-12')).toMatchObject({
      pill: 'yellow',
      targetEvaluation: { underfunded: 40_000, snoozed: false },
    });

    expect((await json(await unsnooze(groceries.id))).body).toMatchObject({ snoozedMonth: null });
    expect(await undoLabel()).toBe('Unsnooze the target for "Groceries"');
    expect(await groceriesRow('2026-11')).toMatchObject({ pill: 'yellow', targetEvaluation: { underfunded: 30_000 } });
    await ctx.client.post('/api/undo');
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('needs a target and a month in the budget range', async () => {
    expect(await json(await snooze(groceries.id, '2026-11'))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'This category has no target.' },
    });
    await put(groceries.id, { kind: 'balance', amount: 1_000 });
    expect(await json(await snooze(groceries.id, '2028-12'))).toMatchObject({
      status: 422,
      body: { code: 'month_out_of_range' },
    });
    expect(await json(await snooze(groceries.id, '2026-1'))).toMatchObject({
      status: 400,
      body: { fieldErrors: { month: ['Use the format YYYY-MM.'] } },
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/targets/target-routes.test.ts`
Expected: FAIL with `Tests  9 failed (9)`; every request gets `{ status: 404, body: { code: 'not_found', message: 'Not found.' } }` (e.g. `expected { status: 404, body: { …(2) } } to deeply equal { status: 200, body: { …(13) } }`).

- [ ] **Step 3: Add the request schemas**

```bash
git apply <<'PATCH'
diff --git a/src/shared/api/targets.ts b/src/shared/api/targets.ts
index cfb5b50..961f5ac 100644
--- a/src/shared/api/targets.ts
+++ b/src/shared/api/targets.ts
@@ -1,3 +1,6 @@
+import { z } from 'zod';
+import { isoDateSchema, monthSchema, nonNegativeMoneySchema } from './common';
+
 /** Spec §4.3 and §6: a category's target. */
 export type TargetKind = 'spending' | 'balance' | 'debt';
 export type TargetCadence = 'weekly' | 'monthly' | 'yearly' | 'custom' | 'none';
@@ -47,3 +50,73 @@ export interface TargetEvaluationDto {
    */
   incomplete: boolean;
 }
+
+const intBetween = (min: number, max: number, message: string) => z.int(message).min(min, message).max(max, message);
+
+/** Defaults to the replaced target's start month, or the current month for a new target. */
+const startMonth = monthSchema.optional();
+
+const spendingFields = {
+  kind: z.literal('spending'),
+  amount: nonNegativeMoneySchema,
+  mode: z.enum(['set_aside', 'refill']).default('set_aside'),
+  startMonth,
+};
+
+const spendingTargetSchema = z.discriminatedUnion('cadence', [
+  z.object({
+    ...spendingFields,
+    cadence: z.literal('weekly'),
+    dueWeekday: intBetween(0, 6, 'Pick a weekday.'),
+  }),
+  z.object({
+    ...spendingFields,
+    cadence: z.literal('monthly'),
+    /** Null (the default) is the last day of the month. */
+    dueDayOfMonth: intBetween(1, 31, 'Pick a day from 1 to 31.').nullable().default(null),
+  }),
+  z.object({ ...spendingFields, cadence: z.literal('yearly'), dueDate: isoDateSchema }),
+  z
+    .object({
+      ...spendingFields,
+      cadence: z.literal('custom'),
+      dueDate: isoDateSchema,
+      /** Null (the default) for a one-off target due on `dueDate`. */
+      repeatUnit: z.enum(['month', 'year']).nullable().default(null),
+      repeatEvery: intBetween(1, 120, 'Enter a whole number from 1 to 120.').nullable().default(null),
+    })
+    .refine((t) => (t.repeatUnit === null) === (t.repeatEvery === null), {
+      path: ['repeatEvery'],
+      message: 'Set how often it repeats together with the unit, or neither.',
+    }),
+]);
+
+const balanceTargetSchema = z.object({
+  kind: z.literal('balance'),
+  amount: nonNegativeMoneySchema,
+  /** "Have X by D"; null (the default) for "have X" with no date. */
+  dueDate: isoDateSchema.nullable().default(null),
+  startMonth,
+});
+
+/** Debt targets: credit card payment and paired loan categories only (spec §6). */
+const debtTargetSchema = z.discriminatedUnion('debtMode', [
+  z.object({ kind: z.literal('debt'), debtMode: z.literal('min_payment'), startMonth }),
+  z.object({ kind: z.literal('debt'), debtMode: z.literal('fixed'), amount: nonNegativeMoneySchema, startMonth }),
+  z.object({ kind: z.literal('debt'), debtMode: z.literal('payoff_by_date'), dueDate: isoDateSchema, startMonth }),
+]);
+
+/**
+ * PUT /api/categories/:id/target: creates or replaces the category's target. Each kind and cadence (or debt mode)
+ * takes only the fields it uses; a replaced target keeps its start month (unless given) and its snooze.
+ */
+export const setTargetRequestSchema = z.discriminatedUnion('kind', [
+  spendingTargetSchema,
+  balanceTargetSchema,
+  debtTargetSchema,
+]);
+
+/** POST /api/categories/:id/target/snooze */
+export const snoozeTargetRequestSchema = z.object({ month: monthSchema });
+
+export type SetTargetRequest = z.infer<typeof setTargetRequestSchema>;
PATCH
```

- [ ] **Step 4: Write the commands**

Create `src/server/targets/target-commands.ts`:

```ts
import { eq } from 'drizzle-orm';
import { type IsoDate, type Month, monthOf } from '../../engine';
import type { SetTargetRequest, TargetDto } from '../../shared/api/targets';
import { assertBudgetMonth, monthStart } from '../budget/assignments';
import { loadCategory } from '../categories/category-commands';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { target } from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { toTargetDto } from './target-model';

/** The columns a target request sets; the category, start month, snooze and timestamps are handled separately. */
type TargetFields = Omit<
  typeof target.$inferInsert,
  'categoryId' | 'startMonth' | 'snoozedMonth' | 'createdAt' | 'updatedAt'
>;

const UNUSED = {
  amount: 0,
  mode: null,
  dueWeekday: null,
  dueDayOfMonth: null,
  dueDate: null,
  repeatUnit: null,
  repeatEvery: null,
  debtMode: null,
} as const;

/** The stored columns of a target; every field the kind and cadence don't use is cleared. */
function targetFields(input: SetTargetRequest): TargetFields {
  if (input.kind === 'balance') {
    return { ...UNUSED, kind: 'balance', cadence: 'none', amount: input.amount, dueDate: input.dueDate };
  }
  if (input.kind === 'debt') {
    // The engine ignores the cadence of debt targets; `monthly` matches the paired loan target (P2b1).
    const debt = { ...UNUSED, kind: 'debt', cadence: 'monthly', debtMode: input.debtMode } as const;
    if (input.debtMode === 'fixed') return { ...debt, amount: input.amount };
    if (input.debtMode === 'payoff_by_date') return { ...debt, dueDate: input.dueDate };
    return debt;
  }
  const { cadence, amount, mode } = input;
  const spending = { ...UNUSED, kind: 'spending', cadence, amount, mode } as const;
  if (input.cadence === 'weekly') return { ...spending, dueWeekday: input.dueWeekday };
  if (input.cadence === 'monthly') return { ...spending, dueDayOfMonth: input.dueDayOfMonth };
  if (input.cadence === 'yearly') return { ...spending, dueDate: input.dueDate };
  return { ...spending, dueDate: input.dueDate, repeatUnit: input.repeatUnit, repeatEvery: input.repeatEvery };
}

const NO_TARGET = () => new AppError(404, 'not_found', 'This category has no target.');

/** A category that may have a target: any live category but Ready to Assign and Uncategorized. */
async function targetableCategory(rec: ChangeRecorder, categoryId: string) {
  const current = await loadCategory(rec.tx, categoryId);
  if (current.kind === 'rta' || current.kind === 'uncategorized') {
    throw new DomainError('system_category', "System categories can't have targets.");
  }
  return current;
}

async function findTarget(db: Executor, categoryId: string) {
  const [row] = await db.select().from(target).where(eq(target.categoryId, categoryId));
  return row ?? null;
}

export async function getTarget(db: Executor, categoryId: string): Promise<TargetDto> {
  const row = await findTarget(db, categoryId);
  if (!row) throw NO_TARGET();
  return toTargetDto(row);
}

/** Spec §4.3 and §6: creates or replaces the category's target (0..1 per category). */
export async function setTarget(
  rec: ChangeRecorder,
  categoryId: string,
  input: SetTargetRequest,
  today: IsoDate,
): Promise<{ name: string }> {
  const current = await targetableCategory(rec, categoryId);
  if (input.kind === 'debt' && current.kind !== 'cc_payment' && current.kind !== 'debt_payment') {
    throw new DomainError('debt_target_not_allowed', 'Only credit card payment and loan categories take debt targets.');
  }
  if (input.startMonth !== undefined) await assertBudgetMonth(rec.tx, input.startMonth, today);
  const existing = await findTarget(rec.tx, categoryId);
  const startMonth = input.startMonth
    ? monthStart(input.startMonth)
    : (existing?.startMonth ?? monthStart(monthOf(today)));
  const fields = { ...targetFields(input), startMonth };
  if (existing) await rec.update(target, eq(target.categoryId, categoryId), fields);
  else await rec.insert(target, { categoryId, ...fields });
  return { name: current.name };
}

export async function deleteTarget(rec: ChangeRecorder, categoryId: string): Promise<{ name: string }> {
  const current = await loadCategory(rec.tx, categoryId);
  if ((await rec.delete(target, eq(target.categoryId, categoryId))).length === 0) throw NO_TARGET();
  return { name: current.name };
}

/** Spec §6: a snoozed target isn't underfunded in that month. `null` unsnoozes. */
export async function snoozeTarget(
  rec: ChangeRecorder,
  categoryId: string,
  month: Month | null,
  today: IsoDate,
): Promise<{ name: string }> {
  const current = await loadCategory(rec.tx, categoryId);
  if (!(await findTarget(rec.tx, categoryId))) throw NO_TARGET();
  if (month !== null) await assertBudgetMonth(rec.tx, month, today);
  await rec.update(target, eq(target.categoryId, categoryId), { snoozedMonth: month && monthStart(month) });
  return { name: current.name };
}
```

- [ ] **Step 5: Add the routes**

```bash
git apply <<'PATCH'
diff --git a/src/server/categories/category-routes.ts b/src/server/categories/category-routes.ts
index 6107838..2fa5099 100644
--- a/src/server/categories/category-routes.ts
+++ b/src/server/categories/category-routes.ts
@@ -8,15 +8,20 @@ import {
   updateCategoryRequestSchema,
 } from '../../shared/api/categories';
 import { idParamSchema, type IdResponse, type ReorderResponse } from '../../shared/api/common';
+import { setTargetRequestSchema, snoozeTargetRequestSchema, type TargetDto } from '../../shared/api/targets';
 import { type AuthedEnv, requireSession } from '../auth/sessions';
+import { todayIn } from '../clock';
 import { type Named, runCommand } from '../commands/run-command';
 import type { AppDeps } from '../http/app';
 import { validate } from '../http/validate';
+import { deleteTarget, getTarget, setTarget, snoozeTarget } from '../targets/target-commands';
 import { createCategory, deleteCategory, reorderCategories, updateCategory } from './category-commands';
 import { getCategory, listCategoryGroups } from './category-queries';
 
-/** /api/categories (spec §10 "Categories"): every change is one undoable command. */
+/** /api/categories (spec §10 "Categories", §6 targets): every change is one undoable command. */
 export function categoryRoutes(deps: AppDeps) {
+  const today = () => todayIn(deps.config.timeZone, deps.clock.now());
+
   return new Hono<AuthedEnv>()
     .use('*', requireSession(deps))
     .get('/', async (c) => c.json<CategoryListResponse>({ groups: await listCategoryGroups(deps.db) }))
@@ -45,5 +50,44 @@ export function categoryRoutes(deps: AppDeps) {
         (rec) => deleteCategory(rec, id, destinationCategoryId, deps.clock.now()),
       );
       return c.json<IdResponse>({ id });
+    })
+    .put('/:id/target', validate('param', idParamSchema), validate('json', setTargetRequestSchema), async (c) => {
+      const { id } = c.req.valid('param');
+      const body = c.req.valid('json');
+      await runCommand(
+        deps,
+        (r: Named) => `Set the target for "${r.name}"`,
+        (rec) => setTarget(rec, id, body, today()),
+      );
+      return c.json<TargetDto>(await getTarget(deps.db, id));
+    })
+    .delete('/:id/target', validate('param', idParamSchema), async (c) => {
+      const { id } = c.req.valid('param');
+      await runCommand(deps, (r: Named) => `Delete the target for "${r.name}"`, (rec) => deleteTarget(rec, id));
+      return c.json<IdResponse>({ id });
+    })
+    .post(
+      '/:id/target/snooze',
+      validate('param', idParamSchema),
+      validate('json', snoozeTargetRequestSchema),
+      async (c) => {
+        const { id } = c.req.valid('param');
+        const { month } = c.req.valid('json');
+        await runCommand(
+          deps,
+          (r: Named) => `Snooze the target for "${r.name}"`,
+          (rec) => snoozeTarget(rec, id, month, today()),
+        );
+        return c.json<TargetDto>(await getTarget(deps.db, id));
+      },
+    )
+    .delete('/:id/target/snooze', validate('param', idParamSchema), async (c) => {
+      const { id } = c.req.valid('param');
+      await runCommand(
+        deps,
+        (r: Named) => `Unsnooze the target for "${r.name}"`,
+        (rec) => snoozeTarget(rec, id, null, today()),
+      );
+      return c.json<TargetDto>(await getTarget(deps.db, id));
     });
 }
PATCH
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project server src/server/targets/target-routes.test.ts`
Expected: `Tests  9 passed (9)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  40 passed (40)`, `Tests  386 passed (386)`; both checks exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/shared/api/targets.ts src/server/targets src/server/categories/category-routes.ts
git commit -m "feat(server): targets API with snooze" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Auto-assign

Spec §7. `POST /api/budget/:month/auto-assign { strategy, scope }` runs as one undoable command, labelled `Auto-assign: <Strategy>`. Inside `runCommand` it:
1. checks the scope's group or category, before the month range, as P2b1's assignment routes do;
2. loads the month with `loadBudgetMonth(rec.tx, …)`, which checks the month range and guarantees the month is in the computed budget;
3. takes the categories in scope from the month view;
4. passes those categories (in display order) and their `targetEvaluation.underfunded` amounts to the engine's `autoAssign`;
5. writes every change with P2b1's `setAssigned`.

**Scopes:**
- `all`: the visible categories of visible groups.
- `group`: every category of the group, hidden ones included. An unknown group, or Internal, is a 422 `invalid_group`.
- `category`: that one category, even if hidden. An unknown one is a 404; Ready to Assign or Uncategorized is a 422 `category_not_assignable`.
- Scope ids match the view's ids because P2b1's `idSchema` lowercases them.

**System categories:** the scope is taken from the month view, which never lists Ready to Assign or Uncategorized. That matters because strategies such as `spent_last_month` and `reset_available` would otherwise assign to Uncategorized, which `computeBudget` refuses (P2 carry-over, P2b1 review).

**Results:** Underfunded uses snoozed and target-less categories' 0. Strategies that change nothing leave no undo entry. The response lists the changed assignments with their new amounts.

**Files:**
- Create: `src/server/budget/auto-assign.ts`
- Modify: `src/shared/api/budget.ts`, `src/server/budget/budget-routes.ts`
- Test: `src/server/budget/auto-assign.test.ts`

**Interfaces:**
- Consumes: `autoAssign`, `AssignmentChange`, `AutoAssignStrategy` from `src/engine`; `loadBudgetMonth` (Task 4); `assignableCategory`, `setAssigned`, the lowercasing `idSchema` (P2b1).
- Produces:
  - `src/shared/api/budget.ts`: `AUTO_ASSIGN_STRATEGIES`, `autoAssignRequestSchema` / `AutoAssignRequest`, `AutoAssignResponse { assignments: AssignmentDto[] }`.
  - `src/server/budget/auto-assign.ts`:
    - `STRATEGY_LABELS: Record<AutoAssignStrategy, string>`
    - `autoAssignMonth(rec, month, request: AutoAssignRequest, today: IsoDate): Promise<AssignmentChange[]>`
  - `POST /api/budget/:month/auto-assign` → 200 `AutoAssignResponse`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/budget/auto-assign.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import type { BudgetMonthDto } from '../../shared/api/budget';
import type { CategoryDto, CategoryGroupDto } from '../../shared/api/categories';
import type { UndoState } from '../../shared/api/undo';
import { systemCategoryId, systemGroupId } from '../db/lookups';
import { assignment } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, insertTransaction } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let checking: AccountDto;
let visa: AccountDto;
let everyday: CategoryGroupDto;
let old: CategoryGroupDto;
let groceries: CategoryDto;
let rent: CategoryDto;
let dining: CategoryDto;
let hobby: CategoryDto;
beforeEach(async () => {
  t = await createTestDatabase();
  // Setup on 20 November 2026; the checking account's starting balance moves the budget start to 2026-10.
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
  checking = await createAccount(ctx.client, {
    name: 'Checking',
    startingBalance: 100_000,
    startingDate: '2026-10-01',
  });
  visa = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card', minPayment: 5_000 });
  everyday = await createGroup(ctx.client, 'Everyday');
  old = await createGroup(ctx.client, 'Old');
  groceries = await createCategory(ctx.client, everyday.id, 'Groceries');
  rent = await createCategory(ctx.client, everyday.id, 'Rent');
  dining = await createCategory(ctx.client, everyday.id, 'Dining');
  hobby = await createCategory(ctx.client, old.id, 'Hobby');
  await ctx.client.send('PATCH', `/api/categories/${dining.id}`, { hidden: true });
  await ctx.client.send('PATCH', `/api/category-groups/${old.id}`, { hidden: true });
  const monthly = (amount: number) => ({ kind: 'spending', cadence: 'monthly', amount });
  for (const [id, body] of [
    [groceries.id, monthly(30_000)],
    [rent.id, monthly(70_000)],
    [dining.id, monthly(10_000)],
    [hobby.id, monthly(5_000)],
    [visa.paymentCategoryId!, { kind: 'debt', debtMode: 'min_payment' }],
  ] as const) {
    expect((await ctx.client.send('PUT', `/api/categories/${id}/target`, body)).status).toBe(200);
  }
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const autoAssign = (month: string, strategy: string, scope: object = { type: 'all' }) =>
  ctx.client.post(`/api/budget/${month}/auto-assign`, { strategy, scope });
const assign = (month: string, categoryId: string, amount: number) =>
  ctx.client.send('PUT', `/api/budget/${month}/assignments/${categoryId}`, { amount });
const assigned = async (month: string) =>
  (await t.db.select().from(assignment)).filter((a) => a.month === `${month}-01`).map((a) => [a.categoryId, a.amount]);
const undoState = async () => (await json<UndoState>(await ctx.client.get('/api/undo'))).body;

describe('POST /api/budget/:month/auto-assign', () => {
  it('underfunded: fills visible targets in display order up to Ready to Assign, as one undoable command', async () => {
    const before = await snapshot(t.db);
    // Display order: Credit Card Payments (Visa), then Everyday (Groceries, Rent; Dining is hidden). Old is hidden.
    expect(await json(await autoAssign('2026-11', 'underfunded'))).toEqual({
      status: 200,
      body: {
        assignments: [
          { month: '2026-11', categoryId: visa.paymentCategoryId, amount: 5_000 },
          { month: '2026-11', categoryId: groceries.id, amount: 30_000 },
          // Only 65 zł of the 70 zł target is left to assign.
          { month: '2026-11', categoryId: rent.id, amount: 65_000 },
        ],
      },
    });
    expect((await json<BudgetMonthDto>(await ctx.client.get('/api/budget/2026-11'))).body.rta.readyToAssign).toBe(0);
    expect((await undoState()).undo).toEqual({ label: 'Auto-assign: Underfunded' });
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('scopes to one group or one category, hidden ones included', async () => {
    // Ids are matched regardless of letter case.
    const diningScope = { type: 'category', id: dining.id.toUpperCase() };
    expect((await json(await autoAssign('2026-11', 'underfunded', diningScope))).body).toEqual({
      assignments: [{ month: '2026-11', categoryId: dining.id, amount: 10_000 }],
    });
    expect((await json(await autoAssign('2026-11', 'underfunded', { type: 'group', id: old.id }))).body).toEqual({
      assignments: [{ month: '2026-11', categoryId: hobby.id, amount: 5_000 }],
    });
    const ccPayments = await systemGroupId(t.db, 'cc_payments');
    expect((await json(await autoAssign('2026-11', 'underfunded', { type: 'group', id: ccPayments }))).body).toEqual({
      assignments: [{ month: '2026-11', categoryId: visa.paymentCategoryId, amount: 5_000 }],
    });
    // Everyday: Groceries 30 zł, Rent the 50 zł left; Dining's target is already funded.
    expect((await json(await autoAssign('2026-11', 'underfunded', { type: 'group', id: everyday.id }))).body).toEqual({
      assignments: [
        { month: '2026-11', categoryId: groceries.id, amount: 30_000 },
        { month: '2026-11', categoryId: rent.id, amount: 50_000 },
      ],
    });
  });

  it('never assigns to Uncategorized or Ready to Assign, whatever the strategy', async () => {
    const uncategorized = await systemCategoryId(t.db, 'uncategorized');
    const spend = (date: string, amount: number, categoryId?: string) =>
      insertTransaction(t.db, { accountId: checking.id, date, amount: -amount, categoryId });
    // Uncategorized spent 20 zł in October and is 10 zł overspent in November.
    await spend('2026-10-10', 2_000);
    await spend('2026-11-10', 1_000);
    await spend('2026-10-12', 3_000, groceries.id);
    expect((await json(await autoAssign('2026-11', 'spent_last_month'))).body).toEqual({
      assignments: [{ month: '2026-11', categoryId: groceries.id, amount: 3_000 }],
    });
    await assign('2026-11', rent.id, 4_000);
    expect((await json(await autoAssign('2026-11', 'reset_available'))).body).toEqual({
      assignments: [
        // Groceries: 3 zł assigned minus 3 zł available (October overspending doesn't carry).
        { month: '2026-11', categoryId: groceries.id, amount: 0 },
        { month: '2026-11', categoryId: rent.id, amount: 0 },
      ],
    });
    expect(await assigned('2026-11')).toEqual([]);
    const month = (await json<BudgetMonthDto>(await ctx.client.get('/api/budget/2026-11'))).body;
    expect(month.uncategorized).toMatchObject({ assigned: 0, available: -1_000 });

    for (const id of [uncategorized, await systemCategoryId(t.db, 'rta')]) {
      expect(await json(await autoAssign('2026-11', 'reset_available', { type: 'category', id }))).toEqual({
        status: 422,
        body: { code: 'category_not_assignable', message: "Money can't be assigned to this category." },
      });
    }
    const internal = { type: 'group', id: await systemGroupId(t.db, 'internal') };
    expect(await json(await autoAssign('2026-11', 'reset_available', internal))).toEqual({
      status: 422,
      body: { code: 'invalid_group', message: 'Choose one of your category groups.' },
    });
  });

  it('copies and averages earlier months, and resets assignments', async () => {
    await assign('2026-10', groceries.id, 20_000);
    await assign('2026-10', visa.paymentCategoryId!, 1_000);
    expect((await json(await autoAssign('2026-11', 'assigned_last_month'))).body).toEqual({
      assignments: [
        { month: '2026-11', categoryId: visa.paymentCategoryId, amount: 1_000 },
        { month: '2026-11', categoryId: groceries.id, amount: 20_000 },
      ],
    });
    // The budget starts in 2026-10, so the average covers October and November.
    expect((await json(await autoAssign('2026-12', 'average_assigned', { type: 'category', id: groceries.id }))).body)
      .toEqual({ assignments: [{ month: '2026-12', categoryId: groceries.id, amount: 20_000 }] });
    expect((await json(await autoAssign('2026-11', 'reset_assigned'))).body).toEqual({
      assignments: [
        { month: '2026-11', categoryId: visa.paymentCategoryId, amount: 0 },
        { month: '2026-11', categoryId: groceries.id, amount: 0 },
      ],
    });
    expect((await undoState()).undo).toEqual({ label: 'Auto-assign: Reset assigned' });
  });

  it('records nothing when no assignment changes', async () => {
    const state = await undoState();
    expect(await json(await autoAssign('2026-11', 'reset_assigned'))).toEqual({
      status: 200,
      body: { assignments: [] },
    });
    expect(await undoState()).toEqual(state);
  });

  it('validates the strategy, the scope and the month, reporting the scope first', async () => {
    const bad = async (body: object) =>
      (await json(await ctx.client.post('/api/budget/2026-11/auto-assign', body))).body;
    expect(await bad({ strategy: 'everything', scope: { type: 'all' } })).toMatchObject({
      code: 'validation',
      fieldErrors: { strategy: [expect.any(String)] },
    });
    expect(await bad({ strategy: 'underfunded' })).toMatchObject({ fieldErrors: { scope: [expect.any(String)] } });
    expect(await bad({ strategy: 'underfunded', scope: { type: 'group' } })).toMatchObject({
      fieldErrors: { scope: [expect.any(String)] },
    });
    const unknown = crypto.randomUUID();
    expect(await json(await autoAssign('2026-11', 'underfunded', { type: 'group', id: unknown }))).toEqual({
      status: 422,
      body: { code: 'invalid_group', message: 'Choose one of your category groups.' },
    });
    expect(await json(await autoAssign('2026-11', 'underfunded', { type: 'category', id: unknown }))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Category not found.' },
    });
    expect(await json(await autoAssign('2026-09', 'underfunded'))).toEqual({
      status: 422,
      body: { code: 'month_out_of_range', message: 'Pick a month from 2026-10 to 2028-11.' },
    });
    expect(await json(await autoAssign('2026-09', 'underfunded', { type: 'category', id: unknown }))).toMatchObject({
      status: 404,
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/budget/auto-assign.test.ts`
Expected: FAIL with `Tests  6 failed (6)`; the route doesn't exist, so the requests get 404 (e.g. `expected { status: 404, body: { …(2) } } to deeply equal { status: 200, body: { …(1) } }`).

- [ ] **Step 3: Add the request schema**

```bash
git apply <<'PATCH'
diff --git a/src/shared/api/budget.ts b/src/shared/api/budget.ts
index 830602e..cda7665 100644
--- a/src/shared/api/budget.ts
+++ b/src/shared/api/budget.ts
@@ -22,6 +22,32 @@ export const monthNoteRequestSchema = z.object({ note: noteSchema });
 
 export type MoveMoneyRequest = z.infer<typeof moveMoneyRequestSchema>;
 
+/** Spec §7 auto-assign strategies. */
+export const AUTO_ASSIGN_STRATEGIES = [
+  'underfunded',
+  'assigned_last_month',
+  'spent_last_month',
+  'average_assigned',
+  'average_spent',
+  'reset_available',
+  'reset_assigned',
+] as const;
+
+/**
+ * POST /api/budget/:month/auto-assign. `all` covers the visible categories of visible groups; a group or a category
+ * may be hidden. Ready to Assign and Uncategorized are never in scope.
+ */
+export const autoAssignRequestSchema = z.object({
+  strategy: z.enum(AUTO_ASSIGN_STRATEGIES),
+  scope: z.discriminatedUnion('type', [
+    z.object({ type: z.literal('all') }),
+    z.object({ type: z.literal('group'), id: idSchema }),
+    z.object({ type: z.literal('category'), id: idSchema }),
+  ]),
+});
+
+export type AutoAssignRequest = z.infer<typeof autoAssignRequestSchema>;
+
 export interface AssignmentDto {
   /** 'YYYY-MM' */
   month: string;
@@ -35,6 +61,11 @@ export interface MoveMoneyResponse {
   assignments: AssignmentDto[];
 }
 
+export interface AutoAssignResponse {
+  /** The categories whose Assigned changed, with their new amounts (empty when nothing changed). */
+  assignments: AssignmentDto[];
+}
+
 export interface MonthNoteDto {
   month: string;
   note: string | null;
PATCH
```

- [ ] **Step 4: Write the command**

Create `src/server/budget/auto-assign.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { type AssignmentChange, type AutoAssignStrategy, autoAssign, type IsoDate, type Month } from '../../engine';
import type { AutoAssignRequest, BudgetCategoryDto, BudgetMonthDto } from '../../shared/api/budget';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { categoryGroup } from '../db/schema';
import { DomainError } from '../http/errors';
import { assignableCategory, setAssigned } from './assignments';
import { loadBudgetMonth } from './budget-month';

type Scope = AutoAssignRequest['scope'];

/** Undo labels: "Auto-assign: Underfunded". */
export const STRATEGY_LABELS: Record<AutoAssignStrategy, string> = {
  underfunded: 'Underfunded',
  assigned_last_month: 'Assigned last month',
  spent_last_month: 'Spent last month',
  average_assigned: 'Average assigned',
  average_spent: 'Average spent',
  reset_available: 'Reset available',
  reset_assigned: 'Reset assigned',
};

/**
 * Like the assignment routes, reports an unusable scope before the month range: an unknown category is a 404,
 * Ready to Assign and Uncategorized are 422 `category_not_assignable`, an unknown or internal group is 422.
 */
async function assertScope(db: Executor, scope: Scope): Promise<void> {
  if (scope.type === 'category') await assignableCategory(db, scope.id);
  if (scope.type === 'group') {
    const [group] = await db
      .select({ kind: categoryGroup.kind })
      .from(categoryGroup)
      .where(and(eq(categoryGroup.id, scope.id), isNull(categoryGroup.deletedAt)));
    if (!group || group.kind === 'internal') {
      throw new DomainError('invalid_group', 'Choose one of your category groups.');
    }
  }
}

/**
 * The categories in scope, in display order (spec §7). The month view leaves out the internal group, so Ready to
 * Assign and Uncategorized are never in scope (`computeBudget` refuses assignments to Uncategorized).
 */
function categoriesInScope(view: BudgetMonthDto, scope: Scope): BudgetCategoryDto[] {
  if (scope.type === 'all') {
    return view.groups.filter((g) => !g.hidden).flatMap((g) => g.categories.filter((c) => !c.hidden));
  }
  if (scope.type === 'group') return view.groups.find((g) => g.id === scope.id)?.categories ?? [];
  return view.groups.flatMap((g) => g.categories).filter((c) => c.id === scope.id);
}

/** Spec §7: one undoable command that sets Assigned for every category in scope that the strategy changes. */
export async function autoAssignMonth(
  rec: ChangeRecorder,
  month: Month,
  request: AutoAssignRequest,
  today: IsoDate,
): Promise<AssignmentChange[]> {
  await assertScope(rec.tx, request.scope);
  const { result, view } = await loadBudgetMonth(rec.tx, month, today);
  const categories = categoriesInScope(view, request.scope);
  const changes = autoAssign({
    strategy: request.strategy,
    month,
    categoryIds: categories.map((c) => c.id),
    budget: result,
    // Snoozed targets and categories without a target are not underfunded.
    underfunded: Object.fromEntries(categories.map((c) => [c.id, c.targetEvaluation?.underfunded ?? 0])),
  });
  for (const change of changes) await setAssigned(rec, change.categoryId, month, change.to);
  return changes;
}
```

- [ ] **Step 5: Add the route**

```bash
git apply <<'PATCH'
diff --git a/src/server/budget/budget-routes.ts b/src/server/budget/budget-routes.ts
index 3a42fbe..9d911ac 100644
--- a/src/server/budget/budget-routes.ts
+++ b/src/server/budget/budget-routes.ts
@@ -2,6 +2,8 @@ import { Hono } from 'hono';
 import {
   type AssignmentDto,
   assignmentParamSchema,
+  type AutoAssignResponse,
+  autoAssignRequestSchema,
   type BudgetMonthDto,
   type MonthNoteDto,
   monthNoteRequestSchema,
@@ -16,11 +18,12 @@ import { type Named, runCommand } from '../commands/run-command';
 import type { AppDeps } from '../http/app';
 import { validate } from '../http/validate';
 import { assertBudgetMonth, assignableCategory, assignedIn, moveMoney, setAssigned, setMonthNote } from './assignments';
+import { autoAssignMonth, STRATEGY_LABELS } from './auto-assign';
 import { loadBudgetMonth } from './budget-month';
 
 /**
- * /api/budget/:month (spec §3, §5.4, §11): the month view, assigning, moving money and the month note; months are
- * 'YYYY-MM'.
+ * /api/budget/:month (spec §3, §5.4, §7, §11): the month view, assigning, moving money, auto-assign and the month
+ * note; months are 'YYYY-MM'.
  */
 export function budgetRoutes(deps: AppDeps) {
   const today = () => todayIn(deps.config.timeZone, deps.clock.now());
@@ -74,6 +77,21 @@ export function budgetRoutes(deps: AppDeps) {
       );
       return c.json<MoveMoneyResponse>({ assignments });
     })
+    .post(
+      '/:month/auto-assign',
+      validate('param', monthParamSchema),
+      validate('json', autoAssignRequestSchema),
+      async (c) => {
+        const { month } = c.req.valid('param');
+        const body = c.req.valid('json');
+        const changes = await runCommand(deps, `Auto-assign: ${STRATEGY_LABELS[body.strategy]}`, (rec) =>
+          autoAssignMonth(rec, month, body, today()),
+        );
+        return c.json<AutoAssignResponse>({
+          assignments: changes.map((change) => ({ month, categoryId: change.categoryId, amount: change.to })),
+        });
+      },
+    )
     .put('/:month/note', validate('param', monthParamSchema), validate('json', monthNoteRequestSchema), async (c) => {
       const { month } = c.req.valid('param');
       const { note } = c.req.valid('json');
PATCH
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project server src/server/budget/auto-assign.test.ts`
Expected: `Tests  6 passed (6)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  41 passed (41)`, `Tests  392 passed (392)`; both checks exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/shared/api/budget.ts src/server/budget
git commit -m "feat(server): auto-assign" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Hide a closed card's settled payment category; P2b2 docs

Spec §10: "Credit card payment categories are hidden automatically when the account is closed with Available = 0" (deferred from P2b1).
- **When:** closing a credit account computes the current month's budget inside the close command. If the payment category's Available is 0, the command also sets `hidden` through the recorder, so a single undo reopens the account and unhides the category.
- **Only once:** it happens only when the account goes from open to closed. Closing an already closed account stays a no-op, and reopening leaves the category as it is.

The P2b carry-over route guard also gets explicit expectations: `app.test.ts` already walks every route and expects a 401, and now also asserts that the new budget and target routes are part of that walk.

Finally, the spec is amended where P2b2 decided something the spec left open, and the carry-over and engineering notes are updated.

**Files:**
- Modify: `src/server/accounts/account-commands.ts`, `src/server/accounts/account-routes.ts`
- Modify (docs): the spec (§3, §5.1 for `585b6ca`'s editable earlier months, §5.3, §6, §7, §10), `docs/superpowers/notes/p2-carry-over.md`, `docs/superpowers/notes/engineering-notes.md`
- Test: `src/server/accounts/account-routes.test.ts`, `src/server/http/app.test.ts`

**Interfaces:**
- Consumes: `loadBudgetInput` (Task 2), `computeBudget`.
- Produces: `setAccountClosed(rec, id, closed: boolean, today: IsoDate): Promise<{ name }>` (new `today` parameter); `POST /api/accounts/:id/close` also hides the settled payment category.

- [ ] **Step 1: Write the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-routes.test.ts b/src/server/accounts/account-routes.test.ts
index ad4b6c4..c76c663 100644
--- a/src/server/accounts/account-routes.test.ts
+++ b/src/server/accounts/account-routes.test.ts
@@ -6,7 +6,7 @@ import { account, assignment, category, payee, target, transaction } from '../db
 import { createTestApp, type TestApp } from '../test/app';
 import { setUpBudget } from '../test/auth';
 import { createTestDatabase, type TestDatabase } from '../test/db';
-import { createAccount } from '../test/fixtures';
+import { createAccount, createCategory, createGroup, insertTransaction } from '../test/fixtures';
 import { snapshot } from '../test/snapshot';
 
 let t: TestDatabase;
@@ -360,6 +360,46 @@ describe('closing and reopening', () => {
     const reopened = await json<AccountDto>(await ctx.client.post(`/api/accounts/${empty.id}/reopen`));
     expect([reopened.status, reopened.body.closed]).toEqual([200, false]);
   });
+
+  it('hides a closed credit card’s payment category when nothing is available in it (spec §10)', async () => {
+    const checking = await createAccount(ctx.client, { name: 'Checking', startingBalance: 100_000 });
+    const visa = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
+    const amex = await createAccount(ctx.client, { name: 'Amex', type: 'credit_card' });
+    const group = await createGroup(ctx.client, 'Everyday');
+    const groceries = await createCategory(ctx.client, group.id, 'Groceries');
+    // Visa: 50 zł of funded spending, paid off in full, leaves its payment category at 0.
+    await ctx.client.send('PUT', `/api/budget/2026-11/assignments/${groceries.id}`, { amount: 5_000 });
+    await insertTransaction(t.db, { accountId: visa.id, date: '2026-11-02', amount: -5_000, categoryId: groceries.id });
+    const out = await insertTransaction(t.db, {
+      accountId: checking.id,
+      date: '2026-11-10',
+      amount: -5_000,
+      transferAccountId: visa.id,
+    });
+    await insertTransaction(t.db, {
+      accountId: visa.id,
+      date: '2026-11-10',
+      amount: 5_000,
+      transferAccountId: checking.id,
+      transferTxnId: out.id,
+    });
+    // Amex: 20 zł is still set aside for it.
+    await ctx.client.send('PUT', `/api/budget/2026-11/assignments/${amex.paymentCategoryId}`, { amount: 2_000 });
+    const hidden = async (categoryId: string) =>
+      (await t.db.select({ hidden: category.hidden }).from(category).where(eq(category.id, categoryId)))[0]?.hidden;
+
+    const before = await snapshot(t.db);
+    expect((await ctx.client.post(`/api/accounts/${visa.id}/close`)).status).toBe(200);
+    expect(await hidden(visa.paymentCategoryId!)).toBe(true);
+    expect((await ctx.client.post(`/api/accounts/${amex.id}/close`)).status).toBe(200);
+    expect(await hidden(amex.paymentCategoryId!)).toBe(false);
+
+    // Reopening leaves the category as it is; undoing the close restores it.
+    await ctx.client.post(`/api/accounts/${visa.id}/reopen`);
+    expect(await hidden(visa.paymentCategoryId!)).toBe(true);
+    for (let i = 0; i < 3; i++) await ctx.client.post('/api/undo');
+    expect(await snapshot(t.db)).toEqual(before);
+  });
 });
 
 describe('DELETE /api/accounts/:id', () => {
diff --git a/src/server/http/app.test.ts b/src/server/http/app.test.ts
index 0b98177..244f604 100644
--- a/src/server/http/app.test.ts
+++ b/src/server/http/app.test.ts
@@ -79,7 +79,17 @@ describe('route guard', () => {
     const routes = app.routes
       .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/') && !isAuth(r.path))
       .map((r) => `${r.method} ${r.path}`);
-    expect(routes).toContain('GET /api/undo');
+    expect(routes).toEqual(
+      expect.arrayContaining([
+        'GET /api/undo',
+        'GET /api/budget/:month',
+        'POST /api/budget/:month/auto-assign',
+        'PUT /api/categories/:id/target',
+        'DELETE /api/categories/:id/target',
+        'POST /api/categories/:id/target/snooze',
+        'DELETE /api/categories/:id/target/snooze',
+      ]),
+    );
 
     const responses = [];
     for (const route of routes) {
PATCH
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/accounts/account-routes.test.ts src/server/http/app.test.ts`
Expected: FAIL with `Tests  1 failed | 25 passed (26)`: `hides a closed credit card’s payment category when nothing is available in it (spec §10)` reports `expected false to be true`. The route guard already passes: the routes from Tasks 4–6 are guarded.

- [ ] **Step 3: Hide the payment category when closing**

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-commands.ts b/src/server/accounts/account-commands.ts
index af0d8bb..15b9958 100644
--- a/src/server/accounts/account-commands.ts
+++ b/src/server/accounts/account-commands.ts
@@ -6,7 +6,8 @@ import {
   type CreateAccountRequest,
   type UpdateAccountRequest,
 } from '../../shared/api/accounts';
-import { type IsoDate, convertToBase, monthOf } from '../../engine';
+import { computeBudget, convertToBase, type IsoDate, monthOf } from '../../engine';
+import { loadBudgetInput } from '../budget/budget-input';
 import type { ChangeRecorder } from '../commands/recorder';
 import { applyOrder } from '../commands/reorder';
 import type { Executor } from '../db/client';
@@ -174,13 +175,36 @@ export async function updateAccount(
   return { name };
 }
 
-/** Spec §10: closing needs a zero balance (in the account's currency); reopening is always allowed. */
-export async function setAccountClosed(rec: ChangeRecorder, id: string, closed: boolean): Promise<{ name: string }> {
+/** Spec §10: a closed card's payment category is hidden when it holds nothing this month (Available = 0). */
+async function hideSettledPaymentCategory(rec: ChangeRecorder, accountId: string, today: IsoDate): Promise<void> {
+  const [payment] = await rec.tx
+    .select({ id: category.id })
+    .from(category)
+    .where(and(eq(category.linkedAccountId, accountId), isNull(category.deletedAt)));
+  if (!payment) return;
+  const month = monthOf(today);
+  const budget = computeBudget(await loadBudgetInput(rec.tx, { throughMonth: month, today }));
+  if (budget.byMonth[month]?.categories[payment.id]?.available === 0) {
+    await rec.update(category, eq(category.id, payment.id), { hidden: true });
+  }
+}
+
+/**
+ * Spec §10: closing needs a zero balance (in the account's currency) and hides a credit card's settled payment
+ * category; reopening is always allowed and leaves the category as it is.
+ */
+export async function setAccountClosed(
+  rec: ChangeRecorder,
+  id: string,
+  closed: boolean,
+  today: IsoDate,
+): Promise<{ name: string }> {
   const current = await loadAccount(rec.tx, id);
   if (closed && (await getAccount(rec.tx, id)).balance.working !== 0) {
     throw new DomainError('account_balance_not_zero', 'Bring the balance to 0 before closing the account.');
   }
   await rec.update(account, eq(account.id, id), { closed });
+  if (closed && !current.closed && current.accountClass === 'credit') await hideSettledPaymentCategory(rec, id, today);
   return { name: current.name };
 }
 
diff --git a/src/server/accounts/account-routes.ts b/src/server/accounts/account-routes.ts
index dec2789..8959e8a 100644
--- a/src/server/accounts/account-routes.ts
+++ b/src/server/accounts/account-routes.ts
@@ -41,12 +41,20 @@ export function accountRoutes(deps: AppDeps) {
     })
     .post('/:id/close', validate('param', idParamSchema), async (c) => {
       const { id } = c.req.valid('param');
-      await runCommand(deps, (r: Named) => `Close account "${r.name}"`, (rec) => setAccountClosed(rec, id, true));
+      await runCommand(
+        deps,
+        (r: Named) => `Close account "${r.name}"`,
+        (rec) => setAccountClosed(rec, id, true, today()),
+      );
       return c.json<AccountDto>(await getAccount(deps.db, id));
     })
     .post('/:id/reopen', validate('param', idParamSchema), async (c) => {
       const { id } = c.req.valid('param');
-      await runCommand(deps, (r: Named) => `Reopen account "${r.name}"`, (rec) => setAccountClosed(rec, id, false));
+      await runCommand(
+        deps,
+        (r: Named) => `Reopen account "${r.name}"`,
+        (rec) => setAccountClosed(rec, id, false, today()),
+      );
       return c.json<AccountDto>(await getAccount(deps.db, id));
     })
     .delete('/:id', validate('param', idParamSchema), async (c) => {
PATCH
```

- [ ] **Step 4: Update the spec and the notes**

```bash
git apply <<'PATCH'
diff --git a/docs/superpowers/notes/engineering-notes.md b/docs/superpowers/notes/engineering-notes.md
index 3915f91..ff278e4 100644
--- a/docs/superpowers/notes/engineering-notes.md
+++ b/docs/superpowers/notes/engineering-notes.md
@@ -66,6 +66,19 @@ Keep each plan to about 8–10 tasks. A task is one reviewable unit with its own
   - `727274001`: login and re-authentication.
   - `727274002`: user commands and undo/redo (`COMMAND_LOCK_KEY` in `src/server/commands/run-command.ts`).
 
+### Budget read model
+- `loadBudgetInput(db, { throughMonth, today })` (`src/server/budget/budget-input.ts`) is the only place that turns
+  the ledger into `computeBudget` input; it starts at `firstEditableMonth()`, the lower bound `assertBudgetMonth()`
+  allows, so every allowed month is in the result. `loadBudgetMonth(db, month, today)` checks the month range, runs
+  `computeBudget` once and builds the month view. Read routes run it in
+  `db.transaction(fn, { isolationLevel: 'repeatable read', accessMode: 'read only' })` so every query sees one
+  snapshot. Commands (auto-assign, closing a card) call it with `rec.tx` inside `runCommand`.
+- `setAssigned`/`addAssigned` don't check the category; callers go through `assignableCategory` or the month view,
+  which never lists Ready to Assign or Uncategorized.
+- "Today" for the budget is `todayIn(config.timeZone, clock.now())`; lines dated later are left out.
+- zod 4 discriminated unions nest (`kind` → `cadence` / `debtMode`), and refined objects can be options.
+  `z.flattenError` reports an unknown discriminator under its key, e.g. `fieldErrors.cadence`.
+
 ### Engine
 - `src/engine` is pure: no I/O, no Node modules, no `Date.now()` / `new Date()` / `Math.random()`. ESLint enforces this.
 - `computeBudget` throws on unknown or duplicate categories, assignments to RTA or Uncategorized, lines categorised to a
diff --git a/docs/superpowers/notes/p2-carry-over.md b/docs/superpowers/notes/p2-carry-over.md
index 37d9764..c70a3d3 100644
--- a/docs/superpowers/notes/p2-carry-over.md
+++ b/docs/superpowers/notes/p2-carry-over.md
@@ -11,32 +11,16 @@ These items were found in the P1 final review and deferred. Fold them into the P
 - A refund larger than the payment category's Available (the §5.3 simplification).
 - The budget property generator should also produce rows outside `[startMonth, throughMonth]`.
 - The loan 1200-month cap (`amortizedPayment` horizon and `projectPayoff` "never").
-- Targets:
-  - `repeatUnit: 'year'`
-  - the cycle start clamped to `startMonth`
-  - an overdue `set_aside` target
-- Auto-assign: the 12-month average window and half-away-from-zero rounding of averages.
 - `transferBases` foreign → base with a `null` rate on the foreign side.
 
 ## Validation and behaviour
-- `autoAssign` should throw when `month` isn't in the computed budget instead of treating it as empty.
 - Validate the schedule anchor date (`nextOccurrence` returns an anchor ahead of `after` unchecked).
-- Build a month-view adapter that creates `TargetContext` (carry, assigned, available, `assignedIn`, debt data incl.
-  escrow) from a `BudgetResult`.
-- Validate the sign of `TargetDef.amount`. Make a `null` spending `mode` default to `set_aside` explicitly.
-- Document the sign conventions for each loan and target function. For example, `balanceAtMonthStart` and `debt`
-  are negative for debt, and `projectPayoff` ignores the sign.
-- Exclude the Uncategorized category, and any system category, from the auto-assign scope. The `spent_last_month`
-  and `reset_available` strategies can produce an assignment for Uncategorized, which `computeBudget` rejects.
-- Validate `TargetContext.debt` numbers (`minPayment`, `balanceAtMonthStart`, `escrow`) as safe integers at the
-  server boundary or in `evaluateTarget`.
 
 ## Resolved in P2a
 - Engine purity lint now also blocks dynamic `import()`, `globalThis.*`, `Date.now()`, `new Date()` and `Math.random()`.
 
 ## From P2a final review
-- P2b2: v_ledger_line month is 'YYYY-MM-01' and the engine uses 'YYYY-MM' (adapter); any migration touching view
-  columns must drop/recreate the view.
+- Any migration touching `v_ledger_line` columns must drop/recreate the view.
 - P2c: enforce date ≤ today on transaction writes (§5.6); the view does not filter future dates. (Starting balances
   already enforce it.)
 - P2c: nested validation errors lose paths in z.flattenError; return issue paths for nested bodies (split lines).
@@ -68,12 +52,6 @@ These items were found in the P1 final review and deferred. Fold them into the P
   lines without a payment category.
 
 ## From P2b1
-- P2b2: hide a credit card payment category automatically when its account is closed with Available = 0 (spec §10);
-  it needs the budget read model. Closing currently only sets `account.closed`.
-- P2b2: a paired loan category's `debt/min_payment` target reads `account.min_payment`, which PATCH can clear (null);
-  the month view must treat null as 0.
-- P2b2: reuse `budgetStartMonth()` and `MONTHS_AHEAD` from `src/server/budget/assignments.ts` for the month view and
-  auto-assign, and `setAssigned`/`addAssigned` for auto-assign writes.
 - P2c: deleting an account is refused while soft-deleted transactions still reference it; decide whether account
   deletion should purge soft-deleted history.
 - P2c: undo/redo replays row by row (two queries per changed row); bulk operations over thousands of rows may need
@@ -83,3 +61,35 @@ These items were found in the P1 final review and deferred. Fold them into the P
 - P2d: the scheduled-transaction job writes outside `runCommand` (no undo entry, redo kept) but should hold
   `lockCommands()` (advisory key 727274002) so it can't interleave with an undo replay.
 - P2d: `fxRate` is required to create a foreign-currency account; make it optional once the NBP lookup exists.
+
+## Resolved in P2b2
+- `loadBudgetInput` converts `v_ledger_line` months ('YYYY-MM-01') to engine months ('YYYY-MM') and casts every sum
+  `::bigint`.
+- `evaluateTarget` validates `TargetDef.amount` (safe integer ≥ 0) and the `TargetContext.debt` numbers (safe
+  integers; `minPayment` and `escrow` ≥ 0); a `null` spending mode is `set_aside` explicitly; the sign conventions of
+  the loan and target functions are documented.
+- `autoAssign` throws for a month outside the computed budget. The server never puts Ready to Assign or Uncategorized
+  in an auto-assign scope.
+- `targetContext` / `evaluateCategoryTarget` (`src/server/targets/target-model.ts`) build `TargetContext` from a
+  `BudgetResult` plus the linked account (minimum payment, APR, escrow for loans, PLN balance before the month).
+- A cleared `min_payment` (or APR) counts as 0 and flags the debt target `incomplete`.
+- Closing a credit account hides its payment category when Available = 0 in the current month.
+- The month view and auto-assign reuse `budgetStartMonth()`, `firstEditableMonth()` (now exported),
+  `assertBudgetMonth()`/`MONTHS_AHEAD` and `setAssigned`; the budget is computed from `firstEditableMonth()`.
+- Test gaps closed: `repeatUnit: 'year'`, the cycle start clamped to `startMonth`, an overdue `set_aside` target, and
+  the auto-assign 12-month window with half-away-from-zero rounding.
+- `app.test.ts` lists the new budget and target routes among those the deny-by-default walk covers.
+
+## From P2b2
+- P2c: the Budget screen's Activity tab needs the register API (transactions behind a category's monthly activity).
+- P2c: transaction writes must keep a split parent's `amount_base` equal to the sum of its live lines: debt balances
+  and "Need X to pay in full" read `transaction` (like account balances), while the budget reads `v_ledger_line`.
+- P2d: a loan's `balanceAtMonthStart` (pay-off-by-date targets) is the PLN sum of its transactions; it ignores the
+  synthetic interest and escrow rows of §8 until the loan engine (`computeLoanMonths`, interest overrides) is wired in.
+- P2d: the loan panel of a paired category (balance, APR, minimum payment, projected payoff, Record payment); the month
+  view only gives `linkedAccountId`.
+- P2d: foreign-currency cards and loans: debt targets use `min_payment` and `escrow_amount` as PLN amounts, which is
+  right only for PLN accounts.
+- Later: `GET /api/budget/:month` takes ≈ 80 ms for 10 years × 150 categories (26k transactions) and ≈ 175 ms in a
+  dense worst case (36k activity rows) on an M3 Max. If it matters, read the activity aggregate with `db.execute`
+  (Drizzle's row mapping costs ≈ 30 ms per 36k rows) and profile `computeBudget`.
diff --git a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
index 841fe7f..7984e2c 100644
--- a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
+++ b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
@@ -86,7 +86,8 @@ An account's type can only change within its class.
 **System categories** live in a hidden `internal` group and never appear as editable rows:
 - **Ready to Assign (RTA)**: the category for income.
 - **Uncategorized**: used for on-budget, non-transfer, non-starting-balance transactions with no category. It
-  appears in the budget grid only when it has activity in the viewed month, and normal overspending rules apply to it.
+  appears in the budget grid only when it has activity or a non-zero Available in the viewed month (an uncategorized
+  inflow carries over), and normal overspending rules apply to it.
 
 Neither system category can receive assignments. "Move money to/from Ready to Assign" changes the other category's
 Assigned amount.
@@ -177,7 +178,9 @@ All amounts are PLN base. `m` = month, `c` = category.
   includes categorized transfers to tracking accounts (e.g. loan payments) and lines of split transactions.
 - **Available(c,m)** = Carry(c,m) + Assigned(c,m) + Activity(c,m)
 - **Carry(c,m)** = max(0, Available(c,m−1)). Negative Available never carries over.
-- Budget start month = min(`budget_start_month`, month of the earliest transaction). Months before it are empty.
+- Budget start month = min(`budget_start_month`, month of the earliest transaction). Months before it are empty,
+  except that a month still holding an assignment or a month note (left behind when the budget start moved later)
+  stays reachable, and the budget is computed from the earliest such month.
 - Hidden categories behave identically; they are only hidden in the UI.
 
 ### 5.2 Overspending (cash vs credit)
@@ -209,7 +212,8 @@ Further rules:
   overspending, which is deducted from RTA next month.
 - Inflows on `k` categorized to RTA count as income and don't touch `p_k`.
 - The starting balance of a credit account is not categorized and doesn't affect the budget. The inspector shows
-  **"Need X to pay in full"** = max(0, −balance(k) − Available(p_k, m)).
+  **"Need X to pay in full"** = max(0, −balance(k) − Available(p_k, m)), with balance(k) in PLN at the end of `m`
+  (or today, if that is earlier).
 - Credit overspending is not carried: next month the category resets to 0, and the unfunded debt stays visible
   through "Need X to pay in full".
 - **Known simplification vs YNAB:** flows are computed from monthly net amounts and always apply. YNAB skips the
@@ -285,6 +289,9 @@ Yearly and custom targets:
 Other target rules:
 - Debt targets apply to credit card payment and loan-paired categories. They count only direct assignments, so
   for a credit card the amount is "in addition to funded spending".
+- The balance at the start of m is the account's PLN balance before m (counting transactions dated today or
+  earlier). If the account has no minimum payment (`min_payment`) or no APR (`payoff_by_date`), the missing value
+  counts as 0 and the target is flagged **incomplete** until the user enters it.
 - **Progress** = (need − underfunded) / need, or Available / A for balance targets.
 - **Snooze:** if `snoozed_month = m`, underfunded is 0 and the category matches the "Snoozed" filter. Progress for a
   snoozed target still reflects its real funding (it is computed from the unsnoozed underfunded amount).
@@ -295,7 +302,8 @@ Other target rules:
 
 ## 7. Auto-assign
 
-Scope can be all visible categories, one group, or one category. Strategies:
+Scope can be all visible categories (visible categories of visible groups), one group, or one category; a group or
+category scope includes hidden categories. Ready to Assign and Uncategorized are never in scope. Strategies:
 - **Underfunded**: walk categories in display order and assign `underfunded(c,m)`, capped at the remaining Shown
   RTA(m). Stop when RTA reaches 0.
 - **Assigned last month**: set Assigned(c,m) = Assigned(c,m−1).
@@ -411,7 +419,7 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
 - A group can be deleted only when it has no live categories; groups are soft-deleted.
 - Credit card payment and paired loan categories follow their account: they can't be renamed, moved or deleted on
   their own (deleting the account removes them). Credit card payment categories are hidden automatically when the
-  account is closed with Available = 0.
+  account is closed with Available = 0 in the current month. Reopening the account doesn't unhide them.
 
 **Accounts**
 - Create via a type-specific wizard. Edit name, note and loan fields.
PATCH
```

- [ ] **Step 5: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/accounts/account-routes.test.ts src/server/http/app.test.ts`
Expected: `Tests  26 passed (26)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  41 passed (41)`, `Tests  393 passed (393)`; both checks exit 0.
Run: `npm run db:generate -- --name check && npm run build`
Expected: `No schema changes, nothing to migrate 😴`, then esbuild's `Done`.

- [ ] **Step 6: Commit**

```bash
git add src/server/accounts src/server/http/app.test.ts docs
git commit -m "feat(server): hide a closed card's settled payment category; P2b2 docs" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Spec coverage (P2b2)

| Spec | Task |
|---|---|
| §2 read path: SQL aggregates over the ledger view → `computeBudget`; nothing persisted; cost at 10 years × 150 categories | 2, 4 |
| §3 Uncategorized for uncategorized on-budget lines; shown only with activity (or money); system categories take no assignment | 2, 4, 6 |
| §5.1 Activity incl. split lines and categorized transfers to tracking; Available, Carry; budget start; hidden categories behave identically | 2, 4 |
| §5.2 cash/credit overspending and pill color in the month view | 4 |
| §5.3 card payment flows via card transfers; credit starting balance off budget; "Need X to pay in full" | 2, 3, 4 |
| §5.4 RTA breakdown (left over, income, assigned, assigned in future, cash overspent last month) | 4 |
| §5.5 budget↔budget transfers excluded; tracking lines never on budget | 2 |
| §5.6 only lines dated today or earlier (configured time zone); 24 months ahead | 2, 4 |
| §6 targets: every kind/cadence, need/underfunded/progress, snooze, overfunded, pill color, debt targets from the linked account (min payment, APR, escrow, balance at month start) | 1, 3, 4, 5 |
| §7 auto-assign: scopes, every strategy, underfunded capped at RTA, one undoable command | 1, 6 |
| §8 debt-target inputs of loans (min payment, escrow, APR) and the paired category's target | 3, 4 |
| §10 Categories / Accounts: card payment category hidden when the card is closed with Available = 0 | 7 |
| §11 Budget screen data: month switcher bounds, RTA banner/breakdown, filter inputs (underfunded, overfunded, available, snoozed), groups, hidden categories, Target tab, "Need X", month note | 4, 5 |
| §13 400 / 404 / 422 errors; one transaction per command | 4–7 |
| §14 server: happy paths and domain errors; undo round trips; an engine golden scenario reproduced from DB rows | 2–7 |
| P2 carry-over: month-view adapter; target and debt input validation; null spending mode; sign docs; `autoAssign` month check; system categories out of scope; P1 test gaps for targets and auto-assign; month conversion; null `min_payment`; hide on close; reuse of `budgetStartMonth`/`MONTHS_AHEAD`/`setAssigned`; route guard covers the new routes | 1–7 |

Deferred (listed in `p2-carry-over.md` under "From P2b2"):
- P2c: the Activity tab (transactions behind a month's activity).
- P2d: the loan panel (balance, projected payoff, Record payment), synthetic loan interest/escrow in debt balances, and foreign-currency debt amounts.
- Later: performance work if the month view gets slow.

## Decisions

Choices made where the spec is silent, ambiguous or in conflict with the brief:

1. **Months before the budget start.** P2b1's fix `585b6ca` keeps a month that still holds an assignment or a note editable (`firstEditableMonth`). P2b2 also computes the budget from that month and makes it the month switcher's lower bound (`firstMonth`). An assignment left there still lowers Ready to Assign, and the user can reach and clear it. `budgetStartMonth` keeps its §5.1 meaning. Spec §5.1 is amended to say so.
2. **Activity rules.** Spec §5.5 forbids a budget→tracking transfer line without a category. If one exists anyway, it is neither activity nor Uncategorized; P2c's write validation must prevent it. A budget↔budget transfer with a category is excluded, and on a card it still counts as a card transfer.
3. **Overspending ties** go to the earlier card in account display order: activity rows are sorted by (month, category, account sort order).
4. **Month range for the month view.** It is the P2b1 assignment range, from `firstEditableMonth()` to the current month + 24. Both sides are a 422 `month_out_of_range`.
5. **One computation, one snapshot.** `loadBudgetMonth` runs `computeBudget` once, through the requested month; the engine adds later months with assignments. The GET route runs every query in one read-only repeatable-read transaction. Commands reuse the function with `rec.tx` under the command lock.
6. **Uncategorized** is a separate `uncategorized` field, not a group. It is present while its Activity or Available is non-zero, because an uncategorized inflow carries over and would otherwise be invisible money. Spec §3 is amended.
7. **Groups in the view.** Every live group except Internal is listed, including empty Credit Card Payments / Debt Payments groups and hidden groups, each with a `hidden` flag. The UI decides what to collapse or hide.
8. **Row kind.** Rows reuse P2b1's `CategoryKind` (`normal`, `cc_payment`, `debt_payment`, `uncategorized`) rather than separate booleans, so they match `GET /api/categories`.
9. **Target definition in the row.** Each row carries its `TargetDto` next to the evaluation, so the Target tab needs no extra request. The evaluation is null without a target or before the target's start month.
10. **"Need X to pay in full"** uses the card's PLN balance at the end of the viewed month, or today if that is earlier (spec §5.3 amended). It is null for every non-card category.
11. **Missing debt fields (P2b1 review).** A cleared `min_payment` (for `min_payment` targets) or `interest_rate` (for `payoff_by_date` targets) counts as 0, and the evaluation says `incomplete: true`. With `need` = 0, the target is neither underfunded nor met. The targets API doesn't refuse such targets, because PATCH could clear the field again at any time. Spec §6 is amended.
12. **Debt balances** are the linked account's PLN sum of live transactions dated before the month (and up to today). Loans skip §8's synthetic interest and escrow until P2d. Escrow is added for loans only, and `min_payment`/`escrow_amount` are used as PLN amounts, which is exact for PLN accounts.
13. **Target storage.**
    - PUT replaces the whole target and clears unused columns.
    - Balance targets are stored with cadence `none`, and debt targets with `monthly` (the engine ignores the cadence of both).
    - The mode defaults to `set_aside`.
    - `repeatEvery` is 1–120 and comes together with `repeatUnit`.
14. **Target start month and snooze.**
    - `startMonth` defaults to the replaced target's start month, or the current month for a new target, so editing doesn't reset a set-aside cycle.
    - A given `startMonth` must lie in the budget range.
    - A replaced target keeps its snooze.
15. **Where targets are allowed.** Debt targets go only on credit card payment and paired loan categories (`debt_target_not_allowed`). Those categories also accept spending and balance targets. System categories accept none (`system_category`, "System categories can't have targets.").
16. **Target endpoints.** They live on the categories router (`/api/categories/:id/target…`), because a second router on the same prefix would leak its `.use` middleware. DELETE returns `{ id }` with the category id; deleting a missing target, or snoozing without one, is a 404.
17. **Snooze** holds one month (`snoozed_month`); snoozing another month replaces it. Unsnooze is `DELETE …/target/snooze`, and unsnoozing an unsnoozed target records nothing.
18. **Auto-assign scope.**
    - `all` is the visible categories of visible groups (§7 "all visible categories").
    - `group` and `category` scopes include hidden categories; the brief limited the hidden-category exclusion to `all`.
    - Ready to Assign and Uncategorized are never in scope.
    - An unknown group or Internal is a 422 `invalid_group`. An unknown category is a 404, and a system category a 422 `category_not_assignable`, both through P2b1's `assignableCategory`.
    - Following `585b6ca`, these scope errors are reported before `month_out_of_range`. Likewise, the target commands check the category (404/422) before the snooze or start month.
19. **Auto-assign results.** The response lists only the changed assignments, with their new amounts. A run that changes nothing records no undo entry and keeps redo.
20. **Closing a card.** The payment category is hidden when its Available in the **current** month is 0, and only when the account goes from open to closed. Reopening doesn't unhide it, because the app can't tell an automatic hide from the user's. Spec §10 is amended.
21. **Labels:** `Set the target for "…"`, `Delete the target for "…"`, `Snooze the target for "…"`, `Unsnooze the target for "…"`, `Auto-assign: Underfunded` (`Assigned last month`, `Spent last month`, `Average assigned`, `Average spent`, `Reset available`, `Reset assigned`).
22. **Engine validation.** Target amounts and debt numbers are validated in `evaluateTarget` rather than only at the server boundary, so every caller is covered. `autoAssign` refuses a month outside the computed budget.
