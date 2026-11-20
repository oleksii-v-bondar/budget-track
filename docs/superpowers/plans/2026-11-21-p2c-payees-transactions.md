# P2c — Payees and Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user record money: payees (list, create, rename, merge, delete); plain transactions, transfers (also between currencies) and splits (also with transfer lines); editing with transfer mirroring, line replacement, moves between accounts and confirmation for reconciled rows; soft deletion; the register with search, cursor pagination and balances; and bulk operations. Every change is one undoable command.

**Architecture:** Every write first describes the transaction as a `Draft` and runs it through `planTransaction` (`src/server/transactions/plan.ts`). The planner applies spec §5.5 (categories and transfers) and §9 (FX) and returns a `Plan`: the transaction row, the other side of a transfer, and the split lines with the counterparts of their transfer lines. `insertPlan` writes a new transaction; a date after today becomes a one-time `scheduled_transaction` instead (`insertSchedule`). An edit loads the saved transaction with all its rows (`loadAggregate`), applies the request to its draft, and plans it again with what it already has (stored rates, the other side's amount, the accounts it is already in). It then checks reconciled rows, and `syncPlan` updates rows in place, soft-deletes rows that went away and creates new ones. Bulk operations run the single-row edit or delete for each id inside one `runCommand`. Reads build `TransactionDto`s from one joined query plus a batch query for split lines; the register adds filters and (date desc, id desc) keyset paging, and reuses P2b1's account balances. Payees get their own router. Request schemas and DTOs live in `src/shared/api/`.

**Tech Stack:** Node 22, TypeScript 6, Hono 4 + @hono/zod-validator, zod 4, Drizzle ORM 0.45 + drizzle-kit 0.31, postgres.js 4, Postgres 16, Vitest 5, @testcontainers/postgresql 11. No new dependencies; one migration (indexes only).

**Spec:** `docs/superpowers/specs/2026-11-19-core-budgeting-design.md` (§3, §4.4, §4.6, §5.3, §5.5–§5.6, §9, §10 "Creating and editing", "Splits", "Transfers", "Reconciled transactions", "Payees", "Search and bulk operations", "Undo/redo", §11 "Transaction sheet" and "Register", §13, §14 "Server"). P2c follows P2b1 (budget structure) and P2b2 (budget read model, targets, auto-assign). P2d adds scheduled-transaction CRUD and the job, reconciliation, NBP rates, revaluation, loan interest and export; P3 is the web app.

**Starting point and reconciling deltas:** Every code block below was verified against `main` at 0fb80df (P2b1 merged, including its final fixes: `DELETE /api/categories/:id` takes the destination as a query parameter, `applyOrder` rejects duplicates, `runMigrations` clears the undo history). That suite is `Test Files  38 passed (38)`, `Tests  356 passed (356)`. P2b2 (budget read model, targets, auto-assign) is in progress and merges to `main` first: **branch `p2c-…` from `main` after P2b2 has merged.** P2c uses no P2b2 feature, but P2b2 touches some of the same files: `src/server/test/fixtures.ts` (it adds `insertTransaction`), `src/shared/api/*`, the engine, `src/server/accounts/account-commands.ts` and its tests, the spec and both notes files, and possibly `src/server/http/app.ts`. Where a patch below doesn't apply, **reconcile the small delta by hand**: keep what landed and apply this plan's intent. Add the test files and tests that P2b2 (and its review fixes) added to every expected total below; P2b2's plan ends 5 test files and 41 tests above its baseline. P2b2 adds no migration, so this plan's migration is `0003`; if one landed meanwhile, `npm run db:generate` numbers this one after it and only the SQL matters.

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
- No foreign key has an `ON DELETE` action. A command deletes or re-points child rows itself, so the undo log sees every change.
- Every router outside `/api/auth` is mounted on its **own** prefix and starts with `.use('*', requireSession(deps))`. Routers are built by chaining, so `App` keeps every route for the Hono RPC client.
- Request schemas and the response DTO types the web app needs live in `src/shared/api/`.
- SQL sums are cast in SQL: `sum(x)::bigint` (never `.mapWith(Number)`).
- Never rewrite a committed migration; add one with `npm run db:generate -- --name …`. A migration that alters a column `v_ledger_line` reads must drop and recreate the view (P2c's only adds indexes). Applying a migration clears the undo history.
- Unknown or deleted resource in the URL → 404 `not_found`; undo/redo conflicts and empty stacks → 409.
- Advisory-lock keys are distinct and listed in `docs/superpowers/notes/engineering-notes.md`: 727274001 login, 727274002 commands and undo/redo.
- Server tests use the P2a/P2b1 harness: `createTestDatabase()` per test (`beforeEach`), `createTestApp(db, { now })`, `setUpBudget(ctx)`, the `createAccount`/`createGroup`/`createCategory` fixtures, and `snapshot(db)` for undo round trips.
- Patches in this plan are shown as `git apply <<'PATCH' … PATCH` commands; run them from the repository root. (Making the same edits by hand is equivalent.)

New in P2c:
- Every transaction write is planned: build a `Draft`, call `planTransaction`, and write only through `insertPlan`, `insertSchedule`, `syncPlan` and `softDelete` (which use the recorder).
- A `DomainError` about one request field names it as a dotted path in its third argument (`'categoryId'`, `'lines.2.payeeId'`, `'ids.3'`); the body then carries `fieldErrors` for it. 400 validation errors are keyed by the dotted issue path too.
- Transactions and split lines are never hard-deleted: `deleted_at` is set to `clock.now()`.
- A command that changes a reconciled row's amount, date, account or transfer, un-reconciles it or deletes it needs `confirmReconciled: true`; otherwise it answers 409 `confirm_reconciled`.
- A new transaction dated after today is a one-time schedule; no edit moves a transaction past today.
- Status codes: create → 201 (`PayeeDto` or `CreateTransactionResponse`); edit, merge → 200 with the DTO; delete → 200 `{ id }`; bulk → 200 `{ ids }`.

## File Structure

```
src/shared/api/payees.ts                     PayeeKind, PayeeDto, PayeeListResponse, payeeNameRequestSchema, mergePayeeRequestSchema
src/shared/api/transactions.ts               flags, cleared states, memo and split-line schemas; create, update, delete, bulk and register
                                             schemas; TransactionDto, TransferDto, SplitLineDto, CreateTransactionResponse, RegisterResponse,
                                             BulkResponse
src/server/payees/payee-queries.ts           payeeKindOf, listPayees, getPayee, payeeUsage
src/server/payees/payee-commands.ts          findUserPayeeByName, createPayee, findOrCreatePayee, renamePayee, mergePayee, deletePayee
src/server/payees/payee-routes.ts            /api/payees
src/server/transactions/rules.ts             account and payee lookups, §5.5 category checks, transfer category placement, FX rates
src/server/transactions/plan.ts              Draft, Plan, planTransaction (spec §5.5 and §9 → rows)
src/server/transactions/aggregate.ts         loadAggregate, draftOf, storedRates, accountsOf
src/server/transactions/write.ts             insertPlan, insertLines, insertSchedule, syncPlan, softDelete, rememberCategory
src/server/transactions/transaction-commands.ts  createTransaction, updateTransaction, deleteTransaction, assertConfirmed, labels
src/server/transactions/transaction-queries.ts   loadTransactions, getTransaction, listRegister
src/server/transactions/bulk.ts              bulkUpdate, bulkLabel
src/server/transactions/transaction-routes.ts    /api/transactions

drizzle/0003_transaction_link_indexes.sql   generated: indexes on the transfer, line-counterpart and schedule links

Modified: src/server/http/errors.ts (dotted field paths), src/server/http/app.ts, src/server/db/schema.ts (indexes),
src/server/accounts/account-commands.ts (account deletion follow-ups), src/server/test/fixtures.ts (createPayee,
createTransaction, ledgerLines), the spec, engineering-notes.md, p2-carry-over.md

Tests: src/server/payees/payee-routes.test.ts, src/server/http/errors.test.ts, src/engine/fx.test.ts,
src/server/db/schema.test.ts, src/server/accounts/account-routes.test.ts, src/server/transactions/{create-transaction,
transfer, split, edit-transaction, split-edit, delete-transaction, register, bulk}.test.ts
```

## API added in P2c

All routes need a session. Ids are UUIDs (a malformed one in the URL is a 400). Amounts are signed minor units in the account's currency.

| Method and path | Body / query | Response |
|---|---|---|
| `GET /api/payees` | – | 200 `{ payees: PayeeDto[] }` (`{ id, name, kind: user \| transfer \| system, transferAccountId, lastCategoryId, usageCount }`) |
| `POST /api/payees` | `{ name }` | 201 `PayeeDto`; 422 `payee_name_taken` |
| `PATCH /api/payees/:id` | `{ name }` | 200 `PayeeDto`; 422 `payee_name_taken` / `payee_not_editable` |
| `POST /api/payees/:id/merge` | `{ targetId }` | 200 `PayeeDto` (the target); 422 `invalid_merge_target` / `payee_not_editable` |
| `DELETE /api/payees/:id` | – | 200 `{ id }`; 422 `payee_in_use` / `payee_not_editable` |
| `POST /api/transactions` | `{ accountId, date?, payeeId? \| payeeName?, categoryId?, memo?, amount, transferAmount?, fxRate?, cleared?, flag?, lines? }` | 201 `{ kind: 'transaction', transaction: TransactionDto }` or `{ kind: 'scheduled', scheduledId, date }` |
| `GET /api/transactions/:id` | – | 200 `TransactionDto` |
| `PATCH /api/transactions/:id` | any of `accountId, date, payeeId, payeeName, categoryId, memo, amount, transferAmount, fxRate, cleared, approved, flag, lines (or null)`, `confirmReconciled?` | 200 `TransactionDto`; 409 `confirm_reconciled` |
| `DELETE /api/transactions/:id` | optional `{ confirmReconciled }` | 200 `{ id }`; 409 `confirm_reconciled` |
| `GET /api/transactions` | `accountId, q, from, to, minAmount, maxAmount, categoryId, payeeId, flag, cleared, unapproved, cursor, limit` | 200 `{ transactions, nextCursor, balances }` |
| `POST /api/transactions/bulk` | `{ ids (1–500), action: { type: categorize \| setPayee \| setFlag \| setCleared \| approve \| moveAccount \| delete, … }, confirmReconciled? }` | 200 `{ ids }` |

`TransactionDto`:

```ts
{
  id, accountId, accountName, currency, date, payeeId, payeeName, categoryId, categoryName, memo,
  amount, amountBase, fxRate, effectiveRate, cleared, approved, flag, isStartingBalance, isSplit,
  transfer: { accountId, accountName, transactionId, splitLineId, amount, currency, effectiveRate } | null,
  lines: { id, amount, amountBase, payeeId, payeeName, categoryId, categoryName, memo,
           transfer: { accountId, accountName, transactionId } | null }[],
}
```

---
### Task 1: Payees — list, create, rename, merge and delete

Spec §4.4 and §10 "Payees". User payees are named by the user and unique among live user payees, ignoring case. Transfer payees (one per account, "Transfer : <name>") and the three system payees are named by the app, so they can't be renamed, merged or deleted. Merging moves every transaction, split line, schedule and schedule line to the target (soft-deleted transactions too, as P2b1's category delete does) and soft-deletes the merged payee; the target keeps its remembered category or takes the merged payee's. Only an unused payee can be deleted (soft delete), and "used" counts live rows. Every change is one undoable command.

**Files:**
- Create: `src/shared/api/payees.ts`, `src/server/payees/payee-queries.ts`, `src/server/payees/payee-commands.ts`, `src/server/payees/payee-routes.ts`
- Modify: `src/server/http/app.ts`, `src/server/test/fixtures.ts`
- Test: `src/server/payees/payee-routes.test.ts`

**Interfaces:**
- Consumes: `runCommand`, `Named`, `ChangeRecorder` (P2b1); `idParamSchema`, `IdResponse`, `idSchema`, `nameSchema` (`src/shared/api/common.ts`); `systemPayeeId` (`src/server/db/lookups.ts`); the P2b1 fixtures.
- Produces:
  - `src/shared/api/payees.ts`: `PayeeKind = 'user' | 'transfer' | 'system'`; `PayeeDto { id, name, kind, transferAccountId, lastCategoryId, usageCount }`; `PayeeListResponse { payees }`; `payeeNameRequestSchema` (`{ name }`); `mergePayeeRequestSchema` (`{ targetId }`).
  - `src/server/payees/payee-queries.ts`:
    - `payeeKindOf(row)`
    - `listPayees(db: Executor, where?: SQL): Promise<PayeeDto[]>`: live payees, user payees first, then transfer and system payees, each by `lower(name)`
    - `getPayee(db, id): Promise<PayeeDto>` (404 `Payee not found.`)
    - `payeeUsage(db, id): Promise<number>`: live transactions, lines of live transactions, schedules and schedule lines
  - `src/server/payees/payee-commands.ts`:
    - `findUserPayeeByName(db, name, exceptId?): Promise<PayeeRow | null>`
    - `createPayee(rec, name): Promise<{ id }>` (422 `payee_name_taken`)
    - `findOrCreatePayee(rec, name): Promise<string>`: reuses a live user payee with that name, ignoring case
    - `renamePayee(rec, id, name): Promise<{ name }>` (returns the old name; 422 `payee_name_taken`)
    - `mergePayee(rec, id, targetId, now): Promise<{ name, targetName }>` (422 `invalid_merge_target`)
    - `deletePayee(rec, id, now): Promise<{ name }>` (422 `payee_in_use`)
    - all but create: 404 for a missing or deleted payee; 422 `payee_not_editable` for transfer and system payees.
  - `payeeRoutes(deps)` at `/api/payees`: `GET /`, `POST /`, `PATCH /:id`, `POST /:id/merge`, `DELETE /:id`. Labels: `Create payee "X"`, `Rename payee "X"` (old name), `Merge payee "X" into "Y"`, `Delete payee "X"`.
  - Fixture `createPayee(client, name): Promise<PayeeDto>`.

- [ ] **Step 1: Write the fixture and the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/server/test/fixtures.ts b/src/server/test/fixtures.ts
index 836ef27..92d5cb3 100644
--- a/src/server/test/fixtures.ts
+++ b/src/server/test/fixtures.ts
@@ -1,5 +1,6 @@
 import type { AccountDto, CreateAccountRequest } from '../../shared/api/accounts';
 import type { CategoryDto, CategoryGroupDto } from '../../shared/api/categories';
+import type { PayeeDto } from '../../shared/api/payees';
 import type { TestClient } from './http-client';
 
 async function created<T>(res: Response, what: string): Promise<T> {
@@ -23,3 +24,7 @@ export async function createGroup(client: TestClient, name: string): Promise<Cat
 export async function createCategory(client: TestClient, groupId: string, name: string): Promise<CategoryDto> {
   return created(await client.post('/api/categories', { groupId, name }), 'createCategory');
 }
+
+export async function createPayee(client: TestClient, name: string): Promise<PayeeDto> {
+  return created(await client.post('/api/payees', { name }), 'createPayee');
+}
PATCH
```

Create `src/server/payees/payee-routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PayeeDto, PayeeListResponse } from '../../shared/api/payees';
import { systemPayeeId } from '../db/lookups';
import { payee, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, createPayee } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const list = async () => (await json<PayeeListResponse>(await ctx.client.get('/api/payees'))).body.payees;
const rename = (id: string, name: string) => ctx.client.send('PATCH', `/api/payees/${id}`, { name });
const merge = (id: string, targetId: string) => ctx.client.post(`/api/payees/${id}/merge`, { targetId });
const remove = (id: string) => ctx.client.send('DELETE', `/api/payees/${id}`);

describe('GET /api/payees', () => {
  it('lists live payees with their kind and live usage, user payees first', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const zabka = await createPayee(ctx.client, 'żabka');
    const biedronka = await createPayee(ctx.client, 'Biedronka');
    const gone = await createPayee(ctx.client, 'Gone');
    await remove(gone.id);
    const line = { accountId: checking.id, date: '2026-11-20', amount: -100, amountBase: -100 };
    const [split] = await t.db
      .insert(transaction)
      .values([
        { ...line, payeeId: biedronka.id },
        { ...line, payeeId: biedronka.id, deletedAt: new Date() },
        { ...line, isSplit: true },
      ])
      .returning()
      .then((rows) => rows.slice(2));
    await t.db.insert(subtransaction).values([
      { txnId: split!.id, amount: -60, amountBase: -60, payeeId: biedronka.id },
      { txnId: split!.id, amount: -40, amountBase: -40, payeeId: biedronka.id, deletedAt: new Date() },
    ]);
    await t.db.insert(scheduledTransaction).values({
      accountId: checking.id,
      payeeId: zabka.id,
      amount: -100,
      frequency: 'monthly',
      anchorDate: '2026-12-01',
      nextDate: '2026-12-01',
    });

    expect((await list()).map((p) => [p.name, p.kind, p.usageCount])).toEqual([
      ['Biedronka', 'user', 2],
      ['żabka', 'user', 1],
      ['Transfer : mBank', 'transfer', 0],
      ['FX revaluation', 'system', 0],
      ['Reconciliation Balance Adjustment', 'system', 0],
      ['Starting Balance', 'system', 1],
    ]);
    expect((await list()).find((p) => p.kind === 'transfer')).toEqual({
      id: checking.transferPayeeId,
      name: 'Transfer : mBank',
      kind: 'transfer',
      transferAccountId: checking.id,
      lastCategoryId: null,
      usageCount: 0,
    });
  });
});

describe('POST /api/payees and PATCH /api/payees/:id', () => {
  it('creates a payee whose name is unique among live user payees, ignoring case', async () => {
    await createAccount(ctx.client, { name: 'mBank' });
    const res = await json<PayeeDto>(await ctx.client.post('/api/payees', { name: '  Biedronka ' }));
    expect(res).toEqual({
      status: 201,
      body: {
        id: expect.any(String),
        name: 'Biedronka',
        kind: 'user',
        transferAccountId: null,
        lastCategoryId: null,
        usageCount: 0,
      },
    });
    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Create payee "Biedronka"' },
    });
    expect(await json(await ctx.client.post('/api/payees', { name: 'BIEDRONKA' }))).toEqual({
      status: 422,
      body: { code: 'payee_name_taken', message: 'You already have a payee with this name.' },
    });
    // Transfer and system payee names don't block user payees.
    for (const name of ['Transfer : mBank', 'Starting Balance']) {
      expect((await ctx.client.post('/api/payees', { name })).status).toBe(201);
    }
    expect((await ctx.client.post('/api/payees', { name: ' ' })).status).toBe(400);
  });

  it('renames user payees only', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const shop = await createPayee(ctx.client, 'Biedronka');
    await createPayee(ctx.client, 'Lidl');

    expect(await json(await rename(shop.id, 'BIEDRONKA'))).toMatchObject({ status: 200, body: { name: 'BIEDRONKA' } });
    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Rename payee "Biedronka"' },
    });
    expect(await json(await rename(shop.id, 'lidl'))).toEqual({
      status: 422,
      body: { code: 'payee_name_taken', message: 'You already have a payee with this name. Merge the two instead.' },
    });
    const locked = {
      status: 422,
      body: { code: 'payee_not_editable', message: "Transfer and system payees can't be renamed, merged or deleted." },
    };
    expect(await json(await rename(checking.transferPayeeId, 'Mine'))).toEqual(locked);
    expect(await json(await rename(await systemPayeeId(t.db, 'starting_balance'), 'Mine'))).toEqual(locked);
    expect(await json(await rename(crypto.randomUUID(), 'X'))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Payee not found.' },
    });
  });
});

describe('POST /api/payees/:id/merge', () => {
  it('moves every transaction, line and schedule to the target, then soft-deletes the payee', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const food = await createGroup(ctx.client, 'Food');
    const groceries = await createCategory(ctx.client, food.id, 'Groceries');
    const typo = await createPayee(ctx.client, 'Biedronak');
    const shop = await createPayee(ctx.client, 'Biedronka');
    await t.db.update(payee).set({ lastCategoryId: groceries.id }).where(eq(payee.id, typo.id));
    const line = { accountId: checking.id, date: '2026-11-20', amount: -100, amountBase: -100 };
    const [live, deleted, split] = await t.db
      .insert(transaction)
      .values([
        { ...line, payeeId: typo.id },
        { ...line, payeeId: typo.id, deletedAt: new Date() },
        { ...line, isSplit: true },
      ])
      .returning();
    const [splitLine] = await t.db
      .insert(subtransaction)
      .values({ txnId: split!.id, amount: -100, amountBase: -100, payeeId: typo.id })
      .returning();
    const [schedule] = await t.db
      .insert(scheduledTransaction)
      .values({
        accountId: checking.id,
        payeeId: typo.id,
        amount: -100,
        frequency: 'monthly',
        anchorDate: '2026-12-01',
        nextDate: '2026-12-01',
      })
      .returning();
    const [scheduleLine] = await t.db
      .insert(scheduledSubtransaction)
      .values({ scheduledId: schedule!.id, amount: -100, payeeId: typo.id })
      .returning();
    const before = await snapshot(t.db);

    const res = await json<PayeeDto>(await merge(typo.id, shop.id));
    expect(res).toMatchObject({ status: 200, body: { id: shop.id, lastCategoryId: groceries.id, usageCount: 4 } });
    const payeeOf = async (table: typeof transaction | typeof subtransaction, id: string) =>
      (await t.db.select({ payeeId: table.payeeId }).from(table).where(eq(table.id, id)))[0]!.payeeId;
    for (const id of [live!.id, deleted!.id]) expect(await payeeOf(transaction, id)).toBe(shop.id);
    expect(await payeeOf(subtransaction, splitLine!.id)).toBe(shop.id);
    const schedules = [
      ...(await t.db.select({ payeeId: scheduledTransaction.payeeId }).from(scheduledTransaction)),
      ...(await t.db
        .select({ payeeId: scheduledSubtransaction.payeeId })
        .from(scheduledSubtransaction)
        .where(eq(scheduledSubtransaction.id, scheduleLine!.id))),
    ];
    expect(schedules).toEqual([{ payeeId: shop.id }, { payeeId: shop.id }]);
    const [merged] = await t.db.select().from(payee).where(eq(payee.id, typo.id));
    expect(merged!.deletedAt).toEqual(ctx.clock.now());
    expect((await list()).map((p) => p.name)).not.toContain('Biedronak');
    const after = await snapshot(t.db);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Merge payee "Biedronak" into "Biedronka"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('refuses merges into itself, a deleted payee, or a transfer or system payee, and of app payees', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const shop = await createPayee(ctx.client, 'Biedronka');
    const gone = await createPayee(ctx.client, 'Gone');
    await remove(gone.id);
    const invalid = {
      status: 422,
      body: { code: 'invalid_merge_target', message: 'Choose another of your payees to merge into.' },
    };
    const startingBalance = await systemPayeeId(t.db, 'starting_balance');
    for (const target of [shop.id, gone.id, checking.transferPayeeId, startingBalance, crypto.randomUUID()]) {
      expect(await json(await merge(shop.id, target))).toEqual(invalid);
    }
    expect((await json(await merge(checking.transferPayeeId, shop.id))).body).toMatchObject({
      code: 'payee_not_editable',
    });
    expect((await merge(gone.id, shop.id)).status).toBe(404);
  });
});

describe('DELETE /api/payees/:id', () => {
  it('deletes only unused user payees, which frees the name', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const shop = await createPayee(ctx.client, 'Biedronka');
    const old = await createPayee(ctx.client, 'Old shop');
    const line = { accountId: checking.id, date: '2026-11-20', amount: -100, amountBase: -100 };
    await t.db.insert(transaction).values([
      { ...line, payeeId: shop.id },
      { ...line, payeeId: old.id, deletedAt: new Date() },
    ]);

    expect(await json(await remove(shop.id))).toEqual({
      status: 422,
      body: { code: 'payee_in_use', message: 'This payee is used by transactions. Merge it into another payee instead.' },
    });
    // Only live rows count: a soft-deleted transaction still points at the (soft-deleted) payee.
    expect(await json(await remove(old.id))).toEqual({ status: 200, body: { id: old.id } });
    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Delete payee "Old shop"' },
    });
    expect((await ctx.client.post('/api/payees', { name: 'Old shop' })).status).toBe(201);
    expect((await json(await remove(checking.transferPayeeId))).body).toMatchObject({ code: 'payee_not_editable' });
    expect((await remove(old.id)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/payees`
Expected: FAIL, `Tests  6 failed (6)`, mostly `createPayee failed: 404 {"code":"not_found","message":"Not found."}` (there is no route yet).

- [ ] **Step 3: Add the shared schemas and DTOs**

Create `src/shared/api/payees.ts`:

```ts
import { z } from 'zod';
import { idSchema, nameSchema } from './common';

/**
 * - `user`: created by the user (by name, or inline from the transaction sheet)
 * - `transfer`: the "Transfer : <account>" payee of an account; choosing it makes a transaction a transfer
 * - `system`: Starting Balance, Reconciliation Balance Adjustment and FX revaluation (used by the app)
 */
export type PayeeKind = 'user' | 'transfer' | 'system';

export interface PayeeDto {
  id: string;
  name: string;
  kind: PayeeKind;
  /** Transfer payees: the account a transaction with this payee transfers to. */
  transferAccountId: string | null;
  /** The category last saved with this payee on a categorized, non-transfer transaction (spec §10). */
  lastCategoryId: string | null;
  /** Live transactions, split lines and scheduled transactions (and their lines) that use the payee. */
  usageCount: number;
}

/** GET /api/payees: live payees; user payees first, then transfer and system payees, each by name. */
export interface PayeeListResponse {
  payees: PayeeDto[];
}

/** POST /api/payees and PATCH /api/payees/:id. Names are unique among live user payees, ignoring case. */
export const payeeNameRequestSchema = z.object({ name: nameSchema });

/** POST /api/payees/:id/merge: the payee that takes over every transaction, line and schedule. */
export const mergePayeeRequestSchema = z.object({ targetId: idSchema });
```

- [ ] **Step 4: Add the payee queries**

Create `src/server/payees/payee-queries.ts`:

```ts
import { and, asc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { PayeeDto, PayeeKind } from '../../shared/api/payees';
import type { Executor } from '../db/client';
import { payee, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
import { AppError } from '../http/errors';

type PayeeRow = typeof payee.$inferSelect;

export function payeeKindOf(row: Pick<PayeeRow, 'transferAccountId' | 'systemKind'>): PayeeKind {
  if (row.transferAccountId) return 'transfer';
  if (row.systemKind) return 'system';
  return 'user';
}

/** Live rows per payee: transactions, lines of live transactions, schedules and schedule lines. */
async function usageByPayee(db: Executor, id?: string): Promise<Map<string, number>> {
  const rows = await db.execute<{ payee_id: string; uses: number }>(sql`
    select u.payee_id, count(*)::int as uses from (
      select t.payee_id from ${transaction} t where t.deleted_at is null
      union all
      select s.payee_id from ${subtransaction} s join ${transaction} p on p.id = s.txn_id
        where s.deleted_at is null and p.deleted_at is null
      union all
      select st.payee_id from ${scheduledTransaction} st
      union all
      select ss.payee_id from ${scheduledSubtransaction} ss
    ) u
    where u.payee_id is not null ${id ? sql`and u.payee_id = ${id}` : sql``}
    group by u.payee_id`);
  return new Map(rows.map((row) => [row.payee_id, row.uses]));
}

const kindOrder = sql`case
  when ${payee.transferAccountId} is not null then 1
  when ${payee.systemKind} is not null then 2
  else 0
end`;

/** Live payees: user payees first, then transfer and system payees, each by name (ignoring case). */
export async function listPayees(db: Executor, where?: SQL): Promise<PayeeDto[]> {
  const rows = await db
    .select()
    .from(payee)
    .where(and(isNull(payee.deletedAt), where))
    .orderBy(kindOrder, sql`lower(${payee.name})`, asc(payee.id));
  const usage = await usageByPayee(db, rows.length === 1 ? rows[0]!.id : undefined);
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    kind: payeeKindOf(p),
    transferAccountId: p.transferAccountId,
    lastCategoryId: p.lastCategoryId,
    usageCount: usage.get(p.id) ?? 0,
  }));
}

export async function getPayee(db: Executor, id: string): Promise<PayeeDto> {
  const [found] = await listPayees(db, eq(payee.id, id));
  if (!found) throw new AppError(404, 'not_found', 'Payee not found.');
  return found;
}

/** How many live rows use the payee (see `PayeeDto.usageCount`). */
export async function payeeUsage(db: Executor, id: string): Promise<number> {
  return (await usageByPayee(db, id)).get(id) ?? 0;
}
```

- [ ] **Step 5: Add the payee commands**

Create `src/server/payees/payee-commands.ts`:

```ts
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { payee, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { payeeKindOf, payeeUsage } from './payee-queries';

type PayeeRow = typeof payee.$inferSelect;

/** Live user payees: neither transfer nor system payees (spec §4.4 name uniqueness applies to these only). */
const isUserPayee = and(isNull(payee.deletedAt), isNull(payee.transferAccountId), isNull(payee.systemKind));

async function loadPayee(db: Executor, id: string): Promise<PayeeRow> {
  const [row] = await db
    .select()
    .from(payee)
    .where(and(eq(payee.id, id), isNull(payee.deletedAt)));
  if (!row) throw new AppError(404, 'not_found', 'Payee not found.');
  return row;
}

/** Spec §10: transfer and system payees are named and used by the app. */
function assertUserPayee(row: PayeeRow): void {
  if (payeeKindOf(row) !== 'user') {
    throw new DomainError('payee_not_editable', "Transfer and system payees can't be renamed, merged or deleted.");
  }
}

/** The live user payee with this name (ignoring case), if any. */
export async function findUserPayeeByName(db: Executor, name: string, exceptId?: string): Promise<PayeeRow | null> {
  const [row] = await db
    .select()
    .from(payee)
    .where(and(isUserPayee, sql`lower(${payee.name}) = lower(${name})`, exceptId ? ne(payee.id, exceptId) : undefined))
    .limit(1);
  return row ?? null;
}

export async function createPayee(rec: ChangeRecorder, name: string): Promise<{ id: string }> {
  if (await findUserPayeeByName(rec.tx, name)) {
    throw new DomainError('payee_name_taken', 'You already have a payee with this name.');
  }
  const [created] = await rec.insert(payee, { name });
  return { id: created!.id };
}

/** The transaction sheet creates payees inline: an existing user payee with the same name (ignoring case) is reused. */
export async function findOrCreatePayee(rec: ChangeRecorder, name: string): Promise<string> {
  return (await findUserPayeeByName(rec.tx, name))?.id ?? (await createPayee(rec, name)).id;
}

export async function renamePayee(rec: ChangeRecorder, id: string, name: string): Promise<{ name: string }> {
  const current = await loadPayee(rec.tx, id);
  assertUserPayee(current);
  if (await findUserPayeeByName(rec.tx, name, id)) {
    throw new DomainError('payee_name_taken', 'You already have a payee with this name. Merge the two instead.');
  }
  await rec.update(payee, eq(payee.id, id), { name });
  return { name: current.name };
}

/**
 * Spec §10: every transaction, split line, schedule and schedule line of the payee moves to the target (soft-deleted
 * transactions too, so undoing their deletion never resurrects a deleted payee), then the payee is soft-deleted.
 * The target keeps its own default category, or inherits the merged payee's.
 */
export async function mergePayee(
  rec: ChangeRecorder,
  id: string,
  targetId: string,
  now: Date,
): Promise<{ name: string; targetName: string }> {
  const source = await loadPayee(rec.tx, id);
  assertUserPayee(source);
  const [target] = await rec.tx
    .select()
    .from(payee)
    .where(and(eq(payee.id, targetId), isUserPayee));
  if (!target || target.id === id) {
    throw new DomainError('invalid_merge_target', 'Choose another of your payees to merge into.');
  }
  const to = { payeeId: targetId };
  await rec.update(transaction, eq(transaction.payeeId, id), to);
  await rec.update(subtransaction, eq(subtransaction.payeeId, id), to);
  await rec.update(scheduledTransaction, eq(scheduledTransaction.payeeId, id), to);
  await rec.update(scheduledSubtransaction, eq(scheduledSubtransaction.payeeId, id), to);
  if (target.lastCategoryId === null && source.lastCategoryId !== null) {
    await rec.update(payee, eq(payee.id, targetId), { lastCategoryId: source.lastCategoryId });
  }
  await rec.update(payee, eq(payee.id, id), { deletedAt: now });
  return { name: source.name, targetName: target.name };
}

/** Spec §10: only an unused payee can be deleted (soft delete); otherwise merge it into another one. */
export async function deletePayee(rec: ChangeRecorder, id: string, now: Date): Promise<{ name: string }> {
  const current = await loadPayee(rec.tx, id);
  assertUserPayee(current);
  if ((await payeeUsage(rec.tx, id)) > 0) {
    throw new DomainError('payee_in_use', 'This payee is used by transactions. Merge it into another payee instead.');
  }
  await rec.update(payee, eq(payee.id, id), { deletedAt: now });
  return { name: current.name };
}
```

- [ ] **Step 6: Add the router and mount it**

Create `src/server/payees/payee-routes.ts`:

```ts
import { Hono } from 'hono';
import { idParamSchema, type IdResponse } from '../../shared/api/common';
import {
  mergePayeeRequestSchema,
  type PayeeDto,
  type PayeeListResponse,
  payeeNameRequestSchema,
} from '../../shared/api/payees';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { type Named, runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { createPayee, deletePayee, mergePayee, renamePayee } from './payee-commands';
import { getPayee, listPayees } from './payee-queries';

/** /api/payees (spec §10 "Payees"): every change is one undoable command. */
export function payeeRoutes(deps: AppDeps) {
  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/', async (c) => c.json<PayeeListResponse>({ payees: await listPayees(deps.db) }))
    .post('/', validate('json', payeeNameRequestSchema), async (c) => {
      const { name } = c.req.valid('json');
      const { id } = await runCommand(deps, `Create payee "${name}"`, (rec) => createPayee(rec, name));
      return c.json<PayeeDto>(await getPayee(deps.db, id), 201);
    })
    .patch('/:id', validate('param', idParamSchema), validate('json', payeeNameRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const { name } = c.req.valid('json');
      await runCommand(deps, (r: Named) => `Rename payee "${r.name}"`, (rec) => renamePayee(rec, id, name));
      return c.json<PayeeDto>(await getPayee(deps.db, id));
    })
    .post('/:id/merge', validate('param', idParamSchema), validate('json', mergePayeeRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const { targetId } = c.req.valid('json');
      await runCommand(
        deps,
        (r: { name: string; targetName: string }) => `Merge payee "${r.name}" into "${r.targetName}"`,
        (rec) => mergePayee(rec, id, targetId, deps.clock.now()),
      );
      return c.json<PayeeDto>(await getPayee(deps.db, targetId));
    })
    .delete('/:id', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(deps, (r: Named) => `Delete payee "${r.name}"`, (rec) => deletePayee(rec, id, deps.clock.now()));
      return c.json<IdResponse>({ id });
    });
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.ts b/src/server/http/app.ts
index c77fb94..80d62c8 100644
--- a/src/server/http/app.ts
+++ b/src/server/http/app.ts
@@ -16,6 +16,7 @@ import { redoRoutes, undoRoutes } from '../commands/undo-routes';
 import type { Config } from '../config';
 import type { Db } from '../db/client';
 import type { Logger } from '../logger';
+import { payeeRoutes } from '../payees/payee-routes';
 import type { ClientIpResolver } from './client-ip';
 import type { AppEnv } from './env';
 import { AppError, errorHandler } from './errors';
@@ -76,7 +77,8 @@ export function createApp(deps: AppDeps) {
     .route('/api/accounts', accountRoutes(deps))
     .route('/api/category-groups', groupRoutes(deps))
     .route('/api/categories', categoryRoutes(deps))
-    .route('/api/budget', budgetRoutes(deps));
+    .route('/api/budget', budgetRoutes(deps))
+    .route('/api/payees', payeeRoutes(deps));
 
   app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
   app.onError(errorHandler);
PATCH
```

- [ ] **Step 7: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/payees`
Expected: `Tests  6 passed (6)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  39 passed (39)`, `Tests  362 passed (362)`; both checks exit 0. (The route guard in `app.test.ts` now also walks the five payee routes.)

- [ ] **Step 8: Commit**

```bash
git add src/shared/api/payees.ts src/server/payees src/server/http/app.ts src/server/test/fixtures.ts
git commit -m "feat(server): payees — list, create, rename, merge and delete" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Plain transactions — create and read; field paths in errors

Spec §4.4, §5.5, §5.6, §9 and §10 "Creating and editing". `POST /api/transactions` books a plain (non-split, non-transfer) transaction:
- The payee is chosen by `payeeId`, or named by `payeeName`: an existing user payee with that name is reused, otherwise one is created in the same command. System payees can't be chosen.
- Categories follow §5.5. Tracking accounts take none, and credit card payment categories are never allowed. Uncategorized is only "no category": sending its id is refused. The category must be live and be Ready to Assign, a regular category or a loan's paired category (hidden ones are fine).
- Closed accounts take no new transactions.
- Manual transactions are approved. `cleared` is `uncleared` (the default) or `cleared`.
- `amount_base` equals the amount for PLN accounts, else `convertToBase(amount, fxRate)`. `fxRate` is required for foreign accounts until P2d adds NBP rates, refused for PLN ones, and stored with `fx_rate_manual = true`.
- A categorized transaction with a user payee makes its category the payee's `last_category_id`.
- A `date` after today (in the configured time zone) is stored as a `scheduled_transaction` with frequency `once` (anchor = next date = date), and the response carries its id. P2d's job enters it on that day. Dates start at 1970-01-01, like starting balances.

`GET /api/transactions/:id` returns the `TransactionDto`; Tasks 3 and 4 fill its `transfer` and `lines`. The task also changes the error format, as the P2 carry-over asks: 400 field errors are keyed by the dotted path of the issue (`lines.1.amount`), and a `DomainError` can name the field it concerns, which adds `fieldErrors` to its 422 body.

**Files:**
- Create: `src/shared/api/transactions.ts`, `src/server/transactions/rules.ts`, `src/server/transactions/plan.ts`, `src/server/transactions/write.ts`, `src/server/transactions/transaction-commands.ts`, `src/server/transactions/transaction-queries.ts`, `src/server/transactions/transaction-routes.ts`
- Modify: `src/server/http/errors.ts`, `src/server/http/app.ts`, `src/server/test/fixtures.ts`
- Test: `src/server/transactions/create-transaction.test.ts`, `src/server/http/errors.test.ts`

**Interfaces:**
- Consumes: `convertToBase`, `effectiveRate`, `IsoDate`, `Money` (engine); `todayIn` (`src/server/clock.ts`); `categoryKindOf` (P2b1); `BASE_CURRENCY`, `fxRateSchema` (`src/shared/api/accounts.ts`); `findOrCreatePayee`, `payeeKindOf` (Task 1).
- Produces:
  - `src/server/http/errors.ts`: `DomainError(code, message, field?: string)`; `ValidationError` keys `fieldErrors` by `issue.path.join('.')`.
  - `src/shared/api/transactions.ts`:
    - `FLAG_COLORS`, `FlagColor`, `ClearedStatus`, `flagSchema`, `userClearedSchema`, `memoSchema` (trimmed, ≤ 500 characters), `transactionDateSchema` (≥ 1970-01-01)
    - `createTransactionRequestSchema` / `CreateTransactionRequest` / `CreateTransactionInput` (the body as sent)
    - `TransferDto`, `SplitLineTransferDto`, `SplitLineDto`, `TransactionDto`
    - `CreateTransactionResponse = { kind: 'transaction', transaction } | { kind: 'scheduled', scheduledId, date }`
  - `src/server/transactions/rules.ts`:
    - `AccountInfo { id, name, currency, accountClass, closed, transferPayeeId }`, `PayeeInfo { id, name, kind, transferAccountId }`, `onBudget(account)`
    - `findAccount(db, id)`, `requireAccount(db, id, field)` (422 `invalid_account`), `assertOpen(account, field)` (422 `account_closed`)
    - `requirePayee(db, id, field)` (422 `invalid_payee`), `assertNotSystemPayee(payee, field)` (422 `system_payee`)
    - `assertUsableCategory(db, id, field)` (422 `invalid_category` / `card_payment_category`), `categoryNotAllowed(message, field)` (`category_not_allowed`), `TRACKING_NO_CATEGORY`
    - `Rates { input, stored, used }`, `rateFor(rates, currency)` (422 `fx_rate_required`), `assertRateUsed(rates)` (422 `fx_rate_not_allowed`), `toBase(amount, rate)` and `bookedBase(currency, amount, rates)` (422 `amount_too_large`)
  - `src/server/transactions/plan.ts`: `Draft`, `RowPlan`, `Plan { main, account, payee, payeeDefault }`, `planTransaction(db, draft): Promise<Plan>`.
  - `src/server/transactions/write.ts`: `insertPlan(rec, plan): Promise<string>`, `insertSchedule(rec, draft, plan): Promise<string>`.
  - `src/server/transactions/transaction-commands.ts`: `SavedTransaction { kind, id, date, payeeName }`; `savedLabel(saved)` (`Add transaction "P"` or `Schedule transaction "P"`; no quotes without a payee); `createTransaction(rec, input, today): Promise<SavedTransaction>`.
  - `src/server/transactions/transaction-queries.ts`: `loadTransactions(db, where?, limit?): Promise<TransactionDto[]>` (live rows, date desc, id desc), `getTransaction(db, id)` (404 `Transaction not found.`).
  - `transactionRoutes(deps)` at `/api/transactions`: `POST /`, `GET /:id`.
  - Fixtures `createTransaction(client, body: CreateTransactionInput): Promise<TransactionDto>` (throws unless the transaction is booked) and `ledgerLines(db, where?)` (`v_ledger_line` rows by date, then base amount).

- [ ] **Step 1: Write the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/server/http/errors.test.ts b/src/server/http/errors.test.ts
index 908cc22..360e2c2 100644
--- a/src/server/http/errors.test.ts
+++ b/src/server/http/errors.test.ts
@@ -49,6 +49,37 @@ describe('errorHandler', () => {
     expect(Object.keys(body.fieldErrors).sort()).toEqual(['amount', 'name']);
   });
 
+  it('keys field errors by their full path, so nested fields keep theirs', async () => {
+    const schema = z.object({ lines: z.array(z.object({ amount: z.int() })).min(2), memo: z.string() });
+    const { app } = appWith((a) => a.post('/x', validate('json', schema), (c) => c.json(c.req.valid('json'))));
+    const res = await app.request('/x', {
+      method: 'POST',
+      headers: { 'content-type': 'application/json' },
+      body: JSON.stringify({ lines: [{ amount: 1 }, { amount: 'x' }], memo: 1 }),
+    });
+    expect(await res.json()).toEqual({
+      code: 'validation',
+      message: 'Some fields are invalid.',
+      fieldErrors: {
+        'lines.1.amount': ['Invalid input: expected number, received string'],
+        memo: ['Invalid input: expected string, received number'],
+      },
+      formErrors: [],
+    });
+  });
+
+  it('puts the field of a DomainError into fieldErrors', async () => {
+    const { app } = appWith((a) =>
+      a.get('/x', () => Promise.reject(new DomainError('split_sum', 'Lines must add up.', 'lines.0.amount'))),
+    );
+    const res = await app.request('/x');
+    expect(await res.json()).toEqual({
+      code: 'split_sum',
+      message: 'Lines must add up.',
+      fieldErrors: { 'lines.0.amount': ['Lines must add up.'] },
+    });
+  });
+
   it('maps malformed JSON to 400', async () => {
     const { app } = appWith((a) => a.post('/x', validate('json', z.object({})), (c) => c.json({})));
     const res = await app.request('/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
diff --git a/src/server/test/fixtures.ts b/src/server/test/fixtures.ts
index 92d5cb3..ccc2826 100644
--- a/src/server/test/fixtures.ts
+++ b/src/server/test/fixtures.ts
@@ -1,6 +1,10 @@
+import { asc, type SQL } from 'drizzle-orm';
 import type { AccountDto, CreateAccountRequest } from '../../shared/api/accounts';
 import type { CategoryDto, CategoryGroupDto } from '../../shared/api/categories';
 import type { PayeeDto } from '../../shared/api/payees';
+import type { CreateTransactionInput, CreateTransactionResponse, TransactionDto } from '../../shared/api/transactions';
+import type { Db } from '../db/client';
+import { ledgerLine } from '../db/schema';
 import type { TestClient } from './http-client';
 
 async function created<T>(res: Response, what: string): Promise<T> {
@@ -28,3 +32,19 @@ export async function createCategory(client: TestClient, groupId: string, name:
 export async function createPayee(client: TestClient, name: string): Promise<PayeeDto> {
   return created(await client.post('/api/payees', { name }), 'createPayee');
 }
+
+/** Books a transaction through the API (defaults: today, no payee, uncategorized) and returns it. */
+export async function createTransaction(
+  client: TestClient,
+  body: CreateTransactionInput,
+): Promise<TransactionDto> {
+  const res = await client.post('/api/transactions', body);
+  const saved = await created<CreateTransactionResponse>(res, 'createTransaction');
+  if (saved.kind !== 'transaction') throw new Error('createTransaction: the transaction was scheduled');
+  return saved.transaction;
+}
+
+/** What the budget sees: `v_ledger_line` rows (spec §4.6), by date and base amount. */
+export function ledgerLines(db: Db, where?: SQL) {
+  return db.select().from(ledgerLine).where(where).orderBy(asc(ledgerLine.date), asc(ledgerLine.amountBase));
+}
PATCH
```

Create `src/server/transactions/create-transaction.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateTransactionResponse, TransactionDto } from '../../shared/api/transactions';
import { systemCategoryId, systemPayeeId } from '../db/lookups';
import { category, ledgerLine, payee, scheduledTransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import {
  createAccount,
  createCategory,
  createGroup,
  createPayee,
  createTransaction,
  ledgerLines,
} from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const post = (body: object) => ctx.client.post('/api/transactions', body);

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  return { checking, groceries };
}

describe('POST /api/transactions', () => {
  it('books an approved, uncleared transaction with a new payee, and remembers the payee’s category', async () => {
    const { checking, groceries } = await setUp();
    const before = await snapshot(t.db);

    const res = await json<CreateTransactionResponse>(
      await post({
        accountId: checking.id,
        date: '2026-11-19',
        payeeName: 'Biedronka',
        categoryId: groceries.id,
        memo: ' weekly shop ',
        amount: -12_345,
      }),
    );
    expect(res.status).toBe(201);
    const [created] = await t.db.select().from(payee).where(eq(payee.name, 'Biedronka'));
    expect(res.body).toEqual({
      kind: 'transaction',
      transaction: {
        id: expect.any(String),
        accountId: checking.id,
        accountName: 'mBank',
        currency: 'PLN',
        date: '2026-11-19',
        payeeId: created!.id,
        payeeName: 'Biedronka',
        categoryId: groceries.id,
        categoryName: 'Groceries',
        memo: 'weekly shop',
        amount: -12_345,
        amountBase: -12_345,
        fxRate: null,
        effectiveRate: null,
        cleared: 'uncleared',
        approved: true,
        flag: null,
        isStartingBalance: false,
        isSplit: false,
        transfer: null,
        lines: [],
      },
    });
    expect(created!.lastCategoryId).toBe(groceries.id);
    const txn = (res.body as { transaction: TransactionDto }).transaction;
    expect(await ledgerLines(t.db, eq(ledgerLine.txnId, txn.id))).toEqual([
      {
        accountId: checking.id,
        accountClass: 'cash',
        date: '2026-11-19',
        month: '2026-11-01',
        categoryId: groceries.id,
        amount: -12_345,
        amountBase: -12_345,
        isTransfer: false,
        counterAccountClass: null,
        isStartingBalance: false,
        txnId: txn.id,
        subtxnId: null,
      },
    ]);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Add transaction "Biedronka"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('reuses payees by name or id, and books without a payee or a category', async () => {
    const { checking } = await setUp();
    const shop = await createPayee(ctx.client, 'Biedronka');
    const rta = await systemCategoryId(t.db, 'rta');

    const byName = await createTransaction(ctx.client, { accountId: checking.id, payeeName: 'BIEDRONKA', amount: -1 });
    expect(byName).toMatchObject({ payeeId: shop.id, date: '2026-11-20', categoryId: null, memo: null });
    const byId = await createTransaction(ctx.client, { accountId: checking.id, payeeId: shop.id, amount: -2 });
    expect(byId.payeeId).toBe(shop.id);
    expect((await t.db.select().from(payee).where(eq(payee.id, shop.id)))[0]!.lastCategoryId).toBeNull();
    const income = await createTransaction(ctx.client, {
      accountId: checking.id,
      categoryId: rta,
      amount: 500_000,
      cleared: 'cleared',
      flag: 'green',
    });
    expect(income).toMatchObject({
      payeeId: null,
      payeeName: null,
      categoryName: 'Ready to Assign',
      cleared: 'cleared',
      flag: 'green',
    });
    const lines = await ledgerLines(t.db, eq(ledgerLine.accountId, checking.id));
    expect(lines.map((l) => [l.categoryId, l.amountBase])).toEqual([
      [null, -2],
      [null, -1],
      [rta, 100_000],
      [rta, 500_000],
    ]);
  });

  it('books a foreign amount in PLN at the entered rate', async () => {
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    await createAccount(ctx.client, { name: 'mBank' });

    expect(await json(await post({ accountId: euro.id, amount: -333 }))).toEqual({
      status: 422,
      body: {
        code: 'fx_rate_required',
        message: 'Enter the exchange rate of EUR to PLN.',
        fieldErrors: { fxRate: ['Enter the exchange rate of EUR to PLN.'] },
      },
    });
    const txn = await createTransaction(ctx.client, { accountId: euro.id, amount: -333, fxRate: '4.3215' });
    // −333 × 4.3215 = −1 439.0595 → −1 439 (half away from zero).
    expect(txn).toMatchObject({
      currency: 'EUR',
      amount: -333,
      amountBase: -1_439,
      fxRate: '4.321500',
      effectiveRate: '4.321321',
    });
    const [row] = await t.db.select().from(transaction).where(eq(transaction.id, txn.id));
    expect(row!.fxRateManual).toBe(true);
    expect((await ledgerLines(t.db, eq(ledgerLine.txnId, txn.id))).map((l) => [l.amount, l.amountBase])).toEqual([
      [-333, -1_439],
    ]);
  });

  it('refuses a rate for PLN accounts', async () => {
    const { checking } = await setUp();
    expect((await json(await post({ accountId: checking.id, amount: -1, fxRate: '1' }))).body).toEqual({
      code: 'fx_rate_not_allowed',
      message: "This transaction doesn't need an exchange rate.",
      fieldErrors: { fxRate: ["This transaction doesn't need an exchange rate."] },
    });
  });

  it('applies the categorization rules of spec §5.5', async () => {
    const { checking, groceries } = await setUp();
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const loan = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      minPayment: 100,
      createPairedCategory: true,
    });
    const food = await createGroup(ctx.client, 'Old');
    const gone = await createCategory(ctx.client, food.id, 'Gone');
    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, gone.id));
    await t.db.update(category).set({ hidden: true }).where(eq(category.id, groceries.id));
    const code = async (body: object) => ((await json<{ code: string }>(await post(body))).body.code);

    expect(await code({ accountId: loan.id, categoryId: groceries.id, amount: -1 })).toBe('category_not_allowed');
    expect(await code({ accountId: checking.id, categoryId: card.paymentCategoryId, amount: -1 })).toBe(
      'card_payment_category',
    );
    const uncategorized = await systemCategoryId(t.db, 'uncategorized');
    expect(await json(await post({ accountId: checking.id, categoryId: uncategorized, amount: -1 }))).toMatchObject({
      status: 422,
      body: { code: 'invalid_category', message: 'Leave the category empty to keep it uncategorized.' },
    });
    for (const categoryId of [gone.id, crypto.randomUUID()]) {
      expect(await code({ accountId: checking.id, categoryId, amount: -1 })).toBe('invalid_category');
    }
    // Hidden categories, a loan's paired category and card spending are fine; tracking lines stay uncategorized.
    for (const body of [
      { accountId: checking.id, categoryId: groceries.id, amount: -1 },
      { accountId: checking.id, categoryId: loan.pairedCategoryId, amount: -1 },
      { accountId: card.id, categoryId: groceries.id, amount: -1 },
      { accountId: loan.id, amount: -1 },
    ]) {
      expect((await post(body)).status).toBe(201);
    }
  });

  it('refuses closed and unknown accounts, unknown and system payees, and malformed bodies', async () => {
    const { checking } = await setUp();
    const old = await createAccount(ctx.client, { name: 'Old', type: 'savings' });
    await ctx.client.post(`/api/accounts/${old.id}/close`);
    const gone = await createPayee(ctx.client, 'Gone');
    await ctx.client.send('DELETE', `/api/payees/${gone.id}`);

    expect(await json(await post({ accountId: old.id, amount: -1 }))).toEqual({
      status: 422,
      body: {
        code: 'account_closed',
        message: '"Old" is closed. Reopen it to add transactions.',
        fieldErrors: { accountId: ['"Old" is closed. Reopen it to add transactions.'] },
      },
    });
    const code = async (body: object) => ((await json<{ code: string }>(await post(body))).body.code);
    expect(await code({ accountId: crypto.randomUUID(), amount: -1 })).toBe('invalid_account');
    for (const payeeId of [gone.id, crypto.randomUUID()]) {
      expect(await code({ accountId: checking.id, payeeId, amount: -1 })).toBe('invalid_payee');
    }
    const startingBalance = await systemPayeeId(t.db, 'starting_balance');
    expect(await code({ accountId: checking.id, payeeId: startingBalance, amount: -1 })).toBe('system_payee');

    const fieldErrors = async (body: object) =>
      (await json<{ fieldErrors: Record<string, string[]> }>(await post(body))).body.fieldErrors;
    expect(await fieldErrors({ accountId: checking.id, payeeId: gone.id, payeeName: 'X', amount: -1 })).toEqual({
      payeeName: ['Choose a payee or type a new name, not both.'],
    });
    expect(Object.keys(await fieldErrors({ accountId: checking.id, amount: 1.5 }))).toEqual(['amount']);
    expect(Object.keys(await fieldErrors({ accountId: checking.id, amount: 1, cleared: 'reconciled' }))).toEqual([
      'cleared',
    ]);
    expect(Object.keys(await fieldErrors({ accountId: checking.id, amount: 1, flag: 'pink' }))).toEqual(['flag']);
    expect(await fieldErrors({ accountId: checking.id, amount: 1, date: '2026-02-30' })).toEqual({
      date: ['Use the format YYYY-MM-DD.'],
    });
    expect(await fieldErrors({ accountId: checking.id, amount: 1, date: '1969-12-31' })).toEqual({
      date: ['Use a date from 1970-01-01 on.'],
    });
  });

  it('saves a transaction dated after today (in the budget time zone) as a one-time schedule', async () => {
    const { checking, groceries } = await setUp();
    // 23:30 UTC is already 2026-11-21 in Warsaw.
    ctx.clock.advance(13.5 * 60 * 60 * 1000);
    const today = await json<CreateTransactionResponse>(
      await post({ accountId: checking.id, date: '2026-11-21', amount: -1 }),
    );
    expect(today.body.kind).toBe('transaction');
    const before = await snapshot(t.db);

    const res = await json<CreateTransactionResponse>(
      await post({
        accountId: checking.id,
        date: '2026-11-22',
        payeeName: 'Landlord',
        categoryId: groceries.id,
        memo: 'rent',
        amount: -200_000,
        flag: 'red',
      }),
    );
    expect(res).toEqual({
      status: 201,
      body: { kind: 'scheduled', scheduledId: expect.any(String), date: '2026-11-22' },
    });
    const [schedule] = await t.db.select().from(scheduledTransaction);
    const [landlord] = await t.db.select().from(payee).where(eq(payee.name, 'Landlord'));
    expect(schedule).toMatchObject({
      id: (res.body as { scheduledId: string }).scheduledId,
      accountId: checking.id,
      payeeId: landlord!.id,
      categoryId: groceries.id,
      memo: 'rent',
      amount: -200_000,
      fxRate: null,
      flag: 'red',
      transferAccountId: null,
      isSplit: false,
      frequency: 'once',
      anchorDate: '2026-11-22',
      nextDate: '2026-11-22',
    });
    expect(landlord!.lastCategoryId).toBe(groceries.id);
    expect(await t.db.select().from(transaction).where(eq(transaction.date, '2026-11-22'))).toEqual([]);
    expect(await ledgerLines(t.db, eq(ledgerLine.date, '2026-11-22'))).toEqual([]);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Schedule transaction "Landlord"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
  });
});

describe('GET /api/transactions/:id', () => {
  it('returns live transactions only', async () => {
    const { checking } = await setUp();
    const txn = await createTransaction(ctx.client, { accountId: checking.id, amount: -1 });
    expect(await json(await ctx.client.get(`/api/transactions/${txn.id}`))).toEqual({ status: 200, body: txn });

    await t.db.update(transaction).set({ deletedAt: new Date() }).where(eq(transaction.id, txn.id));
    expect(await json(await ctx.client.get(`/api/transactions/${txn.id}`))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Transaction not found.' },
    });
    expect((await ctx.client.get('/api/transactions/nope')).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/transactions src/server/http/errors.test.ts`
Expected: FAIL, `Tests  10 failed | 6 passed (16)`: the transaction tests get 404s, and the two new error tests see no dotted paths.

- [ ] **Step 3: Report field paths in errors**

```bash
git apply <<'PATCH'
diff --git a/src/server/http/errors.ts b/src/server/http/errors.ts
index df5d7c3..cae11a5 100644
--- a/src/server/http/errors.ts
+++ b/src/server/http/errors.ts
@@ -18,22 +18,31 @@ export class AppError extends Error {
   }
 }
 
-/** A violated business rule (spec §13): HTTP 422. */
+/**
+ * A violated business rule (spec §13): HTTP 422. `field` names the request field it concerns, as a dotted path
+ * (e.g. `lines.1.categoryId`); the body then also carries `fieldErrors: { [field]: [message] }`.
+ */
 export class DomainError extends AppError {
-  constructor(code: string, message: string) {
-    super(422, code, message);
+  constructor(code: string, message: string, field?: string) {
+    super(422, code, message, field === undefined ? {} : { fieldErrors: { [field]: [message] } });
     this.name = 'DomainError';
   }
 }
 
-/** Request validation failure (spec §13): HTTP 400 `{ code: "validation", fieldErrors, formErrors }`. */
+/**
+ * Request validation failure (spec §13): HTTP 400 `{ code: "validation", fieldErrors, formErrors }`. Field errors are
+ * keyed by the dotted issue path, so nested fields keep theirs (`lines.1.amount`); `z.flattenError` would report
+ * only the top-level key.
+ */
 export class ValidationError extends AppError {
   constructor(error: z.core.$ZodError) {
-    const flat = z.flattenError(error);
-    super(400, 'validation', 'Some fields are invalid.', {
-      fieldErrors: flat.fieldErrors as Record<string, string[]>,
-      formErrors: flat.formErrors,
-    });
+    const fieldErrors: Record<string, string[]> = {};
+    const formErrors: string[] = [];
+    for (const issue of error.issues) {
+      if (issue.path.length === 0) formErrors.push(issue.message);
+      else (fieldErrors[issue.path.map(String).join('.')] ??= []).push(issue.message);
+    }
+    super(400, 'validation', 'Some fields are invalid.', { fieldErrors, formErrors });
     this.name = 'ValidationError';
   }
 }
PATCH
```

- [ ] **Step 4: Add the shared schemas and DTOs**

Create `src/shared/api/transactions.ts`:

```ts
import { z } from 'zod';
import { fxRateSchema } from './accounts';
import { idSchema, isoDateSchema, moneySchema, nameSchema } from './common';

export const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type FlagColor = (typeof FLAG_COLORS)[number];

/** `reconciled` is set by the reconcile flow (P2d); users switch between the other two. */
export type ClearedStatus = 'uncleared' | 'cleared' | 'reconciled';

export const flagSchema = z.enum(FLAG_COLORS);
export const userClearedSchema = z.enum(['uncleared', 'cleared']);
/** Trimmed; an empty memo is stored as null. */
export const memoSchema = z.string().trim().max(500, 'Use at most 500 characters.');
/** Like starting balances, transactions start at 1970-01-01 (checked only once the format is valid). */
export const transactionDateSchema = isoDateSchema.refine((date) => date >= '1970-01-01', {
  error: 'Use a date from 1970-01-01 on.',
  when: (payload) => payload.issues.length === 0,
});

/**
 * POST /api/transactions. `amount` is in the account's currency (minor units, signed: + inflow, − outflow).
 * Choose an existing payee by `payeeId` or name one with `payeeName` (reused if a payee with that name exists,
 * otherwise created). A `date` after today (in the budget's time zone) is saved as a one-time scheduled transaction.
 */
export const createTransactionRequestSchema = z
  .object({
    accountId: idSchema,
    /** Defaults to today. */
    date: transactionDateSchema.optional(),
    payeeId: idSchema.optional(),
    payeeName: nameSchema.optional(),
    /** null = Uncategorized on budget accounts; tracking accounts never take one. */
    categoryId: idSchema.nullable().default(null),
    memo: memoSchema.default(''),
    amount: moneySchema,
    /** Rate to PLN; required for foreign-currency accounts until the NBP lookup exists (P2d). */
    fxRate: fxRateSchema.optional(),
    cleared: userClearedSchema.default('uncleared'),
    flag: flagSchema.nullable().default(null),
  })
  .refine((body) => body.payeeId === undefined || body.payeeName === undefined, {
    path: ['payeeName'],
    message: 'Choose a payee or type a new name, not both.',
  });

export type CreateTransactionRequest = z.infer<typeof createTransactionRequestSchema>;
/** The request body as sent (fields with defaults are optional). */
export type CreateTransactionInput = z.input<typeof createTransactionRequestSchema>;

/** The other side of a transfer. */
export interface TransferDto {
  accountId: string;
  accountName: string;
  /** The other side's transaction; for the counterpart of a split line, the split transaction. */
  transactionId: string;
  /** Set when this transaction is the counterpart of a split line: that line. */
  splitLineId: string | null;
  /** The other side's native amount, in its currency. */
  amount: number;
  currency: string;
  /** PLN per unit of the other side's currency (|base| / |amount|) when it isn't PLN. */
  effectiveRate: string | null;
}

export interface SplitLineTransferDto {
  accountId: string;
  accountName: string;
  /** The counterpart transaction in that account. */
  transactionId: string;
}

export interface SplitLineDto {
  id: string;
  amount: number;
  amountBase: number;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  memo: string | null;
  transfer: SplitLineTransferDto | null;
}

export interface TransactionDto {
  id: string;
  accountId: string;
  accountName: string;
  /** The account's currency; `amount` is in it. */
  currency: string;
  date: string;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  memo: string | null;
  amount: number;
  /** PLN (spec §9). */
  amountBase: number;
  /** The rate the user entered; null for PLN accounts and for amounts derived from the other side of a transfer. */
  fxRate: string | null;
  /** |amountBase| / |amount| for foreign-currency accounts (null for PLN accounts and zero amounts). */
  effectiveRate: string | null;
  cleared: ClearedStatus;
  approved: boolean;
  flag: FlagColor | null;
  isStartingBalance: boolean;
  isSplit: boolean;
  transfer: TransferDto | null;
  /** Live split lines in order; [] unless `isSplit`. */
  lines: SplitLineDto[];
}

/** POST /api/transactions: a booked transaction, or the one-time schedule a future date became (spec §5.6). */
export type CreateTransactionResponse =
  | { kind: 'transaction'; transaction: TransactionDto }
  | { kind: 'scheduled'; scheduledId: string; date: string };
```

- [ ] **Step 5: Add the rules and the planner**

Create `src/server/transactions/rules.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import type { AccountClass } from '../../shared/accounts';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { PayeeKind } from '../../shared/api/payees';
import { convertToBase, type Money } from '../../engine';
import { categoryKindOf } from '../categories/category-queries';
import type { Executor } from '../db/client';
import { account, category, categoryGroup, payee } from '../db/schema';
import { DomainError } from '../http/errors';
import { payeeKindOf } from '../payees/payee-queries';

export interface AccountInfo {
  id: string;
  name: string;
  currency: string;
  accountClass: AccountClass;
  closed: boolean;
  /** Its "Transfer : <name>" payee, which the other side of a transfer to this account uses. */
  transferPayeeId: string;
}

export interface PayeeInfo {
  id: string;
  name: string;
  kind: PayeeKind;
  transferAccountId: string | null;
}

/** Spec §3: cash and credit accounts are on the budget; tracking accounts are not. */
export const onBudget = (a: Pick<AccountInfo, 'accountClass'>) => a.accountClass !== 'tracking';

export async function findAccount(db: Executor, id: string): Promise<AccountInfo | null> {
  const [row] = await db
    .select({
      id: account.id,
      name: account.name,
      currency: account.currency,
      accountClass: account.accountClass,
      closed: account.closed,
      transferPayeeId: payee.id,
    })
    .from(account)
    .innerJoin(payee, eq(payee.transferAccountId, account.id))
    .where(eq(account.id, id));
  return row ?? null;
}

export async function requireAccount(db: Executor, id: string, field: string): Promise<AccountInfo> {
  const found = await findAccount(db, id);
  if (!found) throw new DomainError('invalid_account', 'Choose one of your accounts.', field);
  return found;
}

/** Closed accounts take no new transactions (rows that already exist there stay editable). */
export function assertOpen(target: AccountInfo, field: string): void {
  if (target.closed) {
    throw new DomainError('account_closed', `"${target.name}" is closed. Reopen it to add transactions.`, field);
  }
}

export async function requirePayee(db: Executor, id: string, field: string): Promise<PayeeInfo> {
  const [row] = await db
    .select()
    .from(payee)
    .where(and(eq(payee.id, id), isNull(payee.deletedAt)));
  if (!row) throw new DomainError('invalid_payee', 'Choose one of your payees.', field);
  return { id: row.id, name: row.name, kind: payeeKindOf(row), transferAccountId: row.transferAccountId };
}

/** System payees (Starting Balance, reconciliation and FX adjustments) are set by the app only. */
export function assertNotSystemPayee(found: PayeeInfo, field: string): void {
  if (found.kind === 'system') throw new DomainError('system_payee', 'This payee is reserved for the app.', field);
}

/**
 * Spec §5.5 and §11: a transaction line can use Ready to Assign, a regular category or a loan's paired category;
 * never a credit card payment category, and never Uncategorized explicitly (no category means Uncategorized).
 * Hidden categories are fine.
 */
export async function assertUsableCategory(db: Executor, id: string, field: string): Promise<void> {
  const [row] = await db
    .select({ category, groupKind: categoryGroup.kind })
    .from(category)
    .innerJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
    .where(and(eq(category.id, id), isNull(category.deletedAt)));
  const kind = row && categoryKindOf(row.category, row.groupKind);
  if (kind === undefined) throw new DomainError('invalid_category', 'Choose one of your categories.', field);
  if (kind === 'uncategorized') {
    throw new DomainError('invalid_category', 'Leave the category empty to keep it uncategorized.', field);
  }
  if (kind === 'cc_payment') {
    throw new DomainError(
      'card_payment_category',
      "Credit card payment categories can't be used on transactions: they move with card spending and payments.",
      field,
    );
  }
}

export function categoryNotAllowed(message: string, field: string): DomainError {
  return new DomainError('category_not_allowed', message, field);
}

export const TRACKING_NO_CATEGORY = "Transactions in tracking accounts don't take a category.";

/** Picks the rate a foreign amount is booked at: the one sent with the request, else the one already stored. */
export interface Rates {
  /** The `fxRate` of the request. */
  input: string | null;
  /** Rates of the saved transaction by currency (edits keep them). */
  stored: Map<string, string>;
  /** Set once `input` has been used, so an unneeded rate can be refused. */
  used: boolean;
}

export function rateFor(rates: Rates, currency: string): string {
  const rate = rates.input ?? rates.stored.get(currency);
  if (rate === undefined) {
    throw new DomainError('fx_rate_required', `Enter the exchange rate of ${currency} to ${BASE_CURRENCY}.`, 'fxRate');
  }
  if (rates.input !== null) rates.used = true;
  return rate;
}

/** Throws when the request sent a rate that nothing used. */
export function assertRateUsed(rates: Rates): void {
  if (rates.input !== null && !rates.used) {
    throw new DomainError('fx_rate_not_allowed', "This transaction doesn't need an exchange rate.", 'fxRate');
  }
}

export function toBase(amount: Money, rate: string): Money {
  const base = convertToBase(amount, rate);
  if (!Number.isSafeInteger(base)) throw new DomainError('amount_too_large', 'That amount is too large.', 'amount');
  return base;
}

/** Native amount → PLN (spec §9): PLN amounts are their own base; foreign ones need a rate. */
export function bookedBase(
  currency: string,
  amount: Money,
  rates: Rates,
): { amountBase: Money; fxRate: string | null } {
  if (currency === BASE_CURRENCY) return { amountBase: amount, fxRate: null };
  const rate = rateFor(rates, currency);
  return { amountBase: toBase(amount, rate), fxRate: rate };
}
```

Create `src/server/transactions/plan.ts`:

```ts
import type { ClearedStatus, FlagColor } from '../../shared/api/transactions';
import type { IsoDate, Money } from '../../engine';
import {
  type AccountInfo,
  assertNotSystemPayee,
  assertOpen,
  assertRateUsed,
  assertUsableCategory,
  bookedBase,
  categoryNotAllowed,
  onBudget,
  type PayeeInfo,
  type Rates,
  requireAccount,
  requirePayee,
  TRACKING_NO_CATEGORY,
} from './rules';
import type { Executor } from '../db/client';

/** A transaction as the user describes it, before the rules of spec §5.5 and §9 turn it into rows. */
export interface Draft {
  accountId: string;
  date: IsoDate;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  amount: Money;
  /** The rate sent with the request (null = none sent). */
  fxRate: string | null;
  cleared: ClearedStatus;
  approved: boolean;
  flag: FlagColor | null;
}

/** The columns of one `transaction` row that a plan decides. */
export interface RowPlan {
  accountId: string;
  date: IsoDate;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  amount: Money;
  amountBase: Money;
  fxRate: string | null;
  fxRateManual: boolean;
}

export interface Plan {
  main: RowPlan & { cleared: ClearedStatus; approved: boolean; flag: FlagColor | null };
  account: AccountInfo;
  payee: PayeeInfo | null;
  /** Spec §10: saving a categorized, non-transfer transaction makes its category the payee's default. */
  payeeDefault: { payeeId: string; categoryId: string } | null;
}

/** Validates a draft against spec §5.5 and §9 and computes the rows to write. */
export async function planTransaction(db: Executor, draft: Draft): Promise<Plan> {
  const target = await requireAccount(db, draft.accountId, 'accountId');
  assertOpen(target, 'accountId');
  const payee = draft.payeeId === null ? null : await requirePayee(db, draft.payeeId, 'payeeId');
  if (payee) assertNotSystemPayee(payee, 'payeeId');
  const rates: Rates = { input: draft.fxRate, stored: new Map(), used: false };

  if (draft.categoryId !== null) {
    if (!onBudget(target)) throw categoryNotAllowed(TRACKING_NO_CATEGORY, 'categoryId');
    await assertUsableCategory(db, draft.categoryId, 'categoryId');
  }
  const { amountBase, fxRate } = bookedBase(target.currency, draft.amount, rates);
  assertRateUsed(rates);

  return {
    main: {
      accountId: draft.accountId,
      date: draft.date,
      payeeId: draft.payeeId,
      categoryId: draft.categoryId,
      memo: draft.memo,
      amount: draft.amount,
      amountBase,
      fxRate,
      fxRateManual: fxRate !== null,
      cleared: draft.cleared,
      approved: draft.approved,
      flag: draft.flag,
    },
    account: target,
    payee,
    payeeDefault:
      payee?.kind === 'user' && draft.categoryId !== null ? { payeeId: payee.id, categoryId: draft.categoryId } : null,
  };
}
```

- [ ] **Step 6: Add the writers, the command and the queries**

Create `src/server/transactions/write.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { ChangeRecorder } from '../commands/recorder';
import { payee, scheduledTransaction, transaction } from '../db/schema';
import type { Draft, Plan } from './plan';

/** Spec §10: the transaction sheet pre-fills the category from the payee. */
async function rememberCategory(rec: ChangeRecorder, plan: Plan): Promise<void> {
  if (!plan.payeeDefault) return;
  const { payeeId, categoryId } = plan.payeeDefault;
  await rec.update(payee, eq(payee.id, payeeId), { lastCategoryId: categoryId });
}

/** Writes a new transaction from its plan; returns its id. */
export async function insertPlan(rec: ChangeRecorder, plan: Plan): Promise<string> {
  const [main] = await rec.insert(transaction, plan.main);
  await rememberCategory(rec, plan);
  return main!.id;
}

/**
 * Spec §5.6: a transaction dated after today is stored as a one-time scheduled transaction instead (anchor and next
 * date = its date). P2d's job enters it on that day and computes its PLN amount then.
 */
export async function insertSchedule(rec: ChangeRecorder, draft: Draft, plan: Plan): Promise<string> {
  const [schedule] = await rec.insert(scheduledTransaction, {
    accountId: draft.accountId,
    payeeId: draft.payeeId,
    categoryId: draft.categoryId,
    memo: draft.memo,
    amount: draft.amount,
    fxRate: plan.main.fxRate,
    fxRateManual: plan.main.fxRateManual,
    flag: draft.flag,
    frequency: 'once',
    anchorDate: draft.date,
    nextDate: draft.date,
  });
  await rememberCategory(rec, plan);
  return schedule!.id;
}
```

Create `src/server/transactions/transaction-commands.ts`:

```ts
import type { CreateTransactionRequest } from '../../shared/api/transactions';
import type { IsoDate } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import { findOrCreatePayee } from '../payees/payee-commands';
import { type Draft, planTransaction } from './plan';
import { insertPlan, insertSchedule } from './write';

export interface SavedTransaction {
  kind: 'transaction' | 'scheduled';
  /** The transaction's id, or the schedule's. */
  id: string;
  date: IsoDate;
  /** For the undo label. */
  payeeName: string | null;
}

/** "Add transaction "Biedronka"" / "Schedule transaction "Biedronka"" */
export function savedLabel(saved: SavedTransaction): string {
  const verb = saved.kind === 'scheduled' ? 'Schedule transaction' : 'Add transaction';
  return saved.payeeName === null ? verb : `${verb} "${saved.payeeName}"`;
}

/**
 * Spec §10 "Creating and editing": manual transactions are approved; a new payee name creates the payee; a date
 * after today becomes a one-time scheduled transaction (spec §5.6).
 */
export async function createTransaction(
  rec: ChangeRecorder,
  input: CreateTransactionRequest,
  today: IsoDate,
): Promise<SavedTransaction> {
  const payeeId =
    input.payeeName === undefined ? (input.payeeId ?? null) : await findOrCreatePayee(rec, input.payeeName);
  const draft: Draft = {
    accountId: input.accountId,
    date: input.date ?? today,
    payeeId,
    categoryId: input.categoryId,
    memo: input.memo || null,
    amount: input.amount,
    fxRate: input.fxRate ?? null,
    cleared: input.cleared,
    approved: true,
    flag: input.flag,
  };
  const plan = await planTransaction(rec.tx, draft);
  const payeeName = plan.payee?.name ?? null;
  if (draft.date > today) {
    return { kind: 'scheduled', id: await insertSchedule(rec, draft, plan), date: draft.date, payeeName };
  }
  return { kind: 'transaction', id: await insertPlan(rec, plan), date: draft.date, payeeName };
}
```

Create `src/server/transactions/transaction-queries.ts`:

```ts
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { TransactionDto } from '../../shared/api/transactions';
import { effectiveRate } from '../../engine';
import type { Executor } from '../db/client';
import { account, category, payee, transaction } from '../db/schema';
import { AppError } from '../http/errors';

/** Live transactions matching `where`, newest first (date desc, id desc), as DTOs. */
export async function loadTransactions(db: Executor, where?: SQL, limit?: number): Promise<TransactionDto[]> {
  const query = db
    .select({
      txn: transaction,
      accountName: account.name,
      currency: account.currency,
      payeeName: payee.name,
      categoryName: category.name,
    })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .leftJoin(payee, eq(payee.id, transaction.payeeId))
    .leftJoin(category, eq(category.id, transaction.categoryId))
    .where(and(isNull(transaction.deletedAt), where))
    .orderBy(desc(transaction.date), desc(transaction.id));
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map(({ txn, accountName, currency, payeeName, categoryName }) => ({
    id: txn.id,
    accountId: txn.accountId,
    accountName,
    currency,
    date: txn.date,
    payeeId: txn.payeeId,
    payeeName,
    categoryId: txn.categoryId,
    categoryName,
    memo: txn.memo,
    amount: txn.amount,
    amountBase: txn.amountBase,
    fxRate: txn.fxRate,
    effectiveRate: currency === BASE_CURRENCY ? null : effectiveRate(txn.amount, txn.amountBase),
    cleared: txn.cleared,
    approved: txn.approved,
    flag: txn.flag,
    isStartingBalance: txn.isStartingBalance,
    isSplit: txn.isSplit,
    transfer: null,
    lines: [],
  }));
}

export async function getTransaction(db: Executor, id: string): Promise<TransactionDto> {
  const [found] = await loadTransactions(db, eq(transaction.id, id));
  if (!found) throw new AppError(404, 'not_found', 'Transaction not found.');
  return found;
}
```

- [ ] **Step 7: Add the router and mount it**

Create `src/server/transactions/transaction-routes.ts`:

```ts
import { Hono } from 'hono';
import { idParamSchema } from '../../shared/api/common';
import {
  createTransactionRequestSchema,
  type CreateTransactionResponse,
  type TransactionDto,
} from '../../shared/api/transactions';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import { runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { createTransaction, savedLabel } from './transaction-commands';
import { getTransaction } from './transaction-queries';

/** /api/transactions (spec §10 "Transactions and related workflows"): every change is one undoable command. */
export function transactionRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .post('/', validate('json', createTransactionRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const saved = await runCommand(deps, savedLabel, (rec) => createTransaction(rec, body, today()));
      if (saved.kind === 'scheduled') {
        return c.json<CreateTransactionResponse>({ kind: 'scheduled', scheduledId: saved.id, date: saved.date }, 201);
      }
      const transaction = await getTransaction(deps.db, saved.id);
      return c.json<CreateTransactionResponse>({ kind: 'transaction', transaction }, 201);
    })
    .get('/:id', validate('param', idParamSchema), async (c) =>
      c.json<TransactionDto>(await getTransaction(deps.db, c.req.valid('param').id)),
    );
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.ts b/src/server/http/app.ts
index 80d62c8..4bdce99 100644
--- a/src/server/http/app.ts
+++ b/src/server/http/app.ts
@@ -17,6 +17,7 @@ import type { Config } from '../config';
 import type { Db } from '../db/client';
 import type { Logger } from '../logger';
 import { payeeRoutes } from '../payees/payee-routes';
+import { transactionRoutes } from '../transactions/transaction-routes';
 import type { ClientIpResolver } from './client-ip';
 import type { AppEnv } from './env';
 import { AppError, errorHandler } from './errors';
@@ -78,7 +79,8 @@ export function createApp(deps: AppDeps) {
     .route('/api/category-groups', groupRoutes(deps))
     .route('/api/categories', categoryRoutes(deps))
     .route('/api/budget', budgetRoutes(deps))
-    .route('/api/payees', payeeRoutes(deps));
+    .route('/api/payees', payeeRoutes(deps))
+    .route('/api/transactions', transactionRoutes(deps));
 
   app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
   app.onError(errorHandler);
PATCH
```

- [ ] **Step 8: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/transactions src/server/http/errors.test.ts`
Expected: `Tests  16 passed (16)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  40 passed (40)`, `Tests  372 passed (372)`; both checks exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/shared/api/transactions.ts src/server/transactions src/server/http src/server/test/fixtures.ts
git commit -m "feat(server): create and read plain transactions; field paths in errors" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Transfers, including between currencies; link indexes

Spec §5.5, §9 and §10 "Transfers". Choosing an account's transfer payee makes a transfer. Both sides are created in one command and point at each other through `transfer_txn_id`. As the P2b1 final review asks, one side is inserted with a null link and then updated, because foreign keys are checked immediately and undo replays row by row. The other side gets the entering account's transfer payee and the same date and memo; it is uncleared, approved and unflagged.
- Same currency: the other side's amount is −amount, and `transferAmount` is refused.
- Between currencies, both native amounts are needed (`transferAmount`, opposite sign, both non-zero), and `transferBases` gives base amounts that net to 0. A PLN side decides them. Between two foreign currencies, the sending side's rate converts: that is the side with the outflow, so the request's `fxRate` is that currency's rate even when the transfer is entered on the receiving side. The rate is stored on the sending side. A side whose base is derived from the other side stores `fx_rate = null`; `effectiveRate` shows its rate. A rate is refused when neither side needs one.
- Categories: a transfer between a budget and a tracking account needs one, and it is stored on the budget side wherever the transfer was entered. Transfers between two budget accounts (card payments included) or two tracking accounts take none.
- A transfer to the same account or to a closed account is refused.
- A future-dated transfer is scheduled with its `transfer_account_id`, except between currencies: a schedule has no column for the other side's amount (422 `future_transfer_currency`).

The task also adds the link indexes the P2b1 final review asked for (`transaction.transfer_txn_id`, `transfer_account_id`, `scheduled_id`, `subtransaction.transfer_txn_id`, `scheduled_subtransaction.scheduled_id`) and closes a carry-over gap in `transferBases`' tests (a foreign side with a `null` rate).

**Files:**
- Modify: `src/shared/api/transactions.ts`, `src/server/transactions/rules.ts`, `src/server/transactions/plan.ts`, `src/server/transactions/write.ts`, `src/server/transactions/transaction-commands.ts`, `src/server/transactions/transaction-queries.ts`, `src/server/db/schema.ts`
- Generate: `drizzle/0003_transaction_link_indexes.sql` (drizzle-kit also writes `drizzle/meta/0003_snapshot.json` and a `drizzle/meta/_journal.json` entry)
- Test: `src/server/transactions/transfer.test.ts`, `src/engine/fx.test.ts`, `src/server/db/schema.test.ts`

**Interfaces:**
- Consumes: `transferBases`, `effectiveRate` (engine); Task 2's rules and planner.
- Produces:
  - `createTransactionRequestSchema` gains `transferAmount?: number`.
  - `rules.ts`: `placeTransferCategory(db, here, there, categoryId, field): Promise<{ here, there }>` (422 `category_required` / `category_not_allowed`), `assertNotSelf(here, there, field)` (422 `transfer_to_self`).
  - `Draft.transferAmount: Money | null`; `RowPlan.transferAccountId`; `Plan.counterpart: RowPlan | null` and `Plan.transfer: AccountInfo | null`. New errors `transfer_amount_required`, `transfer_amount_not_allowed`, `transfer_amount_sign`, `future_transfer_currency`.
  - `insertPlan` writes and links the other side; `insertSchedule` stores `transferAccountId`.
  - `TransactionDto.transfer` is filled: `{ accountId, accountName, transactionId, splitLineId: null, amount, currency, effectiveRate }` (the other side's native amount, currency and rate).
  - Indexes `transaction_transfer_txn_id`, `transaction_transfer_account_id`, `transaction_scheduled_id`, `subtransaction_transfer_txn_id`, `scheduled_subtransaction_scheduled_id`.

- [ ] **Step 1: Write the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/engine/fx.test.ts b/src/engine/fx.test.ts
index 6b39f90..91d8244 100644
--- a/src/engine/fx.test.ts
+++ b/src/engine/fx.test.ts
@@ -44,6 +44,12 @@ describe('transferBases', () => {
     ).toEqual({ fromBase: -43_000, toBase: 43_000 });
   });
 
+  it('needs no rate on the foreign side when the other side is PLN', () => {
+    expect(
+      transferBases('PLN', { amount: -9_300, currency: 'EUR', rate: null }, { amount: 40_000, currency: 'PLN', rate: null }),
+    ).toEqual({ fromBase: -40_000, toBase: 40_000 });
+  });
+
   it('requires a rate for a foreign source', () => {
     expect(() =>
       transferBases('PLN', { amount: -1, currency: 'EUR', rate: null }, { amount: 1, currency: 'USD', rate: null }),
diff --git a/src/server/db/schema.test.ts b/src/server/db/schema.test.ts
index 9c2e08e..0a2925c 100644
--- a/src/server/db/schema.test.ts
+++ b/src/server/db/schema.test.ts
@@ -178,3 +178,21 @@ describe('schema hardening (P2b1)', () => {
     expect(rows.map((r) => r.conname)).toEqual([]);
   });
 });
+
+describe('transaction link indexes (P2c)', () => {
+  it('indexes the links between transfer sides, split lines, counterparts and schedules', async () => {
+    const rows = await t.db.execute<{ indexname: string; indexdef: string }>(
+      sql`select indexname, indexdef from pg_indexes
+          where indexname in ('transaction_transfer_txn_id', 'transaction_transfer_account_id',
+            'transaction_scheduled_id', 'subtransaction_transfer_txn_id', 'scheduled_subtransaction_scheduled_id')
+          order by indexname`,
+    );
+    expect(rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, '')])).toEqual([
+      ['scheduled_subtransaction_scheduled_id', '(scheduled_id)'],
+      ['subtransaction_transfer_txn_id', '(transfer_txn_id)'],
+      ['transaction_scheduled_id', '(scheduled_id)'],
+      ['transaction_transfer_account_id', '(transfer_account_id)'],
+      ['transaction_transfer_txn_id', '(transfer_txn_id)'],
+    ]);
+  });
+});
PATCH
```

Create `src/server/transactions/transfer.test.ts`:

```ts
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionDto } from '../../shared/api/transactions';
import { systemCategoryId } from '../db/lookups';
import { ledgerLine, payee, scheduledTransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createPayee, createTransaction, ledgerLines } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const post = (body: object) => ctx.client.post('/api/transactions', body);
const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;
const code = async (body: object) => (await json<{ code: string }>(await post(body))).body.code;
const linesOf = (...ids: string[]) => ledgerLines(t.db, inArray(ledgerLine.txnId, ids));

describe('transfers', () => {
  it('creates both sides of a same-currency transfer, linked through the transfer payees', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
    const before = await snapshot(t.db);

    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      date: '2026-11-19',
      payeeId: savings.transferPayeeId,
      memo: 'rainy day',
      amount: -50_000,
      cleared: 'cleared',
      flag: 'blue',
    });
    expect(sent).toMatchObject({
      payeeName: 'Transfer : Savings',
      categoryId: null,
      amountBase: -50_000,
      cleared: 'cleared',
      transfer: {
        accountId: savings.id,
        accountName: 'Savings',
        transactionId: expect.any(String),
        splitLineId: null,
        amount: 50_000,
        currency: 'PLN',
        effectiveRate: null,
      },
    });
    const received = await get(sent.transfer!.transactionId);
    expect(received).toMatchObject({
      accountId: savings.id,
      date: '2026-11-19',
      payeeId: checking.transferPayeeId,
      payeeName: 'Transfer : mBank',
      categoryId: null,
      memo: 'rainy day',
      amount: 50_000,
      amountBase: 50_000,
      cleared: 'uncleared',
      approved: true,
      flag: null,
      transfer: { accountId: checking.id, transactionId: sent.id, amount: -50_000 },
    });
    const rows = await t.db.select().from(transaction).where(inArray(transaction.id, [sent.id, received.id]));
    expect(rows.map((r) => [r.id, r.transferAccountId, r.transferTxnId]).sort()).toEqual(
      [
        [sent.id, savings.id, received.id],
        [received.id, checking.id, sent.id],
      ].sort(),
    );
    const lines = await linesOf(sent.id, received.id);
    expect(lines.map((l) => [l.accountId, l.amountBase, l.isTransfer, l.counterAccountClass])).toEqual([
      [checking.id, -50_000, true, 'cash'],
      [savings.id, 50_000, true, 'cash'],
    ]);
    const [transferPayee] = await t.db.select().from(payee).where(eq(payee.id, savings.transferPayeeId));
    expect(transferPayee!.lastCategoryId).toBeNull();
    const after = await snapshot(t.db);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Add transaction "Transfer : Savings"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('puts the category of a transfer between a budget and a tracking account on the budget side', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const loan = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      startingBalance: -1_000_000,
      minPayment: 100_000,
      createPairedCategory: true,
    });
    const rta = await systemCategoryId(t.db, 'rta');

    const payment = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: loan.transferPayeeId,
      categoryId: loan.pairedCategoryId,
      amount: -100_000,
    });
    expect(payment.categoryId).toBe(loan.pairedCategoryId);
    expect((await get(payment.transfer!.transactionId)).categoryId).toBeNull();
    // Entered from the tracking side, the category still lands on the budget side.
    const payout = await createTransaction(ctx.client, {
      accountId: loan.id,
      payeeId: checking.transferPayeeId,
      categoryId: rta,
      amount: -20_000,
    });
    expect(payout.categoryId).toBeNull();
    expect((await get(payout.transfer!.transactionId)).categoryId).toBe(rta);

    const lines = await linesOf(payment.id, payment.transfer!.transactionId, payout.id, payout.transfer!.transactionId);
    expect(lines.map((l) => [l.accountClass, l.categoryId, l.amountBase, l.counterAccountClass])).toEqual([
      ['cash', loan.pairedCategoryId, -100_000, 'tracking'],
      ['tracking', null, -20_000, 'cash'],
      ['cash', rta, 20_000, 'tracking'],
      ['tracking', null, 100_000, 'cash'],
    ]);
    const required = 'Choose a category for the budget side of a transfer to or from a tracking account.';
    expect(await json(await post({ accountId: checking.id, payeeId: loan.transferPayeeId, amount: -1 }))).toEqual({
      status: 422,
      body: { code: 'category_required', message: required, fieldErrors: { categoryId: [required] } },
    });
  });

  it('refuses categories on budget↔budget and tracking↔tracking transfers, and self or closed targets', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const loan = await createAccount(ctx.client, { name: 'Car', type: 'auto_loan' });
    const house = await createAccount(ctx.client, { name: 'House', type: 'other_asset' });
    const old = await createAccount(ctx.client, { name: 'Old', type: 'savings' });
    await ctx.client.post(`/api/accounts/${old.id}/close`);
    const rta = await systemCategoryId(t.db, 'rta');
    const transfer = (from: { id: string }, to: { transferPayeeId: string }, extra: object = {}) => ({
      accountId: from.id,
      payeeId: to.transferPayeeId,
      amount: -100,
      ...extra,
    });

    expect(await code(transfer(checking, savings, { categoryId: rta }))).toBe('category_not_allowed');
    expect(await code(transfer(loan, house, { categoryId: rta }))).toBe('category_not_allowed');
    expect(await code(transfer(checking, loan, { categoryId: card.paymentCategoryId }))).toBe('card_payment_category');
    expect(await json(await post(transfer(checking, checking)))).toMatchObject({
      status: 422,
      body: { code: 'transfer_to_self', fieldErrors: { payeeId: ['A transfer needs two different accounts.'] } },
    });
    expect((await json(await post(transfer(checking, old)))).body).toMatchObject({
      code: 'account_closed',
      fieldErrors: { payeeId: ['"Old" is closed. Reopen it to add transactions.'] },
    });
    expect(await code(transfer(checking, savings, { transferAmount: 100 }))).toBe('transfer_amount_not_allowed');
    const shop = await createPayee(ctx.client, 'Biedronka');
    expect(await code({ accountId: checking.id, payeeId: shop.id, amount: -1, transferAmount: 1 })).toBe(
      'transfer_amount_not_allowed',
    );
    // A card payment is a budget↔budget transfer.
    expect((await post(transfer(checking, card))).status).toBe(201);
  });

  it('books a PLN ↔ foreign transfer at both actual amounts, netting to zero (golden scenario 11)', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
    const euro = await createAccount(ctx.client, {
      name: 'Revolut',
      type: 'savings',
      currency: 'EUR',
      fxRate: '4.25',
    });
    const toEuro = { accountId: checking.id, payeeId: euro.transferPayeeId, amount: -40_000 };

    expect(await json(await post(toEuro))).toMatchObject({
      status: 422,
      body: { code: 'transfer_amount_required', message: 'Enter the amount in EUR that "Revolut" receives or sends.' },
    });
    expect(await code({ ...toEuro, transferAmount: -9_300 })).toBe('transfer_amount_sign');
    expect(await code({ ...toEuro, transferAmount: 9_300, fxRate: '4.3' })).toBe('fx_rate_not_allowed');

    const sent = await createTransaction(ctx.client, { ...toEuro, transferAmount: 9_300 });
    expect(sent).toMatchObject({
      amount: -40_000,
      amountBase: -40_000,
      transfer: { accountId: euro.id, amount: 9_300, currency: 'EUR', effectiveRate: '4.301075' },
    });
    expect(await get(sent.transfer!.transactionId)).toMatchObject({
      currency: 'EUR',
      amount: 9_300,
      amountBase: 40_000,
      fxRate: null,
      effectiveRate: '4.301075',
    });
    // From the EUR side, the PLN side still decides the base amounts.
    const back = await createTransaction(ctx.client, {
      accountId: euro.id,
      payeeId: checking.transferPayeeId,
      amount: -1_000,
      transferAmount: 4_200,
    });
    expect([back.amountBase, (await get(back.transfer!.transactionId)).amountBase]).toEqual([-4_200, 4_200]);
    const lines = await linesOf(sent.id, sent.transfer!.transactionId, back.id, back.transfer!.transactionId);
    expect(lines.reduce((sum, l) => sum + l.amountBase, 0)).toBe(0);
    expect(lines.filter((l) => l.accountId === euro.id).map((l) => [l.amount, l.amountBase])).toEqual([
      [-1_000, -4_200],
      [9_300, 40_000],
    ]);
  });

  it('converts a foreign ↔ foreign transfer at the sending currency’s rate', async () => {
    const euro = await createAccount(ctx.client, { name: 'EUR', type: 'savings', currency: 'EUR', fxRate: '4.25' });
    const dollar = await createAccount(ctx.client, { name: 'USD', type: 'savings', currency: 'USD', fxRate: '3.9' });
    const toDollar = { accountId: euro.id, payeeId: dollar.transferPayeeId, amount: -10_000, transferAmount: 11_500 };

    expect((await json(await post(toDollar))).body).toMatchObject({
      code: 'fx_rate_required',
      message: 'Enter the exchange rate of EUR to PLN.',
    });
    const sent = await createTransaction(ctx.client, { ...toDollar, fxRate: '4.3' });
    expect(sent).toMatchObject({ amountBase: -43_000, fxRate: '4.300000', effectiveRate: '4.300000' });
    expect(await get(sent.transfer!.transactionId)).toMatchObject({
      amount: 11_500,
      amountBase: 43_000,
      fxRate: null,
      effectiveRate: '3.739130',
    });
    // Entered on the receiving side, the rate is still the sending (EUR) side's, and stored there.
    const received = await createTransaction(ctx.client, {
      accountId: dollar.id,
      payeeId: euro.transferPayeeId,
      amount: 11_500,
      transferAmount: -10_000,
      fxRate: '4.3',
    });
    expect(received).toMatchObject({ amountBase: 43_000, fxRate: null });
    expect(await get(received.transfer!.transactionId)).toMatchObject({ amountBase: -43_000, fxRate: '4.300000' });
  });

  it('schedules a future transfer, except one between currencies', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
    const euro = await createAccount(ctx.client, {
      name: 'Revolut',
      type: 'savings',
      currency: 'EUR',
      fxRate: '4.25',
    });

    const res = await json<{ kind: string }>(
      await post({ accountId: checking.id, date: '2026-12-01', payeeId: savings.transferPayeeId, amount: -100 }),
    );
    expect(res).toMatchObject({ status: 201, body: { kind: 'scheduled' } });
    expect(await t.db.select().from(scheduledTransaction)).toMatchObject([
      { accountId: checking.id, payeeId: savings.transferPayeeId, transferAccountId: savings.id, amount: -100 },
    ]);
    expect(
      await json(
        await post({
          accountId: checking.id,
          date: '2026-12-01',
          payeeId: euro.transferPayeeId,
          amount: -100,
          transferAmount: 25,
        }),
      ),
    ).toMatchObject({ status: 422, body: { code: 'future_transfer_currency' } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/transactions/transfer.test.ts src/engine/fx.test.ts src/server/db/schema.test.ts`
Expected: FAIL, `Tests  7 failed | 28 passed (35)`: transfers are still booked as plain transactions (e.g. `Cannot read properties of null (reading 'transactionId')`), and the index test finds no indexes. The new `fx.test.ts` case passes already: it pins existing behaviour.

- [ ] **Step 3: Add the indexes and generate the migration**

```bash
git apply <<'PATCH'
diff --git a/src/server/db/schema.ts b/src/server/db/schema.ts
index f6a9d7e..47afb25 100644
--- a/src/server/db/schema.ts
+++ b/src/server/db/schema.ts
@@ -298,18 +298,22 @@ export const scheduledTransaction = pgTable('scheduled_transaction', {
   ...timestamps,
 });
 
-export const scheduledSubtransaction = pgTable('scheduled_subtransaction', {
-  id: uuid('id').primaryKey().defaultRandom(),
-  scheduledId: uuid('scheduled_id')
-    .notNull()
-    .references(() => scheduledTransaction.id),
-  amount: money('amount').notNull(),
-  categoryId: uuid('category_id').references(() => category.id),
-  payeeId: uuid('payee_id').references(() => payee.id),
-  memo: text('memo'),
-  transferAccountId: uuid('transfer_account_id').references(() => account.id),
-  sortOrder: integer('sort_order').notNull().default(0),
-});
+export const scheduledSubtransaction = pgTable(
+  'scheduled_subtransaction',
+  {
+    id: uuid('id').primaryKey().defaultRandom(),
+    scheduledId: uuid('scheduled_id')
+      .notNull()
+      .references(() => scheduledTransaction.id),
+    amount: money('amount').notNull(),
+    categoryId: uuid('category_id').references(() => category.id),
+    payeeId: uuid('payee_id').references(() => payee.id),
+    memo: text('memo'),
+    transferAccountId: uuid('transfer_account_id').references(() => account.id),
+    sortOrder: integer('sort_order').notNull().default(0),
+  },
+  (t) => [index('scheduled_subtransaction_scheduled_id').on(t.scheduledId)],
+);
 
 export const transaction = pgTable(
   'transaction',
@@ -347,6 +351,10 @@ export const transaction = pgTable(
     index('transaction_date').on(t.date),
     index('transaction_category_id').on(t.categoryId),
     index('transaction_payee_id').on(t.payeeId),
+    // Transfer sides, line counterparts and schedule occurrences are looked up (and checked by FKs) through these.
+    index('transaction_transfer_txn_id').on(t.transferTxnId),
+    index('transaction_transfer_account_id').on(t.transferAccountId),
+    index('transaction_scheduled_id').on(t.scheduledId),
     uniqueIndex('transaction_import_id').on(t.accountId, t.importId).where(sql`${t.importId} IS NOT NULL`),
     uniqueIndex('transaction_external_id').on(t.accountId, t.externalId).where(sql`${t.externalId} IS NOT NULL`),
   ],
@@ -370,7 +378,11 @@ export const subtransaction = pgTable(
     deletedAt: instant('deleted_at'),
     ...timestamps,
   },
-  (t) => [index('subtransaction_txn_id').on(t.txnId), index('subtransaction_category_id').on(t.categoryId)],
+  (t) => [
+    index('subtransaction_txn_id').on(t.txnId),
+    index('subtransaction_category_id').on(t.categoryId),
+    index('subtransaction_transfer_txn_id').on(t.transferTxnId),
+  ],
 );
 
 // ---------------------------------------------------------------- support (spec §4.5)
PATCH
```

```bash
npm run db:generate -- --name transaction_link_indexes
```

It writes `drizzle/0003_transaction_link_indexes.sql`, which must read:

```sql
CREATE INDEX "scheduled_subtransaction_scheduled_id" ON "scheduled_subtransaction" USING btree ("scheduled_id");--> statement-breakpoint
CREATE INDEX "subtransaction_transfer_txn_id" ON "subtransaction" USING btree ("transfer_txn_id");--> statement-breakpoint
CREATE INDEX "transaction_transfer_txn_id" ON "transaction" USING btree ("transfer_txn_id");--> statement-breakpoint
CREATE INDEX "transaction_transfer_account_id" ON "transaction" USING btree ("transfer_account_id");--> statement-breakpoint
CREATE INDEX "transaction_scheduled_id" ON "transaction" USING btree ("scheduled_id");
```

- [ ] **Step 4: Accept the other side's amount**

```bash
git apply <<'PATCH'
diff --git a/src/shared/api/transactions.ts b/src/shared/api/transactions.ts
index 0fc7b01..380bd5b 100644
--- a/src/shared/api/transactions.ts
+++ b/src/shared/api/transactions.ts
@@ -22,6 +22,10 @@ export const transactionDateSchema = isoDateSchema.refine((date) => date >= '197
  * POST /api/transactions. `amount` is in the account's currency (minor units, signed: + inflow, − outflow).
  * Choose an existing payee by `payeeId` or name one with `payeeName` (reused if a payee with that name exists,
  * otherwise created). A `date` after today (in the budget's time zone) is saved as a one-time scheduled transaction.
+ *
+ * Choosing an account's "Transfer : <name>" payee makes a transfer (spec §10): the other side is created in that
+ * account. A transfer between a budget and a tracking account needs `categoryId`, which is stored on the budget side;
+ * other transfers take none (spec §5.5).
  */
 export const createTransactionRequestSchema = z
   .object({
@@ -34,7 +38,12 @@ export const createTransactionRequestSchema = z
     categoryId: idSchema.nullable().default(null),
     memo: memoSchema.default(''),
     amount: moneySchema,
-    /** Rate to PLN; required for foreign-currency accounts until the NBP lookup exists (P2d). */
+    /** Transfers between currencies: the other account's native amount (opposite sign). */
+    transferAmount: moneySchema.optional(),
+    /**
+     * Rate to PLN; required for foreign-currency accounts until the NBP lookup exists (P2d). For a transfer between
+     * two foreign-currency accounts it is the rate of the sending account's currency (spec §9).
+     */
     fxRate: fxRateSchema.optional(),
     cleared: userClearedSchema.default('uncleared'),
     flag: flagSchema.nullable().default(null),
PATCH
```

- [ ] **Step 5: Add the transfer rules and plan transfers**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/rules.ts b/src/server/transactions/rules.ts
index 3db98b4..d56ed3c 100644
--- a/src/server/transactions/rules.ts
+++ b/src/server/transactions/rules.ts
@@ -103,6 +103,41 @@ export function categoryNotAllowed(message: string, field: string): DomainError
 
 export const TRACKING_NO_CATEGORY = "Transactions in tracking accounts don't take a category.";
 
+/**
+ * Spec §5.5: a transfer between a budget and a tracking account carries a category on its budget side (wherever it
+ * was entered from); transfers between two budget or two tracking accounts carry none.
+ */
+export async function placeTransferCategory(
+  db: Executor,
+  here: AccountInfo,
+  there: AccountInfo,
+  categoryId: string | null,
+  field: string,
+): Promise<{ here: string | null; there: string | null }> {
+  if (onBudget(here) === onBudget(there)) {
+    if (categoryId !== null) {
+      throw categoryNotAllowed(
+        "Transfers between two budget accounts, or two tracking accounts, don't take a category.",
+        field,
+      );
+    }
+    return { here: null, there: null };
+  }
+  if (categoryId === null) {
+    throw new DomainError(
+      'category_required',
+      'Choose a category for the budget side of a transfer to or from a tracking account.',
+      field,
+    );
+  }
+  await assertUsableCategory(db, categoryId, field);
+  return onBudget(here) ? { here: categoryId, there: null } : { here: null, there: categoryId };
+}
+
+export function assertNotSelf(here: AccountInfo, there: AccountInfo, field: string): void {
+  if (here.id === there.id) throw new DomainError('transfer_to_self', 'A transfer needs two different accounts.', field);
+}
+
 /** Picks the rate a foreign amount is booked at: the one sent with the request, else the one already stored. */
 export interface Rates {
   /** The `fxRate` of the request. */
PATCH
```

Replace the whole of `src/server/transactions/plan.ts`:

```ts
import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { ClearedStatus, FlagColor } from '../../shared/api/transactions';
import { type IsoDate, type Money, transferBases } from '../../engine';
import type { Executor } from '../db/client';
import { DomainError } from '../http/errors';
import {
  type AccountInfo,
  assertNotSelf,
  assertNotSystemPayee,
  assertOpen,
  assertRateUsed,
  assertUsableCategory,
  bookedBase,
  categoryNotAllowed,
  onBudget,
  type PayeeInfo,
  placeTransferCategory,
  rateFor,
  type Rates,
  requireAccount,
  requirePayee,
  TRACKING_NO_CATEGORY,
} from './rules';

/** A transaction as the user describes it, before the rules of spec §5.5 and §9 turn it into rows. */
export interface Draft {
  accountId: string;
  date: IsoDate;
  payeeId: string | null;
  /** For a transfer between a budget and a tracking account: the budget side's category. */
  categoryId: string | null;
  memo: string | null;
  amount: Money;
  /** Transfers between currencies: the other side's native amount. */
  transferAmount: Money | null;
  /** The rate sent with the request (null = none sent). */
  fxRate: string | null;
  cleared: ClearedStatus;
  approved: boolean;
  flag: FlagColor | null;
}

/** The columns of one `transaction` row that a plan decides. */
export interface RowPlan {
  accountId: string;
  date: IsoDate;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  amount: Money;
  amountBase: Money;
  fxRate: string | null;
  fxRateManual: boolean;
  transferAccountId: string | null;
}

export interface Plan {
  main: RowPlan & { cleared: ClearedStatus; approved: boolean; flag: FlagColor | null };
  account: AccountInfo;
  payee: PayeeInfo | null;
  /** The other side of a transfer. */
  counterpart: RowPlan | null;
  /** The other account of a transfer. */
  transfer: AccountInfo | null;
  /** Spec §10: saving a categorized, non-transfer transaction makes its category the payee's default. */
  payeeDefault: { payeeId: string; categoryId: string } | null;
}

const rateColumns = (rate: string | null) => ({ fxRate: rate, fxRateManual: rate !== null });

/**
 * Spec §9: both sides of a transfer net to zero in PLN. Same-currency transfers mirror the amount; transfers between
 * currencies take both native amounts. The sending side (the outflow; this side for 0) decides the base amounts:
 * a PLN side gives them directly, otherwise the sending currency's rate converts.
 */
function transferSides(main: AccountInfo, other: AccountInfo, draft: Draft, rates: Rates) {
  let otherAmount: Money;
  if (main.currency === other.currency) {
    if (draft.transferAmount !== null) {
      throw new DomainError(
        'transfer_amount_not_allowed',
        'Both accounts use the same currency, so the other side mirrors this amount.',
        'transferAmount',
      );
    }
    otherAmount = -draft.amount;
  } else {
    if (draft.transferAmount === null) {
      throw new DomainError(
        'transfer_amount_required',
        `Enter the amount in ${other.currency} that "${other.name}" receives or sends.`,
        'transferAmount',
      );
    }
    if (draft.amount === 0 || Math.sign(draft.transferAmount) !== -Math.sign(draft.amount)) {
      throw new DomainError(
        'transfer_amount_sign',
        'The two sides of a transfer need opposite, non-zero amounts.',
        'transferAmount',
      );
    }
    otherAmount = draft.transferAmount;
  }
  const here = { amount: draft.amount, currency: main.currency };
  const there = { amount: otherAmount, currency: other.currency };
  const mainSends = draft.amount <= 0;
  const from = mainSends ? here : there;
  const to = mainSends ? there : here;
  const rate = from.currency !== BASE_CURRENCY && to.currency !== BASE_CURRENCY ? rateFor(rates, from.currency) : null;
  const { fromBase, toBase } = transferBases(BASE_CURRENCY, { ...from, rate }, { ...to, rate: null });
  if (!Number.isSafeInteger(fromBase)) throw new DomainError('amount_too_large', 'That amount is too large.', 'amount');
  return mainSends
    ? { mainBase: fromBase, mainRate: rate, otherAmount, otherBase: toBase, otherRate: null }
    : { mainBase: toBase, mainRate: null, otherAmount, otherBase: fromBase, otherRate: rate };
}

/** Validates a draft against spec §5.5 and §9 and computes the rows to write. */
export async function planTransaction(db: Executor, draft: Draft): Promise<Plan> {
  const main = await requireAccount(db, draft.accountId, 'accountId');
  assertOpen(main, 'accountId');
  const payee = draft.payeeId === null ? null : await requirePayee(db, draft.payeeId, 'payeeId');
  if (payee) assertNotSystemPayee(payee, 'payeeId');
  const rates: Rates = { input: draft.fxRate, stored: new Map(), used: false };
  const row = {
    accountId: draft.accountId,
    date: draft.date,
    payeeId: draft.payeeId,
    memo: draft.memo,
    amount: draft.amount,
  };
  const status = { cleared: draft.cleared, approved: draft.approved, flag: draft.flag };

  if (payee?.transferAccountId) {
    const other = await requireAccount(db, payee.transferAccountId, 'payeeId');
    assertNotSelf(main, other, 'payeeId');
    assertOpen(other, 'payeeId');
    const category = await placeTransferCategory(db, main, other, draft.categoryId, 'categoryId');
    const sides = transferSides(main, other, draft, rates);
    assertRateUsed(rates);
    return {
      main: {
        ...row,
        ...status,
        categoryId: category.here,
        amountBase: sides.mainBase,
        ...rateColumns(sides.mainRate),
        transferAccountId: other.id,
      },
      account: main,
      payee,
      counterpart: {
        accountId: other.id,
        date: draft.date,
        payeeId: main.transferPayeeId,
        categoryId: category.there,
        memo: draft.memo,
        amount: sides.otherAmount,
        amountBase: sides.otherBase,
        ...rateColumns(sides.otherRate),
        transferAccountId: main.id,
      },
      transfer: other,
      payeeDefault: null,
    };
  }

  if (draft.transferAmount !== null) {
    throw new DomainError('transfer_amount_not_allowed', 'Only transfers take a second amount.', 'transferAmount');
  }
  if (draft.categoryId !== null) {
    if (!onBudget(main)) throw categoryNotAllowed(TRACKING_NO_CATEGORY, 'categoryId');
    await assertUsableCategory(db, draft.categoryId, 'categoryId');
  }
  const { amountBase, fxRate } = bookedBase(main.currency, draft.amount, rates);
  assertRateUsed(rates);
  return {
    main: {
      ...row,
      ...status,
      categoryId: draft.categoryId,
      amountBase,
      ...rateColumns(fxRate),
      transferAccountId: null,
    },
    account: main,
    payee,
    counterpart: null,
    transfer: null,
    payeeDefault:
      payee?.kind === 'user' && draft.categoryId !== null ? { payeeId: payee.id, categoryId: draft.categoryId } : null,
  };
}
```

- [ ] **Step 6: Write both sides, refuse future transfers between currencies, show the other side**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/transaction-commands.ts b/src/server/transactions/transaction-commands.ts
index 610d4b1..e91b705 100644
--- a/src/server/transactions/transaction-commands.ts
+++ b/src/server/transactions/transaction-commands.ts
@@ -1,6 +1,7 @@
 import type { CreateTransactionRequest } from '../../shared/api/transactions';
 import type { IsoDate } from '../../engine';
 import type { ChangeRecorder } from '../commands/recorder';
+import { DomainError } from '../http/errors';
 import { findOrCreatePayee } from '../payees/payee-commands';
 import { type Draft, planTransaction } from './plan';
 import { insertPlan, insertSchedule } from './write';
@@ -38,6 +39,7 @@ export async function createTransaction(
     categoryId: input.categoryId,
     memo: input.memo || null,
     amount: input.amount,
+    transferAmount: input.transferAmount ?? null,
     fxRate: input.fxRate ?? null,
     cleared: input.cleared,
     approved: true,
@@ -46,6 +48,14 @@ export async function createTransaction(
   const plan = await planTransaction(rec.tx, draft);
   const payeeName = plan.payee?.name ?? null;
   if (draft.date > today) {
+    if (plan.transfer && plan.transfer.currency !== plan.account.currency) {
+      // A schedule has no column for the other side's amount.
+      throw new DomainError(
+        'future_transfer_currency',
+        "Transfers between currencies can't be dated in the future yet.",
+        'date',
+      );
+    }
     return { kind: 'scheduled', id: await insertSchedule(rec, draft, plan), date: draft.date, payeeName };
   }
   return { kind: 'transaction', id: await insertPlan(rec, plan), date: draft.date, payeeName };
diff --git a/src/server/transactions/transaction-queries.ts b/src/server/transactions/transaction-queries.ts
index bd8d791..d8a2b3b 100644
--- a/src/server/transactions/transaction-queries.ts
+++ b/src/server/transactions/transaction-queries.ts
@@ -1,11 +1,18 @@
 import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
+import { alias } from 'drizzle-orm/pg-core';
 import { BASE_CURRENCY } from '../../shared/api/accounts';
 import type { TransactionDto } from '../../shared/api/transactions';
-import { effectiveRate } from '../../engine';
+import { effectiveRate, type Money } from '../../engine';
 import type { Executor } from '../db/client';
 import { account, category, payee, transaction } from '../db/schema';
 import { AppError } from '../http/errors';
 
+const transferAccount = alias(account, 'transfer_account');
+const otherSide = alias(transaction, 'other_side');
+
+const rateOf = (currency: string, amount: Money, amountBase: Money) =>
+  currency === BASE_CURRENCY ? null : effectiveRate(amount, amountBase);
+
 /** Live transactions matching `where`, newest first (date desc, id desc), as DTOs. */
 export async function loadTransactions(db: Executor, where?: SQL, limit?: number): Promise<TransactionDto[]> {
   const query = db
@@ -15,15 +22,19 @@ export async function loadTransactions(db: Executor, where?: SQL, limit?: number
       currency: account.currency,
       payeeName: payee.name,
       categoryName: category.name,
+      transferAccount: { name: transferAccount.name, currency: transferAccount.currency },
+      other: { amount: otherSide.amount, amountBase: otherSide.amountBase },
     })
     .from(transaction)
     .innerJoin(account, eq(account.id, transaction.accountId))
     .leftJoin(payee, eq(payee.id, transaction.payeeId))
     .leftJoin(category, eq(category.id, transaction.categoryId))
+    .leftJoin(transferAccount, eq(transferAccount.id, transaction.transferAccountId))
+    .leftJoin(otherSide, eq(otherSide.id, transaction.transferTxnId))
     .where(and(isNull(transaction.deletedAt), where))
     .orderBy(desc(transaction.date), desc(transaction.id));
   const rows = await (limit === undefined ? query : query.limit(limit));
-  return rows.map(({ txn, accountName, currency, payeeName, categoryName }) => ({
+  return rows.map(({ txn, accountName, currency, payeeName, categoryName, transferAccount: to, other }) => ({
     id: txn.id,
     accountId: txn.accountId,
     accountName,
@@ -37,13 +48,24 @@ export async function loadTransactions(db: Executor, where?: SQL, limit?: number
     amount: txn.amount,
     amountBase: txn.amountBase,
     fxRate: txn.fxRate,
-    effectiveRate: currency === BASE_CURRENCY ? null : effectiveRate(txn.amount, txn.amountBase),
+    effectiveRate: rateOf(currency, txn.amount, txn.amountBase),
     cleared: txn.cleared,
     approved: txn.approved,
     flag: txn.flag,
     isStartingBalance: txn.isStartingBalance,
     isSplit: txn.isSplit,
-    transfer: null,
+    transfer:
+      txn.transferAccountId && txn.transferTxnId && to && other
+        ? {
+            accountId: txn.transferAccountId,
+            accountName: to.name,
+            transactionId: txn.transferTxnId,
+            splitLineId: null,
+            amount: other.amount,
+            currency: to.currency,
+            effectiveRate: rateOf(to.currency, other.amount, other.amountBase),
+          }
+        : null,
     lines: [],
   }));
 }
diff --git a/src/server/transactions/write.ts b/src/server/transactions/write.ts
index 2c8a861..8f6f4c1 100644
--- a/src/server/transactions/write.ts
+++ b/src/server/transactions/write.ts
@@ -10,16 +10,25 @@ async function rememberCategory(rec: ChangeRecorder, plan: Plan): Promise<void>
   await rec.update(payee, eq(payee.id, payeeId), { lastCategoryId: categoryId });
 }
 
-/** Writes a new transaction from its plan; returns its id. */
+/**
+ * Writes a new transaction from its plan; returns its id. The two sides of a transfer point at each other through
+ * `transfer_txn_id` (inserted first, then linked, because the foreign keys are checked immediately).
+ */
 export async function insertPlan(rec: ChangeRecorder, plan: Plan): Promise<string> {
   const [main] = await rec.insert(transaction, plan.main);
+  const id = main!.id;
+  if (plan.counterpart) {
+    const [other] = await rec.insert(transaction, { ...plan.counterpart, transferTxnId: id });
+    await rec.update(transaction, eq(transaction.id, id), { transferTxnId: other!.id });
+  }
   await rememberCategory(rec, plan);
-  return main!.id;
+  return id;
 }
 
 /**
  * Spec §5.6: a transaction dated after today is stored as a one-time scheduled transaction instead (anchor and next
- * date = its date). P2d's job enters it on that day and computes its PLN amount then.
+ * date = its date). P2d's job enters it on that day and computes its PLN amount then. A transfer keeps the category
+ * as entered; entering it puts the category on the budget side.
  */
 export async function insertSchedule(rec: ChangeRecorder, draft: Draft, plan: Plan): Promise<string> {
   const [schedule] = await rec.insert(scheduledTransaction, {
@@ -31,6 +40,7 @@ export async function insertSchedule(rec: ChangeRecorder, draft: Draft, plan: Pl
     fxRate: plan.main.fxRate,
     fxRateManual: plan.main.fxRateManual,
     flag: draft.flag,
+    transferAccountId: plan.main.transferAccountId,
     frequency: 'once',
     anchorDate: draft.date,
     nextDate: draft.date,
PATCH
```

- [ ] **Step 7: Run the tests and the final checks**

Run: `npx vitest run src/server/transactions/transfer.test.ts src/engine/fx.test.ts src/server/db/schema.test.ts`
Expected: `Tests  35 passed (35)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  41 passed (41)`, `Tests  380 passed (380)`; both checks exit 0.
Run: `npm run db:generate -- --name check`
Expected: `No schema changes, nothing to migrate 😴`.

- [ ] **Step 8: Commit**

```bash
git add src/shared/api/transactions.ts src/server/transactions src/server/db src/engine/fx.test.ts drizzle
git commit -m "feat(server): transfers, including between currencies; link indexes" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
### Task 4: Split transactions with transfer lines

Spec §10 "Splits" and §9. `lines` makes a split: at least 2 lines (at most 100) whose amounts add up to the transaction's amount, and the split itself has no category (`is_split = true`).
- Foreign lines take their base from the split's rate through `splitLineBases`, so the rounding remainder goes to the last line and Σ line bases = the split's base.
- A line's payee is chosen by id. Choosing a transfer payee makes the line a transfer: the counterpart transaction in the target account has `transfer_txn_id` → the split and `transfer_subtxn_id` → the line, and the line's `transfer_txn_id` points back at it. Transfer lines go only to accounts in the same currency (counterpart base = −line base).
- Line categories follow §5.5 for the split's account, with transfer lines placed like transfers: a budget↔tracking line needs a category on its budget side, even when the split is in the tracking account (the category then lands on the counterpart).
- A split can't itself be a transfer.
- Every line error names its field, e.g. `lines.2.categoryId`; 400 errors keep nested paths such as `lines.1.amount` (Task 2).
- A future-dated split is scheduled with its `scheduled_subtransaction` rows.

**Files:**
- Modify: `src/shared/api/transactions.ts`, `src/server/transactions/plan.ts`, `src/server/transactions/write.ts`, `src/server/transactions/transaction-commands.ts`, `src/server/transactions/transaction-queries.ts`
- Test: `src/server/transactions/split.test.ts`

**Interfaces:**
- Consumes: `splitLineBases` (engine); Task 3's `placeTransferCategory`, `assertNotSelf`.
- Produces:
  - `splitLineSchema` / `SplitLineRequest` (`{ amount, payeeId = null, categoryId = null, memo = '' }`), `splitLinesSchema` (2–100 lines); `createTransactionRequestSchema` gains `lines?`, and refuses `categoryId` with `lines` (400 at `categoryId`).
  - `Draft.lines: DraftLine[] | null`; `DraftLine { amount, payeeId, categoryId, memo }`; `LinePlan { amount, amountBase, payeeId, categoryId, memo, transferAccountId, sortOrder, counterpart }`; `Plan.main.isSplit`; `Plan.lines: LinePlan[] | null`. New errors `split_sum` (field `lines`), `split_transfer`, `split_transfer_currency`.
  - `insertLines(rec, txnId, lines)`; `insertSchedule` writes `isSplit` and the schedule lines.
  - `TransactionDto.lines` is filled; the counterpart of a split line shows `transfer.splitLineId` and the line's amount.

- [ ] **Step 1: Write the failing tests**

Create `src/server/transactions/split.test.ts`:

```ts
import { asc, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionDto } from '../../shared/api/transactions';
import { systemCategoryId, systemPayeeId } from '../db/lookups';
import { ledgerLine, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import {
  createAccount,
  createCategory,
  createGroup,
  createPayee,
  createTransaction,
  ledgerLines,
} from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const post = (body: object) => ctx.client.post('/api/transactions', body);
const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  const household = await createCategory(ctx.client, food.id, 'Household');
  return { checking, savings, groceries, household };
}

describe('splits', () => {
  it('creates a split whose lines the budget sees instead of the split itself', async () => {
    const { checking, groceries, household } = await setUp();
    const drugstore = await createPayee(ctx.client, 'Rossmann');
    const before = await snapshot(t.db);

    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeName: 'Biedronka',
      amount: -10_000,
      lines: [
        { amount: -6_000, categoryId: groceries.id, memo: ' food ' },
        { amount: -4_000, categoryId: household.id, payeeId: drugstore.id },
      ],
    });
    expect(split).toMatchObject({ isSplit: true, categoryId: null, amount: -10_000, amountBase: -10_000 });
    expect(split.lines).toEqual([
      {
        id: expect.any(String),
        amount: -6_000,
        amountBase: -6_000,
        payeeId: null,
        payeeName: null,
        categoryId: groceries.id,
        categoryName: 'Groceries',
        memo: 'food',
        transfer: null,
      },
      {
        id: expect.any(String),
        amount: -4_000,
        amountBase: -4_000,
        payeeId: drugstore.id,
        payeeName: 'Rossmann',
        categoryId: household.id,
        categoryName: 'Household',
        memo: null,
        transfer: null,
      },
    ]);
    const rows = await t.db.select().from(subtransaction).orderBy(asc(subtransaction.sortOrder));
    expect(rows.map((r) => [r.txnId, r.sortOrder, r.amount])).toEqual([
      [split.id, 0, -6_000],
      [split.id, 1, -4_000],
    ]);
    const lines = await ledgerLines(t.db, eq(ledgerLine.txnId, split.id));
    expect(lines.map((l) => [l.subtxnId, l.categoryId, l.amountBase])).toEqual([
      [split.lines[0]!.id, groceries.id, -6_000],
      [split.lines[1]!.id, household.id, -4_000],
    ]);
    const after = await snapshot(t.db);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('gives the rounding remainder of a foreign split to its last line', async () => {
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    const split = await createTransaction(ctx.client, {
      accountId: euro.id,
      amount: -1_000,
      fxRate: '4.3333',
      lines: [{ amount: -500 }, { amount: -500 }],
    });
    // −1 000 × 4.3333 = −4 333; each line rounds to −2 167, so the last one takes −2 166.
    expect([split.amountBase, ...split.lines.map((l) => l.amountBase)]).toEqual([-4_333, -2_167, -2_166]);
    const lines = await ledgerLines(t.db, eq(ledgerLine.txnId, split.id));
    expect(lines.reduce((sum, l) => sum + l.amountBase, 0)).toBe(-4_333);
  });

  it('turns a transfer line into a counterpart transaction in the target account', async () => {
    const { checking, savings, groceries } = await setUp();
    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -50_000,
      lines: [
        { amount: -30_000, categoryId: groceries.id },
        { amount: -20_000, payeeId: savings.transferPayeeId, memo: 'save the rest' },
      ],
    });
    const transferLine = split.lines[1]!;
    expect(transferLine.transfer).toEqual({
      accountId: savings.id,
      accountName: 'Savings',
      transactionId: expect.any(String),
    });
    const counterpart = await get(transferLine.transfer!.transactionId);
    expect(counterpart).toMatchObject({
      accountId: savings.id,
      payeeName: 'Transfer : mBank',
      categoryId: null,
      memo: 'save the rest',
      amount: 20_000,
      amountBase: 20_000,
      cleared: 'uncleared',
      isSplit: false,
      transfer: {
        accountId: checking.id,
        transactionId: split.id,
        splitLineId: transferLine.id,
        amount: -20_000,
        currency: 'PLN',
      },
    });
    const [row] = await t.db.select().from(transaction).where(eq(transaction.id, counterpart.id));
    expect(row).toMatchObject({
      transferTxnId: split.id,
      transferSubtxnId: transferLine.id,
      transferAccountId: checking.id,
    });
    const lines = await ledgerLines(t.db, inArray(ledgerLine.txnId, [split.id, counterpart.id]));
    expect(lines.map((l) => [l.accountId, l.categoryId, l.amountBase, l.isTransfer, l.counterAccountClass])).toEqual([
      [checking.id, groceries.id, -30_000, false, null],
      [checking.id, null, -20_000, true, 'cash'],
      [savings.id, null, 20_000, true, 'cash'],
    ]);
  });

  it('puts the category of a budget↔tracking transfer line on the budget side', async () => {
    const { checking, groceries } = await setUp();
    const loan = await createAccount(ctx.client, {
      name: 'Car',
      type: 'auto_loan',
      minPayment: 1,
      createPairedCategory: true,
    });
    const rta = await systemCategoryId(t.db, 'rta');
    const lines = (categoryId: string | null) => [
      { amount: -1_000, categoryId: groceries.id },
      { amount: -5_000, payeeId: loan.transferPayeeId, categoryId },
    ];

    expect(await json(await post({ accountId: checking.id, amount: -6_000, lines: lines(null) }))).toMatchObject({
      status: 422,
      body: { code: 'category_required', fieldErrors: { 'lines.1.categoryId': [expect.any(String)] } },
    });
    const payment = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -6_000,
      lines: lines(loan.pairedCategoryId),
    });
    expect(payment.lines[1]!.categoryId).toBe(loan.pairedCategoryId);
    // A split in the tracking account: its transfer line's category goes to the budget-side counterpart.
    const payout = await createTransaction(ctx.client, {
      accountId: loan.id,
      amount: -3_000,
      lines: [{ amount: -1_000 }, { amount: -2_000, payeeId: checking.transferPayeeId, categoryId: rta }],
    });
    expect(payout.lines.map((l) => l.categoryId)).toEqual([null, null]);
    expect((await get(payout.lines[1]!.transfer!.transactionId)).categoryId).toBe(rta);
  });

  it('reports invalid lines with the path of the field', async () => {
    const { checking, savings, groceries } = await setUp();
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const loan = await createAccount(ctx.client, { name: 'Car', type: 'auto_loan' });
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    const split = (lines: object[], extra: object = {}) => ({ accountId: checking.id, amount: -300, lines, ...extra });
    const ok = { amount: -100 };
    const error = async (body: object) =>
      (await json<{ code: string; fieldErrors: Record<string, string[]> }>(await post(body))).body;

    expect((await error(split([{ amount: -300 }]))).fieldErrors).toEqual({
      lines: ['A split needs at least two lines.'],
    });
    expect((await error(split([ok, { amount: 1.5 }]))).fieldErrors).toEqual({
      'lines.1.amount': ['Enter a whole amount in minor units.'],
    });
    expect((await error(split([ok, ok], { categoryId: groceries.id }))).fieldErrors).toEqual({
      categoryId: ["A split's categories go on its lines."],
    });
    expect(await error(split([ok, ok]))).toEqual({
      code: 'split_sum',
      message: 'The lines must add up to the transaction amount.',
      fieldErrors: { lines: ['The lines must add up to the transaction amount.'] },
    });
    const third = (line: object) => split([ok, ok, { amount: -100, ...line }]);
    const fieldOf = async (body: object) => {
      const { code, fieldErrors } = await error(body);
      return [code, Object.keys(fieldErrors)];
    };
    expect(await fieldOf(third({ categoryId: card.paymentCategoryId }))).toEqual([
      'card_payment_category',
      ['lines.2.categoryId'],
    ]);
    expect(await fieldOf(third({ payeeId: crypto.randomUUID() }))).toEqual(['invalid_payee', ['lines.2.payeeId']]);
    expect(await fieldOf(third({ payeeId: await systemPayeeId(t.db, 'starting_balance') }))).toEqual([
      'system_payee',
      ['lines.2.payeeId'],
    ]);
    expect(await fieldOf(third({ payeeId: checking.transferPayeeId }))).toEqual([
      'transfer_to_self',
      ['lines.2.payeeId'],
    ]);
    expect(await fieldOf(third({ payeeId: euro.transferPayeeId }))).toEqual([
      'split_transfer_currency',
      ['lines.2.payeeId'],
    ]);
    expect(await fieldOf(third({ payeeId: savings.transferPayeeId, categoryId: groceries.id }))).toEqual([
      'category_not_allowed',
      ['lines.2.categoryId'],
    ]);
    expect(await fieldOf({ ...third({ categoryId: groceries.id }), accountId: loan.id })).toEqual([
      'category_not_allowed',
      ['lines.2.categoryId'],
    ]);
    expect(await fieldOf(split([ok, ok, ok], { payeeId: savings.transferPayeeId }))).toEqual([
      'split_transfer',
      ['payeeId'],
    ]);
  });

  it('schedules a future split with its lines', async () => {
    const { checking, savings, groceries } = await setUp();
    const res = await json<{ kind: string; scheduledId: string }>(
      await post({
        accountId: checking.id,
        date: '2026-12-24',
        amount: -3_000,
        lines: [
          { amount: -1_000, categoryId: groceries.id },
          { amount: -2_000, payeeId: savings.transferPayeeId, memo: 'gift fund' },
        ],
      }),
    );
    expect(res.body.kind).toBe('scheduled');
    expect(await t.db.select().from(scheduledTransaction)).toMatchObject([{ isSplit: true, amount: -3_000 }]);
    const rows = await t.db.select().from(scheduledSubtransaction).orderBy(asc(scheduledSubtransaction.sortOrder));
    expect(rows.map((r) => [r.scheduledId, r.amount, r.categoryId, r.payeeId, r.transferAccountId, r.memo])).toEqual([
      [res.body.scheduledId, -1_000, groceries.id, null, null, null],
      [res.body.scheduledId, -2_000, null, savings.transferPayeeId, savings.id, 'gift fund'],
    ]);
    expect(await t.db.select().from(transaction).where(eq(transaction.date, '2026-12-24'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/transactions/split.test.ts`
Expected: FAIL, `Tests  6 failed (6)`: zod strips the unknown `lines` key, so splits are booked as plain transactions (e.g. `expected [ -4333 ] to deeply equal [ -4333, -2167, -2166 ]`).

- [ ] **Step 3: Accept split lines**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/transaction-commands.ts b/src/server/transactions/transaction-commands.ts
index e91b705..034f54d 100644
--- a/src/server/transactions/transaction-commands.ts
+++ b/src/server/transactions/transaction-commands.ts
@@ -44,6 +44,7 @@ export async function createTransaction(
     cleared: input.cleared,
     approved: true,
     flag: input.flag,
+    lines: input.lines?.map((line) => ({ ...line, memo: line.memo || null })) ?? null,
   };
   const plan = await planTransaction(rec.tx, draft);
   const payeeName = plan.payee?.name ?? null;
diff --git a/src/shared/api/transactions.ts b/src/shared/api/transactions.ts
index 380bd5b..5058526 100644
--- a/src/shared/api/transactions.ts
+++ b/src/shared/api/transactions.ts
@@ -18,6 +18,25 @@ export const transactionDateSchema = isoDateSchema.refine((date) => date >= '197
   when: (payload) => payload.issues.length === 0,
 });
 
+/**
+ * A split line (spec §10 "Splits"). Choosing a transfer payee makes the line a transfer to that account (same
+ * currency only); the line's category follows the same rules as a transaction in the split's account.
+ */
+export const splitLineSchema = z.object({
+  amount: moneySchema,
+  payeeId: idSchema.nullable().default(null),
+  categoryId: idSchema.nullable().default(null),
+  memo: memoSchema.default(''),
+});
+
+export type SplitLineRequest = z.infer<typeof splitLineSchema>;
+
+/** At least two lines; their amounts add up to the transaction's amount. */
+export const splitLinesSchema = z
+  .array(splitLineSchema)
+  .min(2, 'A split needs at least two lines.')
+  .max(100, 'Use at most 100 lines.');
+
 /**
  * POST /api/transactions. `amount` is in the account's currency (minor units, signed: + inflow, − outflow).
  * Choose an existing payee by `payeeId` or name one with `payeeName` (reused if a payee with that name exists,
@@ -25,7 +44,7 @@ export const transactionDateSchema = isoDateSchema.refine((date) => date >= '197
  *
  * Choosing an account's "Transfer : <name>" payee makes a transfer (spec §10): the other side is created in that
  * account. A transfer between a budget and a tracking account needs `categoryId`, which is stored on the budget side;
- * other transfers take none (spec §5.5).
+ * other transfers take none (spec §5.5). `lines` makes a split, whose own category stays empty.
  */
 export const createTransactionRequestSchema = z
   .object({
@@ -47,10 +66,15 @@ export const createTransactionRequestSchema = z
     fxRate: fxRateSchema.optional(),
     cleared: userClearedSchema.default('uncleared'),
     flag: flagSchema.nullable().default(null),
+    lines: splitLinesSchema.optional(),
   })
   .refine((body) => body.payeeId === undefined || body.payeeName === undefined, {
     path: ['payeeName'],
     message: 'Choose a payee or type a new name, not both.',
+  })
+  .refine((body) => body.lines === undefined || body.categoryId === null, {
+    path: ['categoryId'],
+    message: "A split's categories go on its lines.",
   });
 
 export type CreateTransactionRequest = z.infer<typeof createTransactionRequestSchema>;
PATCH
```

- [ ] **Step 4: Plan the lines**

Replace the whole of `src/server/transactions/plan.ts`:

```ts
import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { ClearedStatus, FlagColor } from '../../shared/api/transactions';
import { type IsoDate, type Money, splitLineBases, transferBases } from '../../engine';
import type { Executor } from '../db/client';
import { DomainError } from '../http/errors';
import {
  type AccountInfo,
  assertNotSelf,
  assertNotSystemPayee,
  assertOpen,
  assertRateUsed,
  assertUsableCategory,
  bookedBase,
  categoryNotAllowed,
  onBudget,
  type PayeeInfo,
  placeTransferCategory,
  rateFor,
  type Rates,
  requireAccount,
  requirePayee,
  TRACKING_NO_CATEGORY,
} from './rules';

/** A transaction as the user describes it, before the rules of spec §5.5 and §9 turn it into rows. */
export interface Draft {
  accountId: string;
  date: IsoDate;
  payeeId: string | null;
  /** For a transfer between a budget and a tracking account: the budget side's category. */
  categoryId: string | null;
  memo: string | null;
  amount: Money;
  /** Transfers between currencies: the other side's native amount. */
  transferAmount: Money | null;
  /** The rate sent with the request (null = none sent). */
  fxRate: string | null;
  cleared: ClearedStatus;
  approved: boolean;
  flag: FlagColor | null;
  /** A split's lines (null = not a split). */
  lines: DraftLine[] | null;
}

export interface DraftLine {
  amount: Money;
  payeeId: string | null;
  /** For a transfer line between a budget and a tracking account: the budget side's category. */
  categoryId: string | null;
  memo: string | null;
}

/** The columns of one `transaction` row that a plan decides. */
export interface RowPlan {
  accountId: string;
  date: IsoDate;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  amount: Money;
  amountBase: Money;
  fxRate: string | null;
  fxRateManual: boolean;
  transferAccountId: string | null;
}

/** One `subtransaction` row, with the counterpart transaction of a transfer line. */
export interface LinePlan {
  amount: Money;
  amountBase: Money;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  transferAccountId: string | null;
  sortOrder: number;
  counterpart: RowPlan | null;
}

export interface Plan {
  main: RowPlan & { cleared: ClearedStatus; approved: boolean; flag: FlagColor | null; isSplit: boolean };
  account: AccountInfo;
  payee: PayeeInfo | null;
  /** The other side of a transfer. */
  counterpart: RowPlan | null;
  /** The other account of a transfer. */
  transfer: AccountInfo | null;
  /** A split's lines in order (null = not a split). */
  lines: LinePlan[] | null;
  /** Spec §10: saving a categorized, non-transfer transaction makes its category the payee's default. */
  payeeDefault: { payeeId: string; categoryId: string } | null;
}

const rateColumns = (rate: string | null) => ({ fxRate: rate, fxRateManual: rate !== null });

/**
 * Spec §9: both sides of a transfer net to zero in PLN. Same-currency transfers mirror the amount; transfers between
 * currencies take both native amounts. The sending side (the outflow; this side for 0) decides the base amounts:
 * a PLN side gives them directly, otherwise the sending currency's rate converts.
 */
function transferSides(main: AccountInfo, other: AccountInfo, draft: Draft, rates: Rates) {
  let otherAmount: Money;
  if (main.currency === other.currency) {
    if (draft.transferAmount !== null) {
      throw new DomainError(
        'transfer_amount_not_allowed',
        'Both accounts use the same currency, so the other side mirrors this amount.',
        'transferAmount',
      );
    }
    otherAmount = -draft.amount;
  } else {
    if (draft.transferAmount === null) {
      throw new DomainError(
        'transfer_amount_required',
        `Enter the amount in ${other.currency} that "${other.name}" receives or sends.`,
        'transferAmount',
      );
    }
    if (draft.amount === 0 || Math.sign(draft.transferAmount) !== -Math.sign(draft.amount)) {
      throw new DomainError(
        'transfer_amount_sign',
        'The two sides of a transfer need opposite, non-zero amounts.',
        'transferAmount',
      );
    }
    otherAmount = draft.transferAmount;
  }
  const here = { amount: draft.amount, currency: main.currency };
  const there = { amount: otherAmount, currency: other.currency };
  const mainSends = draft.amount <= 0;
  const from = mainSends ? here : there;
  const to = mainSends ? there : here;
  const rate = from.currency !== BASE_CURRENCY && to.currency !== BASE_CURRENCY ? rateFor(rates, from.currency) : null;
  const { fromBase, toBase } = transferBases(BASE_CURRENCY, { ...from, rate }, { ...to, rate: null });
  if (!Number.isSafeInteger(fromBase)) throw new DomainError('amount_too_large', 'That amount is too large.', 'amount');
  return mainSends
    ? { mainBase: fromBase, mainRate: rate, otherAmount, otherBase: toBase, otherRate: null }
    : { mainBase: toBase, mainRate: null, otherAmount, otherBase: fromBase, otherRate: rate };
}

/** Spec §10 "Splits" and §9: lines add up to the amount; foreign lines get their base from the split's rate. */
async function planLines(
  db: Executor,
  main: AccountInfo,
  draft: Draft & { lines: DraftLine[] },
  rates: Rates,
): Promise<{ amountBase: Money; fxRate: string | null; lines: LinePlan[] }> {
  const total = draft.lines.reduce((sum, line) => sum + line.amount, 0);
  if (total !== draft.amount) {
    throw new DomainError('split_sum', 'The lines must add up to the transaction amount.', 'lines');
  }
  const { amountBase, fxRate } = bookedBase(main.currency, draft.amount, rates);
  const amounts = draft.lines.map((line) => line.amount);
  const bases = fxRate === null ? amounts : splitLineBases(amountBase, amounts, fxRate);

  const lines: LinePlan[] = [];
  for (const [index, line] of draft.lines.entries()) {
    const field = (name: string) => `lines.${index}.${name}`;
    const linePayee = line.payeeId === null ? null : await requirePayee(db, line.payeeId, field('payeeId'));
    if (linePayee) assertNotSystemPayee(linePayee, field('payeeId'));
    const lineBase = bases[index]!;
    const base = {
      amount: line.amount,
      amountBase: lineBase,
      payeeId: line.payeeId,
      memo: line.memo,
      sortOrder: index,
    };
    if (!linePayee?.transferAccountId) {
      if (line.categoryId !== null) {
        if (!onBudget(main)) throw categoryNotAllowed(TRACKING_NO_CATEGORY, field('categoryId'));
        await assertUsableCategory(db, line.categoryId, field('categoryId'));
      }
      lines.push({ ...base, categoryId: line.categoryId, transferAccountId: null, counterpart: null });
      continue;
    }
    const other = await requireAccount(db, linePayee.transferAccountId, field('payeeId'));
    assertNotSelf(main, other, field('payeeId'));
    if (other.currency !== main.currency) {
      throw new DomainError(
        'split_transfer_currency',
        'A split line can only transfer to an account in the same currency.',
        field('payeeId'),
      );
    }
    assertOpen(other, field('payeeId'));
    const category = await placeTransferCategory(db, main, other, line.categoryId, field('categoryId'));
    lines.push({
      ...base,
      categoryId: category.here,
      transferAccountId: other.id,
      counterpart: {
        accountId: other.id,
        date: draft.date,
        payeeId: main.transferPayeeId,
        categoryId: category.there,
        memo: line.memo,
        amount: -line.amount,
        amountBase: -lineBase,
        ...rateColumns(null),
        transferAccountId: main.id,
      },
    });
  }
  return { amountBase, fxRate, lines };
}

/** Validates a draft against spec §5.5 and §9 and computes the rows to write. */
export async function planTransaction(db: Executor, draft: Draft): Promise<Plan> {
  const main = await requireAccount(db, draft.accountId, 'accountId');
  assertOpen(main, 'accountId');
  const payee = draft.payeeId === null ? null : await requirePayee(db, draft.payeeId, 'payeeId');
  if (payee) assertNotSystemPayee(payee, 'payeeId');
  const rates: Rates = { input: draft.fxRate, stored: new Map(), used: false };
  const row = {
    accountId: draft.accountId,
    date: draft.date,
    payeeId: draft.payeeId,
    memo: draft.memo,
    amount: draft.amount,
  };
  const status = { cleared: draft.cleared, approved: draft.approved, flag: draft.flag };

  if (draft.lines !== null) {
    if (payee?.transferAccountId) {
      throw new DomainError(
        'split_transfer',
        "A split itself can't be a transfer: make one of its lines a transfer instead.",
        'payeeId',
      );
    }
    if (draft.categoryId !== null) throw categoryNotAllowed("A split's categories go on its lines.", 'categoryId');
    if (draft.transferAmount !== null) {
      throw new DomainError('transfer_amount_not_allowed', 'Only transfers take a second amount.', 'transferAmount');
    }
    const split = await planLines(db, main, { ...draft, lines: draft.lines }, rates);
    assertRateUsed(rates);
    return {
      main: {
        ...row,
        ...status,
        categoryId: null,
        amountBase: split.amountBase,
        ...rateColumns(split.fxRate),
        transferAccountId: null,
        isSplit: true,
      },
      account: main,
      payee,
      counterpart: null,
      transfer: null,
      lines: split.lines,
      payeeDefault: null,
    };
  }

  if (payee?.transferAccountId) {
    const other = await requireAccount(db, payee.transferAccountId, 'payeeId');
    assertNotSelf(main, other, 'payeeId');
    assertOpen(other, 'payeeId');
    const category = await placeTransferCategory(db, main, other, draft.categoryId, 'categoryId');
    const sides = transferSides(main, other, draft, rates);
    assertRateUsed(rates);
    return {
      main: {
        ...row,
        ...status,
        categoryId: category.here,
        amountBase: sides.mainBase,
        ...rateColumns(sides.mainRate),
        transferAccountId: other.id,
        isSplit: false,
      },
      account: main,
      payee,
      counterpart: {
        accountId: other.id,
        date: draft.date,
        payeeId: main.transferPayeeId,
        categoryId: category.there,
        memo: draft.memo,
        amount: sides.otherAmount,
        amountBase: sides.otherBase,
        ...rateColumns(sides.otherRate),
        transferAccountId: main.id,
      },
      transfer: other,
      lines: null,
      payeeDefault: null,
    };
  }

  if (draft.transferAmount !== null) {
    throw new DomainError('transfer_amount_not_allowed', 'Only transfers take a second amount.', 'transferAmount');
  }
  if (draft.categoryId !== null) {
    if (!onBudget(main)) throw categoryNotAllowed(TRACKING_NO_CATEGORY, 'categoryId');
    await assertUsableCategory(db, draft.categoryId, 'categoryId');
  }
  const { amountBase, fxRate } = bookedBase(main.currency, draft.amount, rates);
  assertRateUsed(rates);
  return {
    main: {
      ...row,
      ...status,
      categoryId: draft.categoryId,
      amountBase,
      ...rateColumns(fxRate),
      transferAccountId: null,
      isSplit: false,
    },
    account: main,
    payee,
    counterpart: null,
    transfer: null,
    lines: null,
    payeeDefault:
      payee?.kind === 'user' && draft.categoryId !== null ? { payeeId: payee.id, categoryId: draft.categoryId } : null,
  };
}
```

- [ ] **Step 5: Write the lines and their counterparts**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/write.ts b/src/server/transactions/write.ts
index 8f6f4c1..da5c911 100644
--- a/src/server/transactions/write.ts
+++ b/src/server/transactions/write.ts
@@ -1,7 +1,7 @@
 import { eq } from 'drizzle-orm';
 import type { ChangeRecorder } from '../commands/recorder';
-import { payee, scheduledTransaction, transaction } from '../db/schema';
-import type { Draft, Plan } from './plan';
+import { payee, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
+import type { Draft, LinePlan, Plan } from './plan';
 
 /** Spec §10: the transaction sheet pre-fills the category from the payee. */
 async function rememberCategory(rec: ChangeRecorder, plan: Plan): Promise<void> {
@@ -10,6 +10,19 @@ async function rememberCategory(rec: ChangeRecorder, plan: Plan): Promise<void>
   await rec.update(payee, eq(payee.id, payeeId), { lastCategoryId: categoryId });
 }
 
+/**
+ * Spec §10 "Splits": a transfer line's counterpart points at the split (`transfer_txn_id`) and the line
+ * (`transfer_subtxn_id`); the line points back at it.
+ */
+export async function insertLines(rec: ChangeRecorder, txnId: string, lines: LinePlan[]): Promise<void> {
+  for (const { counterpart, ...line } of lines) {
+    const [row] = await rec.insert(subtransaction, { ...line, txnId });
+    if (!counterpart) continue;
+    const [other] = await rec.insert(transaction, { ...counterpart, transferTxnId: txnId, transferSubtxnId: row!.id });
+    await rec.update(subtransaction, eq(subtransaction.id, row!.id), { transferTxnId: other!.id });
+  }
+}
+
 /**
  * Writes a new transaction from its plan; returns its id. The two sides of a transfer point at each other through
  * `transfer_txn_id` (inserted first, then linked, because the foreign keys are checked immediately).
@@ -21,6 +34,7 @@ export async function insertPlan(rec: ChangeRecorder, plan: Plan): Promise<strin
     const [other] = await rec.insert(transaction, { ...plan.counterpart, transferTxnId: id });
     await rec.update(transaction, eq(transaction.id, id), { transferTxnId: other!.id });
   }
+  if (plan.lines) await insertLines(rec, id, plan.lines);
   await rememberCategory(rec, plan);
   return id;
 }
@@ -41,10 +55,19 @@ export async function insertSchedule(rec: ChangeRecorder, draft: Draft, plan: Pl
     fxRateManual: plan.main.fxRateManual,
     flag: draft.flag,
     transferAccountId: plan.main.transferAccountId,
+    isSplit: plan.main.isSplit,
     frequency: 'once',
     anchorDate: draft.date,
     nextDate: draft.date,
   });
+  for (const [index, line] of (draft.lines ?? []).entries()) {
+    await rec.insert(scheduledSubtransaction, {
+      ...line,
+      scheduledId: schedule!.id,
+      transferAccountId: plan.lines![index]!.transferAccountId,
+      sortOrder: index,
+    });
+  }
   await rememberCategory(rec, plan);
   return schedule!.id;
 }
PATCH
```

- [ ] **Step 6: Show the lines**

Replace the whole of `src/server/transactions/transaction-queries.ts`:

```ts
import { and, asc, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { SplitLineDto, TransactionDto } from '../../shared/api/transactions';
import { effectiveRate, type Money } from '../../engine';
import type { Executor } from '../db/client';
import { account, category, payee, subtransaction, transaction } from '../db/schema';
import { AppError } from '../http/errors';

const transferAccount = alias(account, 'transfer_account');
const otherSide = alias(transaction, 'other_side');
const otherLine = alias(subtransaction, 'other_line');

const rateOf = (currency: string, amount: Money, amountBase: Money) =>
  currency === BASE_CURRENCY ? null : effectiveRate(amount, amountBase);

/** The live lines of the given split transactions, in order. */
async function linesOf(db: Executor, txnIds: string[]): Promise<Map<string, SplitLineDto[]>> {
  const byTxn = new Map<string, SplitLineDto[]>();
  if (txnIds.length === 0) return byTxn;
  const rows = await db
    .select({
      line: subtransaction,
      payeeName: payee.name,
      categoryName: category.name,
      accountName: transferAccount.name,
    })
    .from(subtransaction)
    .leftJoin(payee, eq(payee.id, subtransaction.payeeId))
    .leftJoin(category, eq(category.id, subtransaction.categoryId))
    .leftJoin(transferAccount, eq(transferAccount.id, subtransaction.transferAccountId))
    .where(and(inArray(subtransaction.txnId, txnIds), isNull(subtransaction.deletedAt)))
    .orderBy(asc(subtransaction.sortOrder), asc(subtransaction.id));
  for (const { line, payeeName, categoryName, accountName } of rows) {
    const list = byTxn.get(line.txnId) ?? [];
    list.push({
      id: line.id,
      amount: line.amount,
      amountBase: line.amountBase,
      payeeId: line.payeeId,
      payeeName,
      categoryId: line.categoryId,
      categoryName,
      memo: line.memo,
      transfer:
        line.transferAccountId && line.transferTxnId && accountName !== null
          ? { accountId: line.transferAccountId, accountName, transactionId: line.transferTxnId }
          : null,
    });
    byTxn.set(line.txnId, list);
  }
  return byTxn;
}

/** Live transactions matching `where`, newest first (date desc, id desc), as DTOs. */
export async function loadTransactions(db: Executor, where?: SQL, limit?: number): Promise<TransactionDto[]> {
  const query = db
    .select({
      txn: transaction,
      accountName: account.name,
      currency: account.currency,
      payeeName: payee.name,
      categoryName: category.name,
      transferAccount: { name: transferAccount.name, currency: transferAccount.currency },
      other: { amount: otherSide.amount, amountBase: otherSide.amountBase },
      line: { amount: otherLine.amount, amountBase: otherLine.amountBase },
    })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .leftJoin(payee, eq(payee.id, transaction.payeeId))
    .leftJoin(category, eq(category.id, transaction.categoryId))
    .leftJoin(transferAccount, eq(transferAccount.id, transaction.transferAccountId))
    .leftJoin(otherSide, eq(otherSide.id, transaction.transferTxnId))
    .leftJoin(otherLine, eq(otherLine.id, transaction.transferSubtxnId))
    .where(and(isNull(transaction.deletedAt), where))
    .orderBy(desc(transaction.date), desc(transaction.id));
  const rows = await (limit === undefined ? query : query.limit(limit));
  const lines = await linesOf(db, rows.filter((r) => r.txn.isSplit).map((r) => r.txn.id));
  return rows.map(({ txn, accountName, currency, payeeName, categoryName, transferAccount: to, ...sides }) => {
    // The counterpart of a split line faces that line, not the whole split.
    const other = sides.line ?? sides.other;
    return {
      id: txn.id,
      accountId: txn.accountId,
      accountName,
      currency,
      date: txn.date,
      payeeId: txn.payeeId,
      payeeName,
      categoryId: txn.categoryId,
      categoryName,
      memo: txn.memo,
      amount: txn.amount,
      amountBase: txn.amountBase,
      fxRate: txn.fxRate,
      effectiveRate: rateOf(currency, txn.amount, txn.amountBase),
      cleared: txn.cleared,
      approved: txn.approved,
      flag: txn.flag,
      isStartingBalance: txn.isStartingBalance,
      isSplit: txn.isSplit,
      transfer:
        txn.transferAccountId && txn.transferTxnId && to && other
          ? {
              accountId: txn.transferAccountId,
              accountName: to.name,
              transactionId: txn.transferTxnId,
              splitLineId: txn.transferSubtxnId,
              amount: other.amount,
              currency: to.currency,
              effectiveRate: rateOf(to.currency, other.amount, other.amountBase),
            }
          : null,
      lines: lines.get(txn.id) ?? [],
    };
  });
}

export async function getTransaction(db: Executor, id: string): Promise<TransactionDto> {
  const [found] = await loadTransactions(db, eq(transaction.id, id));
  if (!found) throw new AppError(404, 'not_found', 'Transaction not found.');
  return found;
}
```

- [ ] **Step 7: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/transactions/split.test.ts`
Expected: `Tests  6 passed (6)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  42 passed (42)`, `Tests  386 passed (386)`; both checks exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/shared/api/transactions.ts src/server/transactions
git commit -m "feat(server): split transactions with transfer lines" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Edit transactions and transfers

Spec §10 "Creating and editing" and "Transfers". `PATCH /api/transactions/:id` changes any of `date, payeeId | payeeName, categoryId, memo, amount, transferAmount, fxRate, cleared, approved, flag`; omitted fields stay. An edit runs every rule of a new transaction. The command:
1. loads the transaction with its rows (`loadAggregate`: the other side of a transfer, the live split lines with the counterparts of transfer lines, or for a line's counterpart the split that owns it);
2. turns them into the saved `Draft` (`draftOf`) and applies the request;
3. plans it again. Edits may keep what a new transaction couldn't use: the stored rate (by currency), the other side's amount of a transfer between currencies (spec §10: it changes only when sent), its system payee, and the accounts it already has rows in even if they are closed;
4. brings the rows in line (`syncPlan`).

Details:
- On a transfer, date, amount and memo are mirrored to the other side, which also follows category placement; cleared, approved and flag stay per side.
- Changing the payee can turn a transaction into a transfer, retarget it, or end it. The old other side is then soft-deleted and a new one created. A new payee keeps this row's own category, not the other side's.
- A split's date (and later its account) reaches the counterparts of its lines, which are updated in place, so they keep their cleared state. A line's counterpart itself takes only memo (mirrored to the line), cleared, approved and flag; anything else is 422 `split_counterpart`.
- No edit moves a transaction past today (422 `date_in_future`). A starting balance keeps its payee and category (422 `starting_balance`).
- The payee's remembered category changes only when the payee or the category does.
- A request that changes nothing records no undo entry.

Line replacement, account moves and reconciled confirmation follow in Task 6.

**Files:**
- Create: `src/server/transactions/aggregate.ts`
- Modify: `src/shared/api/transactions.ts`, `src/server/transactions/plan.ts`, `src/server/transactions/write.ts`, `src/server/transactions/transaction-commands.ts`, `src/server/transactions/transaction-routes.ts`
- Test: `src/server/transactions/edit-transaction.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `updateTransactionRequestSchema` / `UpdateTransactionRequest`.
  - `src/server/transactions/aggregate.ts`:
    - `Aggregate { main, counterpart, lines: { line, counterpart }[], owner: { parent, line } | null }`
    - `loadAggregate(db, id): Promise<Aggregate>` (404 `Transaction not found.`)
    - `draftOf(agg): Draft`
    - `storedRates(db, agg): Promise<Map<currency, rate>>`
    - `accountsOf(agg): Set<string>`
  - `PlanContext { existing?: { payeeId, rates, counterpart: { accountId, amount } | null, accountIds } }`; `planTransaction(db, draft, context = {})`.
  - `write.ts`: `rememberCategory(rec, plan)`, `softDelete(rec, ids, now)`, `syncPlan(rec, agg, plan, now)`.
  - `transaction-commands.ts`: `EditContext { today, now }`, `editLabel` (`Edit transaction "P"`), `updateTransaction(rec, id, patch, context): Promise<{ payeeName }>`.
  - Route `PATCH /:id` → 200 `TransactionDto`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/transactions/edit-transaction.test.ts`:

```ts
import { count, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionDto } from '../../shared/api/transactions';
import { ledgerLine, payee, subtransaction, transaction, undoEntry } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import {
  createAccount,
  createCategory,
  createGroup,
  createPayee,
  createTransaction,
  ledgerLines,
} from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/transactions/${id}`, body);
const edit = async (id: string, body: object) => {
  const res = await json<TransactionDto>(await patch(id, body));
  if (res.status !== 200) throw new Error(`edit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;
const rowOf = async (id: string) => (await t.db.select().from(transaction).where(eq(transaction.id, id)))[0]!;
const undoCount = async () => (await t.db.select({ n: count() }).from(undoEntry))[0]!.n;

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  const household = await createCategory(ctx.client, food.id, 'Household');
  return { checking, savings, groceries, household };
}

describe('PATCH /api/transactions/:id', () => {
  it('edits a plain transaction as one undoable command, and records nothing for a no-op', async () => {
    const { checking, groceries, household } = await setUp();
    const txn = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeName: 'Biedronka',
      categoryId: groceries.id,
      amount: -100,
    });
    const before = await snapshot(t.db);

    const edited = await edit(txn.id, {
      date: '2026-11-18',
      payeeName: 'Lidl',
      categoryId: household.id,
      memo: ' cheaper ',
      amount: -150,
      cleared: 'cleared',
      approved: false,
      flag: 'red',
    });
    expect(edited).toMatchObject({
      date: '2026-11-18',
      payeeName: 'Lidl',
      categoryId: household.id,
      memo: 'cheaper',
      amount: -150,
      amountBase: -150,
      cleared: 'cleared',
      approved: false,
      flag: 'red',
    });
    const [lidl] = await t.db.select().from(payee).where(eq(payee.name, 'Lidl'));
    expect(lidl!.lastCategoryId).toBe(household.id);
    const lines = await ledgerLines(t.db, eq(ledgerLine.txnId, txn.id));
    expect(lines.map((l) => [l.date, l.categoryId, l.amountBase])).toEqual([['2026-11-18', household.id, -150]]);
    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Edit transaction "Lidl"' },
    });

    const entries = await undoCount();
    expect(await edit(txn.id, { memo: 'cheaper', flag: 'red' })).toEqual(edited);
    expect(await undoCount()).toBe(entries);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('updates the payee’s default category only when the payee or the category changes', async () => {
    const { checking, groceries, household } = await setUp();
    const shop = await createPayee(ctx.client, 'Biedronka');
    const old = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: shop.id,
      categoryId: groceries.id,
      amount: -1,
    });
    await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: shop.id,
      categoryId: household.id,
      amount: -1,
    });
    const lastCategory = async () => (await t.db.select().from(payee).where(eq(payee.id, shop.id)))[0]!.lastCategoryId;

    await edit(old.id, { memo: 'old receipt', amount: -2 });
    expect(await lastCategory()).toBe(household.id);
    await edit(old.id, { categoryId: groceries.id, payeeId: shop.id });
    expect(await lastCategory()).toBe(household.id);
    await edit(old.id, { categoryId: null });
    await edit(old.id, { categoryId: groceries.id });
    expect(await lastCategory()).toBe(groceries.id);
  });

  it('rebooks a foreign amount at the stored rate unless a new one is sent', async () => {
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    const txn = await createTransaction(ctx.client, { accountId: euro.id, amount: -1_000, fxRate: '4.3' });

    expect(await edit(txn.id, { amount: -2_000 })).toMatchObject({ amountBase: -8_600, fxRate: '4.300000' });
    expect(await edit(txn.id, { fxRate: '4.5' })).toMatchObject({ amountBase: -9_000, fxRate: '4.500000' });
    const { checking } = await setUp();
    const pln = await createTransaction(ctx.client, { accountId: checking.id, amount: -1 });
    expect((await json(await patch(pln.id, { fxRate: '4.5' }))).body).toMatchObject({ code: 'fx_rate_not_allowed' });
  });

  it('mirrors date, amount and memo to the other side of a transfer; cleared stays per side', async () => {
    const { checking, savings } = await setUp();
    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: savings.transferPayeeId,
      amount: -500,
    });
    const receivedId = sent.transfer!.transactionId;
    const before = await snapshot(t.db);

    // Edited from the receiving side.
    const received = await edit(receivedId, { date: '2026-11-19', amount: 700, memo: 'more', cleared: 'cleared' });
    expect(received).toMatchObject({ amount: 700, cleared: 'cleared', transfer: { amount: -700 } });
    expect(await get(sent.id)).toMatchObject({
      date: '2026-11-19',
      amount: -700,
      amountBase: -700,
      memo: 'more',
      cleared: 'uncleared',
    });
    const lines = await ledgerLines(t.db, inArray(ledgerLine.txnId, [sent.id, receivedId]));
    expect(lines.map((l) => [l.date, l.amountBase])).toEqual([
      ['2026-11-19', -700],
      ['2026-11-19', 700],
    ]);
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('changes the other side’s amount of a transfer between currencies only when it is sent', async () => {
    const { checking } = await setUp();
    const euro = await createAccount(ctx.client, { name: 'Revolut', type: 'savings', currency: 'EUR', fxRate: '4.25' });
    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: euro.transferPayeeId,
      amount: -40_000,
      transferAmount: 9_300,
    });
    const otherId = sent.transfer!.transactionId;

    await edit(sent.id, { amount: -42_000 });
    expect(await get(otherId)).toMatchObject({ amount: 9_300, amountBase: 42_000 });
    await edit(sent.id, { transferAmount: 9_800 });
    expect(await get(otherId)).toMatchObject({ amount: 9_800, amountBase: 42_000, effectiveRate: '4.285714' });
    expect((await json(await patch(sent.id, { amount: 100 }))).body).toMatchObject({ code: 'transfer_amount_sign' });
  });

  it('turns a transaction into a transfer, retargets it and turns it back as the payee changes', async () => {
    const { checking, savings, groceries } = await setUp();
    const wallet = await createAccount(ctx.client, { name: 'Wallet', type: 'cash' });
    const txn = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeName: 'Biedronka',
      categoryId: groceries.id,
      amount: -100,
    });

    expect((await json(await patch(txn.id, { payeeId: savings.transferPayeeId }))).body).toMatchObject({
      code: 'category_not_allowed',
    });
    const toSavings = await edit(txn.id, { payeeId: savings.transferPayeeId, categoryId: null });
    const first = toSavings.transfer!.transactionId;
    expect(await get(first)).toMatchObject({ accountId: savings.id, amount: 100 });

    const toWallet = await edit(txn.id, { payeeId: wallet.transferPayeeId });
    const second = toWallet.transfer!.transactionId;
    expect(second).not.toBe(first);
    expect((await rowOf(first)).deletedAt).toEqual(ctx.clock.now());
    expect(await get(second)).toMatchObject({ accountId: wallet.id, amount: 100, transfer: { transactionId: txn.id } });

    const plain = await edit(txn.id, { payeeName: 'Biedronka', categoryId: groceries.id });
    expect(plain).toMatchObject({ payeeName: 'Biedronka', categoryId: groceries.id, transfer: null });
    expect(await rowOf(txn.id)).toMatchObject({ transferAccountId: null, transferTxnId: null });
    expect((await rowOf(second)).deletedAt).toEqual(ctx.clock.now());
    expect((await ledgerLines(t.db, eq(ledgerLine.accountId, wallet.id))).map((l) => l.txnId)).not.toContain(second);
  });

  it('drops the other side when the tracking side of a loan payment gets a regular payee', async () => {
    const { checking } = await setUp();
    const loan = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      minPayment: 1,
      createPairedCategory: true,
    });
    const payment = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: loan.transferPayeeId,
      categoryId: loan.pairedCategoryId,
      amount: -1_000,
    });
    const loanSide = payment.transfer!.transactionId;
    expect(await edit(loanSide, { payeeName: 'Bank fee' })).toMatchObject({ categoryId: null, transfer: null });
    expect((await rowOf(payment.id)).deletedAt).not.toBeNull();
  });

  it('mirrors a split’s date to its line counterparts, which take only memo, cleared, approved, flag', async () => {
    const { checking, savings, groceries } = await setUp();
    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -300,
      lines: [
        { amount: -100, categoryId: groceries.id },
        { amount: -200, payeeId: savings.transferPayeeId },
      ],
    });
    const counterpartId = split.lines[1]!.transfer!.transactionId;

    expect(await edit(counterpartId, { memo: 'savings', cleared: 'cleared', flag: 'green' })).toMatchObject({
      memo: 'savings',
      cleared: 'cleared',
      flag: 'green',
    });
    expect((await get(split.id)).lines[1]!.memo).toBe('savings');
    await edit(split.id, { date: '2026-11-15', memo: 'monthly' });
    expect(await get(counterpartId)).toMatchObject({ date: '2026-11-15', memo: 'savings', cleared: 'cleared' });
    expect((await ledgerLines(t.db, eq(ledgerLine.txnId, split.id))).map((l) => l.date)).toEqual([
      '2026-11-15',
      '2026-11-15',
    ]);

    expect(await json(await patch(counterpartId, { amount: 250 }))).toEqual({
      status: 422,
      body: {
        code: 'split_counterpart',
        message: 'This transfer is a line of a split in "mBank": change it there.',
        fieldErrors: { amount: ['This transfer is a line of a split in "mBank": change it there.'] },
      },
    });
    expect((await json(await patch(split.id, { amount: -400 }))).body).toMatchObject({ code: 'split_sum' });
    expect((await json(await patch(split.id, { categoryId: groceries.id }))).body).toMatchObject({
      code: 'category_not_allowed',
    });
    const [line] = await t.db.select().from(subtransaction).where(eq(subtransaction.id, split.lines[1]!.id));
    expect(line!.transferTxnId).toBe(counterpartId);
  });

  it('refuses future dates, a new payee or category on a starting balance, and unknown transactions', async () => {
    const { checking, groceries } = await setUp();
    const txn = await createTransaction(ctx.client, { accountId: checking.id, amount: -1 });
    expect(await json(await patch(txn.id, { date: '2026-11-21' }))).toMatchObject({
      status: 422,
      body: { code: 'date_in_future', fieldErrors: { date: [expect.any(String)] } },
    });
    expect(await json(await patch(txn.id, { date: '1969-12-31' }))).toMatchObject({
      status: 400,
      body: { fieldErrors: { date: ['Use a date from 1970-01-01 on.'] } },
    });

    const [opening] = await t.db
      .select()
      .from(transaction)
      .where(eq(transaction.isStartingBalance, true));
    expect(await edit(opening!.id, { amount: 120_000, date: '2026-11-01', memo: 'opening' })).toMatchObject({
      amount: 120_000,
      isStartingBalance: true,
    });
    expect((await json(await patch(opening!.id, { categoryId: groceries.id }))).body).toMatchObject({
      code: 'starting_balance',
    });
    expect((await json(await patch(opening!.id, { payeeName: 'Me' }))).body).toMatchObject({
      code: 'starting_balance',
    });
    await t.db.update(transaction).set({ deletedAt: new Date() }).where(eq(transaction.id, txn.id));
    for (const id of [txn.id, crypto.randomUUID()]) {
      expect(await json(await patch(id, { memo: 'x' }))).toEqual({
        status: 404,
        body: { code: 'not_found', message: 'Transaction not found.' },
      });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/transactions/edit-transaction.test.ts`
Expected: FAIL, `Tests  9 failed (9)`, mostly `edit failed: 404 {"code":"not_found","message":"Not found."}`.

- [ ] **Step 3: Add the request schema**

```bash
git apply <<'PATCH'
diff --git a/src/shared/api/transactions.ts b/src/shared/api/transactions.ts
index 5058526..53fe8bf 100644
--- a/src/shared/api/transactions.ts
+++ b/src/shared/api/transactions.ts
@@ -81,6 +81,34 @@ export type CreateTransactionRequest = z.infer<typeof createTransactionRequestSc
 /** The request body as sent (fields with defaults are optional). */
 export type CreateTransactionInput = z.input<typeof createTransactionRequestSchema>;
 
+/**
+ * PATCH /api/transactions/:id: omitted fields stay as they are. On a transfer, date, amount and memo are mirrored to
+ * the other side (between currencies, the other side's amount changes only with `transferAmount`); cleared, approved
+ * and flag belong to each side. The counterpart of a split line takes only memo, cleared, approved and flag; the
+ * rest is edited on the split.
+ */
+export const updateTransactionRequestSchema = z
+  .object({
+    date: transactionDateSchema.optional(),
+    /** null removes the payee; a transfer payee makes (or retargets) a transfer. */
+    payeeId: idSchema.nullable().optional(),
+    payeeName: nameSchema.optional(),
+    categoryId: idSchema.nullable().optional(),
+    memo: memoSchema.optional(),
+    amount: moneySchema.optional(),
+    transferAmount: moneySchema.optional(),
+    fxRate: fxRateSchema.optional(),
+    cleared: userClearedSchema.optional(),
+    approved: z.boolean().optional(),
+    flag: flagSchema.nullable().optional(),
+  })
+  .refine((body) => body.payeeId === undefined || body.payeeName === undefined, {
+    path: ['payeeName'],
+    message: 'Choose a payee or type a new name, not both.',
+  });
+
+export type UpdateTransactionRequest = z.infer<typeof updateTransactionRequestSchema>;
+
 /** The other side of a transfer. */
 export interface TransferDto {
   accountId: string;
PATCH
```

- [ ] **Step 4: Load saved transactions as drafts**

Create `src/server/transactions/aggregate.ts`:

```ts
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { account, subtransaction, transaction } from '../db/schema';
import { AppError } from '../http/errors';
import type { Draft } from './plan';

type TxnRow = typeof transaction.$inferSelect;
type LineRow = typeof subtransaction.$inferSelect;

/** A saved transaction with every row that belongs to it. */
export interface Aggregate {
  main: TxnRow;
  /** A plain transfer's other side. */
  counterpart: TxnRow | null;
  /** A split's live lines in order, each with the counterpart of a transfer line. */
  lines: { line: LineRow; counterpart: TxnRow | null }[];
  /** Set when `main` is the counterpart of a split line: that split and line, which own its amount and date. */
  owner: { parent: TxnRow; line: LineRow } | null;
}

async function row(db: Executor, id: string): Promise<TxnRow | null> {
  const [found] = await db.select().from(transaction).where(eq(transaction.id, id));
  return found ?? null;
}

/** The live transaction `id` with its transfer side, split lines and line counterparts (404 when there is none). */
export async function loadAggregate(db: Executor, id: string): Promise<Aggregate> {
  const main = await row(db, id);
  if (!main || main.deletedAt) throw new AppError(404, 'not_found', 'Transaction not found.');
  if (main.transferSubtxnId) {
    const [line] = await db.select().from(subtransaction).where(eq(subtransaction.id, main.transferSubtxnId));
    const parent = (await row(db, main.transferTxnId!))!;
    return { main, counterpart: null, lines: [], owner: { parent, line: line! } };
  }
  const counterpart = !main.isSplit && main.transferTxnId ? await row(db, main.transferTxnId) : null;
  const lineRows = main.isSplit
    ? await db
        .select()
        .from(subtransaction)
        .where(and(eq(subtransaction.txnId, id), isNull(subtransaction.deletedAt)))
        .orderBy(asc(subtransaction.sortOrder), asc(subtransaction.id))
    : [];
  const counterpartIds = lineRows.flatMap((line) => (line.transferTxnId ? [line.transferTxnId] : []));
  const counterparts =
    counterpartIds.length === 0
      ? []
      : await db.select().from(transaction).where(inArray(transaction.id, counterpartIds));
  return {
    main,
    counterpart,
    lines: lineRows.map((line) => ({
      line,
      counterpart: counterparts.find((c) => c.id === line.transferTxnId) ?? null,
    })),
    owner: null,
  };
}

/**
 * The saved transaction as a draft. The category of a budget↔tracking transfer (or transfer line) is the budget
 * side's, wherever it is stored.
 */
export function draftOf(agg: Aggregate): Draft {
  const { main, counterpart } = agg;
  return {
    accountId: main.accountId,
    date: main.date,
    payeeId: main.payeeId,
    categoryId: main.categoryId ?? counterpart?.categoryId ?? null,
    memo: main.memo,
    amount: main.amount,
    transferAmount: null,
    fxRate: null,
    cleared: main.cleared,
    approved: main.approved,
    flag: main.flag,
    lines: main.isSplit
      ? agg.lines.map(({ line, counterpart: other }) => ({
          amount: line.amount,
          payeeId: line.payeeId,
          categoryId: line.categoryId ?? other?.categoryId ?? null,
          memo: line.memo,
        }))
      : null,
  };
}

/** Rates already stored on the transaction's rows, by currency (spec §9: edits keep them unless a new one is sent). */
export async function storedRates(db: Executor, agg: Aggregate): Promise<Map<string, string>> {
  const rates = new Map<string, string>();
  for (const r of [agg.main, agg.counterpart]) {
    if (!r?.fxRate) continue;
    const [owner] = await db.select({ currency: account.currency }).from(account).where(eq(account.id, r.accountId));
    rates.set(owner!.currency, r.fxRate);
  }
  return rates;
}

/** Accounts that already hold rows of the transaction: closed ones among them keep those rows editable. */
export function accountsOf(agg: Aggregate): Set<string> {
  const rows = [agg.main, agg.counterpart, ...agg.lines.map((l) => l.counterpart)];
  return new Set(rows.flatMap((r) => (r ? [r.accountId] : [])));
}
```

- [ ] **Step 5: Let the planner keep what a saved transaction has**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/plan.ts b/src/server/transactions/plan.ts
index 05664f6..136828d 100644
--- a/src/server/transactions/plan.ts
+++ b/src/server/transactions/plan.ts
@@ -90,6 +90,19 @@ export interface Plan {
   payeeDefault: { payeeId: string; categoryId: string } | null;
 }
 
+/** What an edited transaction already has; edits may keep values that new transactions can't use. */
+export interface PlanContext {
+  existing?: {
+    payeeId: string | null;
+    /** Stored rates by currency, used when the request sends none. */
+    rates: Map<string, string>;
+    /** A plain transfer's other side: its amount stays unless `transferAmount` is sent. */
+    counterpart: { accountId: string; amount: Money } | null;
+    /** Accounts that already hold the transaction's rows (they may be closed). */
+    accountIds: Set<string>;
+  };
+}
+
 const rateColumns = (rate: string | null) => ({ fxRate: rate, fxRateManual: rate !== null });
 
 /**
@@ -97,7 +110,7 @@ const rateColumns = (rate: string | null) => ({ fxRate: rate, fxRateManual: rate
  * currencies take both native amounts. The sending side (the outflow; this side for 0) decides the base amounts:
  * a PLN side gives them directly, otherwise the sending currency's rate converts.
  */
-function transferSides(main: AccountInfo, other: AccountInfo, draft: Draft, rates: Rates) {
+function transferSides(main: AccountInfo, other: AccountInfo, draft: Draft, rates: Rates, context: PlanContext) {
   let otherAmount: Money;
   if (main.currency === other.currency) {
     if (draft.transferAmount !== null) {
@@ -109,21 +122,23 @@ function transferSides(main: AccountInfo, other: AccountInfo, draft: Draft, rate
     }
     otherAmount = -draft.amount;
   } else {
-    if (draft.transferAmount === null) {
+    const kept = context.existing?.counterpart;
+    const amount = draft.transferAmount ?? (kept?.accountId === other.id ? kept.amount : null);
+    if (amount === null) {
       throw new DomainError(
         'transfer_amount_required',
         `Enter the amount in ${other.currency} that "${other.name}" receives or sends.`,
         'transferAmount',
       );
     }
-    if (draft.amount === 0 || Math.sign(draft.transferAmount) !== -Math.sign(draft.amount)) {
+    if (draft.amount === 0 || Math.sign(amount) !== -Math.sign(draft.amount)) {
       throw new DomainError(
         'transfer_amount_sign',
         'The two sides of a transfer need opposite, non-zero amounts.',
         'transferAmount',
       );
     }
-    otherAmount = draft.transferAmount;
+    otherAmount = amount;
   }
   const here = { amount: draft.amount, currency: main.currency };
   const there = { amount: otherAmount, currency: other.currency };
@@ -144,6 +159,7 @@ async function planLines(
   main: AccountInfo,
   draft: Draft & { lines: DraftLine[] },
   rates: Rates,
+  open: (target: AccountInfo, field: string) => void,
 ): Promise<{ amountBase: Money; fxRate: string | null; lines: LinePlan[] }> {
   const total = draft.lines.reduce((sum, line) => sum + line.amount, 0);
   if (total !== draft.amount) {
@@ -183,7 +199,7 @@ async function planLines(
         field('payeeId'),
       );
     }
-    assertOpen(other, field('payeeId'));
+    open(other, field('payeeId'));
     const category = await placeTransferCategory(db, main, other, line.categoryId, field('categoryId'));
     lines.push({
       ...base,
@@ -206,12 +222,16 @@ async function planLines(
 }
 
 /** Validates a draft against spec §5.5 and §9 and computes the rows to write. */
-export async function planTransaction(db: Executor, draft: Draft): Promise<Plan> {
+export async function planTransaction(db: Executor, draft: Draft, context: PlanContext = {}): Promise<Plan> {
+  const existing = context.existing;
+  const open = (target: AccountInfo, field: string) => {
+    if (!existing?.accountIds.has(target.id)) assertOpen(target, field);
+  };
   const main = await requireAccount(db, draft.accountId, 'accountId');
-  assertOpen(main, 'accountId');
+  open(main, 'accountId');
   const payee = draft.payeeId === null ? null : await requirePayee(db, draft.payeeId, 'payeeId');
-  if (payee) assertNotSystemPayee(payee, 'payeeId');
-  const rates: Rates = { input: draft.fxRate, stored: new Map(), used: false };
+  if (payee && draft.payeeId !== existing?.payeeId) assertNotSystemPayee(payee, 'payeeId');
+  const rates: Rates = { input: draft.fxRate, stored: existing?.rates ?? new Map(), used: false };
   const row = {
     accountId: draft.accountId,
     date: draft.date,
@@ -233,7 +253,7 @@ export async function planTransaction(db: Executor, draft: Draft): Promise<Plan>
     if (draft.transferAmount !== null) {
       throw new DomainError('transfer_amount_not_allowed', 'Only transfers take a second amount.', 'transferAmount');
     }
-    const split = await planLines(db, main, { ...draft, lines: draft.lines }, rates);
+    const split = await planLines(db, main, { ...draft, lines: draft.lines }, rates, open);
     assertRateUsed(rates);
     return {
       main: {
@@ -257,9 +277,9 @@ export async function planTransaction(db: Executor, draft: Draft): Promise<Plan>
   if (payee?.transferAccountId) {
     const other = await requireAccount(db, payee.transferAccountId, 'payeeId');
     assertNotSelf(main, other, 'payeeId');
-    assertOpen(other, 'payeeId');
+    open(other, 'payeeId');
     const category = await placeTransferCategory(db, main, other, draft.categoryId, 'categoryId');
-    const sides = transferSides(main, other, draft, rates);
+    const sides = transferSides(main, other, draft, rates, context);
     assertRateUsed(rates);
     return {
       main: {
PATCH
```

- [ ] **Step 6: Sync the rows, add the command and the route**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/transaction-commands.ts b/src/server/transactions/transaction-commands.ts
index 034f54d..f61ec9f 100644
--- a/src/server/transactions/transaction-commands.ts
+++ b/src/server/transactions/transaction-commands.ts
@@ -1,10 +1,14 @@
-import type { CreateTransactionRequest } from '../../shared/api/transactions';
+import { eq } from 'drizzle-orm';
+import type { CreateTransactionRequest, UpdateTransactionRequest } from '../../shared/api/transactions';
 import type { IsoDate } from '../../engine';
 import type { ChangeRecorder } from '../commands/recorder';
+import { payee, subtransaction, transaction } from '../db/schema';
 import { DomainError } from '../http/errors';
 import { findOrCreatePayee } from '../payees/payee-commands';
+import { accountsOf, type Aggregate, draftOf, loadAggregate, storedRates } from './aggregate';
 import { type Draft, planTransaction } from './plan';
-import { insertPlan, insertSchedule } from './write';
+import { findAccount } from './rules';
+import { insertPlan, insertSchedule, rememberCategory, syncPlan } from './write';
 
 export interface SavedTransaction {
   kind: 'transaction' | 'scheduled';
@@ -61,3 +65,130 @@ export async function createTransaction(
   }
   return { kind: 'transaction', id: await insertPlan(rec, plan), date: draft.date, payeeName };
 }
+
+export interface EditContext {
+  today: IsoDate;
+  now: Date;
+}
+
+/** The payee's name for undo labels. */
+async function payeeNameOf(rec: ChangeRecorder, id: string | null): Promise<string | null> {
+  if (id === null) return null;
+  const [row] = await rec.tx.select({ name: payee.name }).from(payee).where(eq(payee.id, id));
+  return row?.name ?? null;
+}
+
+/** "Edit transaction "Biedronka"" */
+export const editLabel = (r: { payeeName: string | null }) =>
+  r.payeeName === null ? 'Edit transaction' : `Edit transaction "${r.payeeName}"`;
+
+/** Fields that a split line's counterpart takes; everything else belongs to the split (spec §10 "Splits"). */
+const COUNTERPART_FIELDS = new Set(['memo', 'cleared', 'approved', 'flag']);
+
+/** The counterpart of a split line: its memo mirrors the line's; cleared, approved and flag are its own. */
+async function updateLineCounterpart(
+  rec: ChangeRecorder,
+  agg: Aggregate & { owner: NonNullable<Aggregate['owner']> },
+  patch: UpdateTransactionRequest,
+): Promise<void> {
+  const field = Object.keys(patch).find(
+    (key) => patch[key as keyof UpdateTransactionRequest] !== undefined && !COUNTERPART_FIELDS.has(key),
+  );
+  if (field !== undefined) {
+    const split = await findAccount(rec.tx, agg.owner.parent.accountId);
+    throw new DomainError(
+      'split_counterpart',
+      `This transfer is a line of a split in "${split!.name}": change it there.`,
+      field,
+    );
+  }
+  const memo = patch.memo === undefined ? undefined : patch.memo || null;
+  await rec.update(transaction, eq(transaction.id, agg.main.id), {
+    memo,
+    cleared: patch.cleared,
+    approved: patch.approved,
+    flag: patch.flag,
+  });
+  await rec.update(subtransaction, eq(subtransaction.id, agg.owner.line.id), { memo });
+}
+
+/** The saved draft with the request's changes applied. */
+async function applyPatch(rec: ChangeRecorder, agg: Aggregate, patch: UpdateTransactionRequest): Promise<Draft> {
+  const current = draftOf(agg);
+  const payeeId =
+    patch.payeeName !== undefined
+      ? await findOrCreatePayee(rec, patch.payeeName)
+      : patch.payeeId !== undefined
+        ? patch.payeeId
+        : current.payeeId;
+  return {
+    ...current,
+    date: patch.date ?? current.date,
+    payeeId,
+    // A new payee keeps this row's own category, not the other side's: the transfer it belonged to is gone.
+    categoryId:
+      patch.categoryId !== undefined
+        ? patch.categoryId
+        : payeeId !== current.payeeId
+          ? agg.main.categoryId
+          : current.categoryId,
+    memo: patch.memo === undefined ? current.memo : patch.memo || null,
+    amount: patch.amount ?? current.amount,
+    transferAmount: patch.transferAmount ?? null,
+    fxRate: patch.fxRate ?? null,
+    cleared: patch.cleared ?? current.cleared,
+    approved: patch.approved ?? current.approved,
+    flag: patch.flag !== undefined ? patch.flag : current.flag,
+  };
+}
+
+/** A starting balance (spec §10) keeps its payee and category, and can't become a split or a transfer. */
+function assertStartingBalanceKept(agg: Aggregate, draft: Draft): void {
+  const { main } = agg;
+  if (main.isStartingBalance && (draft.payeeId !== main.payeeId || draft.categoryId !== main.categoryId)) {
+    throw new DomainError(
+      'starting_balance',
+      "A starting balance keeps its payee and category; change its amount, date or memo instead.",
+      draft.payeeId !== main.payeeId ? 'payeeId' : 'categoryId',
+    );
+  }
+}
+
+/**
+ * PATCH /api/transactions/:id (spec §10 "Creating and editing", "Transfers"): the edited transaction is planned again
+ * with every rule of a new one, then its rows are brought in line.
+ */
+export async function updateTransaction(
+  rec: ChangeRecorder,
+  id: string,
+  patch: UpdateTransactionRequest,
+  context: EditContext,
+): Promise<{ payeeName: string | null }> {
+  const agg = await loadAggregate(rec.tx, id);
+  if (agg.owner) {
+    await updateLineCounterpart(rec, { ...agg, owner: agg.owner }, patch);
+    return { payeeName: await payeeNameOf(rec, agg.main.payeeId) };
+  }
+  const draft = await applyPatch(rec, agg, patch);
+  if (patch.date !== undefined && patch.date > context.today) {
+    throw new DomainError(
+      'date_in_future',
+      "A saved transaction can't move into the future. Delete it and add it again with the new date.",
+      'date',
+    );
+  }
+  assertStartingBalanceKept(agg, draft);
+  const plan = await planTransaction(rec.tx, draft, {
+    existing: {
+      payeeId: agg.main.payeeId,
+      rates: await storedRates(rec.tx, agg),
+      counterpart: agg.counterpart && { accountId: agg.counterpart.accountId, amount: agg.counterpart.amount },
+      accountIds: accountsOf(agg),
+    },
+  });
+  await syncPlan(rec, agg, plan, context.now);
+  if (draft.payeeId !== agg.main.payeeId || draft.categoryId !== agg.main.categoryId) {
+    await rememberCategory(rec, plan);
+  }
+  return { payeeName: plan.payee?.name ?? null };
+}
diff --git a/src/server/transactions/transaction-routes.ts b/src/server/transactions/transaction-routes.ts
index 974d3d5..74ba745 100644
--- a/src/server/transactions/transaction-routes.ts
+++ b/src/server/transactions/transaction-routes.ts
@@ -4,13 +4,14 @@ import {
   createTransactionRequestSchema,
   type CreateTransactionResponse,
   type TransactionDto,
+  updateTransactionRequestSchema,
 } from '../../shared/api/transactions';
 import { type AuthedEnv, requireSession } from '../auth/sessions';
 import { todayIn } from '../clock';
 import { runCommand } from '../commands/run-command';
 import type { AppDeps } from '../http/app';
 import { validate } from '../http/validate';
-import { createTransaction, savedLabel } from './transaction-commands';
+import { createTransaction, editLabel, savedLabel, updateTransaction } from './transaction-commands';
 import { getTransaction } from './transaction-queries';
 
 /** /api/transactions (spec §10 "Transactions and related workflows"): every change is one undoable command. */
@@ -30,5 +31,12 @@ export function transactionRoutes(deps: AppDeps) {
     })
     .get('/:id', validate('param', idParamSchema), async (c) =>
       c.json<TransactionDto>(await getTransaction(deps.db, c.req.valid('param').id)),
-    );
+    )
+    .patch('/:id', validate('param', idParamSchema), validate('json', updateTransactionRequestSchema), async (c) => {
+      const { id } = c.req.valid('param');
+      const body = c.req.valid('json');
+      const context = { today: today(), now: deps.clock.now() };
+      await runCommand(deps, editLabel, (rec) => updateTransaction(rec, id, body, context));
+      return c.json<TransactionDto>(await getTransaction(deps.db, id));
+    });
 }
diff --git a/src/server/transactions/write.ts b/src/server/transactions/write.ts
index da5c911..3fda0af 100644
--- a/src/server/transactions/write.ts
+++ b/src/server/transactions/write.ts
@@ -1,10 +1,11 @@
-import { eq } from 'drizzle-orm';
+import { eq, inArray } from 'drizzle-orm';
 import type { ChangeRecorder } from '../commands/recorder';
 import { payee, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
+import type { Aggregate } from './aggregate';
 import type { Draft, LinePlan, Plan } from './plan';
 
 /** Spec §10: the transaction sheet pre-fills the category from the payee. */
-async function rememberCategory(rec: ChangeRecorder, plan: Plan): Promise<void> {
+export async function rememberCategory(rec: ChangeRecorder, plan: Plan): Promise<void> {
   if (!plan.payeeDefault) return;
   const { payeeId, categoryId } = plan.payeeDefault;
   await rec.update(payee, eq(payee.id, payeeId), { lastCategoryId: categoryId });
@@ -71,3 +72,37 @@ export async function insertSchedule(rec: ChangeRecorder, draft: Draft, plan: Pl
   await rememberCategory(rec, plan);
   return schedule!.id;
 }
+
+/** Soft-deletes transactions (spec §13); their lines stay, and the ledger view drops them with their split. */
+export async function softDelete(rec: ChangeRecorder, ids: string[], now: Date): Promise<void> {
+  if (ids.length > 0) await rec.update(transaction, inArray(transaction.id, ids), { deletedAt: now });
+}
+
+/**
+ * Brings a saved transaction's rows in line with its new plan. A transfer side in the same account is updated in
+ * place (keeping its cleared, approved and flag); a transfer that moves to another account, or stops being one,
+ * loses its old side, and a new side is created. Split lines are updated in place.
+ */
+export async function syncPlan(rec: ChangeRecorder, agg: Aggregate, plan: Plan, now: Date): Promise<void> {
+  const id = agg.main.id;
+  const old = agg.counterpart;
+  const next = plan.counterpart;
+  if (old && next && old.accountId === next.accountId) {
+    await rec.update(transaction, eq(transaction.id, id), plan.main);
+    await rec.update(transaction, eq(transaction.id, old.id), next);
+  } else {
+    if (old) await softDelete(rec, [old.id], now);
+    await rec.update(transaction, eq(transaction.id, id), { ...plan.main, transferTxnId: null });
+    if (next) {
+      const [other] = await rec.insert(transaction, { ...next, transferTxnId: id });
+      await rec.update(transaction, eq(transaction.id, id), { transferTxnId: other!.id });
+    }
+  }
+  for (const [index, { line, counterpart }] of agg.lines.entries()) {
+    const { counterpart: nextCounterpart, ...nextLine } = plan.lines![index]!;
+    await rec.update(subtransaction, eq(subtransaction.id, line.id), nextLine);
+    if (counterpart && nextCounterpart) {
+      await rec.update(transaction, eq(transaction.id, counterpart.id), nextCounterpart);
+    }
+  }
+}
PATCH
```

- [ ] **Step 7: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/transactions/edit-transaction.test.ts`
Expected: `Tests  9 passed (9)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  43 passed (43)`, `Tests  395 passed (395)`; both checks exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/shared/api/transactions.ts src/server/transactions
git commit -m "feat(server): edit transactions and transfers" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Edit split lines; reconciled confirmation; moves between accounts

Spec §10 "Splits", "Reconciled transactions" and "Search and bulk operations" (moves).
- **Lines.** `lines` in a PATCH replaces the split's lines: the old lines and their counterparts are soft-deleted and the new ones created, unless the lines sent equal the current ones (same amounts, payees, categories and memos), in which case nothing churns. `lines: null` turns a split into a plain transaction. Lines on a plain transaction turn it into a split; its category then defaults to none, and its transfer (if any) has to end in the same request, because a split can't be a transfer.
- **Reconciled rows.** Changing a reconciled row's amount, date, account or transfer, or un-reconciling it, needs `confirmReconciled: true`, otherwise 409 `confirm_reconciled`. This covers mirrored changes that reach a reconciled other side or line counterpart, removing such a side, and replacing a reconciled split's lines. Memo, payee, category, flag and approval changes don't need it.
- **Moves.** `accountId` moves a transaction to another account in the same currency (422 `move_currency`), and every §5.5 rule runs again in the new account. The other side of a transfer and the counterparts of split lines stay where they are and follow: their `transfer_account_id` and payee become the new account's. Starting balances and the counterparts of split lines can't move.

**Files:**
- Modify: `src/shared/api/transactions.ts`, `src/server/transactions/write.ts`, `src/server/transactions/transaction-commands.ts`
- Test: `src/server/transactions/split-edit.test.ts`, `src/server/transactions/edit-transaction.test.ts`

**Interfaces:**
- Consumes: Task 5.
- Produces:
  - `updateTransactionRequestSchema` gains `accountId?`, `lines?: SplitLineRequest[] | null`, `confirmReconciled = false`; it refuses `categoryId` with `lines` (400).
  - `syncPlan(rec, agg, plan, now, replaceLines: boolean)`.
  - `assertConfirmed(touches, confirmed)` (409 `confirm_reconciled` "This changes a reconciled transaction. Confirm to go ahead.").
  - Errors `move_currency`; `starting_balance` also covers `accountId` and `lines`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/transactions/split-edit.test.ts`:

```ts
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionDto } from '../../shared/api/transactions';
import { ledgerLine, subtransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, createTransaction, ledgerLines } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/transactions/${id}`, body);
const edit = async (id: string, body: object) => {
  const res = await json<TransactionDto>(await patch(id, body));
  if (res.status !== 200) throw new Error(`edit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;
const deletedAt = async (table: typeof transaction | typeof subtransaction, id: string) =>
  (await t.db.select({ deletedAt: table.deletedAt }).from(table).where(eq(table.id, id)))[0]!.deletedAt;

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
  const wallet = await createAccount(ctx.client, { name: 'Wallet', type: 'cash' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  const household = await createCategory(ctx.client, food.id, 'Household');
  const split = await createTransaction(ctx.client, {
    accountId: checking.id,
    amount: -300,
    lines: [
      { amount: -100, categoryId: groceries.id },
      { amount: -200, payeeId: savings.transferPayeeId },
    ],
  });
  return { checking, savings, wallet, groceries, household, split };
}

describe('editing splits', () => {
  it('replaces changed lines, soft-deleting the old lines and their counterparts', async () => {
    const { checking, wallet, groceries, household, split } = await setUp();
    const before = await snapshot(t.db);
    const oldCounterpart = split.lines[1]!.transfer!.transactionId;

    const edited = await edit(split.id, {
      amount: -400,
      lines: [
        { amount: -150, categoryId: groceries.id },
        { amount: -50, categoryId: household.id, memo: 'soap' },
        { amount: -200, payeeId: wallet.transferPayeeId },
      ],
    });
    expect(edited.lines.map((l) => [l.amount, l.categoryId, l.memo, l.transfer?.accountId ?? null])).toEqual([
      [-150, groceries.id, null, null],
      [-50, household.id, 'soap', null],
      [-200, null, null, wallet.id],
    ]);
    for (const line of split.lines) expect(await deletedAt(subtransaction, line.id)).toEqual(ctx.clock.now());
    expect(await deletedAt(transaction, oldCounterpart)).toEqual(ctx.clock.now());
    expect(await get(edited.lines[2]!.transfer!.transactionId)).toMatchObject({
      accountId: wallet.id,
      amount: 200,
      transfer: { transactionId: split.id, splitLineId: edited.lines[2]!.id },
    });
    const lines = await ledgerLines(t.db, inArray(ledgerLine.accountId, [checking.id, wallet.id]));
    expect(lines.filter((l) => !l.isStartingBalance).map((l) => [l.accountId, l.categoryId, l.amountBase])).toEqual([
      [checking.id, null, -200],
      [checking.id, groceries.id, -150],
      [checking.id, household.id, -50],
      [wallet.id, null, 200],
    ]);
    const after = await snapshot(t.db);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('keeps the lines and their counterparts when the same lines are sent again', async () => {
    const { savings, groceries, split } = await setUp();
    const counterpartId = split.lines[1]!.transfer!.transactionId;
    await edit(counterpartId, { cleared: 'cleared' });

    const edited = await edit(split.id, {
      memo: 'groceries and savings',
      lines: [
        { amount: -100, categoryId: groceries.id },
        { amount: -200, payeeId: savings.transferPayeeId },
      ],
    });
    expect(edited.lines.map((l) => l.id)).toEqual(split.lines.map((l) => l.id));
    expect(await get(counterpartId)).toMatchObject({ cleared: 'cleared' });
  });

  it('turns a split into a plain transaction and back', async () => {
    const { checking, savings, groceries, split } = await setUp();
    const counterpartId = split.lines[1]!.transfer!.transactionId;

    const plain = await edit(split.id, { lines: null, categoryId: groceries.id });
    expect(plain).toMatchObject({ isSplit: false, categoryId: groceries.id, lines: [] });
    expect(await deletedAt(transaction, counterpartId)).not.toBeNull();
    expect((await ledgerLines(t.db, eq(ledgerLine.txnId, split.id))).map((l) => [l.subtxnId, l.categoryId])).toEqual([
      [null, groceries.id],
    ]);

    const again = await edit(split.id, { lines: [{ amount: -1, categoryId: groceries.id }, { amount: -299 }] });
    expect(again).toMatchObject({ isSplit: true, categoryId: null });
    expect(again.lines.map((l) => l.amount)).toEqual([-1, -299]);

    // A transfer has to stop being one before it can be split.
    const transfer = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: savings.transferPayeeId,
      amount: -10,
    });
    const lines = [{ amount: -4 }, { amount: -6 }];
    expect((await json(await patch(transfer.id, { lines }))).body).toMatchObject({ code: 'split_transfer' });
    expect(await edit(transfer.id, { lines, payeeName: 'Market' })).toMatchObject({ isSplit: true, transfer: null });
    expect(await deletedAt(transaction, transfer.transfer!.transactionId)).not.toBeNull();
  });

  it('validates new lines like the lines of a new split', async () => {
    const { groceries, split } = await setUp();
    const error = async (body: object) =>
      (await json<{ code: string; fieldErrors: Record<string, string[]> }>(await patch(split.id, body))).body;

    expect((await error({ lines: [{ amount: -100 }, { amount: -100 }] })).code).toBe('split_sum');
    expect((await error({ lines: [{ amount: -300 }, { amount: 'x' }] })).fieldErrors).toEqual({
      'lines.1.amount': ['Enter a whole amount in minor units.'],
    });
    expect(
      (await error({ categoryId: groceries.id, lines: [{ amount: -100 }, { amount: -200 }] })).fieldErrors,
    ).toEqual({ categoryId: ["A split's categories go on its lines."] });
  });
});
```

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/edit-transaction.test.ts b/src/server/transactions/edit-transaction.test.ts
index 7b321b1..6917472 100644
--- a/src/server/transactions/edit-transaction.test.ts
+++ b/src/server/transactions/edit-transaction.test.ts
@@ -306,3 +306,139 @@ describe('PATCH /api/transactions/:id', () => {
     }
   });
 });
+
+describe('reconciled transactions', () => {
+  const reconcile = (...ids: string[]) =>
+    t.db.update(transaction).set({ cleared: 'reconciled' }).where(inArray(transaction.id, ids));
+  const confirmNeeded = {
+    status: 409,
+    body: { code: 'confirm_reconciled', message: 'This changes a reconciled transaction. Confirm to go ahead.' },
+  };
+
+  it('asks to confirm a new amount, date, account or transfer, or un-reconciling', async () => {
+    const { checking, savings, groceries } = await setUp();
+    const wallet = await createAccount(ctx.client, { name: 'Wallet', type: 'cash' });
+    const txn = await createTransaction(ctx.client, { accountId: checking.id, amount: -100 });
+    await reconcile(txn.id);
+
+    for (const body of [
+      { amount: -101 },
+      { date: '2026-11-19' },
+      { accountId: wallet.id },
+      { payeeId: savings.transferPayeeId },
+      { cleared: 'cleared' },
+    ]) {
+      expect(await json(await patch(txn.id, body))).toEqual(confirmNeeded);
+    }
+    expect(await edit(txn.id, { memo: 'checked', flag: 'green', categoryId: groceries.id })).toMatchObject({
+      cleared: 'reconciled',
+    });
+    expect(await edit(txn.id, { amount: -101, confirmReconciled: true })).toMatchObject({
+      amount: -101,
+      cleared: 'reconciled',
+    });
+    expect(await edit(txn.id, { cleared: 'uncleared', confirmReconciled: true })).toMatchObject({
+      cleared: 'uncleared',
+    });
+  });
+
+  it('also guards the reconciled other side of a transfer and of a split line', async () => {
+    const { checking, savings, groceries } = await setUp();
+    const sent = await createTransaction(ctx.client, {
+      accountId: checking.id,
+      payeeId: savings.transferPayeeId,
+      amount: -100,
+    });
+    await reconcile(sent.transfer!.transactionId);
+    expect(await json(await patch(sent.id, { date: '2026-11-19' }))).toEqual(confirmNeeded);
+    expect(await json(await patch(sent.id, { payeeName: 'Shop' }))).toEqual(confirmNeeded);
+    expect((await patch(sent.id, { memo: 'mirrored, but not guarded' })).status).toBe(200);
+
+    const split = await createTransaction(ctx.client, {
+      accountId: checking.id,
+      amount: -300,
+      lines: [
+        { amount: -100, categoryId: groceries.id },
+        { amount: -200, payeeId: savings.transferPayeeId },
+      ],
+    });
+    const lineSide = split.lines[1]!.transfer!.transactionId;
+    await reconcile(lineSide);
+    expect(await json(await patch(split.id, { lines: [{ amount: -150 }, { amount: -150 }] }))).toEqual(confirmNeeded);
+    expect(await json(await patch(split.id, { date: '2026-11-19' }))).toEqual(confirmNeeded);
+    expect(await json(await patch(lineSide, { cleared: 'cleared' }))).toEqual(confirmNeeded);
+    expect((await patch(lineSide, { cleared: 'cleared', confirmReconciled: true })).status).toBe(200);
+  });
+});
+
+describe('moving a transaction to another account', () => {
+  it('moves it within its currency, keeping transfer sides and split lines linked', async () => {
+    const { checking, savings, groceries } = await setUp();
+    const wallet = await createAccount(ctx.client, { name: 'Wallet', type: 'cash' });
+    const txn = await createTransaction(ctx.client, { accountId: checking.id, categoryId: groceries.id, amount: -100 });
+    expect(await edit(txn.id, { accountId: wallet.id })).toMatchObject({ accountId: wallet.id, accountName: 'Wallet' });
+    expect((await ledgerLines(t.db, eq(ledgerLine.txnId, txn.id)))[0]!.accountId).toBe(wallet.id);
+
+    const sent = await createTransaction(ctx.client, {
+      accountId: checking.id,
+      payeeId: savings.transferPayeeId,
+      amount: -500,
+    });
+    await edit(sent.id, { accountId: wallet.id });
+    expect(await get(sent.transfer!.transactionId)).toMatchObject({
+      id: sent.transfer!.transactionId,
+      accountId: savings.id,
+      payeeName: 'Transfer : Wallet',
+      transfer: { accountId: wallet.id, transactionId: sent.id },
+    });
+
+    const split = await createTransaction(ctx.client, {
+      accountId: checking.id,
+      amount: -300,
+      lines: [
+        { amount: -100, categoryId: groceries.id },
+        { amount: -200, payeeId: savings.transferPayeeId },
+      ],
+    });
+    const moved = await edit(split.id, { accountId: wallet.id });
+    expect(moved.lines.map((l) => l.id)).toEqual(split.lines.map((l) => l.id));
+    expect(await get(split.lines[1]!.transfer!.transactionId)).toMatchObject({
+      payeeName: 'Transfer : Wallet',
+      transfer: { accountId: wallet.id, transactionId: split.id },
+    });
+  });
+
+  it('re-checks the rules of spec §5.5 in the new account', async () => {
+    const { checking, savings, groceries } = await setUp();
+    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
+    const loan = await createAccount(ctx.client, { name: 'Car', type: 'auto_loan' });
+    const old = await createAccount(ctx.client, { name: 'Old', type: 'savings' });
+    await ctx.client.post(`/api/accounts/${old.id}/close`);
+    const txn = await createTransaction(ctx.client, { accountId: checking.id, categoryId: groceries.id, amount: -100 });
+    const code = async (id: string, body: object) => (await json<{ code: string }>(await patch(id, body))).body.code;
+
+    expect(await json(await patch(txn.id, { accountId: euro.id }))).toMatchObject({
+      status: 422,
+      body: { code: 'move_currency', message: 'A transaction can only move to another PLN account.' },
+    });
+    expect(await code(txn.id, { accountId: old.id })).toBe('account_closed');
+    expect(await code(txn.id, { accountId: loan.id })).toBe('category_not_allowed');
+    expect(await edit(txn.id, { accountId: loan.id, categoryId: null })).toMatchObject({ accountId: loan.id });
+
+    const sent = await createTransaction(ctx.client, {
+      accountId: checking.id,
+      payeeId: savings.transferPayeeId,
+      amount: -500,
+    });
+    expect(await code(sent.id, { accountId: savings.id })).toBe('transfer_to_self');
+    const [opening] = await t.db.select().from(transaction).where(eq(transaction.isStartingBalance, true));
+    expect(await code(opening!.id, { accountId: savings.id })).toBe('starting_balance');
+    const split = await createTransaction(ctx.client, {
+      accountId: checking.id,
+      amount: -300,
+      lines: [{ amount: -100 }, { amount: -200, payeeId: savings.transferPayeeId }],
+    });
+    expect(await code(split.lines[1]!.transfer!.transactionId, { accountId: checking.id })).toBe('split_counterpart');
+    expect(await code(split.id, { accountId: savings.id })).toBe('transfer_to_self');
+  });
+});
PATCH
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/transactions/edit-transaction.test.ts src/server/transactions/split-edit.test.ts`
Expected: FAIL, `Tests  7 failed | 10 passed (17)`: zod strips `accountId`, `lines` and `confirmReconciled`, so moves and new lines are ignored and reconciled rows change without a 409.

- [ ] **Step 3: Accept moves, lines and the confirmation**

```bash
git apply <<'PATCH'
diff --git a/src/shared/api/transactions.ts b/src/shared/api/transactions.ts
index 53fe8bf..43bf42d 100644
--- a/src/shared/api/transactions.ts
+++ b/src/shared/api/transactions.ts
@@ -86,9 +86,14 @@ export type CreateTransactionInput = z.input<typeof createTransactionRequestSche
  * the other side (between currencies, the other side's amount changes only with `transferAmount`); cleared, approved
  * and flag belong to each side. The counterpart of a split line takes only memo, cleared, approved and flag; the
  * rest is edited on the split.
+ *
+ * Changing the amount, account, date or transfer of a reconciled transaction (or un-reconciling it) needs
+ * `confirmReconciled: true`; otherwise the answer is 409 `confirm_reconciled`.
  */
 export const updateTransactionRequestSchema = z
   .object({
+    /** Another account in the same currency. */
+    accountId: idSchema.optional(),
     date: transactionDateSchema.optional(),
     /** null removes the payee; a transfer payee makes (or retargets) a transfer. */
     payeeId: idSchema.nullable().optional(),
@@ -101,10 +106,17 @@ export const updateTransactionRequestSchema = z
     cleared: userClearedSchema.optional(),
     approved: z.boolean().optional(),
     flag: flagSchema.nullable().optional(),
+    /** New lines replace the split's lines (unless they equal them); null turns a split into a plain transaction. */
+    lines: splitLinesSchema.nullable().optional(),
+    confirmReconciled: z.boolean().default(false),
   })
   .refine((body) => body.payeeId === undefined || body.payeeName === undefined, {
     path: ['payeeName'],
     message: 'Choose a payee or type a new name, not both.',
+  })
+  .refine((body) => !body.lines || !body.categoryId, {
+    path: ['categoryId'],
+    message: "A split's categories go on its lines.",
   });
 
 export type UpdateTransactionRequest = z.infer<typeof updateTransactionRequestSchema>;
PATCH
```

- [ ] **Step 4: Replace lines, check reconciled rows and the currency of a move**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/transaction-commands.ts b/src/server/transactions/transaction-commands.ts
index f61ec9f..5671e0f 100644
--- a/src/server/transactions/transaction-commands.ts
+++ b/src/server/transactions/transaction-commands.ts
@@ -3,10 +3,10 @@ import type { CreateTransactionRequest, UpdateTransactionRequest } from '../../s
 import type { IsoDate } from '../../engine';
 import type { ChangeRecorder } from '../commands/recorder';
 import { payee, subtransaction, transaction } from '../db/schema';
-import { DomainError } from '../http/errors';
+import { AppError, DomainError } from '../http/errors';
 import { findOrCreatePayee } from '../payees/payee-commands';
 import { accountsOf, type Aggregate, draftOf, loadAggregate, storedRates } from './aggregate';
-import { type Draft, planTransaction } from './plan';
+import { type Draft, type DraftLine, type Plan, planTransaction, type RowPlan } from './plan';
 import { findAccount } from './rules';
 import { insertPlan, insertSchedule, rememberCategory, syncPlan } from './write';
 
@@ -82,8 +82,43 @@ async function payeeNameOf(rec: ChangeRecorder, id: string | null): Promise<stri
 export const editLabel = (r: { payeeName: string | null }) =>
   r.payeeName === null ? 'Edit transaction' : `Edit transaction "${r.payeeName}"`;
 
+type TxnRow = Aggregate['main'];
+
+/** Spec §10 "Reconciled transactions": does the change move a reconciled row's amount, date, account or transfer? */
+function touchesReconciled(row: TxnRow | null, next: RowPlan | null): boolean {
+  if (row?.cleared !== 'reconciled') return false;
+  return (
+    next === null ||
+    next.amount !== row.amount ||
+    next.date !== row.date ||
+    next.accountId !== row.accountId ||
+    next.transferAccountId !== row.transferAccountId
+  );
+}
+
+/** 409 unless the client confirmed a change to reconciled rows (the UI asks first). */
+export function assertConfirmed(touches: boolean, confirmed: boolean): void {
+  if (touches && !confirmed) {
+    throw new AppError(409, 'confirm_reconciled', 'This changes a reconciled transaction. Confirm to go ahead.');
+  }
+}
+
+/** Reconciled rows the edit changes: un-reconciling, replaced lines, and mirrored or removed transfer sides count. */
+function editTouchesReconciled(agg: Aggregate, plan: Plan, replaceLines: boolean): boolean {
+  const { main, counterpart } = agg;
+  const sameSide = plan.counterpart && plan.counterpart.accountId === counterpart?.accountId ? plan.counterpart : null;
+  return (
+    touchesReconciled(main, plan.main) ||
+    (main.cleared === 'reconciled' && (plan.main.cleared !== 'reconciled' || replaceLines)) ||
+    touchesReconciled(counterpart, sameSide) ||
+    agg.lines.some(({ counterpart: lineSide }, index) =>
+      touchesReconciled(lineSide, replaceLines ? null : (plan.lines?.[index]?.counterpart ?? null)),
+    )
+  );
+}
+
 /** Fields that a split line's counterpart takes; everything else belongs to the split (spec §10 "Splits"). */
-const COUNTERPART_FIELDS = new Set(['memo', 'cleared', 'approved', 'flag']);
+const COUNTERPART_FIELDS = new Set(['memo', 'cleared', 'approved', 'flag', 'confirmReconciled']);
 
 /** The counterpart of a split line: its memo mirrors the line's; cleared, approved and flag are its own. */
 async function updateLineCounterpart(
@@ -102,6 +137,8 @@ async function updateLineCounterpart(
       field,
     );
   }
+  const unreconciles = agg.main.cleared === 'reconciled' && patch.cleared !== undefined;
+  assertConfirmed(unreconciles, patch.confirmReconciled);
   const memo = patch.memo === undefined ? undefined : patch.memo || null;
   await rec.update(transaction, eq(transaction.id, agg.main.id), {
     memo,
@@ -112,9 +149,26 @@ async function updateLineCounterpart(
   await rec.update(subtransaction, eq(subtransaction.id, agg.owner.line.id), { memo });
 }
 
+const sameLines = (a: DraftLine[] | null, b: DraftLine[] | null) =>
+  a === b ||
+  (a !== null &&
+    b !== null &&
+    a.length === b.length &&
+    a.every(
+      (line, i) =>
+        line.amount === b[i]!.amount &&
+        line.payeeId === b[i]!.payeeId &&
+        line.categoryId === b[i]!.categoryId &&
+        line.memo === b[i]!.memo,
+    ));
+
 /** The saved draft with the request's changes applied. */
 async function applyPatch(rec: ChangeRecorder, agg: Aggregate, patch: UpdateTransactionRequest): Promise<Draft> {
   const current = draftOf(agg);
+  const lines =
+    patch.lines === undefined
+      ? current.lines
+      : (patch.lines?.map((line) => ({ ...line, memo: line.memo || null })) ?? null);
   const payeeId =
     patch.payeeName !== undefined
       ? await findOrCreatePayee(rec, patch.payeeName)
@@ -123,15 +177,19 @@ async function applyPatch(rec: ChangeRecorder, agg: Aggregate, patch: UpdateTran
         : current.payeeId;
   return {
     ...current,
+    accountId: patch.accountId ?? current.accountId,
     date: patch.date ?? current.date,
     payeeId,
-    // A new payee keeps this row's own category, not the other side's: the transfer it belonged to is gone.
+    // New lines leave the split itself uncategorized; a new payee keeps this row's own category, not the other
+    // side's: the transfer it belonged to is gone.
     categoryId:
       patch.categoryId !== undefined
         ? patch.categoryId
-        : payeeId !== current.payeeId
-          ? agg.main.categoryId
-          : current.categoryId,
+        : patch.lines
+          ? null
+          : payeeId !== current.payeeId
+            ? agg.main.categoryId
+            : current.categoryId,
     memo: patch.memo === undefined ? current.memo : patch.memo || null,
     amount: patch.amount ?? current.amount,
     transferAmount: patch.transferAmount ?? null,
@@ -139,17 +197,41 @@ async function applyPatch(rec: ChangeRecorder, agg: Aggregate, patch: UpdateTran
     cleared: patch.cleared ?? current.cleared,
     approved: patch.approved ?? current.approved,
     flag: patch.flag !== undefined ? patch.flag : current.flag,
+    lines,
   };
 }
 
-/** A starting balance (spec §10) keeps its payee and category, and can't become a split or a transfer. */
+/** A starting balance (spec §10) keeps its account, payee and category, and can't become a split or a transfer. */
 function assertStartingBalanceKept(agg: Aggregate, draft: Draft): void {
   const { main } = agg;
-  if (main.isStartingBalance && (draft.payeeId !== main.payeeId || draft.categoryId !== main.categoryId)) {
+  if (!main.isStartingBalance) return;
+  const changed = (
+    [
+      ['accountId', draft.accountId !== main.accountId],
+      ['payeeId', draft.payeeId !== main.payeeId],
+      ['categoryId', draft.categoryId !== main.categoryId],
+      ['lines', draft.lines !== null],
+    ] as const
+  ).find(([, differs]) => differs);
+  if (changed) {
     throw new DomainError(
       'starting_balance',
-      "A starting balance keeps its payee and category; change its amount, date or memo instead.",
-      draft.payeeId !== main.payeeId ? 'payeeId' : 'categoryId',
+      'A starting balance keeps its account, payee and category; change its amount, date or memo instead.',
+      changed[0],
+    );
+  }
+}
+
+/** Moving a transaction keeps its amounts, so only accounts in the same currency qualify. */
+async function assertSameCurrency(rec: ChangeRecorder, agg: Aggregate, draft: Draft): Promise<void> {
+  if (draft.accountId === agg.main.accountId) return;
+  const from = await findAccount(rec.tx, agg.main.accountId);
+  const to = await findAccount(rec.tx, draft.accountId);
+  if (to && to.currency !== from!.currency) {
+    throw new DomainError(
+      'move_currency',
+      `A transaction can only move to another ${from!.currency} account.`,
+      'accountId',
     );
   }
 }
@@ -178,6 +260,7 @@ export async function updateTransaction(
     );
   }
   assertStartingBalanceKept(agg, draft);
+  await assertSameCurrency(rec, agg, draft);
   const plan = await planTransaction(rec.tx, draft, {
     existing: {
       payeeId: agg.main.payeeId,
@@ -186,7 +269,9 @@ export async function updateTransaction(
       accountIds: accountsOf(agg),
     },
   });
-  await syncPlan(rec, agg, plan, context.now);
+  const replaceLines = !sameLines(draftOf(agg).lines, draft.lines);
+  assertConfirmed(editTouchesReconciled(agg, plan, replaceLines), patch.confirmReconciled);
+  await syncPlan(rec, agg, plan, context.now, replaceLines);
   if (draft.payeeId !== agg.main.payeeId || draft.categoryId !== agg.main.categoryId) {
     await rememberCategory(rec, plan);
   }
diff --git a/src/server/transactions/write.ts b/src/server/transactions/write.ts
index 3fda0af..bdd239a 100644
--- a/src/server/transactions/write.ts
+++ b/src/server/transactions/write.ts
@@ -78,12 +78,26 @@ export async function softDelete(rec: ChangeRecorder, ids: string[], now: Date):
   if (ids.length > 0) await rec.update(transaction, inArray(transaction.id, ids), { deletedAt: now });
 }
 
+/** Soft-deletes a split's live lines and the counterparts of its transfer lines. */
+async function softDeleteLines(rec: ChangeRecorder, agg: Aggregate, now: Date): Promise<void> {
+  const ids = agg.lines.map(({ line }) => line.id);
+  if (ids.length > 0) await rec.update(subtransaction, inArray(subtransaction.id, ids), { deletedAt: now });
+  await softDelete(rec, agg.lines.flatMap(({ counterpart }) => (counterpart ? [counterpart.id] : [])), now);
+}
+
 /**
  * Brings a saved transaction's rows in line with its new plan. A transfer side in the same account is updated in
  * place (keeping its cleared, approved and flag); a transfer that moves to another account, or stops being one,
- * loses its old side, and a new side is created. Split lines are updated in place.
+ * loses its old side, and a new side is created. Split lines are updated in place, unless `replaceLines` is set:
+ * then the old lines and their counterparts are soft-deleted and the plan's lines are created.
  */
-export async function syncPlan(rec: ChangeRecorder, agg: Aggregate, plan: Plan, now: Date): Promise<void> {
+export async function syncPlan(
+  rec: ChangeRecorder,
+  agg: Aggregate,
+  plan: Plan,
+  now: Date,
+  replaceLines: boolean,
+): Promise<void> {
   const id = agg.main.id;
   const old = agg.counterpart;
   const next = plan.counterpart;
@@ -98,6 +112,11 @@ export async function syncPlan(rec: ChangeRecorder, agg: Aggregate, plan: Plan,
       await rec.update(transaction, eq(transaction.id, id), { transferTxnId: other!.id });
     }
   }
+  if (replaceLines) {
+    await softDeleteLines(rec, agg, now);
+    if (plan.lines) await insertLines(rec, id, plan.lines);
+    return;
+  }
   for (const [index, { line, counterpart }] of agg.lines.entries()) {
     const { counterpart: nextCounterpart, ...nextLine } = plan.lines![index]!;
     await rec.update(subtransaction, eq(subtransaction.id, line.id), nextLine);
PATCH
```

- [ ] **Step 5: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/transactions/edit-transaction.test.ts src/server/transactions/split-edit.test.ts`
Expected: `Tests  17 passed (17)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  44 passed (44)`, `Tests  403 passed (403)`; both checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared/api/transactions.ts src/server/transactions
git commit -m "feat(server): edit split lines; confirm changes to reconciled rows; move between accounts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
### Task 7: Delete transactions; account deletion follow-ups

Spec §10 "Transfers" and "Splits", §13. `DELETE /api/transactions/:id` soft-deletes the transaction in one undoable command:
- Deleting either side of a transfer deletes both.
- Deleting a split deletes the counterparts of its transfer lines. Its lines stay as they are: the ledger view drops them with their deleted split, and undo brings everything back.
- A split line's counterpart is removed by editing the split (422 `split_counterpart`).
- Deleting a reconciled row needs `confirmReconciled: true` in the optional body (409 `confirm_reconciled`).

Account deletion stays refused while soft-deleted transactions reference the account (P2b1 decision 20; the P2 carry-over asked P2c to decide). Those rows are history that undo can still restore, so the user closes the account instead; a test pins this. The P2b1 final review asked for two more changes in `isAccountInUse`. Rows that use the account's transfer payee now count as use. A payee that remembers one of the account's linked categories no longer blocks the delete; the delete clears `last_category_id` instead.

**Files:**
- Modify: `src/shared/api/transactions.ts`, `src/server/transactions/transaction-commands.ts`, `src/server/transactions/transaction-routes.ts`, `src/server/accounts/account-commands.ts`
- Test: `src/server/transactions/delete-transaction.test.ts`, `src/server/accounts/account-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 5–6 (`loadAggregate`, `softDelete`, `assertConfirmed`).
- Produces:
  - `deleteTransactionRequestSchema` (`{ confirmReconciled = false }`; the body may be omitted).
  - `deleteLabel` (`Delete transaction "P"`), `deleteTransaction(rec, id, { now, confirmReconciled }): Promise<{ payeeName }>`.
  - Route `DELETE /:id` → 200 `{ id }`.
  - `deleteAccount` clears `payee.last_category_id` for the account's linked categories; `isAccountInUse` also checks `payee_id` = the account's transfer payee in transactions, lines, schedules and schedule lines.

- [ ] **Step 1: Write the failing tests**

Create `src/server/transactions/delete-transaction.test.ts`:

```ts
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountListResponse } from '../../shared/api/accounts';
import { ledgerLine, subtransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, createTransaction, ledgerLines } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const remove = (id: string, body?: object) => ctx.client.send('DELETE', `/api/transactions/${id}`, body);
const deletedAt = async (table: typeof transaction | typeof subtransaction, id: string) =>
  (await t.db.select({ deletedAt: table.deletedAt }).from(table).where(eq(table.id, id)))[0]!.deletedAt;

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  return { checking, savings, groceries };
}

describe('DELETE /api/transactions/:id', () => {
  it('soft-deletes a transaction, which leaves the budget and the balance, as one undoable command', async () => {
    const { checking, groceries } = await setUp();
    const txn = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeName: 'Biedronka',
      categoryId: groceries.id,
      amount: -1_000,
    });
    const before = await snapshot(t.db);

    expect(await json(await remove(txn.id))).toEqual({ status: 200, body: { id: txn.id } });
    expect(await deletedAt(transaction, txn.id)).toEqual(ctx.clock.now());
    expect((await ctx.client.get(`/api/transactions/${txn.id}`)).status).toBe(404);
    expect(await ledgerLines(t.db, eq(ledgerLine.txnId, txn.id))).toEqual([]);
    const { accounts } = (await json<AccountListResponse>(await ctx.client.get('/api/accounts'))).body;
    expect(accounts.find((a) => a.id === checking.id)!.balance.working).toBe(100_000);
    // Deleted transactions still count as history: the account can be closed, not deleted (P2b1 decision 20).
    expect((await json(await ctx.client.send('DELETE', `/api/accounts/${checking.id}`))).body).toMatchObject({
      code: 'account_in_use',
    });
    const after = await snapshot(t.db);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Delete transaction "Biedronka"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('deletes both sides of a transfer, from either side', async () => {
    const { checking, savings } = await setUp();
    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: savings.transferPayeeId,
      amount: -500,
    });
    const received = sent.transfer!.transactionId;
    expect((await remove(received)).status).toBe(200);
    for (const id of [sent.id, received]) expect(await deletedAt(transaction, id)).toEqual(ctx.clock.now());
    expect(await ledgerLines(t.db, inArray(ledgerLine.txnId, [sent.id, received]))).toEqual([]);
  });

  it('deletes a split with the counterparts of its transfer lines', async () => {
    const { checking, savings, groceries } = await setUp();
    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -300,
      lines: [
        { amount: -100, categoryId: groceries.id },
        { amount: -200, payeeId: savings.transferPayeeId },
      ],
    });
    const counterpart = split.lines[1]!.transfer!.transactionId;
    const before = await snapshot(t.db);

    expect((await remove(split.id)).status).toBe(200);
    expect(await deletedAt(transaction, counterpart)).toEqual(ctx.clock.now());
    // The lines stay live, but the ledger drops them with their deleted split.
    for (const line of split.lines) expect(await deletedAt(subtransaction, line.id)).toBeNull();
    expect(await ledgerLines(t.db, inArray(ledgerLine.txnId, [split.id, counterpart]))).toEqual([]);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('refuses a split line’s counterpart, asks to confirm reconciled rows, and 404s unknown transactions', async () => {
    const { checking, savings } = await setUp();
    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -300,
      lines: [{ amount: -100 }, { amount: -200, payeeId: savings.transferPayeeId }],
    });
    expect(await json(await remove(split.lines[1]!.transfer!.transactionId))).toEqual({
      status: 422,
      body: {
        code: 'split_counterpart',
        message: 'This transfer is a line of a split in "mBank": remove the line there.',
      },
    });

    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: savings.transferPayeeId,
      amount: -500,
    });
    const received = sent.transfer!.transactionId;
    await t.db.update(transaction).set({ cleared: 'reconciled' }).where(eq(transaction.id, received));
    expect(await json(await remove(sent.id))).toEqual({
      status: 409,
      body: { code: 'confirm_reconciled', message: 'This changes a reconciled transaction. Confirm to go ahead.' },
    });
    expect((await remove(sent.id, { confirmReconciled: true })).status).toBe(200);
    for (const id of [sent.id, crypto.randomUUID()]) {
      expect(await json(await remove(id))).toEqual({
        status: 404,
        body: { code: 'not_found', message: 'Transaction not found.' },
      });
    }
  });
});
```

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-routes.test.ts b/src/server/accounts/account-routes.test.ts
index 612b61d..8ae4d94 100644
--- a/src/server/accounts/account-routes.test.ts
+++ b/src/server/accounts/account-routes.test.ts
@@ -2,7 +2,16 @@ import { and, eq } from 'drizzle-orm';
 import { afterEach, beforeEach, describe, expect, it } from 'vitest';
 import type { AccountDto } from '../../shared/api/accounts';
 import { systemCategoryId, systemGroupId, systemPayeeId } from '../db/lookups';
-import { account, assignment, category, payee, target, transaction } from '../db/schema';
+import {
+  account,
+  assignment,
+  category,
+  payee,
+  scheduledSubtransaction,
+  scheduledTransaction,
+  target,
+  transaction,
+} from '../db/schema';
 import { createTestApp, type TestApp } from '../test/app';
 import { setUpBudget } from '../test/auth';
 import { createTestDatabase, type TestDatabase } from '../test/db';
@@ -407,6 +416,45 @@ describe('DELETE /api/accounts/:id', () => {
     expect(await snapshot(t.db)).toEqual(after);
   });
 
+  it('clears payees that remember a linked category, and refuses while rows use the transfer payee', async () => {
+    const loan = await createAccount(ctx.client, {
+      name: 'Car',
+      type: 'auto_loan',
+      minPayment: 1,
+      createPairedCategory: true,
+    });
+    const [bank] = await t.db
+      .insert(payee)
+      .values({ name: 'Bank', lastCategoryId: loan.pairedCategoryId })
+      .returning();
+    const before = await snapshot(t.db);
+    expect((await ctx.client.send('DELETE', `/api/accounts/${loan.id}`)).status).toBe(200);
+    expect((await t.db.select().from(payee).where(eq(payee.id, bank!.id)))[0]!.lastCategoryId).toBeNull();
+    await ctx.client.post('/api/undo');
+    expect(await snapshot(t.db)).toEqual(before);
+
+    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
+    const checking = await createAccount(ctx.client, { name: 'mBank' });
+    const [schedule] = await t.db
+      .insert(scheduledTransaction)
+      .values({
+        accountId: checking.id,
+        amount: -1,
+        isSplit: true,
+        frequency: 'monthly',
+        anchorDate: '2026-12-01',
+        nextDate: '2026-12-01',
+      })
+      .returning();
+    // A line naming the transfer payee without its account (the API never writes one) still blocks the delete.
+    await t.db
+      .insert(scheduledSubtransaction)
+      .values({ scheduledId: schedule!.id, amount: -1, payeeId: savings.transferPayeeId });
+    expect((await json(await ctx.client.send('DELETE', `/api/accounts/${savings.id}`))).body).toMatchObject({
+      code: 'account_in_use',
+    });
+  });
+
   it('refuses while anything else refers to the account or its linked category', async () => {
     const checking = await createAccount(ctx.client, { name: 'mBank' });
     const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
PATCH
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/transactions/delete-transaction.test.ts src/server/accounts/account-routes.test.ts`
Expected: FAIL, `Tests  5 failed | 18 passed (23)`: the transaction deletes get 404s, and the account delete is refused (`expected 422 to be 200`) because a payee remembers the paired category.

- [ ] **Step 3: Add the delete command and route**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/transaction-commands.ts b/src/server/transactions/transaction-commands.ts
index 5671e0f..35c719d 100644
--- a/src/server/transactions/transaction-commands.ts
+++ b/src/server/transactions/transaction-commands.ts
@@ -8,7 +8,7 @@ import { findOrCreatePayee } from '../payees/payee-commands';
 import { accountsOf, type Aggregate, draftOf, loadAggregate, storedRates } from './aggregate';
 import { type Draft, type DraftLine, type Plan, planTransaction, type RowPlan } from './plan';
 import { findAccount } from './rules';
-import { insertPlan, insertSchedule, rememberCategory, syncPlan } from './write';
+import { insertPlan, insertSchedule, rememberCategory, softDelete, syncPlan } from './write';
 
 export interface SavedTransaction {
   kind: 'transaction' | 'scheduled';
@@ -277,3 +277,31 @@ export async function updateTransaction(
   }
   return { payeeName: plan.payee?.name ?? null };
 }
+
+/** "Delete transaction "Biedronka"" */
+export const deleteLabel = (r: { payeeName: string | null }) =>
+  r.payeeName === null ? 'Delete transaction' : `Delete transaction "${r.payeeName}"`;
+
+/**
+ * Spec §10: deleting one side of a transfer deletes both; deleting a split deletes the counterparts of its transfer
+ * lines (its lines leave the budget with it). Everything is soft-deleted. A split line's counterpart is removed by
+ * editing the split.
+ */
+export async function deleteTransaction(
+  rec: ChangeRecorder,
+  id: string,
+  context: { now: Date; confirmReconciled: boolean },
+): Promise<{ payeeName: string | null }> {
+  const agg = await loadAggregate(rec.tx, id);
+  if (agg.owner) {
+    const split = await findAccount(rec.tx, agg.owner.parent.accountId);
+    throw new DomainError(
+      'split_counterpart',
+      `This transfer is a line of a split in "${split!.name}": remove the line there.`,
+    );
+  }
+  const rows = [agg.main, agg.counterpart, ...agg.lines.map((l) => l.counterpart)].filter((r) => r !== null);
+  assertConfirmed(rows.some((r) => r.cleared === 'reconciled'), context.confirmReconciled);
+  await softDelete(rec, rows.map((r) => r.id), context.now);
+  return { payeeName: await payeeNameOf(rec, agg.main.payeeId) };
+}
diff --git a/src/server/transactions/transaction-routes.ts b/src/server/transactions/transaction-routes.ts
index 74ba745..63b22b9 100644
--- a/src/server/transactions/transaction-routes.ts
+++ b/src/server/transactions/transaction-routes.ts
@@ -1,8 +1,9 @@
 import { Hono } from 'hono';
-import { idParamSchema } from '../../shared/api/common';
+import { idParamSchema, type IdResponse } from '../../shared/api/common';
 import {
   createTransactionRequestSchema,
   type CreateTransactionResponse,
+  deleteTransactionRequestSchema,
   type TransactionDto,
   updateTransactionRequestSchema,
 } from '../../shared/api/transactions';
@@ -11,7 +12,14 @@ import { todayIn } from '../clock';
 import { runCommand } from '../commands/run-command';
 import type { AppDeps } from '../http/app';
 import { validate } from '../http/validate';
-import { createTransaction, editLabel, savedLabel, updateTransaction } from './transaction-commands';
+import {
+  createTransaction,
+  deleteLabel,
+  deleteTransaction,
+  editLabel,
+  savedLabel,
+  updateTransaction,
+} from './transaction-commands';
 import { getTransaction } from './transaction-queries';
 
 /** /api/transactions (spec §10 "Transactions and related workflows"): every change is one undoable command. */
@@ -38,5 +46,12 @@ export function transactionRoutes(deps: AppDeps) {
       const context = { today: today(), now: deps.clock.now() };
       await runCommand(deps, editLabel, (rec) => updateTransaction(rec, id, body, context));
       return c.json<TransactionDto>(await getTransaction(deps.db, id));
+    })
+    .delete('/:id', validate('param', idParamSchema), validate('json', deleteTransactionRequestSchema), async (c) => {
+      const { id } = c.req.valid('param');
+      const { confirmReconciled } = c.req.valid('json');
+      const context = { now: deps.clock.now(), confirmReconciled };
+      await runCommand(deps, deleteLabel, (rec) => deleteTransaction(rec, id, context));
+      return c.json<IdResponse>({ id });
     });
 }
diff --git a/src/shared/api/transactions.ts b/src/shared/api/transactions.ts
index 43bf42d..b22a59d 100644
--- a/src/shared/api/transactions.ts
+++ b/src/shared/api/transactions.ts
@@ -121,6 +121,12 @@ export const updateTransactionRequestSchema = z
 
 export type UpdateTransactionRequest = z.infer<typeof updateTransactionRequestSchema>;
 
+/**
+ * DELETE /api/transactions/:id (body optional): deletes the transaction with its transfer side or the counterparts of
+ * its split lines. Deleting reconciled rows needs `confirmReconciled: true` (409 `confirm_reconciled` otherwise).
+ */
+export const deleteTransactionRequestSchema = z.object({ confirmReconciled: z.boolean().default(false) });
+
 /** The other side of a transfer. */
 export interface TransferDto {
   accountId: string;
PATCH
```

- [ ] **Step 4: Account deletion follow-ups**

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-commands.ts b/src/server/accounts/account-commands.ts
index 0e21670..32f1f1f 100644
--- a/src/server/accounts/account-commands.ts
+++ b/src/server/accounts/account-commands.ts
@@ -188,10 +188,12 @@ export async function setAccountClosed(rec: ChangeRecorder, id: string, closed:
 
 /**
  * True when anything but the account's own starting balance, transfer payee and linked categories (with their
- * assignments and target) refers to the account. Soft-deleted transactions count: they still reference the rows.
+ * assignments and target) refers to the account, its transfer payee or its linked categories. Soft-deleted
+ * transactions count: they still reference the rows. A payee's remembered category doesn't: deleting clears it.
  */
 async function isAccountInUse(db: Executor, id: string): Promise<boolean> {
   const linked = db.select({ id: category.id }).from(category).where(eq(category.linkedAccountId, id));
+  const transferPayee = db.select({ id: payee.id }).from(payee).where(eq(payee.transferAccountId, id));
   const checks = [
     db
       .select({ id: transaction.id })
@@ -201,12 +203,19 @@ async function isAccountInUse(db: Executor, id: string): Promise<boolean> {
           and(eq(transaction.accountId, id), eq(transaction.isStartingBalance, false)),
           eq(transaction.transferAccountId, id),
           inArray(transaction.categoryId, linked),
+          inArray(transaction.payeeId, transferPayee),
         ),
       ),
     db
       .select({ id: subtransaction.id })
       .from(subtransaction)
-      .where(or(eq(subtransaction.transferAccountId, id), inArray(subtransaction.categoryId, linked))),
+      .where(
+        or(
+          eq(subtransaction.transferAccountId, id),
+          inArray(subtransaction.categoryId, linked),
+          inArray(subtransaction.payeeId, transferPayee),
+        ),
+      ),
     db
       .select({ id: scheduledTransaction.id })
       .from(scheduledTransaction)
@@ -215,19 +224,23 @@ async function isAccountInUse(db: Executor, id: string): Promise<boolean> {
           eq(scheduledTransaction.accountId, id),
           eq(scheduledTransaction.transferAccountId, id),
           inArray(scheduledTransaction.categoryId, linked),
+          inArray(scheduledTransaction.payeeId, transferPayee),
         ),
       ),
     db
       .select({ id: scheduledSubtransaction.id })
       .from(scheduledSubtransaction)
       .where(
-        or(eq(scheduledSubtransaction.transferAccountId, id), inArray(scheduledSubtransaction.categoryId, linked)),
+        or(
+          eq(scheduledSubtransaction.transferAccountId, id),
+          inArray(scheduledSubtransaction.categoryId, linked),
+          inArray(scheduledSubtransaction.payeeId, transferPayee),
+        ),
       ),
     db
       .select({ id: loanInterestOverride.accountId })
       .from(loanInterestOverride)
       .where(eq(loanInterestOverride.accountId, id)),
-    db.select({ id: payee.id }).from(payee).where(inArray(payee.lastCategoryId, linked)),
   ];
   for (const check of checks) if ((await check.limit(1)).length > 0) return true;
   return false;
@@ -252,6 +265,7 @@ export async function deleteAccount(rec: ChangeRecorder, id: string): Promise<{
   if (linkedIds.length > 0) {
     await rec.delete(target, inArray(target.categoryId, linkedIds));
     await rec.delete(assignment, inArray(assignment.categoryId, linkedIds));
+    await rec.update(payee, inArray(payee.lastCategoryId, linkedIds), { lastCategoryId: null });
   }
   await rec.delete(transaction, eq(transaction.accountId, id));
   await rec.delete(payee, eq(payee.transferAccountId, id));
PATCH
```

- [ ] **Step 5: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/transactions/delete-transaction.test.ts src/server/accounts/account-routes.test.ts`
Expected: `Tests  23 passed (23)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  45 passed (45)`, `Tests  408 passed (408)`; both checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared/api/transactions.ts src/server/transactions src/server/accounts
git commit -m "feat(server): delete transactions; account deletion follow-ups" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: The register — search, filters, cursor pagination and balances

Spec §10 "Search and bulk operations" and §11 "Register". `GET /api/transactions` lists live transactions newest first by (date desc, id desc), in pages of `limit` (1–200, default 50). `nextCursor` (an opaque `YYYY-MM-DD_<id>`) continues after the last row. All filters are optional and combine:
- `accountId`: one register, which also returns the account's cleared, uncleared and working balances in its currency and in PLN, from P2b1's `getAccount`. Without it the response covers all accounts and `balances` is null.
- `q`: case-insensitive text in the payee name, memo or category name of the transaction or of any of its live split lines; `%`, `_` and `\` match literally.
- `from` / `to`: an inclusive date range. `minAmount` / `maxAmount`: an inclusive range of the signed native amount.
- `categoryId`, `payeeId`: the transaction's own, or one of its split lines'.
- `flag`, `cleared` (`uncleared` | `cleared` | `reconciled`), `unapproved=true`.

Rows are full `TransactionDto`s (account, payee and category names, transfer info, split lines). Starting balances and the counterparts of split lines are rows like any other.

**Files:**
- Modify: `src/shared/api/transactions.ts`, `src/server/transactions/transaction-queries.ts`, `src/server/transactions/transaction-routes.ts`
- Test: `src/server/transactions/register.test.ts`

**Interfaces:**
- Consumes: `getAccount` (P2b1 `src/server/accounts/account-queries.ts`); Task 2's `loadTransactions`.
- Produces:
  - `CLEARED_STATUSES`, `registerCursorSchema`, `registerQuerySchema` / `RegisterQuery`, `RegisterResponse { transactions, nextCursor, balances: { balance, balanceBase } | null }`.
  - `listRegister(db, query): Promise<RegisterResponse>` (404 `Account not found.` for an unknown `accountId`).
  - Route `GET /` → 200 `RegisterResponse`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/transactions/register.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RegisterResponse, TransactionDto } from '../../shared/api/transactions';
import { transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, createPayee, createTransaction } from '../test/fixtures';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const register = async (query: Record<string, string>) => {
  const res = await json<RegisterResponse>(await ctx.client.get(`/api/transactions?${new URLSearchParams(query)}`));
  if (res.status !== 200) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
const memos = (page: RegisterResponse) => page.transactions.map((txn) => txn.memo);

async function setUp() {
  const checking = await createAccount(ctx.client, {
    name: 'mBank',
    startingBalance: 100_000,
    startingDate: '2026-11-01',
  });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings', startingDate: '2026-11-01' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  const household = await createCategory(ctx.client, food.id, 'Household');
  const shop = await createPayee(ctx.client, 'Biedronka');
  const add = (body: object) => createTransaction(ctx.client, { accountId: checking.id, amount: -100, ...body });
  const weekly = await add({
    date: '2026-11-10',
    payeeId: shop.id,
    categoryId: groceries.id,
    memo: 'weekly',
    amount: -1_000,
    cleared: 'cleared',
  });
  const transfer = await add({ date: '2026-11-15', payeeId: savings.transferPayeeId, memo: 'saving', amount: -5_000 });
  const split = await add({
    date: '2026-11-18',
    memo: 'mixed',
    amount: -300,
    flag: 'red',
    lines: [
      { amount: -100, categoryId: groceries.id, memo: '50% off' },
      { amount: -200, categoryId: household.id, payeeId: shop.id },
    ],
  });
  return { checking, savings, groceries, household, shop, weekly, transfer, split };
}

describe('GET /api/transactions', () => {
  it('lists an account’s transactions newest first, with names, transfers, split lines and balances', async () => {
    const { checking, savings, weekly, transfer, split } = await setUp();
    const page = await register({ accountId: checking.id });

    expect(page.transactions.map((txn) => [txn.date, txn.memo])).toEqual([
      ['2026-11-18', 'mixed'],
      ['2026-11-15', 'saving'],
      ['2026-11-10', 'weekly'],
      ['2026-11-01', null],
    ]);
    const byId = (id: string) => page.transactions.find((txn) => txn.id === id)!;
    expect(byId(weekly.id)).toEqual(weekly);
    expect(byId(transfer.id).transfer).toMatchObject({ accountId: savings.id, accountName: 'Savings' });
    expect(byId(split.id).lines.map((l) => [l.categoryName, l.payeeName])).toEqual([
      ['Groceries', null],
      ['Household', 'Biedronka'],
    ]);
    expect(page.transactions.at(-1)).toMatchObject({ isStartingBalance: true, payeeName: 'Starting Balance' });
    const balance = { cleared: 99_000, uncleared: -5_300, working: 93_700 };
    expect(page.balances).toEqual({ balance, balanceBase: balance });
    expect(page.nextCursor).toBeNull();
    expect(memos(await register({ accountId: savings.id }))).toEqual(['saving', null]);
  });

  it('pages by (date desc, id desc) with a cursor', async () => {
    const { checking } = await setUp();
    for (const memo of ['a', 'b', 'c']) {
      await createTransaction(ctx.client, { accountId: checking.id, amount: -1, memo });
    }
    const all = (await register({ accountId: checking.id })).transactions;
    expect(all.map((txn) => txn.date)).toEqual([...all.map((txn) => txn.date)].sort().reverse());

    const seen: TransactionDto[] = [];
    let cursor: string | null = null;
    do {
      const query = { accountId: checking.id, limit: '3', ...(cursor ? { cursor } : {}) };
      const page: RegisterResponse = await register(query);
      expect(page.transactions.length).toBeLessThanOrEqual(3);
      seen.push(...page.transactions);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.map((txn) => txn.id)).toEqual(all.map((txn) => txn.id));
    // Within a date, ids descend.
    const today = all.filter((txn) => txn.date === '2026-11-20').map((txn) => txn.id);
    expect(today).toEqual([...today].sort().reverse());

    const status = async (query: string) => (await ctx.client.get(`/api/transactions?${query}`)).status;
    expect(await status('cursor=nope')).toBe(400);
    expect(await status('limit=201')).toBe(400);
    expect(await status('limit=0')).toBe(400);
  });

  it('searches text in payees, memos and categories, split lines included', async () => {
    await setUp();
    expect(memos(await register({ q: 'BIED' }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ q: 'groc' }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ q: 'saving' }))).toEqual(['saving', 'saving']);
    expect(memos(await register({ q: 'Transfer : mBank' }))).toEqual(['saving']);
    // % is a literal: only the split line's memo "50% off" matches.
    expect(memos(await register({ q: '50%' }))).toEqual(['mixed']);
    expect(memos(await register({ q: '_' }))).toEqual([]);
  });

  it('filters by dates, amounts, account, category, payee, flag, cleared state and approval', async () => {
    const { checking, savings, groceries, household, shop, weekly } = await setUp();
    await ctx.client.send('PATCH', `/api/transactions/${weekly.id}`, { approved: false });

    expect(memos(await register({ from: '2026-11-10', to: '2026-11-15' }))).toEqual(['saving', 'saving', 'weekly']);
    expect(memos(await register({ minAmount: '-1000', maxAmount: '-300' }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ accountId: savings.id, minAmount: '1' }))).toEqual(['saving']);
    expect(memos(await register({ categoryId: groceries.id }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ categoryId: household.id }))).toEqual(['mixed']);
    expect(memos(await register({ payeeId: shop.id }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ flag: 'red' }))).toEqual(['mixed']);
    expect(memos(await register({ accountId: checking.id, cleared: 'cleared' }))).toEqual(['weekly', null]);
    expect(memos(await register({ unapproved: 'true' }))).toEqual(['weekly']);
    expect((await register({ unapproved: 'false' })).transactions).toHaveLength(6);
    expect((await register({})).balances).toBeNull();
  });

  it('leaves out deleted transactions and refuses invalid filters', async () => {
    const { checking, weekly } = await setUp();
    await t.db.update(transaction).set({ deletedAt: new Date() }).where(eq(transaction.id, weekly.id));
    expect(memos(await register({ accountId: checking.id }))).toEqual(['mixed', 'saving', null]);

    const errors = async (query: string) =>
      (await json<{ fieldErrors: Record<string, string[]> }>(await ctx.client.get(`/api/transactions?${query}`))).body
        .fieldErrors;
    expect(await errors('from=2026-11-15&to=2026-11-10')).toEqual({
      to: ['The end date must not be before the start date.'],
    });
    expect(await errors('minAmount=1.5')).toEqual({ minAmount: ['Enter a whole amount in minor units.'] });
    expect(Object.keys(await errors('flag=pink&cleared=maybe'))).toEqual(['flag', 'cleared']);
    expect(await json(await ctx.client.get(`/api/transactions?accountId=${crypto.randomUUID()}`))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Account not found.' },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/transactions/register.test.ts`
Expected: FAIL, `Tests  5 failed (5)`: `register failed: 404 {"code":"not_found","message":"Not found."}`.

- [ ] **Step 3: Add the query schema and the response type**

```bash
git apply <<'PATCH'
diff --git a/src/shared/api/transactions.ts b/src/shared/api/transactions.ts
index b22a59d..5ba52ae 100644
--- a/src/shared/api/transactions.ts
+++ b/src/shared/api/transactions.ts
@@ -1,12 +1,13 @@
 import { z } from 'zod';
-import { fxRateSchema } from './accounts';
+import { type AccountBalances, fxRateSchema } from './accounts';
 import { idSchema, isoDateSchema, moneySchema, nameSchema } from './common';
 
 export const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
 export type FlagColor = (typeof FLAG_COLORS)[number];
 
+export const CLEARED_STATUSES = ['uncleared', 'cleared', 'reconciled'] as const;
 /** `reconciled` is set by the reconcile flow (P2d); users switch between the other two. */
-export type ClearedStatus = 'uncleared' | 'cleared' | 'reconciled';
+export type ClearedStatus = (typeof CLEARED_STATUSES)[number];
 
 export const flagSchema = z.enum(FLAG_COLORS);
 export const userClearedSchema = z.enum(['uncleared', 'cleared']);
@@ -127,6 +128,63 @@ export type UpdateTransactionRequest = z.infer<typeof updateTransactionRequestSc
  */
 export const deleteTransactionRequestSchema = z.object({ confirmReconciled: z.boolean().default(false) });
 
+/** Money in a query string: a whole number of minor units. */
+const queryMoneySchema = z
+  .string()
+  .regex(/^-?\d{1,16}$/, 'Enter a whole amount in minor units.')
+  .transform(Number)
+  .pipe(moneySchema);
+
+/** An opaque page position: the (date, id) of the last row of the previous page. */
+export const registerCursorSchema = z
+  .string()
+  .regex(/^\d{4}-\d{2}-\d{2}_[0-9a-f-]{36}$/i, 'Invalid cursor.')
+  .transform((cursor) => ({ date: cursor.slice(0, 10), id: cursor.slice(11).toLowerCase() }));
+
+/**
+ * GET /api/transactions (spec §10 "Search and bulk operations", §11 Register): newest first by (date desc, id desc),
+ * cursor-paginated. Every filter is optional and they combine with AND.
+ */
+export const registerQuerySchema = z
+  .object({
+    /** One account's register (with its balances); all accounts when omitted. */
+    accountId: idSchema.optional(),
+    /** Case-insensitive text in the payee, memo or category name, including split lines. */
+    q: z.string().trim().min(1).max(100).optional(),
+    /** Inclusive date range. */
+    from: isoDateSchema.optional(),
+    to: isoDateSchema.optional(),
+    /** Inclusive range of the signed native amount. */
+    minAmount: queryMoneySchema.optional(),
+    maxAmount: queryMoneySchema.optional(),
+    /** The transaction's category or one of its split lines'. */
+    categoryId: idSchema.optional(),
+    /** The transaction's payee or one of its split lines'. */
+    payeeId: idSchema.optional(),
+    flag: flagSchema.optional(),
+    cleared: z.enum(CLEARED_STATUSES).optional(),
+    /** `true`: only transactions waiting for approval. */
+    unapproved: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
+    cursor: registerCursorSchema.optional(),
+    /** Page size, 1–200 (default 50). */
+    limit: z
+      .string()
+      .regex(/^\d{1,3}$/, 'Use 1 to 200.')
+      .transform(Number)
+      .pipe(z.int().min(1, 'Use 1 to 200.').max(200, 'Use 1 to 200.'))
+      .optional(),
+  })
+  .refine((query) => !query.from || !query.to || query.from <= query.to, {
+    path: ['to'],
+    message: 'The end date must not be before the start date.',
+  })
+  .refine(({ minAmount: min, maxAmount: max }) => min === undefined || max === undefined || min <= max, {
+    path: ['maxAmount'],
+    message: 'The largest amount must not be below the smallest.',
+  });
+
+export type RegisterQuery = z.infer<typeof registerQuerySchema>;
+
 /** The other side of a transfer. */
 export interface TransferDto {
   accountId: string;
@@ -194,3 +252,12 @@ export interface TransactionDto {
 export type CreateTransactionResponse =
   | { kind: 'transaction'; transaction: TransactionDto }
   | { kind: 'scheduled'; scheduledId: string; date: string };
+
+/** GET /api/transactions */
+export interface RegisterResponse {
+  transactions: TransactionDto[];
+  /** Pass as `cursor` to get the next page; null on the last page. */
+  nextCursor: string | null;
+  /** With `accountId`: the register header's cleared, uncleared and working balances (natively and in PLN). */
+  balances: { balance: AccountBalances; balanceBase: AccountBalances } | null;
+}
PATCH
```

- [ ] **Step 4: Add the register query and route**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/transaction-queries.ts b/src/server/transactions/transaction-queries.ts
index 78201d2..1cdf275 100644
--- a/src/server/transactions/transaction-queries.ts
+++ b/src/server/transactions/transaction-queries.ts
@@ -1,8 +1,9 @@
-import { and, asc, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
+import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, type SQL, sql } from 'drizzle-orm';
 import { alias } from 'drizzle-orm/pg-core';
 import { BASE_CURRENCY } from '../../shared/api/accounts';
-import type { SplitLineDto, TransactionDto } from '../../shared/api/transactions';
+import type { RegisterQuery, RegisterResponse, SplitLineDto, TransactionDto } from '../../shared/api/transactions';
 import { effectiveRate, type Money } from '../../engine';
+import { getAccount } from '../accounts/account-queries';
 import type { Executor } from '../db/client';
 import { account, category, payee, subtransaction, transaction } from '../db/schema';
 import { AppError } from '../http/errors';
@@ -121,3 +122,60 @@ export async function getTransaction(db: Executor, id: string): Promise<Transact
   if (!found) throw new AppError(404, 'not_found', 'Transaction not found.');
   return found;
 }
+
+const DEFAULT_PAGE_SIZE = 50;
+
+/** A live split line of the row matching `condition` (written against aliases s, sp and sc). */
+const lineWhere = (condition: SQL) => sql`exists (
+  select 1 from ${subtransaction} s
+  left join ${payee} sp on sp.id = s.payee_id
+  left join ${category} sc on sc.id = s.category_id
+  where s.txn_id = ${transaction.id} and s.deleted_at is null and ${condition})`;
+
+/** ILIKE pattern for a literal substring: %, _ and \ in the text match only themselves. */
+const containing = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
+
+function registerWhere(query: RegisterQuery): SQL | undefined {
+  const pattern = query.q === undefined ? null : containing(query.q);
+  return and(
+    query.accountId ? eq(transaction.accountId, query.accountId) : undefined,
+    pattern === null
+      ? undefined
+      : or(
+          ilike(payee.name, pattern),
+          ilike(transaction.memo, pattern),
+          ilike(category.name, pattern),
+          lineWhere(sql`(s.memo ilike ${pattern} or sp.name ilike ${pattern} or sc.name ilike ${pattern})`),
+        ),
+    query.from ? gte(transaction.date, query.from) : undefined,
+    query.to ? lte(transaction.date, query.to) : undefined,
+    query.minAmount === undefined ? undefined : gte(transaction.amount, query.minAmount),
+    query.maxAmount === undefined ? undefined : lte(transaction.amount, query.maxAmount),
+    query.categoryId
+      ? or(eq(transaction.categoryId, query.categoryId), lineWhere(sql`s.category_id = ${query.categoryId}`))
+      : undefined,
+    query.payeeId
+      ? or(eq(transaction.payeeId, query.payeeId), lineWhere(sql`s.payee_id = ${query.payeeId}`))
+      : undefined,
+    query.flag ? eq(transaction.flag, query.flag) : undefined,
+    query.cleared ? eq(transaction.cleared, query.cleared) : undefined,
+    query.unapproved ? eq(transaction.approved, false) : undefined,
+    query.cursor
+      ? sql`(${transaction.date}, ${transaction.id}) < (${query.cursor.date}::date, ${query.cursor.id}::uuid)`
+      : undefined,
+  );
+}
+
+/** Spec §10 "Search" and §11 Register: one page of matching transactions, plus the account's balances. */
+export async function listRegister(db: Executor, query: RegisterQuery): Promise<RegisterResponse> {
+  const balances = query.accountId ? await getAccount(db, query.accountId) : null;
+  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
+  const rows = await loadTransactions(db, registerWhere(query), limit + 1);
+  const page = rows.slice(0, limit);
+  const last = page.at(-1);
+  return {
+    transactions: page,
+    nextCursor: rows.length > limit && last ? `${last.date}_${last.id}` : null,
+    balances: balances && { balance: balances.balance, balanceBase: balances.balanceBase },
+  };
+}
diff --git a/src/server/transactions/transaction-routes.ts b/src/server/transactions/transaction-routes.ts
index 63b22b9..e3fc408 100644
--- a/src/server/transactions/transaction-routes.ts
+++ b/src/server/transactions/transaction-routes.ts
@@ -4,6 +4,8 @@ import {
   createTransactionRequestSchema,
   type CreateTransactionResponse,
   deleteTransactionRequestSchema,
+  type RegisterResponse,
+  registerQuerySchema,
   type TransactionDto,
   updateTransactionRequestSchema,
 } from '../../shared/api/transactions';
@@ -20,7 +22,7 @@ import {
   savedLabel,
   updateTransaction,
 } from './transaction-commands';
-import { getTransaction } from './transaction-queries';
+import { getTransaction, listRegister } from './transaction-queries';
 
 /** /api/transactions (spec §10 "Transactions and related workflows"): every change is one undoable command. */
 export function transactionRoutes(deps: AppDeps) {
@@ -28,6 +30,9 @@ export function transactionRoutes(deps: AppDeps) {
 
   return new Hono<AuthedEnv>()
     .use('*', requireSession(deps))
+    .get('/', validate('query', registerQuerySchema), async (c) =>
+      c.json<RegisterResponse>(await listRegister(deps.db, c.req.valid('query'))),
+    )
     .post('/', validate('json', createTransactionRequestSchema), async (c) => {
       const body = c.req.valid('json');
       const saved = await runCommand(deps, savedLabel, (rec) => createTransaction(rec, body, today()));
PATCH
```

- [ ] **Step 5: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/transactions/register.test.ts`
Expected: `Tests  5 passed (5)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  46 passed (46)`, `Tests  413 passed (413)`; both checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared/api/transactions.ts src/server/transactions
git commit -m "feat(server): register search with cursor pagination and balances" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Bulk operations; P2c docs

Spec §10 "Search and bulk operations" and "Undo/redo". `POST /api/transactions/bulk { ids, action, confirmReconciled? }` applies one action to up to 500 distinct transactions as **one** undoable command. The actions are `categorize { categoryId | null }`, `setPayee { payeeId | null }`, `setFlag { flag | null }`, `setCleared { cleared }`, `approve`, `moveAccount { accountId }` (same currency) and `delete`.
- Each row goes through the single-row `updateTransaction` / `deleteTransaction`, so every §5.5 rule, the reconciled confirmation and the transfer mirroring apply per row.
- The first row that fails aborts everything; its error keeps its status and code and names the row (`fieldErrors: { 'ids.3': [message] }`).
- Deleting skips rows already deleted with an earlier row: the other side of a selected transfer, or the counterpart of a line whose split is selected too.
- Rows are processed one at a time, so no statement gets a large IN list; 500 rows take about 1.4 s, and undoing them about 0.5 s.

A test shows that an undo conflict on one row of a bulk command rolls back the rows already replayed (the P2b1 final review asked for a multi-row conflict test). The task closes with the spec amendments (§5.5, §9, §10, §13), the engineering notes and the carry-over.

**Files:**
- Create: `src/server/transactions/bulk.ts`
- Modify: `src/shared/api/transactions.ts`, `src/server/transactions/transaction-commands.ts`, `src/server/transactions/transaction-routes.ts`
- Modify (docs): `docs/superpowers/specs/2026-11-19-core-budgeting-design.md`, `docs/superpowers/notes/engineering-notes.md`, `docs/superpowers/notes/p2-carry-over.md`
- Test: `src/server/transactions/bulk.test.ts`

**Interfaces:**
- Consumes: Tasks 5–7.
- Produces:
  - `bulkActionSchema` / `BulkAction`, `bulkRequestSchema` / `BulkRequest`, `BulkResponse { ids }`.
  - `bulkLabel(request)` (`Categorize 3 transactions`, `Set the payee of 3 transactions`, `Flag 3 transactions` / `Remove the flag of 3 transactions`, `Mark 3 transactions cleared|uncleared`, `Approve 3 transactions`, `Move 3 transactions`, `Delete 3 transactions`; `1 transaction` in the singular).
  - `bulkUpdate(rec, request, context: EditContext): Promise<void>`.
  - `deleteTransaction` also returns the deleted `ids`.
  - Route `POST /bulk` → 200 `{ ids }`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/transactions/bulk.test.ts`:

```ts
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionDto } from '../../shared/api/transactions';
import { payee, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, createPayee, createTransaction } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const bulk = (ids: string[], action: object, extra: object = {}) =>
  ctx.client.post('/api/transactions/bulk', { ids, action, ...extra });
const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;
const undoLabel = async () =>
  (await json<{ undo: { label: string } }>(await ctx.client.get('/api/undo'))).body.undo.label;

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
  const wallet = await createAccount(ctx.client, { name: 'Wallet', type: 'cash' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  const shop = await createPayee(ctx.client, 'Biedronka');
  const add = (body: object = {}) => createTransaction(ctx.client, { accountId: checking.id, amount: -100, ...body });
  return { checking, savings, wallet, groceries, shop, add };
}

describe('POST /api/transactions/bulk', () => {
  it('categorizes the selection as one undoable command', async () => {
    const { groceries, shop, add } = await setUp();
    const rows = [await add({ payeeId: shop.id }), await add(), await add({ amount: 500 })];
    const ids = rows.map((r) => r.id);
    const before = await snapshot(t.db);

    expect(await json(await bulk(ids, { type: 'categorize', categoryId: groceries.id }))).toEqual({
      status: 200,
      body: { ids },
    });
    for (const id of ids) expect((await get(id)).categoryId).toBe(groceries.id);
    expect((await t.db.select().from(payee).where(eq(payee.id, shop.id)))[0]!.lastCategoryId).toBe(groceries.id);
    expect(await undoLabel()).toBe('Categorize 3 transactions');
    const after = await snapshot(t.db);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('rolls back the rows already replayed when undoing a bulk command hits a changed row', async () => {
    const { groceries, add } = await setUp();
    const rows = [await add(), await add(), await add()];
    await bulk(rows.map((r) => r.id), { type: 'categorize', categoryId: groceries.id });
    // Undo replays the newest change first, so the first row is checked last; change it outside the command layer.
    await t.db.update(transaction).set({ memo: 'changed elsewhere' }).where(eq(transaction.id, rows[0]!.id));
    const before = await snapshot(t.db);

    expect(await json(await ctx.client.post('/api/undo'))).toEqual({
      status: 409,
      body: { code: 'undo_conflict', message: "Can't undo: data changed since." },
    });
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('checks every row like a single edit and changes nothing when one fails', async () => {
    const { groceries, add } = await setUp();
    const loan = await createAccount(ctx.client, { name: 'Car', type: 'auto_loan' });
    const ok = await add();
    const tracking = await createTransaction(ctx.client, { accountId: loan.id, amount: -100 });
    const before = await snapshot(t.db);

    expect(await json(await bulk([ok.id, tracking.id], { type: 'categorize', categoryId: groceries.id }))).toEqual({
      status: 422,
      body: {
        code: 'category_not_allowed',
        message: "Transactions in tracking accounts don't take a category.",
        fieldErrors: { 'ids.1': ["Transactions in tracking accounts don't take a category."] },
      },
    });
    expect(await snapshot(t.db)).toEqual(before);
    expect(await json(await bulk([ok.id, crypto.randomUUID()], { type: 'approve' }))).toMatchObject({
      status: 404,
      body: { code: 'not_found', fieldErrors: { 'ids.1': ['Transaction not found.'] } },
    });
    const status = async (ids: string[], action: object) => (await bulk(ids, action)).status;
    expect(await status([], { type: 'approve' })).toBe(400);
    expect(await status([ok.id, ok.id], { type: 'approve' })).toBe(400);
    expect(await status([ok.id], { type: 'paint' })).toBe(400);
    expect(await status([ok.id], { type: 'categorize' })).toBe(400);
  });

  it('sets the payee, the flag and approval', async () => {
    const { shop, add } = await setUp();
    const ids = [(await add({ payeeName: 'Lidl' })).id, (await add()).id];
    await ctx.client.send('PATCH', `/api/transactions/${ids[0]}`, { approved: false });

    await bulk(ids, { type: 'setPayee', payeeId: shop.id });
    expect(await undoLabel()).toBe('Set the payee of 2 transactions');
    await bulk(ids, { type: 'setFlag', flag: 'purple' });
    expect(await undoLabel()).toBe('Flag 2 transactions');
    await bulk(ids, { type: 'approve' });
    expect(await undoLabel()).toBe('Approve 2 transactions');
    for (const id of ids) expect(await get(id)).toMatchObject({ payeeId: shop.id, flag: 'purple', approved: true });
    await bulk(ids, { type: 'setFlag', flag: null });
    expect(await undoLabel()).toBe('Remove the flag of 2 transactions');
    for (const id of ids) expect((await get(id)).flag).toBeNull();
  });

  it('sets the cleared state of each side, confirming reconciled rows', async () => {
    const { savings, add } = await setUp();
    const plain = await add();
    const sent = await add({ payeeId: savings.transferPayeeId });
    await t.db.update(transaction).set({ cleared: 'reconciled' }).where(eq(transaction.id, plain.id));

    expect(await json(await bulk([sent.id, plain.id], { type: 'setCleared', cleared: 'cleared' }))).toMatchObject({
      status: 409,
      body: { code: 'confirm_reconciled', fieldErrors: { 'ids.1': [expect.any(String)] } },
    });
    const clear = { type: 'setCleared', cleared: 'cleared' };
    expect((await bulk([sent.id, plain.id], clear, { confirmReconciled: true })).status).toBe(200);
    expect(await undoLabel()).toBe('Mark 2 transactions cleared');
    expect((await get(plain.id)).cleared).toBe('cleared');
    expect((await get(sent.id)).cleared).toBe('cleared');
    expect((await get(sent.transfer!.transactionId)).cleared).toBe('uncleared');
  });

  it('moves the selection to an account in the same currency', async () => {
    const { savings, wallet, add } = await setUp();
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    const plain = await add();
    const sent = await add({ payeeId: savings.transferPayeeId });

    await bulk([plain.id, sent.id], { type: 'moveAccount', accountId: wallet.id });
    expect(await undoLabel()).toBe('Move 2 transactions');
    expect((await get(plain.id)).accountId).toBe(wallet.id);
    expect(await get(sent.transfer!.transactionId)).toMatchObject({ payeeName: 'Transfer : Wallet' });
    expect((await json(await bulk([plain.id], { type: 'moveAccount', accountId: euro.id }))).body).toMatchObject({
      code: 'move_currency',
      fieldErrors: { 'ids.0': [expect.any(String)] },
    });
  });

  it('deletes the selection, including both sides of transfers and splits with their line counterparts', async () => {
    const { savings, add } = await setUp();
    const plain = await add();
    const sent = await add({ payeeId: savings.transferPayeeId });
    const split = await add({
      amount: -300,
      lines: [{ amount: -100 }, { amount: -200, payeeId: savings.transferPayeeId }],
    });
    const lineSide = split.lines[1]!.transfer!.transactionId;
    const ids = [lineSide, sent.transfer!.transactionId, plain.id, sent.id, split.id];
    const before = await snapshot(t.db);

    expect((await bulk(ids, { type: 'delete' })).status).toBe(200);
    const rows = await t.db.select().from(transaction).where(inArray(transaction.id, ids));
    expect(rows.map((r) => r.deletedAt)).toEqual(ids.map(() => ctx.clock.now()));
    expect(await undoLabel()).toBe('Delete 5 transactions');
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/transactions/bulk.test.ts`
Expected: FAIL, `Tests  7 failed (7)`: every bulk request gets a 404.

- [ ] **Step 3: Add the request schema**

```bash
git apply <<'PATCH'
diff --git a/src/shared/api/transactions.ts b/src/shared/api/transactions.ts
index 5ba52ae..929a23c 100644
--- a/src/shared/api/transactions.ts
+++ b/src/shared/api/transactions.ts
@@ -128,6 +128,41 @@ export type UpdateTransactionRequest = z.infer<typeof updateTransactionRequestSc
  */
 export const deleteTransactionRequestSchema = z.object({ confirmReconciled: z.boolean().default(false) });
 
+/** One edit for every selected transaction (spec §10 "Search and bulk operations"). */
+export const bulkActionSchema = z.discriminatedUnion('type', [
+  z.object({ type: z.literal('categorize'), categoryId: idSchema.nullable() }),
+  z.object({ type: z.literal('setPayee'), payeeId: idSchema.nullable() }),
+  z.object({ type: z.literal('setFlag'), flag: flagSchema.nullable() }),
+  z.object({ type: z.literal('setCleared'), cleared: userClearedSchema }),
+  z.object({ type: z.literal('approve') }),
+  /** Another account in the same currency. */
+  z.object({ type: z.literal('moveAccount'), accountId: idSchema }),
+  z.object({ type: z.literal('delete') }),
+]);
+
+export type BulkAction = z.infer<typeof bulkActionSchema>;
+
+/**
+ * POST /api/transactions/bulk: one undoable command. Each row gets exactly the checks of a single edit or delete;
+ * if any row fails, nothing changes and the error's `fieldErrors` names it (`ids.<index>`).
+ */
+export const bulkRequestSchema = z.object({
+  ids: z
+    .array(idSchema)
+    .min(1, 'Select at least one transaction.')
+    .max(500, 'Select at most 500 transactions.')
+    .refine((ids) => new Set(ids).size === ids.length, 'List each id once.'),
+  action: bulkActionSchema,
+  confirmReconciled: z.boolean().default(false),
+});
+
+export type BulkRequest = z.infer<typeof bulkRequestSchema>;
+
+/** The selected ids. */
+export interface BulkResponse {
+  ids: string[];
+}
+
 /** Money in a query string: a whole number of minor units. */
 const queryMoneySchema = z
   .string()
PATCH
```

- [ ] **Step 4: Add the bulk command and route**

Create `src/server/transactions/bulk.ts`:

```ts
import type { BulkAction, BulkRequest, UpdateTransactionRequest } from '../../shared/api/transactions';
import type { ChangeRecorder } from '../commands/recorder';
import { AppError } from '../http/errors';
import { loadAggregate } from './aggregate';
import { deleteTransaction, type EditContext, updateTransaction } from './transaction-commands';

const count = (n: number) => (n === 1 ? '1 transaction' : `${n} transactions`);

/** "Categorize 3 transactions", "Delete 1 transaction", … */
export function bulkLabel(request: BulkRequest): string {
  const n = count(request.ids.length);
  const { action } = request;
  switch (action.type) {
    case 'categorize':
      return `Categorize ${n}`;
    case 'setPayee':
      return `Set the payee of ${n}`;
    case 'setFlag':
      return action.flag === null ? `Remove the flag of ${n}` : `Flag ${n}`;
    case 'setCleared':
      return `Mark ${n} ${action.cleared}`;
    case 'approve':
      return `Approve ${n}`;
    case 'moveAccount':
      return `Move ${n}`;
    case 'delete':
      return `Delete ${n}`;
  }
}

/** The single-transaction edit an action stands for. */
function patchFor(
  action: Exclude<BulkAction, { type: 'delete' }>,
  confirmReconciled: boolean,
): UpdateTransactionRequest {
  switch (action.type) {
    case 'categorize':
      return { categoryId: action.categoryId, confirmReconciled };
    case 'setPayee':
      return { payeeId: action.payeeId, confirmReconciled };
    case 'setFlag':
      return { flag: action.flag, confirmReconciled };
    case 'setCleared':
      return { cleared: action.cleared, confirmReconciled };
    case 'approve':
      return { approved: true, confirmReconciled };
    case 'moveAccount':
      return { accountId: action.accountId, confirmReconciled };
  }
}

/**
 * Spec §10 "Search and bulk operations": applies the action to every selected transaction inside the caller's
 * command, re-checking every rule per row. A failure names the row (`ids.<index>`) and rolls everything back.
 * Deleting skips rows already deleted with an earlier selected row (the other side of a transfer, or a split
 * line's counterpart whose split is selected too).
 */
export async function bulkUpdate(rec: ChangeRecorder, request: BulkRequest, context: EditContext): Promise<void> {
  const { ids, action, confirmReconciled } = request;
  const selected = new Set(ids);
  const deleted = new Set<string>();
  for (const [index, id] of ids.entries()) {
    try {
      if (action.type !== 'delete') {
        await updateTransaction(rec, id, patchFor(action, confirmReconciled), context);
        continue;
      }
      if (deleted.has(id)) continue;
      const agg = await loadAggregate(rec.tx, id);
      if (agg.owner && selected.has(agg.owner.parent.id)) continue;
      const result = await deleteTransaction(rec, id, { now: context.now, confirmReconciled });
      for (const gone of result.ids) deleted.add(gone);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      throw new AppError(err.status, err.code, err.message, { fieldErrors: { [`ids.${index}`]: [err.message] } });
    }
  }
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/transaction-commands.ts b/src/server/transactions/transaction-commands.ts
index 35c719d..6101f57 100644
--- a/src/server/transactions/transaction-commands.ts
+++ b/src/server/transactions/transaction-commands.ts
@@ -291,7 +291,7 @@ export async function deleteTransaction(
   rec: ChangeRecorder,
   id: string,
   context: { now: Date; confirmReconciled: boolean },
-): Promise<{ payeeName: string | null }> {
+): Promise<{ payeeName: string | null; ids: string[] }> {
   const agg = await loadAggregate(rec.tx, id);
   if (agg.owner) {
     const split = await findAccount(rec.tx, agg.owner.parent.accountId);
@@ -302,6 +302,7 @@ export async function deleteTransaction(
   }
   const rows = [agg.main, agg.counterpart, ...agg.lines.map((l) => l.counterpart)].filter((r) => r !== null);
   assertConfirmed(rows.some((r) => r.cleared === 'reconciled'), context.confirmReconciled);
-  await softDelete(rec, rows.map((r) => r.id), context.now);
-  return { payeeName: await payeeNameOf(rec, agg.main.payeeId) };
+  const ids = rows.map((r) => r.id);
+  await softDelete(rec, ids, context.now);
+  return { payeeName: await payeeNameOf(rec, agg.main.payeeId), ids };
 }
diff --git a/src/server/transactions/transaction-routes.ts b/src/server/transactions/transaction-routes.ts
index e3fc408..41a0dee 100644
--- a/src/server/transactions/transaction-routes.ts
+++ b/src/server/transactions/transaction-routes.ts
@@ -1,6 +1,8 @@
 import { Hono } from 'hono';
 import { idParamSchema, type IdResponse } from '../../shared/api/common';
 import {
+  type BulkResponse,
+  bulkRequestSchema,
   createTransactionRequestSchema,
   type CreateTransactionResponse,
   deleteTransactionRequestSchema,
@@ -14,6 +16,7 @@ import { todayIn } from '../clock';
 import { runCommand } from '../commands/run-command';
 import type { AppDeps } from '../http/app';
 import { validate } from '../http/validate';
+import { bulkLabel, bulkUpdate } from './bulk';
 import {
   createTransaction,
   deleteLabel,
@@ -42,6 +45,12 @@ export function transactionRoutes(deps: AppDeps) {
       const transaction = await getTransaction(deps.db, saved.id);
       return c.json<CreateTransactionResponse>({ kind: 'transaction', transaction }, 201);
     })
+    .post('/bulk', validate('json', bulkRequestSchema), async (c) => {
+      const body = c.req.valid('json');
+      const context = { today: today(), now: deps.clock.now() };
+      await runCommand(deps, bulkLabel(body), (rec) => bulkUpdate(rec, body, context));
+      return c.json<BulkResponse>({ ids: body.ids });
+    })
     .get('/:id', validate('param', idParamSchema), async (c) =>
       c.json<TransactionDto>(await getTransaction(deps.db, c.req.valid('param').id)),
     )
PATCH
```

- [ ] **Step 5: Update the spec and the notes**

```bash
git apply <<'PATCH'
diff --git a/docs/superpowers/notes/engineering-notes.md b/docs/superpowers/notes/engineering-notes.md
index d373c2c..2c4a332 100644
--- a/docs/superpowers/notes/engineering-notes.md
+++ b/docs/superpowers/notes/engineering-notes.md
@@ -56,10 +56,13 @@ Keep each plan to about 8–10 tasks. A task is one reviewable unit with its own
   `.use('*', requireSession(deps))` on a router mounted under its **own** prefix. Never `.use` on a router that shares
   its prefix with other routers: the middleware leaks onto later routes there.
 - `validate(target, schema)` in `src/server/http/validate.ts` gives 400 `validation` with `fieldErrors`/`formErrors`.
-  zod 4 hooks pass `z.core.$ZodError`. Note that `z.flattenError` only reports top-level paths; for nested bodies
-  (split lines) also return the issue paths.
-- Error classes: `AppError(status, code, message)` and `DomainError(code, message)` (422) in
-  `src/server/http/errors.ts`.
+  zod 4 hooks pass `z.core.$ZodError`. `ValidationError` keys `fieldErrors` by the dotted issue path
+  (`lines.1.amount`), so nested bodies keep their paths (`z.flattenError` would report only `lines`).
+- Error classes: `AppError(status, code, message, extra?)` and `DomainError(code, message, field?)` (422) in
+  `src/server/http/errors.ts`. A `DomainError` about one field (a dotted path) also returns
+  `fieldErrors: { [field]: [message] }`.
+- Query strings arrive as strings: parse numbers with a regex + `transform(Number)` + `pipe(...)` (not
+  `z.coerce`, which turns `''` into 0).
 - Request bodies are limited to 64 KiB on `/api/*`. Every `/api` response has `Cache-Control: no-store`.
 - The logger's `err` serializer strips Drizzle query params. Always log with a message string:
   `logger.error({ err }, 'msg')`.
@@ -70,6 +73,19 @@ Keep each plan to about 8–10 tasks. A task is one reviewable unit with its own
   - `727274001`: login and re-authentication.
   - `727274002`: user commands and undo/redo (`COMMAND_LOCK_KEY` in `src/server/commands/run-command.ts`).
 
+### Transactions (P2c)
+- Every transaction write is planned first: build a `Draft` (what the user describes) and call
+  `planTransaction(db, draft, context)` in `src/server/transactions/plan.ts`. It applies spec §5.5 and §9 and returns
+  the rows (`Plan`); `insertPlan` writes a new transaction and `syncPlan` brings a saved one in line. P2d's schedule
+  job, reconcile adjustments and FX revaluation should build drafts too, so they get the same rules.
+- `loadAggregate(db, id)` returns a transaction with its transfer side, live split lines with their counterparts, or,
+  for a split line's counterpart, its owning split and line (`owner`).
+- Rows that point at each other (the two sides of a transfer, a line and its counterpart) are inserted first and then
+  linked with `rec.update`, because foreign keys are checked immediately; undo replays the steps in reverse.
+- The category of a budget↔tracking transfer lives on the budget-side row; `draftOf` reads it from either side.
+- `fx_rate` holds the rate a base amount was computed with (always user-entered in P2c, so `fx_rate_manual`); sides
+  whose base is derived from the other side of a transfer store null. `effectiveRate` in the DTOs shows the rate.
+
 ### Engine
 - `src/engine` is pure: no I/O, no Node modules, no `Date.now()` / `new Date()` / `Math.random()`. ESLint enforces this.
 - `computeBudget` throws on unknown or duplicate categories, assignments to RTA or Uncategorized, lines categorised to a
diff --git a/docs/superpowers/notes/p2-carry-over.md b/docs/superpowers/notes/p2-carry-over.md
index 3ab2d0c..013643e 100644
--- a/docs/superpowers/notes/p2-carry-over.md
+++ b/docs/superpowers/notes/p2-carry-over.md
@@ -104,3 +104,47 @@ These items were found in the P1 final review and deferred. Fold them into the P
 - P3: build mutation responses inside the command (`rec.tx`), not after commit; consider returning the touched table
   names from undo/redo for query invalidation; a zod abort skips `superRefine` (form UX); unify 404 vs 422 for unknown
   ids in bodies; a lint rule forbidding direct `rec.tx` writes in command files.
+
+## Resolved in P2c
+- Date ≤ today on transaction writes (§5.6): a new transaction dated after today becomes a one-time scheduled
+  transaction; an edit can't move a transaction past today. Transaction dates start at 1970-01-01, like starting
+  balances.
+- Nested validation paths: `fieldErrors` are keyed by the dotted issue path (`lines.1.amount`); `DomainError` takes
+  an optional field, used for split lines (`lines.2.categoryId`) and bulk rows (`ids.3`).
+- The ledger view is checked through the API: split lines instead of their split, both sides of transfers, a deleted
+  split whose lines stay live, and foreign lines with amount ≠ amount_base.
+- Transfers, transfer lines and their counterparts are inserted with a null link and linked by an update; undo/redo
+  round trips are tested for transfers, splits, replaced lines and bulk operations. Commands stay at READ COMMITTED.
+- Soft-deleted and credit card payment categories are refused on every transaction write (`assertUsableCategory`).
+- Account deletion: `isAccountInUse` also checks rows that use the account's transfer payee, and a payee that
+  remembers a linked category no longer blocks the delete (the delete clears `last_category_id`). Soft-deleted
+  transactions still block it (`account_in_use`): they are history that undo can bring back, so the account is closed
+  instead.
+- Indexes on `transaction.transfer_txn_id`, `transfer_account_id` and `scheduled_id`,
+  `subtransaction.transfer_txn_id` and `scheduled_subtransaction.scheduled_id` (migration 0003).
+- Bulk operations run row by row (no large IN lists) and take at most 500 ids. Categorizing 500 rows took about
+  1.4 s and its undo about 0.5 s against the Testcontainers database. A test shows that an undo conflict on one row of
+  a bulk command rolls back the rows already replayed.
+- `transferBases` foreign → PLN with a `null` rate on the foreign side has a test.
+
+## From P2c
+- P2d: shutdown hardening, moved from P2c (SIGTERM during migrations, close timeout, exit code on db close failure,
+  `init: true` in compose).
+- P2d: entering a scheduled transaction must build a `Draft` and use `planTransaction` + `insertPlan`. Schedules keep
+  the category of a transfer as entered (the plan puts it on the budget side), the `fx_rate` of a foreign ↔ foreign
+  transfer schedule is the sending side's rate, and schedule lines keep their payee and `transfer_account_id`.
+- P2d: `scheduled_transaction` has no column for the other side's amount, so future-dated transfers between currencies
+  are refused (`future_transfer_currency`). Add a column (and allow them) with the scheduled-transaction CRUD.
+- P2d: NBP rates. Until then `fxRate` is required for foreign-currency transactions and stored with
+  `fx_rate_manual = true`; edits keep the stored rate unless a new one is sent. With NBP, a date change should
+  re-fetch a non-manual rate.
+- P2d: only the reconcile flow sets `reconciled`; users switch between `uncleared` and `cleared`.
+- Later: `ChangeRecorder.update` re-selects the rows it changed with one IN list, so a single update of more than about
+  65 000 rows (merging a payee with that many transactions, or P2b1's category delete) would exceed Postgres'
+  bind-parameter limit. Batch it there if that ever matters.
+- P3: changing a categorized transaction's payee to the transfer payee of a budget account needs `categoryId: null`
+  in the same request (`category_not_allowed` otherwise). For a budget↔tracking transfer only the budget side's DTO
+  shows the category.
+- P3: register rows of the same date are ordered by id (spec: date desc, id), not by entry time.
+- P3: unknown ids in transaction bodies are 422 with a field (`invalid_account`, `invalid_payee`, `invalid_category`);
+  the "unify 404 vs 422" item from the P2b1 final review stays open for the older endpoints.
diff --git a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
index 4d45674..fdd1d53 100644
--- a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
+++ b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
@@ -239,6 +239,10 @@ Further rules:
 - No transaction line may be categorized to a credit card payment category. Those categories change only through
   funded spending flows, card transfers and assignments.
 - An on-budget, non-transfer, non-starting-balance transaction without a category is "Uncategorized".
+- A line may use Ready to Assign, a regular category or a loan's paired category (hidden ones included). Uncategorized
+  is never chosen explicitly: leaving the category empty means Uncategorized.
+- The category of a budget↔tracking transfer (or transfer line) is stored on its budget side, whichever side it was
+  entered from. Closed accounts take no new rows; rows already there stay editable.
 
 ### 5.6 Future-dated transactions
 A transaction saved with `date > today` is stored as a `scheduled_transaction` with frequency `once`. The budget only
@@ -351,8 +355,10 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
   Σ line base = parent base.
 - **Cross-currency transfers**: the user enters both actual amounts.
   - PLN ↔ foreign: the foreign side's `amount_base` = −(PLN side amount).
-  - Foreign ↔ foreign: the source side's base comes from its rate; destination base = −source base.
+  - Foreign ↔ foreign: the source side's base comes from its rate; destination base = −source base. The rate is
+    stored on the source side; a side whose base is derived from the other side stores `fx_rate = null`.
   - Either way the transfer nets to 0 in the budget. The effective rate is displayed.
+  - Split lines transfer only to accounts in the same currency (counterpart base = −line base).
 - **Account display**: native balance, plus "≈ X zł" at the latest available NBP rate.
 - **Revalue**: unrealized difference = round(native balance × latest rate) − Σ `amount_base`. The action posts a
   transaction with `amount = 0`, `amount_base = diff`, payee "FX revaluation", cleared. On-budget accounts get
@@ -364,22 +370,32 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
 **Creating and editing**
 - Manual transactions are created `approved = true`. The `approved = false` state exists for bank import (#2).
 - Saving a categorized, non-transfer transaction updates `payee.last_category_id`. The transaction sheet pre-fills
-  the category from the selected payee.
+  the category from the selected payee. An edit updates it only when the payee or the category changes.
+- A saved transaction can move to another account in the same currency; every rule is checked again. It can't move to
+  a date after today (§5.6 applies to new transactions).
 
 **Splits**
 - A split has `is_split = true`, a null parent category, ≥ 2 lines, and Σ line amounts = parent amount.
 - A line may be a transfer, which creates a counterpart transaction in the target account with `transfer_txn_id`
   pointing to the parent and `transfer_subtxn_id` to the line.
+- Editing lines replaces them: the old lines and their counterparts are soft-deleted, unless the lines sent are
+  identical. Edits of the split's date or account update its line counterparts in place.
+- A line's counterpart takes only memo (mirrored to the line), cleared, approved and flag; the rest is edited on the
+  split, and the counterpart goes away by removing its line.
 
 **Transfers**
 - Creating a transfer creates both sides atomically, linked via `transfer_txn_id`.
 - Editing date, amount or memo on one side mirrors it to the other. For cross-currency transfers, the other side's
   native amount is changed only when the user edits it explicitly.
 - Cleared status is independent per side. Deleting one side deletes both.
+- Choosing a different payee retargets or ends the transfer: the old other side is soft-deleted and a new one created.
+- A future-dated transfer between currencies is refused until scheduled transactions can store the other side's
+  amount.
 
 **Reconciled transactions**
 - Changing amount, account, date or the transfer link of a reconciled transaction requires `confirmReconciled: true`.
-  The UI asks for confirmation first.
+  The UI asks for confirmation first. Un-reconciling and deleting it need the confirmation too, and so do mirrored
+  changes that reach a reconciled other side. Without it the server answers 409 `confirm_reconciled`.
 
 **Starting balance**
 - Created with every new account: payee "Starting Balance", `cleared`, `is_starting_balance = true`, dated on the
@@ -403,7 +419,9 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
 
 **Payees**
 - Rename. Merge (reassign all transactions, lines and schedules to the target payee, then soft-delete the source).
-- Delete is allowed only when the payee is unused. Transfer and system payees can't be renamed or deleted.
+  The target keeps its last-used category, or takes the source's when it has none.
+- Delete is allowed only when the payee is unused by live rows. Transfer and system payees can't be renamed, merged or
+  deleted, and system payees can't be chosen for a transaction.
 
 **Categories**
 - Create, rename, reorder (drag), hide, and move between groups.
@@ -425,7 +443,9 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
 - Filters: text (ILIKE on payee, memo, category), date range, amount range, account, category, payee, flag, cleared
   state, unapproved.
 - Bulk operations on the selected IDs are one command each (one undo): categorize, set payee, set flag,
-  clear/unclear, approve, move to account (same-currency accounts only), delete.
+  clear/unclear, approve, move to account (same-currency accounts only), delete. Each row is checked like a single
+  edit; if one fails, nothing changes. A request takes up to 500 IDs.
+- The amount range filters the signed native amount.
 
 **Undo/redo**
 - Every user command writes through `ChangeRecorder`, which captures the before/after row images.
@@ -513,11 +533,15 @@ signs out other sessions.
 
 ## 13. Error handling
 
-- **zod validation failures** → HTTP 400 `{ code: "validation", fieldErrors }`; the UI shows them inline.
+- **zod validation failures** → HTTP 400 `{ code: "validation", fieldErrors }`; the UI shows them inline. Field
+  errors are keyed by the dotted path of the field (`lines.1.amount`); a domain error about one field (or split
+  line, or bulk row: `ids.3`) carries the same `fieldErrors`.
 - **Domain rule violations** throw a typed `DomainError(code, message)` → HTTP 422; the UI shows the message.
   Examples: split sum mismatch, category on a budget↔budget transfer, closing an account with a non-zero balance.
 - **Undo/redo conflicts** (a row changed since the command) → HTTP 409 `undo_conflict` "Can't undo: data changed
   since." (or "Can't redo: …"); an empty stack → 409 `nothing_to_undo` / `nothing_to_redo`.
+- **Unconfirmed changes to reconciled transactions** → HTTP 409 `confirm_reconciled`; the UI asks and resends with
+  `confirmReconciled: true`.
 - **Auth failures** → 401 (no session) or 429 (rate limited / locked).
 - **Unexpected errors** → 500 with a generic message. The server logs details with pino (JSON to stdout, including a
   request ID); the UI shows a toast with Retry.
PATCH
```

- [ ] **Step 6: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/transactions/bulk.test.ts`
Expected: `Tests  7 passed (7)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  47 passed (47)`, `Tests  420 passed (420)`; both checks exit 0.
Run: `npm run db:generate -- --name check && npm run build`
Expected: `No schema changes, nothing to migrate 😴`, then esbuild's `Done`.

- [ ] **Step 7: Commit**

```bash
git add src/shared/api/transactions.ts src/server/transactions docs
git commit -m "feat(server): bulk transaction operations; P2c docs" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
## Spec coverage (P2c)

| Spec | Task |
|---|---|
| §3 budget vs tracking accounts in the categorization and transfer rules | 2, 3, 4, 6 |
| §4.4 payees: name uniqueness among live user payees, transfer and system payees, `last_category_id` | 1, 2, 5 |
| §4.4 transactions: native/base amounts, `fx_rate`, `fx_rate_manual`, cleared, approved, flag, transfer links, `is_split`, `deleted_at` | 2–7 |
| §4.4 subtransactions; `scheduled_transaction` (`once`) and `scheduled_subtransaction` for future dates | 2, 3, 4 |
| §4.6 the budget's view of the writes: split lines instead of the split, both transfer sides, deleted splits with live lines, amount ≠ amount_base (tested through `v_ledger_line`) | 2, 3, 4, 5, 6, 7 |
| §5.3 card payments are budget↔budget transfers; card payment categories never on transaction lines | 2, 3, 4 |
| §5.5 the transfer/category table and its rules, re-checked on edits, moves and bulk edits | 2, 3, 4, 5, 6, 9 |
| §5.6 future dates become one-time schedules; edits stay on or before today | 2, 3, 4, 5 |
| §9 `convertToBase`, `splitLineBases`, `transferBases`, effective rate, manual rates | 2, 3, 4, 5 |
| §10 Creating and editing (approved, inline payees, payee default category) | 1, 2, 5, 6 |
| §10 Splits (≥ 2 lines, sum, transfer lines and their counterparts) | 4, 5, 6, 7 |
| §10 Transfers (atomic, linked, mirrored edits, cross-currency amounts, per-side cleared, delete both) | 3, 5, 7 |
| §10 Reconciled transactions (`confirmReconciled`) | 6, 7, 9 |
| §10 Payees (rename, merge, delete when unused; transfer and system payees locked) | 1 |
| §10 Search and bulk operations | 8, 9 |
| §10 Undo/redo: one entry per command, round trips incl. bulk, conflicts roll back | 1–9 |
| §11 Transaction sheet (payee autocomplete incl. transfer payees, category rules, FX rate, split validation) | 1–4 |
| §11 Register (balances, rows, search and filters) | 8 |
| §13 400 with dotted field paths, 404, 409 `confirm_reconciled`, 422 domain errors; soft deletes | 2–9 |
| §14 Server: each handler's happy path and domain errors; undo → redo round trips | 1–9 |
| P2 carry-over: nested validation paths; date ≤ today; ledger view through the API; account deletion with soft-deleted history; bulk and undo scale; `transferBases` with a `null` rate; P2b1 final review (null-link-then-update with round trips, link indexes, transfer-payee usage and remembered categories on account delete, multi-row conflict rollback) | 2, 3, 7, 9 |

Deferred (listed in `p2-carry-over.md` under "From P2c"):
- P2d: scheduled-transaction CRUD and the job (which must plan entered occurrences with `planTransaction`), future-dated transfers between currencies, NBP rates, reconciliation (the only writer of `reconciled`), revaluation, loan interest, export; shutdown hardening (moved from P2c).
- P3: the web app; the client sends `categoryId: null` when a payee change makes a transaction a budget↔budget transfer.

## Decisions

Choices made where the spec is silent, ambiguous or in conflict with the brief:

1. **Payee kinds and order.** `GET /api/payees` lists live payees with `kind` `user`, `transfer` or `system`: user payees first, then transfer and system payees, each by name ignoring case. `usageCount` counts live rows: transactions, lines of live transactions, schedules and schedule lines.
2. **Payee names** are unique among live user payees, ignoring case (422 `payee_name_taken`). Transfer and system payee names don't block them. `payeeName` on a transaction reuses a live user payee with that name, otherwise creates one inside the same command.
3. **Merge** re-points soft-deleted transactions too (as P2b1's category delete does), so undoing their deletion never revives a deleted payee. The target must be another live user payee (422 `invalid_merge_target`), keeps its remembered category or takes the merged payee's, and is returned. Merging transfer or system payees, or into them, is refused.
4. **Payee delete** counts only live use (a soft-deleted transaction may keep pointing at the soft-deleted payee); it is a soft delete and frees the name.
5. **Allowed categories.** Lines may use Ready to Assign, regular categories **and a loan's paired category**. The brief said "normal or RTA", but spec §8's "Record payment" categorizes a loan transfer to the paired category. Credit card payment categories are 422 `card_payment_category`. Sending Uncategorized's id is 422 `invalid_category` (send `null`). Hidden categories are fine.
6. **Unknown ids in bodies** are 422 with the field (`invalid_account`, `invalid_payee`, `invalid_category`), so forms can mark them. Unknown ids in URLs stay 404.
7. **Closed accounts** take no new rows: no new transaction, new transfer side, new line counterpart or move into them (422 `account_closed`). Rows already there stay editable.
8. **Transfers are made by payee.** Choosing an account's transfer payee (by `payeeId`) makes a transfer. The other side gets the entering account's transfer payee and the same date and memo, and is uncleared, approved and unflagged. System payees can't be chosen for transactions.
9. **Category of a budget↔tracking transfer** is stored on the budget side, wherever the transfer (or transfer line) was entered. Only the budget side's DTO shows it.
10. **FX.** Foreign-currency transactions need `fxRate` until P2d (422 `fx_rate_required`), stored with `fx_rate_manual = true`; PLN transactions and PLN ↔ foreign transfers refuse one (422 `fx_rate_not_allowed`). Between two foreign currencies (or within one), the rate is the **sending** side's (the outflow; the entered side when the amount is 0) even when the transfer is entered on the receiving side, and it is stored on that side. Sides whose base is derived from the other side store `fx_rate = null`. Every DTO has `effectiveRate` (|base| / |amount| for foreign accounts), and `transfer.effectiveRate` gives the other side's.
11. **Amounts between currencies.** `transferAmount` is required on create, has the opposite sign, and neither amount may be 0 (422 `transfer_amount_sign`). Same-currency transfers refuse it. An edit keeps the other side's amount unless `transferAmount` is sent (spec §10).
12. **Splits.** 2–100 lines whose sum is the amount (422 `split_sum`, field `lines`); the split has no category. Line payees are chosen by id (no inline names). Transfer lines go only to accounts in the same currency (422 `split_transfer_currency`), and a split itself can't be a transfer (422 `split_transfer`). A transfer line's counterpart takes the line's memo.
13. **Future dates.** On create, a date after today becomes a `once` schedule, for transfers and splits too (schedule lines included). The schedule keeps the category as entered and the entered rate; saving it also updates the payee's remembered category. Future transfers between currencies are refused (422 `future_transfer_currency`), because a schedule has no column for the other side's amount. Edits can't move past today (422 `date_in_future`). Dates start at 1970-01-01, matching P2b1's starting dates.
14. **Error paths.** 400 `fieldErrors` are keyed by the dotted issue path, replacing `z.flattenError` (top-level keys are unchanged). A `DomainError` may name its field, which adds `fieldErrors`: `lines.2.categoryId` for lines, `ids.3` for bulk rows.
15. **PATCH semantics.**
    - Omitted fields stay, and `payeeName` creates or reuses a payee.
    - A new payee keeps this row's own category, not the other side's.
    - Sending `lines` defaults the split's category to none.
    - The payee's remembered category changes only when the payee or the category changes.
    - An edit that changes nothing records no undo entry.
16. **Transfer link changes.** A new transfer payee creates the other side. Retargeting soft-deletes the old side and creates a new one. A regular payee (or none) soft-deletes the other side.
17. **Line edits replace lines** (old lines and their counterparts soft-deleted, new ones created), as the brief asks. When the lines sent equal the current ones, they are kept, and date, account or rate changes update them and their counterparts in place, so counterparts keep their cleared state. `lines: null` converts a split to a plain transaction.
18. **Split line counterparts** take only memo (mirrored to the line), cleared, approved and flag (422 `split_counterpart` otherwise) and can't be deleted directly: the user edits the split.
19. **Reconciled confirmation is 409 `confirm_reconciled`**, not 422: it isn't a rule violation but a round trip (the UI asks and resends with `confirmReconciled: true`), and a distinct status keeps it apart from validation errors.
    - It covers amount, date, account and transfer changes, including mirrored changes that reach a reconciled other side, removed sides and replaced lines.
    - It also covers un-reconciling (any `cleared` sent for a reconciled row) and deletion.
    - Memo, payee, category, flag and approval changes don't need it.
    - Users can't set `reconciled`; only P2d's reconcile flow does.
20. **Moving between accounts** is allowed within the same currency only (422 `move_currency`), with every rule re-run in the new account. The other side of a transfer and the line counterparts stay put and follow (their payee becomes the new account's transfer payee). Starting balances and line counterparts can't move.
21. **Starting balances** keep their account, payee and category and can't become splits or transfers (422 `starting_balance`); amount, date, memo, cleared, flag and rate can change, and they can be deleted.
22. **Delete** is soft. Both sides of a transfer go; a split takes its line counterparts with it, and its lines stay untouched because the view drops them with the split. **Account deletion** stays refused while soft-deleted transactions reference the account (the carry-over asked P2c to decide): they are history that undo can restore, and closing is the alternative. As the P2b1 final review asked, transfer-payee use now blocks an account delete, and remembered categories are cleared instead of blocking it.
23. **Register.**
    - Order (date desc, id desc), as §10 says. Within a date the order is by id, not entry time.
    - The cursor is an opaque `YYYY-MM-DD_<id>`; `limit` is 1–200 (default 50).
    - Text search matches the transaction's and its live lines' payee, memo and category names, literally.
    - The amount range is the signed native amount; category and payee filters include split lines; `unapproved=true` filters.
    - `balances` comes only with `accountId` (404 for an unknown account).
24. **Bulk.**
    - `action` is a discriminated union, and a request takes 1–500 distinct ids.
    - Each row runs the single-row edit or delete. The first failure aborts the whole request with its own status and code, plus `fieldErrors` `ids.<index>`.
    - `setPayee` accepts any non-system payee, so a transfer payee turns rows into transfers when the rules allow it.
    - Payee defaults follow the single-edit rule.
    - The response is `{ ids }` (the selection).
    - Rows are processed one by one, so there are no large IN lists; 500 rows take about 1.4 s and their undo about 0.5 s, so no batching yet.
25. **Labels:** `Create payee "X"`, `Rename payee "X"`, `Merge payee "X" into "Y"`, `Delete payee "X"`, `Add transaction "P"`, `Schedule transaction "P"`, `Edit transaction "P"`, `Delete transaction "P"` (without quotes when there is no payee), and the bulk labels of Task 9.
26. **Memos** are trimmed, at most 500 characters, and an empty memo is stored as null.
27. **Migration 0003** only adds indexes, so `v_ledger_line` is untouched. Applying it clears the undo history (P2b1's `runMigrations`).
28. **Shutdown hardening**, listed for P2c in the carry-over, is outside payees and transactions and moves to P2d.
