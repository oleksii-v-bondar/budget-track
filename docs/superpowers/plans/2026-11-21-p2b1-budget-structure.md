# P2b1 — Budget Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the server's undoable command layer and the budget's structure: a `ChangeRecorder` / `runCommand` / undo-redo core with its API, deny-by-default API routing, a schema-hardening migration, and the accounts, category groups and categories, assignments, move-money and month-note endpoints.

**Architecture:** Every user command runs through `runCommand(deps, label, fn)`. It opens one transaction holding advisory lock 727274002, and `fn` makes every write through a `ChangeRecorder`, which keeps ordered, JSON-safe before/after row images. If anything changed, an `undo_entry` is appended, the redo stack is cleared and the history is trimmed to 100 entries. Undo and redo replay those images row by row after checking that each row still matches. Feature routers (`/api/undo`, `/api/redo`, `/api/accounts`, `/api/category-groups`, `/api/categories`, `/api/budget`) each sit on their own prefix behind `.use('*', requireSession(deps))` and call command functions that take the recorder. Request schemas and DTO types live in `src/shared/api/` for the P3 web client.

**Tech Stack:** Node 22, TypeScript 6, Hono 4 + @hono/zod-validator, zod 4, Drizzle ORM 0.45 + drizzle-kit 0.31, postgres.js 4, Postgres 16, Vitest 5, @testcontainers/postgresql 11. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-core-budgeting-design.md` (§2–§5, §10 "Categories", "Accounts", "Starting balance" and "Undo/redo", §12, §13, §14 "Server"). P2b1 is the first half of P2b. P2b2 adds the budget month read API, targets and auto-assign; P2c adds payees, transactions and the register; P2d adds scheduled transactions, reconciliation, NBP rates, loans and export.

## Global Constraints

Inherited from P2a:
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

New in P2b1:
- Every user command goes through `runCommand` and writes only through its recorder (`rec.insert` / `rec.update` / `rec.delete`); it reads through `rec.tx`. Auth and settings changes don't use `runCommand` and aren't undoable.
- No foreign key has an `ON DELETE` action (migration 0002 removes the two that existed). A command deletes or re-points child rows itself, so the undo log sees every change.
- Every router outside `/api/auth` is mounted on its **own** prefix and starts with `.use('*', requireSession(deps))`. Routers are built by chaining, so `App` keeps every route for the Hono RPC client.
- Request schemas and the response DTO types the web app needs live in `src/shared/api/`.
- SQL sums are cast in SQL: `sum(x)::bigint` (never `.mapWith(Number)`).
- Never rewrite a committed migration; add one with `npm run db:generate -- --name …`. A migration that alters a column `v_ledger_line` reads must drop and recreate the view.
- Status codes: create → 201 with the DTO; edit → 200 with the DTO; delete → 200 `{ id }`; reorder → 200 `{ ids }`; unknown or deleted resource in the URL → 404 `not_found`; undo/redo conflicts and empty stacks → 409.
- Advisory-lock keys are distinct and listed in `docs/superpowers/notes/engineering-notes.md`: 727274001 login, 727274002 commands and undo/redo.
- Server tests use the P2a harness: `createTestDatabase()` per test (`beforeEach`) when undo history matters, `createTestApp(db, { now })`, `setUpBudget(ctx)`. Undo round trips compare `snapshot(db)` from `src/server/test/snapshot.ts`.
- Patches in this plan are shown as `git apply <<'PATCH' … PATCH` commands; run them from the repository root. (Making the same edits by hand is equivalent.)

## File Structure

```
src/shared/api/common.ts                 zod building blocks (money, month, date, id, name, note, reorder) + IdResponse, ReorderResponse
src/shared/api/undo.ts                   UndoItem, UndoState, UndoResponse, RedoResponse
src/shared/api/accounts.ts               account request schemas, accountFieldsAllowed, AccountDto
src/shared/api/categories.ts             group/category request schemas, CategoryKind, CategoryDto, CategoryGroupDto
src/shared/api/budget.ts                 assignment, move-money and month-note schemas and DTOs
src/server/commands/recorder.ts          ChangeRecorder, RowImage, Change, RECORDED_TABLES, image helpers
src/server/commands/run-command.ts       runCommand, lockCommands, COMMAND_LOCK_KEY, UNDO_HISTORY_LIMIT, Named
src/server/commands/history.ts           historyState, undo, redo (replay with conflict check)
src/server/commands/undo-routes.ts       /api/undo, /api/redo
src/server/commands/reorder.ts           applyOrder (full-list reorders)
src/server/db/lookups.ts                 systemPayeeId, systemCategoryId, systemGroupId, nextSortOrder
src/server/accounts/account-queries.ts   listAccounts, getAccount (DTO with balances)
src/server/accounts/account-commands.ts  createAccount, updateAccount, setAccountClosed, deleteAccount, reorderAccounts
src/server/accounts/account-routes.ts    /api/accounts
src/server/categories/category-queries.ts  categoryKindOf, listCategoryGroups, getCategoryGroup, getCategory
src/server/categories/group-commands.ts    createGroup, updateGroup, deleteGroup, reorderGroups
src/server/categories/category-commands.ts createCategory, updateCategory, reorderCategories, deleteCategory
src/server/categories/group-routes.ts      /api/category-groups
src/server/categories/category-routes.ts   /api/categories
src/server/budget/assignments.ts         budget month range, setAssigned/addAssigned, moveMoney, setMonthNote
src/server/budget/budget-routes.ts       /api/budget/:month/…
src/server/test/snapshot.ts              snapshot(db): exact dump of every undo-recorded table
src/server/test/fixtures.ts              createAccount, createGroup, createCategory through the API
drizzle/0002_schema_hardening.sql        generated, then extended by hand (view drop/recreate, system payees)

Modified: src/server/db/schema.ts, src/server/clock.ts, src/server/http/app.ts, src/server/db/schema.test.ts,
src/server/db/ledger-view.test.ts, src/server/http/app.test.ts, the spec, engineering-notes.md, p2-carry-over.md
```

## API added in P2b1

All routes need a session. Months in URLs are `YYYY-MM`; ids are UUIDs (a malformed one is a 400).

| Method and path | Body | Response |
|---|---|---|
| `GET /api/undo` | – | 200 `UndoState` `{ undo: { label } \| null, redo: { label } \| null }` |
| `POST /api/undo` | – | 200 `UndoResponse` (`UndoState` + `undone: { label }`); 409 `undo_conflict` / `nothing_to_undo` |
| `POST /api/redo` | – | 200 `RedoResponse` (`UndoState` + `redone: { label }`); 409 `undo_conflict` / `nothing_to_redo` |
| `GET /api/accounts` | – | 200 `{ accounts: AccountDto[] }` |
| `POST /api/accounts` | `CreateAccountRequest` | 201 `AccountDto` |
| `PATCH /api/accounts/:id` | `UpdateAccountRequest` | 200 `AccountDto` |
| `POST /api/accounts/:id/close`, `…/reopen` | – | 200 `AccountDto` |
| `DELETE /api/accounts/:id` | – | 200 `{ id }` |
| `PUT /api/accounts/order` | `{ ids }` (every account) | 200 `{ ids }` |
| `GET /api/categories` | – | 200 `{ groups: CategoryGroupDto[] }` |
| `POST /api/category-groups` | `{ name }` | 201 `CategoryGroupDto` |
| `PATCH /api/category-groups/:id` | `{ name?, hidden? }` | 200 `CategoryGroupDto` |
| `DELETE /api/category-groups/:id` | – | 200 `{ id }` |
| `PUT /api/category-groups/order` | `{ ids }` (every live group except Internal) | 200 `{ ids }` |
| `POST /api/categories` | `{ groupId, name, note? }` | 201 `CategoryDto` |
| `PATCH /api/categories/:id` | `{ name?, note?, hidden?, groupId? }` | 200 `CategoryDto` |
| `PUT /api/categories/order` | `{ groupId, ids }` (every live category of the group) | 200 `{ ids }` |
| `DELETE /api/categories/:id` | `{ destinationCategoryId }` | 200 `{ id }` |
| `PUT /api/budget/:month/assignments/:categoryId` | `{ amount }` | 200 `AssignmentDto` `{ month, categoryId, amount }` |
| `POST /api/budget/:month/move` | `{ from: id \| null, to: id \| null, amount }` | 200 `{ assignments: AssignmentDto[] }` |
| `PUT /api/budget/:month/note` | `{ note }` | 200 `{ month, note: string \| null }` |

---

### Task 1: Schema hardening migration and system payees

Folds in the P2 carry-over schema items. Partial unique indexes keep system rows unique. User payees no longer collide with transfer or system payee names. Groups can be soft-deleted. Foreign keys get indexes, and the two `ON DELETE` actions, which would bypass the undo recorder, are removed. Timestamps get millisecond precision so that undo images restore them exactly. The three system payees are created by the migration.

**Files:**
- Modify: `src/server/db/schema.ts`, `src/server/clock.ts`
- Generate, then edit: `drizzle/0002_schema_hardening.sql` (drizzle-kit also writes `drizzle/meta/0002_snapshot.json` and a `drizzle/meta/_journal.json` entry)
- Modify (docs): `docs/superpowers/specs/2026-11-19-core-budgeting-design.md` (§4 intro, §4.3, §4.4)
- Test: `src/server/db/schema.test.ts`, `src/server/db/ledger-view.test.ts`

**Interfaces:**
- Consumes: the P2a schema; `AccountClass` from `src/shared/accounts.ts`.
- Produces:
  - `categoryGroup.deletedAt: Date | null` (null = live).
  - Unique indexes: `payee_one_per_system_kind` (`payee.system_kind`), `category_linked_account_live` (live `category.linked_account_id`), `category_group_one_per_system_kind` (`category_group.kind <> 'normal'`). `payee_name_live` now covers only user payees (`deleted_at`, `transfer_account_id` and `system_kind` all null).
  - In every migrated database: payees `{ name: 'Starting Balance', systemKind: 'starting_balance' }`, `{ name: 'Reconciliation Balance Adjustment', systemKind: 'reconciliation_adjustment' }`, `{ name: 'FX revaluation', systemKind: 'fx_revaluation' }`.
  - Every timestamp column is `timestamptz(3)`.
  - No foreign key has an `ON DELETE` action.
  - Indexes `transaction_category_id`, `transaction_payee_id`, `subtransaction_category_id`.
  - `account.accountClass`, `ledgerLine.accountClass` and `ledgerLine.counterAccountClass` are typed `AccountClass`.
  - `todayIn(timeZone, instant)`: same signature and behaviour, now built with `formatToParts`.

- [ ] **Step 1: Write the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/server/db/ledger-view.test.ts b/src/server/db/ledger-view.test.ts
index bd02be0..558f616 100644
--- a/src/server/db/ledger-view.test.ts
+++ b/src/server/db/ledger-view.test.ts
@@ -1,4 +1,4 @@
-import { asc, desc } from 'drizzle-orm';
+import { asc, desc, eq } from 'drizzle-orm';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
 import { createTestDatabase, type TestDatabase } from '../test/db';
 import { account, category, categoryGroup, ledgerLine, subtransaction, transaction } from './schema';
@@ -95,4 +95,37 @@ describe('v_ledger_line', () => {
       { account: 'checking', accountClass: 'cash', date: '2026-12-02', month: '2026-12-01', category: 'housing', amountBase: -5_000, isTransfer: true, counterAccountClass: 'tracking', isStartingBalance: false, isSplitLine: true, parent: 'split' },
     ]);
   });
+
+  it('drops the live lines of a deleted split parent', async () => {
+    const s = await seed();
+    const [split] = await t.db
+      .insert(transaction)
+      .values({
+        accountId: s.checking.id,
+        date: '2026-11-19',
+        amount: -100,
+        amountBase: -100,
+        isSplit: true,
+        deletedAt: new Date(),
+      })
+      .returning();
+    await t.db.insert(subtransaction).values([
+      { txnId: split!.id, amount: -60, amountBase: -60, categoryId: s.groceries.id },
+      { txnId: split!.id, amount: -40, amountBase: -40, categoryId: s.housing.id },
+    ]);
+    expect(await t.db.select().from(ledgerLine).where(eq(ledgerLine.txnId, split!.id))).toEqual([]);
+  });
+
+  it('exposes the native amount next to the PLN base amount', async () => {
+    const [euro] = await t.db.insert(account).values({ name: 'Euro', type: 'savings', currency: 'EUR' }).returning();
+    const [txn] = await t.db
+      .insert(transaction)
+      .values({ accountId: euro!.id, date: '2026-11-19', amount: 10_000, amountBase: 42_512, fxRate: '4.2512' })
+      .returning();
+    const rows = await t.db
+      .select({ amount: ledgerLine.amount, amountBase: ledgerLine.amountBase })
+      .from(ledgerLine)
+      .where(eq(ledgerLine.txnId, txn!.id));
+    expect(rows).toEqual([{ amount: 10_000, amountBase: 42_512 }]);
+  });
 });
diff --git a/src/server/db/schema.test.ts b/src/server/db/schema.test.ts
index 96c5318..9c2e08e 100644
--- a/src/server/db/schema.test.ts
+++ b/src/server/db/schema.test.ts
@@ -1,4 +1,4 @@
-import { sql } from 'drizzle-orm';
+import { asc, eq, isNotNull, sql } from 'drizzle-orm';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
 import { ACCOUNT_TYPES, accountClassOf } from '../../shared/accounts';
 import { createTestDatabase, type TestDatabase } from '../test/db';
@@ -124,3 +124,57 @@ describe('constraints', () => {
     await expect(t.db.insert(account).values({ name: 'Bad', type: 'checking', currency: 'pln' })).rejects.toThrow();
   });
 });
+
+describe('schema hardening (P2b1)', () => {
+  it('creates the three system payees, one per kind', async () => {
+    const rows = await t.db
+      .select({ name: payee.name, systemKind: payee.systemKind })
+      .from(payee)
+      .where(isNotNull(payee.systemKind))
+      .orderBy(asc(payee.name));
+    expect(rows).toEqual([
+      { name: 'FX revaluation', systemKind: 'fx_revaluation' },
+      { name: 'Reconciliation Balance Adjustment', systemKind: 'reconciliation_adjustment' },
+      { name: 'Starting Balance', systemKind: 'starting_balance' },
+    ]);
+    const query = t.db.insert(payee).values({ name: 'Another start', systemKind: 'starting_balance' });
+    expect(await rejectionText(query)).toContain('payee_one_per_system_kind');
+  });
+
+  it('lets user payees reuse the names of transfer and system payees', async () => {
+    const [savings] = await t.db.insert(account).values({ name: 'Savings', type: 'savings' }).returning();
+    await t.db.insert(payee).values({ name: 'Transfer : Savings', transferAccountId: savings!.id });
+    await t.db.insert(payee).values([{ name: 'transfer : savings' }, { name: 'starting balance' }]);
+  });
+
+  it('allows one group per non-normal kind but any number of normal groups', async () => {
+    await t.db.insert(categoryGroup).values([{ name: 'Internal', kind: 'internal' }, { name: 'A' }, { name: 'B' }]);
+    const query = t.db.insert(categoryGroup).values({ name: 'Internal 2', kind: 'internal' });
+    expect(await rejectionText(query)).toContain('category_group_one_per_system_kind');
+  });
+
+  it('allows one live category per linked account', async () => {
+    const [card] = await t.db.insert(account).values({ name: 'Visa', type: 'credit_card' }).returning();
+    const [group] = await t.db.insert(categoryGroup).values({ name: 'Cards' }).returning();
+    const linked = { groupId: group!.id, name: 'Visa', linkedAccountId: card!.id };
+    const [first] = await t.db.insert(category).values(linked).returning();
+    expect(await rejectionText(t.db.insert(category).values(linked))).toContain('category_linked_account_live');
+    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, first!.id));
+    await t.db.insert(category).values(linked);
+  });
+
+  it('stores timestamps with millisecond precision, so JS dates read back exactly', async () => {
+    const [row] = await t.db.execute<{ micros: number }>(
+      sql`insert into category_group (name, created_at) values ('Precise', '2026-11-20T10:00:00.123456Z')
+          returning (extract(microseconds from created_at)::bigint % 1000) as micros`,
+    );
+    expect(row?.micros).toBe(0);
+  });
+
+  it('has no ON DELETE actions, which would bypass the undo recorder', async () => {
+    const rows = await t.db.execute<{ conname: string }>(
+      sql`select conname from pg_constraint where contype = 'f' and confdeltype <> 'a'`,
+    );
+    expect(rows.map((r) => r.conname)).toEqual([]);
+  });
+});
PATCH
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/db/schema.test.ts src/server/db/ledger-view.test.ts`
Expected: FAIL with `Tests  6 failed | 13 passed (19)`. All six `schema hardening (P2b1)` tests fail. Examples: `expected [] to deeply equal [ …(3) ]` (no system payees), `duplicate key value violates unique constraint "payee_name_live"`, and `expected 456 to be +0` (microseconds are stored). The two new ledger-view tests already pass: they pin the view that the migration drops and recreates.

- [ ] **Step 3: Harden the schema**

```bash
git apply <<'PATCH'
diff --git a/src/server/db/schema.ts b/src/server/db/schema.ts
index a8515f8..1845843 100644
--- a/src/server/db/schema.ts
+++ b/src/server/db/schema.ts
@@ -20,12 +20,13 @@ import {
   uniqueIndex,
   uuid,
 } from 'drizzle-orm/pg-core';
-import { ACCOUNT_CLASS_SQL, ACCOUNT_TYPES } from '../../shared/accounts';
+import { ACCOUNT_CLASS_SQL, ACCOUNT_TYPES, type AccountClass } from '../../shared/accounts';
 
 // Money is integer minor units (grosze); `mode: 'number'` maps int8 to a JS number (safe below 2^53).
 const money = (name: string) => bigint(name, { mode: 'number' });
 const day = (name: string) => date(name, { mode: 'string' });
-const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
+// Millisecond precision matches JS Date exactly, so undo row images (spec §4.5) restore timestamps without loss.
+const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
 const timestamps = {
   createdAt: instant('created_at').defaultNow().notNull(),
   updatedAt: instant('updated_at')
@@ -115,6 +116,7 @@ export const account = pgTable(
     name: text('name').notNull(),
     type: accountType('type').notNull(),
     accountClass: text('account_class')
+      .$type<AccountClass>()
       .notNull()
       .generatedAlwaysAs(sql.raw(ACCOUNT_CLASS_SQL)),
     currency: text('currency').notNull().default('PLN'),
@@ -152,14 +154,20 @@ export const loanInterestOverride = pgTable(
 
 // ---------------------------------------------------------------- categories and budget (spec §4.3)
 
-export const categoryGroup = pgTable('category_group', {
-  id: uuid('id').primaryKey().defaultRandom(),
-  name: text('name').notNull(),
-  sortOrder: integer('sort_order').notNull().default(0),
-  hidden: boolean('hidden').notNull().default(false),
-  kind: categoryGroupKind('kind').notNull().default('normal'),
-  ...timestamps,
-});
+export const categoryGroup = pgTable(
+  'category_group',
+  {
+    id: uuid('id').primaryKey().defaultRandom(),
+    name: text('name').notNull(),
+    sortOrder: integer('sort_order').notNull().default(0),
+    hidden: boolean('hidden').notNull().default(false),
+    kind: categoryGroupKind('kind').notNull().default('normal'),
+    // Groups are soft-deleted: soft-deleted categories keep pointing at their group.
+    deletedAt: instant('deleted_at'),
+    ...timestamps,
+  },
+  (t) => [uniqueIndex('category_group_one_per_system_kind').on(t.kind).where(sql`${t.kind} <> 'normal'`)],
+);
 
 export const category = pgTable(
   'category',
@@ -179,6 +187,10 @@ export const category = pgTable(
   },
   (t) => [
     uniqueIndex('category_one_per_system_kind').on(t.systemKind).where(sql`${t.systemKind} IS NOT NULL`),
+    // One live credit card payment or paired loan category per account.
+    uniqueIndex('category_linked_account_live')
+      .on(t.linkedAccountId)
+      .where(sql`${t.linkedAccountId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
     index('category_group_id').on(t.groupId),
   ],
 );
@@ -257,7 +269,13 @@ export const payee = pgTable(
     deletedAt: instant('deleted_at'),
     ...timestamps,
   },
-  (t) => [uniqueIndex('payee_name_live').on(sql`lower(${t.name})`).where(sql`${t.deletedAt} IS NULL`)],
+  (t) => [
+    // Transfer and system payees are named by the app, so they never block a name the user picks.
+    uniqueIndex('payee_name_live')
+      .on(sql`lower(${t.name})`)
+      .where(sql`${t.deletedAt} IS NULL AND ${t.transferAccountId} IS NULL AND ${t.systemKind} IS NULL`),
+    uniqueIndex('payee_one_per_system_kind').on(t.systemKind).where(sql`${t.systemKind} IS NOT NULL`),
+  ],
 );
 
 export const scheduledTransaction = pgTable('scheduled_transaction', {
@@ -284,7 +302,7 @@ export const scheduledSubtransaction = pgTable('scheduled_subtransaction', {
   id: uuid('id').primaryKey().defaultRandom(),
   scheduledId: uuid('scheduled_id')
     .notNull()
-    .references(() => scheduledTransaction.id, { onDelete: 'cascade' }),
+    .references(() => scheduledTransaction.id),
   amount: money('amount').notNull(),
   categoryId: uuid('category_id').references(() => category.id),
   payeeId: uuid('payee_id').references(() => payee.id),
@@ -316,7 +334,9 @@ export const transaction = pgTable(
     transferSubtxnId: uuid('transfer_subtxn_id').references((): AnyPgColumn => subtransaction.id),
     isSplit: boolean('is_split').notNull().default(false),
     isStartingBalance: boolean('is_starting_balance').notNull().default(false),
-    scheduledId: uuid('scheduled_id').references(() => scheduledTransaction.id, { onDelete: 'set null' }),
+    // No ON DELETE actions anywhere: cascades would bypass the undo ChangeRecorder, so commands change children
+    // explicitly.
+    scheduledId: uuid('scheduled_id').references(() => scheduledTransaction.id),
     importId: text('import_id'),
     externalId: text('external_id'),
     deletedAt: instant('deleted_at'),
@@ -325,6 +345,8 @@ export const transaction = pgTable(
   (t) => [
     index('transaction_account_date').on(t.accountId, t.date),
     index('transaction_date').on(t.date),
+    index('transaction_category_id').on(t.categoryId),
+    index('transaction_payee_id').on(t.payeeId),
     uniqueIndex('transaction_import_id').on(t.accountId, t.importId).where(sql`${t.importId} IS NOT NULL`),
     uniqueIndex('transaction_external_id').on(t.accountId, t.externalId).where(sql`${t.externalId} IS NOT NULL`),
   ],
@@ -348,7 +370,7 @@ export const subtransaction = pgTable(
     deletedAt: instant('deleted_at'),
     ...timestamps,
   },
-  (t) => [index('subtransaction_txn_id').on(t.txnId)],
+  (t) => [index('subtransaction_txn_id').on(t.txnId), index('subtransaction_category_id').on(t.categoryId)],
 );
 
 // ---------------------------------------------------------------- support (spec §4.5)
@@ -379,14 +401,14 @@ export const undoEntry = pgTable('undo_entry', {
 /** Read-only view created by migration 0001_ledger_view.sql; `.existing()` keeps drizzle-kit from managing it. */
 export const ledgerLine = pgView('v_ledger_line', {
   accountId: uuid('account_id').notNull(),
-  accountClass: text('account_class').notNull(),
+  accountClass: text('account_class').$type<AccountClass>().notNull(),
   date: day('date').notNull(),
   month: day('month').notNull(),
   categoryId: uuid('category_id'),
   amount: money('amount').notNull(),
   amountBase: money('amount_base').notNull(),
   isTransfer: boolean('is_transfer').notNull(),
-  counterAccountClass: text('counter_account_class'),
+  counterAccountClass: text('counter_account_class').$type<AccountClass>(),
   isStartingBalance: boolean('is_starting_balance').notNull(),
   txnId: uuid('txn_id').notNull(),
   subtxnId: uuid('subtxn_id'),
PATCH
```

- [ ] **Step 4: Generate the migration, then extend it by hand**

Run: `npm run db:generate -- --name schema_hardening`
Expected: `[✓] Your SQL migration file ➜ drizzle/0002_schema_hardening.sql 🚀`. The generated SQL drops and re-adds the two scheduled-transaction foreign keys without `ON DELETE` actions, drops `payee_name_live`, and alters every timestamp column to `timestamp (3) with time zone`. It also adds `category_group.deleted_at` and creates the new indexes.

drizzle-kit can't know two things:
- `v_ledger_line` reads `transaction.deleted_at` and `subtransaction.deleted_at`, and Postgres refuses to change a column's type while a view uses it. The view is therefore dropped first and recreated unchanged at the end.
- The system payees are data.

Replace the whole of `drizzle/0002_schema_hardening.sql` with the content below. The generated statements are unchanged; they are wrapped in the view drop/recreate and followed by the payee insert.

```sql
-- Hand-edited after `npm run db:generate -- --name schema_hardening`: v_ledger_line reads transaction/subtransaction
-- deleted_at, whose type changes below, so the view is dropped first and recreated unchanged at the end.
DROP VIEW "v_ledger_line";--> statement-breakpoint
ALTER TABLE "scheduled_subtransaction" DROP CONSTRAINT "scheduled_subtransaction_scheduled_id_scheduled_transaction_id_fk";
--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT "transaction_scheduled_id_scheduled_transaction_id_fk";
--> statement-breakpoint
DROP INDEX "payee_name_live";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "last_reconciled_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "app_user" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "app_user" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "category" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "category" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "category" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "category" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "category" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "category_group" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "category_group" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "category_group" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "category_group" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "login_attempt" ALTER COLUMN "at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "month_note" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "month_note" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "month_note" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "month_note" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "payee" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "payee" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "payee" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "payee" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "payee" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "expires_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "last_seen_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "subtransaction" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "subtransaction" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "subtransaction" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "subtransaction" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "subtransaction" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "target" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "target" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "target" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "target" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "undo_entry" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "undo_entry" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "category_group" ADD COLUMN "deleted_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_subtransaction" ADD CONSTRAINT "scheduled_subtransaction_scheduled_id_scheduled_transaction_id_fk" FOREIGN KEY ("scheduled_id") REFERENCES "public"."scheduled_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_scheduled_id_scheduled_transaction_id_fk" FOREIGN KEY ("scheduled_id") REFERENCES "public"."scheduled_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_linked_account_live" ON "category" USING btree ("linked_account_id") WHERE "category"."linked_account_id" IS NOT NULL AND "category"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "category_group_one_per_system_kind" ON "category_group" USING btree ("kind") WHERE "category_group"."kind" <> 'normal';--> statement-breakpoint
CREATE UNIQUE INDEX "payee_one_per_system_kind" ON "payee" USING btree ("system_kind") WHERE "payee"."system_kind" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "subtransaction_category_id" ON "subtransaction" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "transaction_category_id" ON "transaction" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "transaction_payee_id" ON "transaction" USING btree ("payee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payee_name_live" ON "payee" USING btree (lower("name")) WHERE "payee"."deleted_at" IS NULL AND "payee"."transfer_account_id" IS NULL AND "payee"."system_kind" IS NULL;--> statement-breakpoint
-- Recreated exactly as in 0001_ledger_view.sql.
CREATE VIEW "v_ledger_line" AS
SELECT
  t."account_id",
  a."account_class",
  t."date",
  date_trunc('month', t."date")::date AS "month",
  t."category_id",
  t."amount",
  t."amount_base",
  t."transfer_account_id" IS NOT NULL AS "is_transfer",
  ca."account_class" AS "counter_account_class",
  t."is_starting_balance",
  t."id" AS "txn_id",
  NULL::uuid AS "subtxn_id"
FROM "transaction" t
JOIN "account" a ON a."id" = t."account_id"
LEFT JOIN "account" ca ON ca."id" = t."transfer_account_id"
WHERE t."deleted_at" IS NULL AND NOT t."is_split"
UNION ALL
SELECT
  t."account_id",
  a."account_class",
  t."date",
  date_trunc('month', t."date")::date,
  s."category_id",
  s."amount",
  s."amount_base",
  s."transfer_account_id" IS NOT NULL,
  ca."account_class",
  false,
  t."id",
  s."id"
FROM "subtransaction" s
JOIN "transaction" t ON t."id" = s."txn_id"
JOIN "account" a ON a."id" = t."account_id"
LEFT JOIN "account" ca ON ca."id" = s."transfer_account_id"
WHERE s."deleted_at" IS NULL AND t."deleted_at" IS NULL AND t."is_split";--> statement-breakpoint
-- System payees (spec §4.4) are budget-independent rows, so the migration creates them for both existing and fresh
-- databases. ON CONFLICT keeps it idempotent against payee_one_per_system_kind.
INSERT INTO "payee" ("name", "system_kind") VALUES
  ('Starting Balance', 'starting_balance'),
  ('Reconciliation Balance Adjustment', 'reconciliation_adjustment'),
  ('FX revaluation', 'fx_revaluation')
ON CONFLICT ("system_kind") WHERE "system_kind" IS NOT NULL DO NOTHING;
```

The migration seeds the system payees because migrations run once on every database before the server listens. That covers databases that were set up before P2b1 as well as fresh ones, without touching `seedBudget`. Payees don't depend on the budget owner, so creating them before setup is harmless. `ON CONFLICT … DO NOTHING` against `payee_one_per_system_kind` makes re-running the insert a no-op.

Run: `npm run db:generate -- --name check`
Expected: `No schema changes, nothing to migrate 😴` (the hand-written SQL is data and a view, which drizzle-kit doesn't track).

- [ ] **Step 5: Build `todayIn` from date parts (P2 carry-over)**

```bash
git apply <<'PATCH'
diff --git a/src/server/clock.ts b/src/server/clock.ts
index 35d9e34..690e072 100644
--- a/src/server/clock.ts
+++ b/src/server/clock.ts
@@ -9,12 +9,15 @@ export const systemClock: Clock = { now: () => new Date() };
 
 /** Calendar date of `instant` in `timeZone`, formatted 'YYYY-MM-DD'. */
 export function todayIn(timeZone: string, instant: Date): IsoDate {
-  return new Intl.DateTimeFormat('en-CA', {
+  // Built from parts: a locale's date pattern (e.g. en-CA's) can change between ICU versions.
+  const parts = new Intl.DateTimeFormat('en-US', {
     timeZone,
     year: 'numeric',
     month: '2-digit',
     day: '2-digit',
-  }).format(instant);
+  }).formatToParts(instant);
+  const part = (type: 'year' | 'month' | 'day') => parts.find((p) => p.type === type)?.value ?? '';
+  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
 }
 
 /** Calendar month of `instant` in `timeZone`, formatted 'YYYY-MM'. */
PATCH
```

This doesn't change behaviour; `src/server/clock.test.ts` already pins time-zone and DST handling.

- [ ] **Step 6: Amend the spec** (§4 exceptions, group soft delete, payee name rule)

```bash
git apply <<'PATCH'
diff --git a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
index f8604dd..047a073 100644
--- a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
+++ b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
@@ -93,7 +93,13 @@ Assigned amount.
 
 ## 4. Data model
 
-All tables use UUID primary keys and `created_at` / `updated_at` timestamps unless noted.
+All tables use UUID primary keys and `created_at` / `updated_at` timestamps unless noted. The exceptions:
+`login_attempt` and `undo_entry` have bigserial ids; `assignment`, `loan_interest_override`, `fx_rate`, `month_note` and
+`target` use the natural keys listed below; `session` and `undo_entry` have only `created_at`; `login_attempt` has only
+`at`; `assignment`, `loan_interest_override`, `fx_rate` and `scheduled_subtransaction` have no timestamps.
+Timestamps have millisecond precision (`timestamptz(3)`), so a JS `Date` round-trips exactly through undo images.
+Foreign keys have no `ON DELETE` actions: commands delete or re-point child rows themselves, so the undo log sees every
+change.
 
 ### 4.1 Settings and auth
 - `app_user` (at most one row): `password_hash` (argon2id), `totp_secret_enc`, `recovery_code_hashes text[]`,
@@ -111,7 +117,8 @@ All tables use UUID primary keys and `created_at` / `updated_at` timestamps unle
 - `loan_interest_override`: `account_id`, `month`, `amount`. Exists only when the user edits the computed interest.
 
 ### 4.3 Categories and budget
-- `category_group`: `name`, `sort_order`, `hidden`, `kind` (`normal` | `cc_payments` | `debt_payments` | `internal`).
+- `category_group`: `name`, `sort_order`, `hidden`, `kind` (`normal` | `cc_payments` | `debt_payments` | `internal`;
+  at most one group of each kind other than `normal`), `deleted_at`.
 - `category`: `group_id`, `name`, `sort_order`, `hidden`, `note`, `system_kind` (`rta` | `uncategorized` | null),
   `linked_account_id` (set for credit card payment categories and paired loan categories), `deleted_at`.
 - `assignment`: PK (`category_id`, `month`), `amount`. Sparse: rows with amount 0 are deleted.
@@ -126,9 +133,10 @@ All tables use UUID primary keys and `created_at` / `updated_at` timestamps unle
 - `month_note`: PK `month`, `note`.
 
 ### 4.4 Payees and transactions
-- `payee`: `name` (unique among non-deleted), `transfer_account_id` (unique; one auto-created
-  "Transfer : <Account>" payee per account), `system_kind` (`starting_balance` | `reconciliation_adjustment` |
-  `fx_revaluation` | null), `last_category_id`, `deleted_at`.
+- `payee`: `name` (unique among live user payees; transfer and system payees are exempt), `transfer_account_id`
+  (unique; one auto-created "Transfer : <Account>" payee per account), `system_kind` (`starting_balance` |
+  `reconciliation_adjustment` | `fx_revaluation` | null; one payee per kind, created by migration), `last_category_id`,
+  `deleted_at`.
 - `transaction`:
   - `account_id`, `date`, `payee_id`, `category_id` (null for splits, budget↔budget transfers, tracking-only
     transactions, credit/tracking starting balances), `memo`
PATCH
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project server src/server/db/schema.test.ts src/server/db/ledger-view.test.ts src/server/clock.test.ts`
Expected: `Tests  22 passed (22)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  30 passed (30)`, `Tests  294 passed (294)`; both checks exit 0.

- [ ] **Step 8: Commit**

```bash
git add drizzle src/server/db src/server/clock.ts docs/superpowers/specs
git commit -m "feat(server): schema hardening migration and system payees" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Undoable command layer

Spec §2 write path and §10 "Undo/redo". `runCommand` wraps a command in one transaction. The `ChangeRecorder` is the only way a command writes, and it records `{ table, pk, before, after }` for every row it inserts, updates or deletes, in order. Undo applies the before images in reverse order and redo applies the after images in order. Both refuse the whole replay if any row no longer matches the image it expects (ignoring `created_at`/`updated_at`).

Key properties:
- **JSON-safe, exact images.** Rows are keyed by Drizzle property name; `Date` values become ISO strings. `fromImage` turns them back into `Date` for `PgTimestamp` columns, using the column metadata. Numerics stay decimal strings and int8 values are safe integers. Generated columns (`account.accountClass`) are left out. With `timestamptz(3)` (Task 1), this restores every value exactly.
- **No-op updates record nothing.** `rec.update` only touches rows where some value `IS DISTINCT FROM` the new one. A command that changes nothing leaves no entry and keeps the redo stack.
- **Guard rails.** `rec.update` refuses to change primary keys, and `rec.update`/`rec.delete` refuse to run without a `WHERE`.
- **One history.** Commands and undo/redo serialize on `pg_advisory_xact_lock(727274002)`.

**Files:**
- Create: `src/shared/api/undo.ts`, `src/server/commands/recorder.ts`, `src/server/commands/run-command.ts`, `src/server/commands/history.ts`, `src/server/test/snapshot.ts`
- Modify (docs): `docs/superpowers/notes/engineering-notes.md` (advisory-lock key list)
- Test: `src/server/commands/history.test.ts`

**Interfaces:**
- Consumes: `undoEntry` and the other tables from `src/server/db/schema.ts`; `Db`, `Tx`, `Executor` from `src/server/db/client.ts`; `AppError` from `src/server/http/errors.ts`.
- Produces:
  - `src/shared/api/undo.ts`: `UndoItem { label: string }`, `UndoState { undo: UndoItem | null; redo: UndoItem | null }`, `UndoResponse extends UndoState { undone: UndoItem }`, `RedoResponse extends UndoState { redone: UndoItem }`.
  - `src/server/commands/recorder.ts`:
    - `RECORDED_TABLES` (SQL name → table), `RecordedTableName`, `RecordedTable`
    - `RowImage = Record<string, string | number | boolean | null>`
    - `Change { table: RecordedTableName; pk: RowImage; before: RowImage | null; after: RowImage | null }`
    - `class ChangeRecorder` with:
      - `readonly tx: Tx`
      - `readonly changes: Change[]`
      - `insert<T>(table: T, values: T['$inferInsert'] | T['$inferInsert'][]): Promise<T['$inferSelect'][]>`
      - `update<T>(table: T, where: SQL | undefined, set: Partial<T['$inferInsert']>): Promise<T['$inferSelect'][]>` (returns only the rows that changed)
      - `delete<T>(table: T, where: SQL | undefined): Promise<T['$inferSelect'][]>`
    - helpers `toImage`, `fromImage`, `sameData`, `pkWhere`, `primaryKeyOf`, `tableNameOf`.
  - `src/server/commands/run-command.ts`:
    - `COMMAND_LOCK_KEY = 727274002`, `UNDO_HISTORY_LIMIT = 100`
    - `lockCommands(tx: Tx): Promise<void>`
    - `interface Named { name: string }`
    - `runCommand<T>(deps: { db: Db }, label: string | ((result: T) => string), fn: (rec: ChangeRecorder) => Promise<T>): Promise<T>`. A label function must annotate its parameter, e.g. `(r: Named) => …`; otherwise TypeScript infers `unknown`.
  - `src/server/commands/history.ts`:
    - `historyState(db: Executor): Promise<UndoState>`
    - `undo(db: Db): Promise<UndoItem>`, `redo(db: Db): Promise<UndoItem>`
    - errors: `AppError(409, 'undo_conflict', "Can't undo: data changed since.")` (or `"Can't redo: …"`), `409 nothing_to_undo "Nothing to undo."`, `409 nothing_to_redo "Nothing to redo."`
  - `src/server/test/snapshot.ts`: `snapshot(db: Db): Promise<DbSnapshot>` (`Record<tableName, string[]>` of `to_jsonb` rows, sorted).

- [ ] **Step 1: Write the test helper and the failing test**

Create `src/server/test/snapshot.ts`:

```ts
import { sql } from 'drizzle-orm';
import { RECORDED_TABLES } from '../commands/recorder';
import type { Db } from '../db/client';

export type DbSnapshot = Record<string, string[]>;

/**
 * Every row of every undo-recorded table as Postgres renders it (`to_jsonb`), sorted. Comparing two snapshots checks
 * that undo/redo restored the exact database state, timestamps and generated columns included.
 */
export async function snapshot(db: Db): Promise<DbSnapshot> {
  const result: DbSnapshot = {};
  for (const name of Object.keys(RECORDED_TABLES)) {
    const rows = await db.execute<{ row: string }>(
      sql`select to_jsonb(t)::text as row from ${sql.identifier(name)} t order by 1`,
    );
    result[name] = rows.map((r) => r.row);
  }
  return result;
}
```

Create `src/server/commands/history.test.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { account, assignment, category, categoryGroup, undoEntry } from '../db/schema';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { snapshot } from '../test/snapshot';
import { historyState, redo, undo } from './history';
import type { Change } from './recorder';
import { runCommand, UNDO_HISTORY_LIMIT } from './run-command';

let t: TestDatabase;
beforeEach(async () => {
  t = await createTestDatabase();
});
afterEach(async () => {
  await t.drop();
});

const deps = () => ({ db: t.db });

function createGroup(name: string) {
  return runCommand(deps(), `Create ${name}`, async (rec) => (await rec.insert(categoryGroup, { name }))[0]!);
}

function renameGroup(id: string, name: string) {
  return runCommand(deps(), `Rename to ${name}`, (rec) =>
    rec.update(categoryGroup, eq(categoryGroup.id, id), { name }),
  );
}

async function entries() {
  return t.db.select().from(undoEntry).orderBy(undoEntry.id);
}

const kindOf = (c: Change) => (c.before === null ? 'insert' : c.after === null ? 'delete' : 'update');

describe('runCommand', () => {
  it('records ordered, JSON-safe before/after images of every insert, update and delete', async () => {
    const { group, rent } = await runCommand(deps(), 'Mixed', async (rec) => {
      const [group] = await rec.insert(categoryGroup, { name: 'Bills' });
      const [rent] = await rec.insert(category, { groupId: group!.id, name: 'Rent' });
      await rec.update(category, eq(category.id, rent!.id), { name: 'Rent & bills' });
      await rec.insert(assignment, { categoryId: rent!.id, month: '2026-11-01', amount: 150_000 });
      await rec.delete(assignment, eq(assignment.categoryId, rent!.id));
      return { group: group!, rent: rent! };
    });

    const [entry] = await entries();
    expect(entry).toMatchObject({ label: 'Mixed', state: 'done' });
    const changes = entry!.changes as Change[];
    expect(changes.map((c) => [c.table, kindOf(c)])).toEqual([
      ['category_group', 'insert'],
      ['category', 'insert'],
      ['category', 'update'],
      ['assignment', 'insert'],
      ['assignment', 'delete'],
    ]);
    expect(changes[0]).toEqual({
      table: 'category_group',
      pk: { id: group.id },
      before: null,
      after: {
        id: group.id,
        name: 'Bills',
        sortOrder: 0,
        hidden: false,
        kind: 'normal',
        deletedAt: null,
        createdAt: group.createdAt.toISOString(),
        updatedAt: group.updatedAt.toISOString(),
      },
    });
    expect([changes[2]!.before!.name, changes[2]!.after!.name]).toEqual(['Rent', 'Rent & bills']);
    expect(changes[4]).toMatchObject({
      pk: { categoryId: rent.id, month: '2026-11-01' },
      before: { categoryId: rent.id, month: '2026-11-01', amount: 150_000 },
      after: null,
    });
  });

  it('keeps numerics as decimal strings and leaves generated columns out of images', async () => {
    await runCommand(deps(), 'Create loan', (rec) =>
      rec.insert(account, { name: 'Mortgage', type: 'mortgage', interestRate: '6.5', minPayment: 250_000 }),
    );
    const [change] = (await entries())[0]!.changes as Change[];
    expect(change!.after).toMatchObject({ interestRate: '6.5000', minPayment: 250_000 });
    expect(change!.after).not.toHaveProperty('accountClass');
  });

  it('records nothing for a no-op, so the history (including redo) stays as it was', async () => {
    const group = await createGroup('Bills');
    await renameGroup(group.id, 'Utilities');
    await undo(t.db);
    expect(await renameGroup(group.id, 'Bills')).toEqual([]);
    expect((await entries()).map((e) => [e.label, e.state])).toEqual([
      ['Create Bills', 'done'],
      ['Rename to Utilities', 'undone'],
    ]);
  });

  it('rolls back every write and records nothing when the command fails', async () => {
    const failing = runCommand(deps(), 'Fails', async (rec) => {
      await rec.insert(categoryGroup, { name: 'Bills' });
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    expect(await t.db.select().from(categoryGroup)).toEqual([]);
    expect(await entries()).toEqual([]);
  });

  it('clears the redo stack on a new command and keeps only the newest 100 done entries', async () => {
    const group = await createGroup('Bills');
    await renameGroup(group.id, 'Undone');
    await undo(t.db);
    for (let i = 1; i <= UNDO_HISTORY_LIMIT; i += 1) await renameGroup(group.id, `Name ${i}`);
    const rows = await entries();
    expect(rows).toHaveLength(UNDO_HISTORY_LIMIT);
    expect(rows.every((e) => e.state === 'done')).toBe(true);
    expect([rows[0]!.label, rows.at(-1)!.label]).toEqual(['Rename to Name 1', 'Rename to Name 100']);
  });

  it('refuses writes that would escape the recorder: primary key changes and updates without WHERE', async () => {
    const group = await createGroup('Bills');
    const pkChange = runCommand(deps(), 'Bad', (rec) =>
      rec.update(categoryGroup, eq(categoryGroup.id, group.id), { id: crypto.randomUUID() }),
    );
    await expect(pkChange).rejects.toThrow('Recorded updates cannot change primary keys');
    const everything = runCommand(deps(), 'Bad', (rec) => rec.delete(categoryGroup, undefined));
    await expect(everything).rejects.toThrow('Recorded updates and deletes need a WHERE condition');
  });
});

describe('undo and redo', () => {
  it('restore the exact state before and after a bulk command', async () => {
    const setup = await runCommand(deps(), 'Setup', async (rec) => {
      const [group] = await rec.insert(categoryGroup, { name: 'Bills' });
      const cats = await rec.insert(
        category,
        ['Rent', 'Power', 'Water'].map((name, i) => ({ groupId: group!.id, name, sortOrder: i })),
      );
      await rec.insert(
        assignment,
        cats.map((c, i) => ({ categoryId: c.id, month: '2026-11-01', amount: 10_000 * (i + 1) })),
      );
      return { group: group!, cats };
    });
    const before = await snapshot(t.db);

    await runCommand(deps(), 'Bulk', async (rec) => {
      await rec.update(category, eq(category.groupId, setup.group.id), { hidden: true, note: 'archived' });
      await rec.delete(assignment, eq(assignment.month, '2026-11-01'));
      await rec.insert(category, { groupId: setup.group.id, name: 'Internet', sortOrder: 3 });
      await rec.update(categoryGroup, eq(categoryGroup.id, setup.group.id), {
        name: 'Old bills',
        deletedAt: new Date(),
      });
    });
    const after = await snapshot(t.db);
    expect(after).not.toEqual(before);

    expect(await undo(t.db)).toEqual({ label: 'Bulk' });
    expect(await snapshot(t.db)).toEqual(before);
    expect(await redo(t.db)).toEqual({ label: 'Bulk' });
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('report what Undo and Redo would do next', async () => {
    expect(await historyState(t.db)).toEqual({ undo: null, redo: null });
    const group = await createGroup('Bills');
    await renameGroup(group.id, 'Utilities');
    expect(await historyState(t.db)).toEqual({ undo: { label: 'Rename to Utilities' }, redo: null });
    await undo(t.db);
    const middle = { undo: { label: 'Create Bills' }, redo: { label: 'Rename to Utilities' } };
    expect(await historyState(t.db)).toEqual(middle);
    await undo(t.db);
    expect(await historyState(t.db)).toEqual({ undo: null, redo: { label: 'Create Bills' } });
    await redo(t.db);
    expect(await historyState(t.db)).toEqual(middle);
  });

  it('refuse to undo when a row changed since, leaving everything as it was', async () => {
    const group = await createGroup('Bills');
    await renameGroup(group.id, 'Utilities');
    await t.db.update(categoryGroup).set({ hidden: true }).where(eq(categoryGroup.id, group.id));
    const state = await snapshot(t.db);

    await expect(undo(t.db)).rejects.toMatchObject({
      status: 409,
      code: 'undo_conflict',
      message: "Can't undo: data changed since.",
    });
    expect(await snapshot(t.db)).toEqual(state);
    expect((await entries()).map((e) => e.state)).toEqual(['done', 'done']);
  });

  it('refuse to undo an insert whose row is gone, and to redo when a row changed since', async () => {
    const group = await createGroup('Bills');
    await t.db.delete(categoryGroup).where(eq(categoryGroup.id, group.id));
    await expect(undo(t.db)).rejects.toMatchObject({ code: 'undo_conflict' });

    const other = await createGroup('Food');
    await renameGroup(other.id, 'Groceries');
    await undo(t.db);
    await t.db.update(categoryGroup).set({ name: 'Dining' }).where(eq(categoryGroup.id, other.id));
    await expect(redo(t.db)).rejects.toMatchObject({
      status: 409,
      code: 'undo_conflict',
      message: "Can't redo: data changed since.",
    });
  });

  it('ignore timestamp-only differences', async () => {
    const group = await createGroup('Bills');
    await renameGroup(group.id, 'Utilities');
    await t.db.execute(sql`update category_group set updated_at = updated_at + interval '1 hour'`);
    await expect(undo(t.db)).resolves.toEqual({ label: 'Rename to Utilities' });
    const [row] = await t.db.select().from(categoryGroup);
    expect(row!.name).toBe('Bills');
  });

  it('say when there is nothing to undo or redo', async () => {
    const nothing = (code: string, message: string) => ({ status: 409, code, message });
    await expect(undo(t.db)).rejects.toMatchObject(nothing('nothing_to_undo', 'Nothing to undo.'));
    await expect(redo(t.db)).rejects.toMatchObject(nothing('nothing_to_redo', 'Nothing to redo.'));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project server src/server/commands/history.test.ts`
Expected: FAIL with `Error: Cannot find module '../commands/recorder' imported from …/src/server/test/snapshot.ts` (`Test Files  1 failed (1)`, no tests run).

- [ ] **Step 3: Add the shared undo types**

Create `src/shared/api/undo.ts`:

```ts
/** A command in the undo history, as the header's Undo/Redo buttons show it. */
export interface UndoItem {
  label: string;
}

/** GET /api/undo: what Undo would revert and what Redo would reapply (null = nothing). */
export interface UndoState {
  undo: UndoItem | null;
  redo: UndoItem | null;
}

/** POST /api/undo */
export interface UndoResponse extends UndoState {
  undone: UndoItem;
}

/** POST /api/redo */
export interface RedoResponse extends UndoState {
  redone: UndoItem;
}
```

- [ ] **Step 4: Write the recorder**

Create `src/server/commands/recorder.ts`:

```ts
import { and, eq, getTableColumns, getTableName, inArray, is, or, type SQL, sql } from 'drizzle-orm';
import { getTableConfig, type PgColumn, PgTimestamp } from 'drizzle-orm/pg-core';
import type { Tx } from '../db/client';
import {
  account,
  assignment,
  category,
  categoryGroup,
  loanInterestOverride,
  monthNote,
  payee,
  scheduledSubtransaction,
  scheduledTransaction,
  subtransaction,
  target,
  transaction,
} from '../db/schema';

/** Every table a user command may write, keyed by its SQL name; undo looks tables up here. */
export const RECORDED_TABLES = {
  account,
  category_group: categoryGroup,
  category,
  assignment,
  target,
  month_note: monthNote,
  payee,
  scheduled_transaction: scheduledTransaction,
  scheduled_subtransaction: scheduledSubtransaction,
  transaction,
  subtransaction,
  loan_interest_override: loanInterestOverride,
} as const;

export type RecordedTableName = keyof typeof RECORDED_TABLES;
export type RecordedTable = (typeof RECORDED_TABLES)[RecordedTableName];
type Row = Record<string, unknown>;

/**
 * A JSON-safe copy of one row, keyed by Drizzle property name. Timestamps are ISO strings (exact: columns have
 * millisecond precision), numerics stay decimal strings, generated columns are left out.
 */
export type RowImage = Record<string, string | number | boolean | null>;

/** One recorded row change (spec §4.5 `undo_entry.changes`); `before` is null for inserts, `after` for deletes. */
export interface Change {
  table: RecordedTableName;
  pk: RowImage;
  before: RowImage | null;
  after: RowImage | null;
}

/** Undo conflict checks skip these: they come from two clocks (Postgres now() and JS) and carry no user data. */
const IGNORED_IN_COMPARISON = new Set(['createdAt', 'updatedAt']);

function columnsOf(table: RecordedTable): Record<string, PgColumn> {
  return getTableColumns(table) as Record<string, PgColumn>;
}

export function tableNameOf(table: RecordedTable): RecordedTableName {
  const name = getTableName(table) as RecordedTableName;
  if (RECORDED_TABLES[name] !== table) throw new Error(`Table ${name} is not recorded for undo`);
  return name;
}

/** Property names of the table's primary key columns. */
export function primaryKeyOf(table: RecordedTable): string[] {
  const columns = Object.entries(columnsOf(table));
  const single = columns.filter(([, column]) => column.primary).map(([key]) => key);
  if (single.length > 0) return single;
  const names = getTableConfig(table).primaryKeys[0]?.columns.map((column) => column.name) ?? [];
  return names.map((name) => columns.find(([, column]) => column.name === name)![0]);
}

export function toImage(table: RecordedTable, row: Row): RowImage {
  const image: RowImage = {};
  for (const [key, column] of Object.entries(columnsOf(table))) {
    if (column.generated) continue;
    const value = row[key];
    if (value instanceof Date) image[key] = value.toISOString();
    else if (value === null || value === undefined) image[key] = null;
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') image[key] = value;
    else throw new Error(`Column ${key} of ${getTableName(table)} holds a value undo can't record`);
  }
  return image;
}

/** The inverse of toImage: values ready for Drizzle insert/update (ISO strings back to Date for timestamps). */
export function fromImage(table: RecordedTable, image: RowImage): Row {
  const columns = columnsOf(table);
  return Object.fromEntries(
    Object.entries(image).map(([key, value]) => {
      const column = columns[key];
      if (!column) throw new Error(`Unknown column ${key} of ${getTableName(table)}`);
      return [key, value !== null && is(column, PgTimestamp) ? new Date(value as string) : value];
    }),
  );
}

/** True when both images hold the same user data (timestamps excluded). */
export function sameData(a: RowImage, b: RowImage): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => IGNORED_IN_COMPARISON.has(key) || a[key] === b[key]);
}

export function pkWhere(table: RecordedTable, pk: RowImage): SQL {
  const columns = columnsOf(table);
  const values = fromImage(table, pk);
  return and(...Object.entries(values).map(([key, value]) => eq(columns[key]!, value)))!;
}

function pkOf(table: RecordedTable, row: Row): RowImage {
  const image = toImage(table, row);
  return Object.fromEntries(primaryKeyOf(table).map((key) => [key, image[key] ?? null]));
}

/** Matches exactly `rows` by primary key. */
function rowsWhere(table: RecordedTable, rows: Row[]): SQL {
  const keys = primaryKeyOf(table);
  const columns = columnsOf(table);
  if (keys.length === 1) return inArray(columns[keys[0]!]!, rows.map((row) => row[keys[0]!]));
  return or(...rows.map((row) => pkWhere(table, pkOf(table, row))))!;
}

function requireWhere(where: SQL | undefined): SQL {
  // Guards against a forgotten condition turning into a whole-table write.
  if (!where) throw new Error('Recorded updates and deletes need a WHERE condition');
  return where;
}

/**
 * Writes rows inside a command's transaction and records ordered before/after images of every row it touches, so
 * undo/redo can replay them (spec §10 "Undo/redo"). Commands must make every write through it; reads go through `tx`.
 */
export class ChangeRecorder {
  readonly changes: Change[] = [];

  constructor(readonly tx: Tx) {}

  async insert<T extends RecordedTable>(
    table: T,
    values: T['$inferInsert'] | T['$inferInsert'][],
  ): Promise<T['$inferSelect'][]> {
    const list = Array.isArray(values) ? values : [values];
    if (list.length === 0) return [];
    const rows = (await this.tx.insert(table).values(list as never).returning()) as T['$inferSelect'][];
    for (const row of rows) this.record(table, null, row as Row);
    return rows;
  }

  /**
   * Applies `set` (plain values only) to the rows matching `where` whose values actually differ, and returns those
   * rows as updated. Rows that already hold the values are left alone, so a no-op records nothing.
   */
  async update<T extends RecordedTable>(
    table: T,
    where: SQL | undefined,
    set: Partial<T['$inferInsert']>,
  ): Promise<T['$inferSelect'][]> {
    const columns = columnsOf(table);
    const entries = Object.entries(set).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return [];
    const keys = primaryKeyOf(table);
    if (entries.some(([key]) => keys.includes(key))) throw new Error('Recorded updates cannot change primary keys');
    const differs = or(
      ...entries.map(([key, value]) => sql`${columns[key]!} IS DISTINCT FROM ${sql.param(value, columns[key]!)}`),
    );
    const before = (await this.tx
      .select()
      .from(table as RecordedTable)
      .where(and(requireWhere(where), differs))
      .for('update')) as Row[];
    if (before.length === 0) return [];
    const after = (await this.tx
      .update(table)
      .set(set as never)
      .where(rowsWhere(table, before))
      .returning()) as Row[];
    const afterByPk = new Map(after.map((row) => [JSON.stringify(pkOf(table, row)), row]));
    for (const row of before) this.record(table, row, afterByPk.get(JSON.stringify(pkOf(table, row)))!);
    return after as T['$inferSelect'][];
  }

  async delete<T extends RecordedTable>(table: T, where: SQL | undefined): Promise<T['$inferSelect'][]> {
    const rows = (await this.tx.delete(table).where(requireWhere(where)).returning()) as Row[];
    for (const row of rows) this.record(table, row, null);
    return rows as T['$inferSelect'][];
  }

  private record(table: RecordedTable, before: Row | null, after: Row | null): void {
    this.changes.push({
      table: tableNameOf(table),
      pk: pkOf(table, (after ?? before)!),
      before: before && toImage(table, before),
      after: after && toImage(table, after),
    });
  }
}
```

- [ ] **Step 5: Write `runCommand`**

Create `src/server/commands/run-command.ts`:

```ts
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { undoEntry } from '../db/schema';
import { ChangeRecorder } from './recorder';

/**
 * Advisory lock key that serializes user commands with undo/redo, so a command can't interleave with a replay and
 * the history stays linear. (The login lock is 727274001; keep the keys distinct.)
 */
export const COMMAND_LOCK_KEY = 727274002;

/** Spec §10: only the newest 100 done entries are kept. */
export const UNDO_HISTORY_LIMIT = 100;

export async function lockCommands(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${COMMAND_LOCK_KEY}::bigint)`);
}

/** What commands return when their undo label names the row they changed. */
export interface Named {
  name: string;
}

/**
 * Runs one user command in one transaction (spec §2 write path). `fn` writes through the recorder; if it changed
 * anything, the changes become a new undo entry, the redo stack is cleared and the history is trimmed. A command
 * that changes nothing leaves the history (including redo) alone.
 */
export function runCommand<T>(
  deps: { db: Db },
  /** A function gets the command's result, e.g. `(r: Named) => \`Delete account "${r.name}"\``. */
  label: string | ((result: T) => string),
  fn: (rec: ChangeRecorder) => Promise<T>,
): Promise<T> {
  return deps.db.transaction(async (tx) => {
    await lockCommands(tx);
    const rec = new ChangeRecorder(tx);
    const result = await fn(rec);
    if (rec.changes.length > 0) {
      await tx.delete(undoEntry).where(eq(undoEntry.state, 'undone'));
      await tx.insert(undoEntry).values({
        label: typeof label === 'function' ? label(result) : label,
        changes: rec.changes,
      });
      const kept = tx
        .select({ id: undoEntry.id })
        .from(undoEntry)
        .where(eq(undoEntry.state, 'done'))
        .orderBy(desc(undoEntry.id))
        .limit(UNDO_HISTORY_LIMIT);
      await tx.delete(undoEntry).where(and(eq(undoEntry.state, 'done'), notInArray(undoEntry.id, kept)));
    }
    return result;
  });
}
```

- [ ] **Step 6: Write undo and redo**

Create `src/server/commands/history.ts`:

```ts
import { asc, desc, eq } from 'drizzle-orm';
import type { UndoItem, UndoState } from '../../shared/api/undo';
import type { Db, Executor, Tx } from '../db/client';
import { undoEntry } from '../db/schema';
import { AppError } from '../http/errors';
import { type Change, fromImage, pkWhere, RECORDED_TABLES, sameData, toImage } from './recorder';
import { lockCommands } from './run-command';

type Direction = 'undo' | 'redo';

/** The entry Undo would revert (newest done) and the one Redo would reapply (oldest undone). */
export async function historyState(db: Executor): Promise<UndoState> {
  const [undo] = await db
    .select({ label: undoEntry.label })
    .from(undoEntry)
    .where(eq(undoEntry.state, 'done'))
    .orderBy(desc(undoEntry.id))
    .limit(1);
  const [redo] = await db
    .select({ label: undoEntry.label })
    .from(undoEntry)
    .where(eq(undoEntry.state, 'undone'))
    .orderBy(asc(undoEntry.id))
    .limit(1);
  return { undo: undo ?? null, redo: redo ?? null };
}

/**
 * Replays changes one row at a time. Each row must still look exactly as the entry left it (ignoring timestamps);
 * otherwise the whole replay is refused and the transaction rolls back.
 */
async function replay(tx: Tx, changes: Change[], direction: Direction): Promise<void> {
  const ordered = direction === 'undo' ? [...changes].reverse() : changes;
  for (const change of ordered) {
    const table = RECORDED_TABLES[change.table];
    const expected = direction === 'undo' ? change.after : change.before;
    const wanted = direction === 'undo' ? change.before : change.after;
    const where = pkWhere(table, change.pk);
    const [current] = await tx
      .select()
      .from(table as typeof table)
      .where(where)
      .for('update');
    const matches =
      current === undefined ? expected === null : expected !== null && sameData(toImage(table, current), expected);
    if (!matches) {
      const verb = direction === 'undo' ? 'undo' : 'redo';
      throw new AppError(409, 'undo_conflict', `Can't ${verb}: data changed since.`);
    }
    if (wanted === null) await tx.delete(table).where(where);
    else if (current === undefined) await tx.insert(table).values(fromImage(table, wanted) as never);
    else await tx.update(table).set(fromImage(table, wanted) as never).where(where);
  }
}

async function step(db: Db, direction: Direction): Promise<UndoItem> {
  return db.transaction(async (tx) => {
    await lockCommands(tx);
    const [entry] = await tx
      .select()
      .from(undoEntry)
      .where(eq(undoEntry.state, direction === 'undo' ? 'done' : 'undone'))
      .orderBy(direction === 'undo' ? desc(undoEntry.id) : asc(undoEntry.id))
      .limit(1);
    if (!entry) {
      throw direction === 'undo'
        ? new AppError(409, 'nothing_to_undo', 'Nothing to undo.')
        : new AppError(409, 'nothing_to_redo', 'Nothing to redo.');
    }
    await replay(tx, entry.changes as Change[], direction);
    await tx
      .update(undoEntry)
      .set({ state: direction === 'undo' ? 'undone' : 'done' })
      .where(eq(undoEntry.id, entry.id));
    return { label: entry.label };
  });
}

/** Reverts the newest done command: its before images, in reverse order. */
export function undo(db: Db): Promise<UndoItem> {
  return step(db, 'undo');
}

/** Reapplies the most recently undone command: its after images, in order. */
export function redo(db: Db): Promise<UndoItem> {
  return step(db, 'redo');
}
```

- [ ] **Step 7: Register the advisory-lock key**

```bash
git apply <<'PATCH'
diff --git a/docs/superpowers/notes/engineering-notes.md b/docs/superpowers/notes/engineering-notes.md
index 7b740d8..3915f91 100644
--- a/docs/superpowers/notes/engineering-notes.md
+++ b/docs/superpowers/notes/engineering-notes.md
@@ -64,6 +64,7 @@ Keep each plan to about 8–10 tasks. A task is one reviewable unit with its own
 - `withLoginLock(db, fn)` in `src/server/auth/rate-limit.ts` serialises sign-in and re-auth with
   `pg_advisory_xact_lock(727274001)`. Any new advisory lock needs a different key; list keys in this file:
   - `727274001`: login and re-authentication.
+  - `727274002`: user commands and undo/redo (`COMMAND_LOCK_KEY` in `src/server/commands/run-command.ts`).
 
 ### Engine
 - `src/engine` is pure: no I/O, no Node modules, no `Date.now()` / `new Date()` / `Math.random()`. ESLint enforces this.
PATCH
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run --project server src/server/commands/history.test.ts`
Expected: `Tests  12 passed (12)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  31 passed (31)`, `Tests  306 passed (306)`; both checks exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/shared/api/undo.ts src/server/commands src/server/test/snapshot.ts docs/superpowers/notes/engineering-notes.md
git commit -m "feat(server): undoable command layer (ChangeRecorder, runCommand, undo/redo)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Undo/redo API and deny-by-default routing

The header's Undo and Redo buttons (spec §11) call these endpoints. This task also adds the P2a carry-over guard: every router outside `/api/auth` is mounted on its own prefix behind `.use('*', requireSession(deps))`, and a test walks `app.routes` and expects 401 without a session for each of those routes, so a future router can't silently be public. Hono's `'/api/undo/*'` pattern also matches `/api/undo`, so a router's `.use('*')` guards its root route too.

**Files:**
- Create: `src/server/commands/undo-routes.ts`
- Modify: `src/server/http/app.ts`
- Modify (docs): spec §4.5 (`pk` in `undo_entry.changes`) and §13 (409 for undo conflicts)
- Test: `src/server/commands/undo-routes.test.ts`, `src/server/http/app.test.ts`

**Interfaces:**
- Consumes: `historyState`, `undo`, `redo`, `runCommand` (Task 2); `requireSession`, `AuthedEnv` from `src/server/auth/sessions.ts`.
- Produces:
  - `undoRoutes(deps: AppDeps)`, mounted at `/api/undo`: `GET /` → `UndoState`; `POST /` → `UndoResponse`.
  - `redoRoutes(deps: AppDeps)`, mounted at `/api/redo`: `POST /` → `RedoResponse`.
  - The mounting pattern every later router follows: `new Hono<AuthedEnv>().use('*', requireSession(deps))…`, mounted with `.route('/api/<prefix>', …)` after the auth routers.

- [ ] **Step 1: Write the failing tests**

Create `src/server/commands/undo-routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { categoryGroup } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { runCommand } from './run-command';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db);
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as unknown };
}

function createGroup(name: string) {
  return runCommand({ db: t.db }, `Create group "${name}"`, async (rec) => {
    const [group] = await rec.insert(categoryGroup, { name });
    return group!;
  });
}

describe('/api/undo and /api/redo', () => {
  it('shows, undoes and redoes the newest command', async () => {
    expect(await json(await ctx.client.get('/api/undo'))).toEqual({ status: 200, body: { undo: null, redo: null } });
    const group = await createGroup('Bills');
    expect(await json(await ctx.client.get('/api/undo'))).toEqual({
      status: 200,
      body: { undo: { label: 'Create group "Bills"' }, redo: null },
    });

    expect(await json(await ctx.client.post('/api/undo'))).toEqual({
      status: 200,
      body: { undo: null, redo: { label: 'Create group "Bills"' }, undone: { label: 'Create group "Bills"' } },
    });
    expect(await t.db.select().from(categoryGroup).where(eq(categoryGroup.id, group.id))).toEqual([]);

    expect(await json(await ctx.client.post('/api/redo'))).toEqual({
      status: 200,
      body: { undo: { label: 'Create group "Bills"' }, redo: null, redone: { label: 'Create group "Bills"' } },
    });
    expect(await t.db.select().from(categoryGroup).where(eq(categoryGroup.id, group.id))).toEqual([group]);
  });

  it('answers 409 when the data changed since, or when there is nothing to undo or redo', async () => {
    expect(await json(await ctx.client.post('/api/undo'))).toEqual({
      status: 409,
      body: { code: 'nothing_to_undo', message: 'Nothing to undo.' },
    });
    expect(await json(await ctx.client.post('/api/redo'))).toEqual({
      status: 409,
      body: { code: 'nothing_to_redo', message: 'Nothing to redo.' },
    });
    const group = await createGroup('Bills');
    await t.db.update(categoryGroup).set({ name: 'Edited elsewhere' }).where(eq(categoryGroup.id, group.id));
    expect(await json(await ctx.client.post('/api/undo'))).toEqual({
      status: 409,
      body: { code: 'undo_conflict', message: "Can't undo: data changed since." },
    });
  });
});
```

Add the route guard test to `src/server/http/app.test.ts`:

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.test.ts b/src/server/http/app.test.ts
index 567f56c..0b98177 100644
--- a/src/server/http/app.test.ts
+++ b/src/server/http/app.test.ts
@@ -71,3 +71,24 @@ describe('cross-cutting behaviour', () => {
     expect(withHeader.status).toBe(404);
   });
 });
+
+describe('route guard', () => {
+  it('requires a session on every /api route outside /api/auth (deny by default)', async () => {
+    const { app, client } = createTestApp(t.db);
+    const isAuth = (path: string) => path === '/api/auth' || path.startsWith('/api/auth/');
+    const routes = app.routes
+      .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/') && !isAuth(r.path))
+      .map((r) => `${r.method} ${r.path}`);
+    expect(routes).toContain('GET /api/undo');
+
+    const responses = [];
+    for (const route of routes) {
+      const [method, path] = route.split(' ') as [string, string];
+      const url = path.replace(/:[^/]+/g, crypto.randomUUID());
+      const res = await client.send(method, url, method === 'GET' ? undefined : {});
+      responses.push({ route, status: res.status, body: await res.json() });
+    }
+    const unauthorized = { status: 401, body: { code: 'unauthorized', message: 'Please sign in.' } };
+    expect(responses).toEqual(routes.map((route) => ({ route, ...unauthorized })));
+  });
+});
PATCH
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/commands/undo-routes.test.ts src/server/http/app.test.ts`
Expected: FAIL with `Tests  3 failed | 7 passed (10)`. The undo tests get `{ status: 404, … }`, and the guard fails with `expected [] to include 'GET /api/undo'` (no `/api` route outside `/api/auth` exists yet).

- [ ] **Step 3: Write the routes**

Create `src/server/commands/undo-routes.ts`:

```ts
import { Hono } from 'hono';
import type { RedoResponse, UndoResponse, UndoState } from '../../shared/api/undo';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import type { AppDeps } from '../http/app';
import { historyState, redo, undo } from './history';

/** /api/undo (spec §10 "Undo/redo"): GET shows what Undo and Redo would do, POST undoes the newest command. */
export function undoRoutes(deps: AppDeps) {
  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/', async (c) => c.json<UndoState>(await historyState(deps.db)))
    .post('/', async (c) => {
      const undone = await undo(deps.db);
      return c.json<UndoResponse>({ ...(await historyState(deps.db)), undone });
    });
}

/** /api/redo: POST reapplies the most recently undone command. */
export function redoRoutes(deps: AppDeps) {
  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .post('/', async (c) => {
      const redone = await redo(deps.db);
      return c.json<RedoResponse>({ ...(await historyState(deps.db)), redone });
    });
}
```

- [ ] **Step 4: Mount them**

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.ts b/src/server/http/app.ts
index 43b2273..c430791 100644
--- a/src/server/http/app.ts
+++ b/src/server/http/app.ts
@@ -8,6 +8,7 @@ import { loginRoutes } from '../auth/login-routes';
 import { securityRoutes } from '../auth/security-routes';
 import { setupRoutes } from '../auth/setup-routes';
 import type { Clock } from '../clock';
+import { redoRoutes, undoRoutes } from '../commands/undo-routes';
 import type { Config } from '../config';
 import type { Db } from '../db/client';
 import type { Logger } from '../logger';
@@ -63,7 +64,11 @@ export function createApp(deps: AppDeps) {
     })
     .route('/api/auth', setupRoutes(deps))
     .route('/api/auth', loginRoutes(deps))
-    .route('/api/auth', securityRoutes(deps));
+    .route('/api/auth', securityRoutes(deps))
+    // Every router below is mounted on its own prefix and starts with .use('*', requireSession(deps)), so each new
+    // route is private by default (app.test.ts walks app.routes to keep it that way).
+    .route('/api/undo', undoRoutes(deps))
+    .route('/api/redo', redoRoutes(deps));
 
   app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
   app.onError(errorHandler);
PATCH
```

- [ ] **Step 5: Amend the spec**

```bash
git apply <<'PATCH'
diff --git a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
index 047a073..1ed3fce 100644
--- a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
+++ b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
@@ -158,7 +158,8 @@ change.
 
 ### 4.5 Support
 - `fx_rate`: PK (`currency`, `date`), `rate`, `source` (`nbp`), `effective_date` (the NBP publication day used).
-- `undo_entry`: `label`, `changes jsonb` (ordered `[{table, id, before, after}]`), `state` (`done` | `undone`).
+- `undo_entry`: `label`, `changes jsonb` (ordered `[{table, pk, before, after}]`; `pk` is an object because
+  `assignment` has a composite key), `state` (`done` | `undone`).
 
 ### 4.6 Ledger view
 `v_ledger_line` merges non-split transactions and subtransactions of non-deleted transactions (all accounts) into one
@@ -510,8 +511,9 @@ signs out other sessions.
 
 - **zod validation failures** → HTTP 400 `{ code: "validation", fieldErrors }`; the UI shows them inline.
 - **Domain rule violations** throw a typed `DomainError(code, message)` → HTTP 422; the UI shows the message.
-  Examples: split sum mismatch, category on a budget↔budget transfer, closing an account with a non-zero balance,
-  undo conflict.
+  Examples: split sum mismatch, category on a budget↔budget transfer, closing an account with a non-zero balance.
+- **Undo/redo conflicts** (a row changed since the command) → HTTP 409 `undo_conflict` "Can't undo: data changed
+  since." (or "Can't redo: …"); an empty stack → 409 `nothing_to_undo` / `nothing_to_redo`.
 - **Auth failures** → 401 (no session) or 429 (rate limited / locked).
 - **Unexpected errors** → 500 with a generic message. The server logs details with pino (JSON to stdout, including a
   request ID); the UI shows a toast with Retry.
PATCH
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project server src/server/commands/undo-routes.test.ts src/server/http/app.test.ts`
Expected: `Tests  10 passed (10)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  32 passed (32)`, `Tests  309 passed (309)`; both checks exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/server/commands src/server/http docs/superpowers/specs
git commit -m "feat(server): undo/redo API and deny-by-default API routing" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Accounts — list and create

Spec §3, §4.2, §9 and §10 "Accounts" / "Starting balance". Creating an account is one undoable command that creates:
- the account;
- its transfer payee `Transfer : <name>`;
- the cleared starting-balance transaction, with payee "Starting Balance", `is_starting_balance`, `amount_base` from the engine's `convertToBase`, and category Ready to Assign for cash accounts or none for credit and tracking accounts;
- for credit accounts, the credit card payment category in the Credit Card Payments group;
- for loans that opt in, the paired category in Debt Payments with a `debt`/`min_payment` target.

The starting date defaults to today in the configured time zone and may not be in the future (§5.6). A foreign currency needs `fxRate` until the NBP lookup arrives in P2d. The rate is stored with `fx_rate_manual = true`.

Balances are computed on read from live transactions: cleared (cleared + reconciled), uncleared and working, natively and in PLN (Σ booked `amount_base`).

**Files:**
- Create: `src/shared/api/common.ts`, `src/shared/api/accounts.ts`, `src/server/db/lookups.ts`, `src/server/accounts/account-queries.ts`, `src/server/accounts/account-commands.ts`, `src/server/accounts/account-routes.ts`, `src/server/test/fixtures.ts`
- Modify: `src/server/http/app.ts`
- Test: `src/server/accounts/account-routes.test.ts`

**Interfaces:**
- Consumes:
  - from Task 2: `runCommand`, `ChangeRecorder` (`rec.insert`, `rec.update`, `rec.tx`)
  - from Task 3: the router pattern
  - from `src/engine`: `convertToBase(amount, rate)`, `monthOf(date)`, `IsoDate`
  - from `src/server/clock.ts`: `todayIn(timeZone, instant)`
  - from `src/shared/accounts.ts`: `accountClassOf`, `isLoanType`, `ACCOUNT_TYPES`
- Produces:
  - `src/shared/api/common.ts`:
    - schemas: `moneySchema` (`z.int`), `nonNegativeMoneySchema`, `positiveMoneySchema`, `isoDateSchema`, `monthSchema` (`YYYY-MM`), `idSchema`, `idParamSchema` (`{ id }`), `nameSchema` (trimmed, 1–100), `noteSchema` (trimmed, ≤ 2000), `reorderRequestSchema` (`{ ids }`, unique)
    - types: `ReorderRequest`, `IdResponse { id }`, `ReorderResponse { ids }`
  - `src/shared/api/accounts.ts`:
    - `BASE_CURRENCY = 'PLN'`
    - field schemas: `currencySchema`, `fxRateSchema`, `interestRateSchema`
    - `accountFieldsAllowed(type) → { interestRate, minPayment, escrowAmount, pairedCategory }`
    - `createAccountRequestSchema` / `CreateAccountRequest`: `{ name, type, currency = 'PLN', startingBalance, startingDate?, fxRate?, note?, interestRate?, minPayment?, escrowAmount?, createPairedCategory = false }`
    - `AccountBalances { cleared, uncleared, working }`
    - `AccountDto { id, name, type, accountClass, currency, closed, sortOrder, note, interestRate, minPayment, escrowAmount, lastReconciledAt, lastReconciledBalance, transferPayeeId, paymentCategoryId, pairedCategoryId, balance, balanceBase }`
    - `AccountListResponse { accounts }`
  - `src/server/db/lookups.ts`:
    - `systemPayeeId(db, kind)`, `systemCategoryId(db, 'rta' | 'uncategorized')`, `systemGroupId(db, 'internal' | 'cc_payments' | 'debt_payments')`, each `Promise<string>`
    - `nextSortOrder(db, table, where?): Promise<number>`
  - `src/server/accounts/account-queries.ts`: `listAccounts(db: Executor, where?: SQL): Promise<AccountDto[]>`, `getAccount(db, id): Promise<AccountDto>` (404 `Account not found.`).
  - `src/server/accounts/account-commands.ts`:
    - `transferPayeeName(name)`
    - `assertAccountNameFree(db, name, exceptId?)` (422 `account_name_taken`)
    - `createAccount(rec, input: CreateAccountRequest, today: IsoDate): Promise<{ id: string }>` (422 `starting_date_in_future`)
  - `accountRoutes(deps)` at `/api/accounts`: `GET /` and `POST /`.
  - Test helper `createAccount(client, body)` in `src/server/test/fixtures.ts`.

- [ ] **Step 1: Write the test helper and the failing tests**

Create `src/server/test/fixtures.ts`:

```ts
import type { AccountDto, CreateAccountRequest } from '../../shared/api/accounts';
import type { TestClient } from './http-client';

/** Creates an account through the API (defaults: checking, PLN, starting balance 0). */
export async function createAccount(
  client: TestClient,
  body: Partial<CreateAccountRequest> & { name: string },
): Promise<AccountDto> {
  const res = await client.post('/api/accounts', { type: 'checking', startingBalance: 0, ...body });
  if (res.status !== 201) throw new Error(`createAccount failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as AccountDto;
}
```

Create `src/server/accounts/account-routes.test.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import { systemCategoryId, systemGroupId, systemPayeeId } from '../db/lookups';
import { category, payee, target, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount } from '../test/fixtures';
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

const startingBalanceOf = async (accountId: string) => {
  const [txn] = await t.db
    .select()
    .from(transaction)
    .where(and(eq(transaction.accountId, accountId), eq(transaction.isStartingBalance, true)));
  return txn!;
};

describe('POST /api/accounts', () => {
  it('creates a cash account with its transfer payee and a cleared Ready to Assign starting balance', async () => {
    const res = await json<AccountDto>(
      await ctx.client.post('/api/accounts', { name: 'mBank', type: 'checking', startingBalance: 250_000 }),
    );
    expect(res.status).toBe(201);
    const balance = { cleared: 250_000, uncleared: 0, working: 250_000 };
    expect(res.body).toEqual({
      id: expect.any(String),
      name: 'mBank',
      type: 'checking',
      accountClass: 'cash',
      currency: 'PLN',
      closed: false,
      sortOrder: 1,
      note: null,
      interestRate: null,
      minPayment: null,
      escrowAmount: null,
      lastReconciledAt: null,
      lastReconciledBalance: null,
      transferPayeeId: expect.any(String),
      paymentCategoryId: null,
      pairedCategoryId: null,
      balance,
      balanceBase: balance,
    });
    const [transferPayee] = await t.db.select().from(payee).where(eq(payee.id, res.body.transferPayeeId));
    expect(transferPayee).toMatchObject({ name: 'Transfer : mBank', transferAccountId: res.body.id });
    expect(await startingBalanceOf(res.body.id)).toMatchObject({
      date: '2026-11-20',
      payeeId: await systemPayeeId(t.db, 'starting_balance'),
      categoryId: await systemCategoryId(t.db, 'rta'),
      amount: 250_000,
      amountBase: 250_000,
      fxRate: null,
      fxRateManual: false,
      cleared: 'cleared',
      approved: true,
      isStartingBalance: true,
    });
  });

  it('gives a credit card a payment category named after it and an uncategorized starting balance', async () => {
    const card = await createAccount(ctx.client, {
      name: 'Visa',
      type: 'credit_card',
      startingBalance: -37_500,
      interestRate: '19.9',
      minPayment: 5_000,
      note: 'Main card',
    });
    expect(card).toMatchObject({
      accountClass: 'credit',
      interestRate: '19.9000',
      minPayment: 5_000,
      note: 'Main card',
      balance: { cleared: -37_500, uncleared: 0, working: -37_500 },
    });
    const [payment] = await t.db.select().from(category).where(eq(category.id, card.paymentCategoryId!));
    expect(payment).toMatchObject({
      groupId: await systemGroupId(t.db, 'cc_payments'),
      name: 'Visa',
      linkedAccountId: card.id,
      hidden: false,
    });
    expect(await startingBalanceOf(card.id)).toMatchObject({ categoryId: null, amount: -37_500 });
  });

  it('creates a loan with an opt-in paired category and its minimum-payment target', async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      startingBalance: -40_000_000,
      interestRate: '6.5',
      minPayment: 250_000,
      escrowAmount: 20_000,
      createPairedCategory: true,
    });
    expect(loan).toMatchObject({ accountClass: 'tracking', escrowAmount: 20_000, paymentCategoryId: null });
    const [paired] = await t.db.select().from(category).where(eq(category.id, loan.pairedCategoryId!));
    expect(paired).toMatchObject({
      groupId: await systemGroupId(t.db, 'debt_payments'),
      name: 'Mortgage',
      linkedAccountId: loan.id,
    });
    const [debtTarget] = await t.db.select().from(target).where(eq(target.categoryId, paired!.id));
    expect(debtTarget).toMatchObject({
      kind: 'debt',
      cadence: 'monthly',
      debtMode: 'min_payment',
      startMonth: '2026-11-01',
    });
    expect(await startingBalanceOf(loan.id)).toMatchObject({ categoryId: null, amount: -40_000_000 });

    const plain = await createAccount(ctx.client, { name: 'Car loan', type: 'auto_loan', startingBalance: -100 });
    expect(plain.pairedCategoryId).toBeNull();
  });

  it('books a foreign starting balance in PLN at the given rate', async () => {
    const euro = await createAccount(ctx.client, {
      name: 'Revolut EUR',
      type: 'savings',
      currency: 'EUR',
      startingBalance: 10_001,
      fxRate: '4.2512',
    });
    expect(euro).toMatchObject({
      currency: 'EUR',
      balance: { cleared: 10_001, uncleared: 0, working: 10_001 },
      balanceBase: { cleared: 42_516, uncleared: 0, working: 42_516 },
    });
    expect(await startingBalanceOf(euro.id)).toMatchObject({
      amountBase: 42_516,
      fxRate: '4.251200',
      fxRateManual: true,
    });
  });

  it("defaults the starting date to today in the budget's time zone and refuses future dates", async () => {
    // 23:30 UTC on 20 November is already 21 November in Warsaw.
    ctx.clock.advance(13.5 * 60 * 60 * 1000);
    const tonight = await createAccount(ctx.client, { name: 'Cash', type: 'cash' });
    expect((await startingBalanceOf(tonight.id)).date).toBe('2026-11-21');
    const backdated = await createAccount(ctx.client, { name: 'Old cash', type: 'cash', startingDate: '2026-01-15' });
    expect((await startingBalanceOf(backdated.id)).date).toBe('2026-01-15');

    const tomorrow = { name: 'Later', type: 'cash', startingBalance: 0, startingDate: '2026-11-22' };
    const future = await json(await ctx.client.post('/api/accounts', tomorrow));
    expect(future).toEqual({
      status: 422,
      body: { code: 'starting_date_in_future', message: "The starting balance can't be dated in the future." },
    });
  });

  it('validates the optional fields against the account type and currency', async () => {
    const errors = async (body: Record<string, unknown>) => {
      const res = await json<{ fieldErrors: Record<string, string[]> }>(
        await ctx.client.post('/api/accounts', { name: 'X', startingBalance: 0, ...body }),
      );
      expect(res.status).toBe(400);
      return res.body.fieldErrors;
    };
    expect(
      await errors({ type: 'checking', interestRate: '5', minPayment: 1, escrowAmount: 1, createPairedCategory: true }),
    ).toEqual({
      interestRate: ['Only loans and credit accounts have an interest rate.'],
      minPayment: ['Only loans and credit accounts have a minimum payment.'],
      escrowAmount: ['Only loans have escrow.'],
      createPairedCategory: ['Only loans can have a paired category.'],
    });
    expect(await errors({ type: 'credit_card', escrowAmount: 1 })).toEqual({
      escrowAmount: ['Only loans have escrow.'],
    });
    expect(await errors({ type: 'mortgage', createPairedCategory: true })).toEqual({
      minPayment: ["Enter the minimum payment: it becomes the paired category's target."],
    });
    expect(await errors({ type: 'savings', currency: 'EUR' })).toEqual({
      fxRate: ['Enter the exchange rate to PLN for the starting balance.'],
    });
    expect(await errors({ type: 'savings', fxRate: '4.2' })).toEqual({
      fxRate: ["PLN accounts don't need an exchange rate."],
    });
    expect(await errors({ type: 'savings', currency: 'eur', fxRate: '4.2' })).toEqual({
      currency: ['Use a 3-letter currency code, e.g. EUR.'],
    });
    expect(await errors({ type: 'savings', currency: 'ABC', fxRate: '4.2' })).toEqual({
      currency: ['Unknown currency code.'],
    });
    expect(await errors({ type: 'savings', startingBalance: 1.5 })).toEqual({
      startingBalance: ['Enter a whole amount in minor units.'],
    });
  });

  it('refuses a second account with the same name, ignoring case', async () => {
    await createAccount(ctx.client, { name: 'mBank' });
    const res = await json(
      await ctx.client.post('/api/accounts', { name: 'MBANK', type: 'savings', startingBalance: 0 }),
    );
    expect(res).toEqual({
      status: 422,
      body: { code: 'account_name_taken', message: 'You already have an account with this name.' },
    });
  });

  it('is one undoable command', async () => {
    const before = await snapshot(t.db);
    await createAccount(ctx.client, { name: 'Mortgage', type: 'mortgage', minPayment: 1, createPairedCategory: true });
    const after = await snapshot(t.db);

    expect(await json(await ctx.client.post('/api/undo'))).toMatchObject({
      status: 200,
      body: { undone: { label: 'Create account "Mortgage"' } },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });
});

describe('GET /api/accounts', () => {
  it('lists accounts in order with cleared, uncleared and working balances, native and in PLN', async () => {
    const cash = await createAccount(ctx.client, { name: 'Cash', type: 'cash', startingBalance: 10_000 });
    const euro = await createAccount(ctx.client, {
      name: 'Euro',
      type: 'savings',
      currency: 'EUR',
      startingBalance: 1_000,
      fxRate: '4.25',
    });
    await t.db.insert(transaction).values([
      { accountId: euro.id, date: '2026-11-20', amount: -200, amountBase: -860, cleared: 'uncleared' },
      { accountId: euro.id, date: '2026-11-20', amount: 300, amountBase: 1_290, cleared: 'reconciled' },
      { accountId: euro.id, date: '2026-11-20', amount: -999, amountBase: -999, deletedAt: new Date() },
    ]);

    const res = await json<{ accounts: AccountDto[] }>(await ctx.client.get('/api/accounts'));
    expect(res.status).toBe(200);
    const sums = (cleared: number, uncleared: number) => ({ cleared, uncleared, working: cleared + uncleared });
    expect(res.body.accounts.map((a) => [a.name, a.sortOrder, a.balance, a.balanceBase])).toEqual([
      ['Cash', 1, sums(10_000, 0), sums(10_000, 0)],
      ['Euro', 2, sums(1_300, -200), sums(5_540, -860)],
    ]);
    expect(res.body.accounts[0]!.id).toBe(cash.id);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/accounts/account-routes.test.ts`
Expected: FAIL with `Error: Cannot find module '../db/lookups' imported from …/src/server/accounts/account-routes.test.ts` (the test reads system row ids through the lookups added below).

- [ ] **Step 3: Add the shared API building blocks**

Create `src/shared/api/common.ts`:

```ts
import { z } from 'zod';

/** Integer minor units (grosze for PLN); `z.int()` also keeps it inside the safe integer range (spec §2). */
export const moneySchema = z.int('Enter a whole amount in minor units.');
export const nonNegativeMoneySchema = moneySchema.min(0, 'Enter 0 or more.');
export const positiveMoneySchema = moneySchema.min(1, 'Enter an amount greater than 0.');

export const isoDateSchema = z.iso.date('Use the format YYYY-MM-DD.');
/** A budget month in URLs and bodies; stored as its first day ('YYYY-MM-01'). */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM.');

export const idSchema = z.uuid('Invalid id.');
export const idParamSchema = z.object({ id: idSchema });

export const nameSchema = z.string().trim().min(1, 'Enter a name.').max(100, 'Use at most 100 characters.');
/** Free text; an empty note clears it. */
export const noteSchema = z.string().trim().max(2000, 'Use at most 2000 characters.');

/** PUT …/order: the full new order of the affected rows. */
export const reorderRequestSchema = z.object({
  ids: z
    .array(idSchema)
    .min(1, 'List at least one id.')
    .max(1000, 'List at most 1000 ids.')
    .refine((ids) => new Set(ids).size === ids.length, 'List each id once.'),
});

export type ReorderRequest = z.infer<typeof reorderRequestSchema>;

/** Response of deletes: the id of the removed row. */
export interface IdResponse {
  id: string;
}

/** Response of reorders: the ids in their new order. */
export interface ReorderResponse {
  ids: string[];
}
```

Create `src/shared/api/accounts.ts`. Its `superRefine` reports type-specific field rules as 400 field errors. `abort: true` stops the currency/rate refinements from running after a format error:

```ts
import { z } from 'zod';
import { ACCOUNT_TYPES, type AccountClass, type AccountType, accountClassOf, isLoanType } from '../accounts';
import { isoDateSchema, moneySchema, nameSchema, nonNegativeMoneySchema, noteSchema } from './common';

/** Spec §1: the budget currency. */
export const BASE_CURRENCY = 'PLN';

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { error: 'Use a 3-letter currency code, e.g. EUR.', abort: true })
  .refine((code) => Intl.supportedValuesOf('currency').includes(code), 'Unknown currency code.');

/** Rate to PLN, numeric(14,6). */
export const fxRateSchema = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,6})?$/, { error: 'Enter the rate as a decimal number, e.g. 4.2512.', abort: true })
  .refine((rate) => Number(rate) > 0, 'The rate must be greater than 0.');

/** APR in percent, numeric(7,4). */
export const interestRateSchema = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter the APR in percent, e.g. 6.5.');

/** Spec §4.2: which optional fields an account type takes. */
export function accountFieldsAllowed(type: AccountType) {
  const loan = isLoanType(type);
  const credit = accountClassOf(type) === 'credit';
  return { interestRate: loan || credit, minPayment: loan || credit, escrowAmount: loan, pairedCategory: loan };
}

export const createAccountRequestSchema = z
  .object({
    name: nameSchema,
    type: z.enum(ACCOUNT_TYPES),
    currency: currencySchema.default(BASE_CURRENCY),
    /** Native minor units; negative for debt. */
    startingBalance: moneySchema,
    /** Defaults to today in the budget's time zone; may not be in the future. */
    startingDate: isoDateSchema.optional(),
    /** Required for foreign currencies until the NBP lookup exists (P2d). */
    fxRate: fxRateSchema.optional(),
    note: noteSchema.optional(),
    interestRate: interestRateSchema.optional(),
    minPayment: nonNegativeMoneySchema.optional(),
    escrowAmount: nonNegativeMoneySchema.optional(),
    /** Loans only: a Debt Payments category linked to the loan, with a minimum-payment target (spec §8). */
    createPairedCategory: z.boolean().default(false),
  })
  .superRefine((body, ctx) => {
    const allowed = accountFieldsAllowed(body.type);
    const reject = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (body.interestRate !== undefined && !allowed.interestRate) {
      reject('interestRate', 'Only loans and credit accounts have an interest rate.');
    }
    if (body.minPayment !== undefined && !allowed.minPayment) {
      reject('minPayment', 'Only loans and credit accounts have a minimum payment.');
    }
    if (body.escrowAmount !== undefined && !allowed.escrowAmount) reject('escrowAmount', 'Only loans have escrow.');
    if (body.createPairedCategory && !allowed.pairedCategory) {
      reject('createPairedCategory', 'Only loans can have a paired category.');
    } else if (body.createPairedCategory && body.minPayment === undefined) {
      reject('minPayment', "Enter the minimum payment: it becomes the paired category's target.");
    }
    if (body.currency === BASE_CURRENCY && body.fxRate !== undefined) {
      reject('fxRate', `${BASE_CURRENCY} accounts don't need an exchange rate.`);
    }
    if (body.currency !== BASE_CURRENCY && body.fxRate === undefined) {
      reject('fxRate', `Enter the exchange rate to ${BASE_CURRENCY} for the starting balance.`);
    }
  });

export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;

export interface AccountBalances {
  /** Cleared and reconciled transactions. */
  cleared: number;
  uncleared: number;
  /** cleared + uncleared */
  working: number;
}

export interface AccountDto {
  id: string;
  name: string;
  type: AccountType;
  accountClass: AccountClass;
  currency: string;
  closed: boolean;
  sortOrder: number;
  note: string | null;
  /** APR in percent as a decimal string, e.g. "6.5000". */
  interestRate: string | null;
  minPayment: number | null;
  escrowAmount: number | null;
  lastReconciledAt: string | null;
  lastReconciledBalance: number | null;
  /** The "Transfer : <name>" payee that targets this account. */
  transferPayeeId: string;
  /** Credit accounts: their credit card payment category. */
  paymentCategoryId: string | null;
  /** Loans: the opt-in paired Debt Payments category. */
  pairedCategoryId: string | null;
  /** In the account's currency (minor units). */
  balance: AccountBalances;
  /** In PLN: the sum of the booked base amounts. */
  balanceBase: AccountBalances;
}

export interface AccountListResponse {
  accounts: AccountDto[];
}
```

- [ ] **Step 4: Add lookups for system rows**

Create `src/server/db/lookups.ts`:

```ts
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { account, category, categoryGroup, payee } from './schema';

type SystemPayeeKind = NonNullable<typeof payee.$inferSelect.systemKind>;
type SystemCategoryKind = NonNullable<typeof category.$inferSelect.systemKind>;
type SystemGroupKind = Exclude<typeof categoryGroup.$inferSelect.kind, 'normal'>;

/** The system payee of `kind`; created by migration 0002, so a miss is a broken database. */
export async function systemPayeeId(db: Executor, kind: SystemPayeeKind): Promise<string> {
  const [row] = await db.select({ id: payee.id }).from(payee).where(eq(payee.systemKind, kind));
  if (!row) throw new Error(`System payee ${kind} is missing`);
  return row.id;
}

/** Ready to Assign or Uncategorized (seeded at setup). */
export async function systemCategoryId(db: Executor, kind: SystemCategoryKind): Promise<string> {
  const [row] = await db.select({ id: category.id }).from(category).where(eq(category.systemKind, kind));
  if (!row) throw new Error(`System category ${kind} is missing`);
  return row.id;
}

/** The internal, credit card payments or debt payments group (seeded at setup). */
export async function systemGroupId(db: Executor, kind: SystemGroupKind): Promise<string> {
  const [row] = await db
    .select({ id: categoryGroup.id })
    .from(categoryGroup)
    .where(and(eq(categoryGroup.kind, kind), isNull(categoryGroup.deletedAt)));
  if (!row) throw new Error(`Category group ${kind} is missing`);
  return row.id;
}

/** One past the highest sort_order of the rows matching `where`, so a new row goes last. */
export async function nextSortOrder(
  db: Executor,
  table: typeof account | typeof categoryGroup | typeof category,
  where?: SQL,
): Promise<number> {
  const [row] = await db
    .select({ next: sql<number>`coalesce(max(${table.sortOrder}), 0) + 1` })
    .from(table)
    .where(where);
  return row!.next;
}
```

- [ ] **Step 5: Write the account read model**

Create `src/server/accounts/account-queries.ts`:

```ts
import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { AccountBalances, AccountDto } from '../../shared/api/accounts';
import type { Executor } from '../db/client';
import { account, category, payee, transaction } from '../db/schema';
import { AppError } from '../http/errors';

interface Sums {
  cleared: number;
  uncleared: number;
  clearedBase: number;
  unclearedBase: number;
}

const ZERO: Sums = { cleared: 0, uncleared: 0, clearedBase: 0, unclearedBase: 0 };

const balances = (cleared: number, uncleared: number): AccountBalances => ({
  cleared,
  uncleared,
  working: cleared + uncleared,
});

/** Native and PLN sums of the live transactions per account (split parents carry their lines' total). */
async function sumsByAccount(db: Executor, accountIds: string[]): Promise<Map<string, Sums>> {
  if (accountIds.length === 0) return new Map();
  const isCleared = sql`${transaction.cleared} <> 'uncleared'`;
  const rows = await db
    .select({
      accountId: transaction.accountId,
      // sum() of bigint is numeric (a string in JS); the ::bigint cast brings it back as an exact number.
      cleared: sql<number>`coalesce(sum(${transaction.amount}) filter (where ${isCleared}), 0)::bigint`,
      uncleared: sql<number>`coalesce(sum(${transaction.amount}) filter (where not ${isCleared}), 0)::bigint`,
      clearedBase: sql<number>`coalesce(sum(${transaction.amountBase}) filter (where ${isCleared}), 0)::bigint`,
      unclearedBase: sql<number>`coalesce(sum(${transaction.amountBase}) filter (where not ${isCleared}), 0)::bigint`,
    })
    .from(transaction)
    .where(and(inArray(transaction.accountId, accountIds), isNull(transaction.deletedAt)))
    .groupBy(transaction.accountId);
  return new Map(rows.map(({ accountId, ...sums }) => [accountId, sums]));
}

/** Accounts in display order (spec §11 Accounts), with their balances. */
export async function listAccounts(db: Executor, where?: SQL): Promise<AccountDto[]> {
  const rows = await db
    .select({ account, transferPayeeId: payee.id, linkedCategoryId: category.id })
    .from(account)
    .innerJoin(payee, eq(payee.transferAccountId, account.id))
    .leftJoin(category, and(eq(category.linkedAccountId, account.id), isNull(category.deletedAt)))
    .where(where)
    .orderBy(asc(account.sortOrder), asc(account.createdAt), asc(account.id));
  const sums = await sumsByAccount(db, rows.map((r) => r.account.id));
  return rows.map(({ account: a, transferPayeeId, linkedCategoryId }) => {
    const s = sums.get(a.id) ?? ZERO;
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      accountClass: a.accountClass,
      currency: a.currency,
      closed: a.closed,
      sortOrder: a.sortOrder,
      note: a.note,
      interestRate: a.interestRate,
      minPayment: a.minPayment,
      escrowAmount: a.escrowAmount,
      lastReconciledAt: a.lastReconciledAt?.toISOString() ?? null,
      lastReconciledBalance: a.lastReconciledBalance,
      transferPayeeId,
      paymentCategoryId: a.accountClass === 'credit' ? linkedCategoryId : null,
      pairedCategoryId: a.pairedCategoryId,
      balance: balances(s.cleared, s.uncleared),
      balanceBase: balances(s.clearedBase, s.unclearedBase),
    };
  });
}

export async function getAccount(db: Executor, id: string): Promise<AccountDto> {
  const [found] = await listAccounts(db, eq(account.id, id));
  if (!found) throw new AppError(404, 'not_found', 'Account not found.');
  return found;
}
```

- [ ] **Step 6: Write the create command**

Create `src/server/accounts/account-commands.ts`. The paired loan category and the account point at each other (`category.linked_account_id`, `account.paired_category_id`), so the account is inserted first and linked by a recorded update:

```ts
import { and, eq, ne, sql } from 'drizzle-orm';
import { accountClassOf } from '../../shared/accounts';
import { BASE_CURRENCY, type CreateAccountRequest } from '../../shared/api/accounts';
import { type IsoDate, convertToBase, monthOf } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { nextSortOrder, systemCategoryId, systemGroupId, systemPayeeId } from '../db/lookups';
import { account, category, payee, target, transaction } from '../db/schema';
import { DomainError } from '../http/errors';

/** Spec §4.4: every account has one transfer payee named after it. */
export const transferPayeeName = (accountName: string) => `Transfer : ${accountName}`;

/** Account names are unique (ignoring case), so transfer payees and linked categories stay unambiguous. */
export async function assertAccountNameFree(db: Executor, name: string, exceptId?: string): Promise<void> {
  const [taken] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(sql`lower(${account.name}) = lower(${name})`, exceptId ? ne(account.id, exceptId) : undefined))
    .limit(1);
  if (taken) throw new DomainError('account_name_taken', 'You already have an account with this name.');
}

/**
 * Spec §10 "Accounts" and "Starting balance": the account, its transfer payee, its cleared starting-balance
 * transaction, and for credit accounts the credit card payment category (spec §5.3); for loans that opt in, the
 * paired Debt Payments category with a minimum-payment target (spec §8).
 */
export async function createAccount(
  rec: ChangeRecorder,
  input: CreateAccountRequest,
  today: IsoDate,
): Promise<{ id: string }> {
  const startingDate = input.startingDate ?? today;
  if (startingDate > today) {
    throw new DomainError('starting_date_in_future', "The starting balance can't be dated in the future.");
  }
  await assertAccountNameFree(rec.tx, input.name);
  const accountClass = accountClassOf(input.type);

  const [created] = await rec.insert(account, {
    name: input.name,
    type: input.type,
    currency: input.currency,
    note: input.note || null,
    interestRate: input.interestRate ?? null,
    minPayment: input.minPayment ?? null,
    escrowAmount: input.escrowAmount ?? null,
    sortOrder: await nextSortOrder(rec.tx, account),
  });
  const accountId = created!.id;
  await rec.insert(payee, { name: transferPayeeName(input.name), transferAccountId: accountId });

  const foreign = input.currency !== BASE_CURRENCY;
  // The schema requires fxRate exactly when the currency is foreign.
  const rate = foreign ? input.fxRate! : null;
  await rec.insert(transaction, {
    accountId,
    date: startingDate,
    payeeId: await systemPayeeId(rec.tx, 'starting_balance'),
    // Cash starting balances are income; credit and tracking ones stay off the budget.
    categoryId: accountClass === 'cash' ? await systemCategoryId(rec.tx, 'rta') : null,
    amount: input.startingBalance,
    amountBase: rate === null ? input.startingBalance : convertToBase(input.startingBalance, rate),
    fxRate: rate,
    // Entered by the user until the NBP lookup exists (P2d).
    fxRateManual: foreign,
    cleared: 'cleared',
    isStartingBalance: true,
  });

  if (accountClass === 'credit') {
    const groupId = await systemGroupId(rec.tx, 'cc_payments');
    await rec.insert(category, {
      groupId,
      name: input.name,
      linkedAccountId: accountId,
      sortOrder: await nextSortOrder(rec.tx, category, eq(category.groupId, groupId)),
    });
  }

  if (input.createPairedCategory) {
    const groupId = await systemGroupId(rec.tx, 'debt_payments');
    const [paired] = await rec.insert(category, {
      groupId,
      name: input.name,
      linkedAccountId: accountId,
      sortOrder: await nextSortOrder(rec.tx, category, eq(category.groupId, groupId)),
    });
    await rec.insert(target, {
      categoryId: paired!.id,
      kind: 'debt',
      cadence: 'monthly',
      debtMode: 'min_payment',
      startMonth: `${monthOf(today)}-01`,
    });
    await rec.update(account, eq(account.id, accountId), { pairedCategoryId: paired!.id });
  }
  return { id: accountId };
}
```

- [ ] **Step 7: Add the routes and mount them**

Create `src/server/accounts/account-routes.ts`:

```ts
import { Hono } from 'hono';
import { type AccountDto, type AccountListResponse, createAccountRequestSchema } from '../../shared/api/accounts';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import { runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { createAccount } from './account-commands';
import { getAccount, listAccounts } from './account-queries';

/** /api/accounts (spec §10 "Accounts"): every change is one undoable command. */
export function accountRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/', async (c) => c.json<AccountListResponse>({ accounts: await listAccounts(deps.db) }))
    .post('/', validate('json', createAccountRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const { id } = await runCommand(deps, `Create account "${body.name}"`, (rec) =>
        createAccount(rec, body, today()),
      );
      return c.json<AccountDto>(await getAccount(deps.db, id), 201);
    });
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.ts b/src/server/http/app.ts
index c430791..a39432e 100644
--- a/src/server/http/app.ts
+++ b/src/server/http/app.ts
@@ -4,6 +4,7 @@ import { bodyLimit } from 'hono/body-limit';
 import { requestId } from 'hono/request-id';
 import { secureHeaders } from 'hono/secure-headers';
 import type { ApiErrorBody } from '../../shared/http';
+import { accountRoutes } from '../accounts/account-routes';
 import { loginRoutes } from '../auth/login-routes';
 import { securityRoutes } from '../auth/security-routes';
 import { setupRoutes } from '../auth/setup-routes';
@@ -68,7 +69,8 @@ export function createApp(deps: AppDeps) {
     // Every router below is mounted on its own prefix and starts with .use('*', requireSession(deps)), so each new
     // route is private by default (app.test.ts walks app.routes to keep it that way).
     .route('/api/undo', undoRoutes(deps))
-    .route('/api/redo', redoRoutes(deps));
+    .route('/api/redo', redoRoutes(deps))
+    .route('/api/accounts', accountRoutes(deps));
 
   app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
   app.onError(errorHandler);
PATCH
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run --project server src/server/accounts/account-routes.test.ts`
Expected: `Tests  9 passed (9)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  33 passed (33)`, `Tests  318 passed (318)`; both checks exit 0. (The route guard in `app.test.ts` now also covers `GET` and `POST /api/accounts`.)

- [ ] **Step 9: Commit**

```bash
git add src/shared/api src/server/db/lookups.ts src/server/accounts src/server/test/fixtures.ts src/server/http/app.ts
git commit -m "feat(server): list and create accounts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Accounts — edit, close/reopen, delete and reorder

Spec §3 and §10 "Accounts".

**Edit:**
- Edits the name, note, type and loan/credit fields. `null`, or an empty note, clears a field.
- The type may change only within its class, and a loan only to another loan type. This keeps its loan fields and paired category meaningful.
- Fields the type doesn't take are a 422.
- A rename also renames the transfer payee and the linked credit card payment or paired loan category.

**Close/reopen:**
- Closing needs a native working balance of exactly 0 (422 `account_balance_not_zero`). Reopening is always allowed.
- The spec also hides a credit card payment category automatically when its account is closed with Available = 0. That needs the budget read model, so it is deferred to **P2b2** (recorded in `p2-carry-over.md` in Task 8).

**Delete:**
- Allowed only when nothing but the account's own starting balance, transfer payee and linked category refers to the account. That rules out other transactions (live or soft-deleted), transfers into it, split lines, schedules, interest overrides, and anything that uses its linked category.
- It removes those rows too, with the linked category's assignments and target. The removal is a single undoable command.

**Reorder:** takes the full list of accounts.

**Files:**
- Create: `src/server/commands/reorder.ts`
- Modify: `src/shared/api/accounts.ts`, `src/server/accounts/account-commands.ts`, `src/server/accounts/account-routes.ts` (replace)
- Test: `src/server/accounts/account-routes.test.ts`

**Interfaces:**
- Consumes: Task 4's `getAccount`, `assertAccountNameFree`, `transferPayeeName`, `accountFieldsAllowed`; Task 2's `Named`.
- Produces:
  - `updateAccountRequestSchema` / `UpdateAccountRequest`: `{ name?, note?: string | null, type?, interestRate?: string | null, minPayment?: number | null, escrowAmount?: number | null }`.
  - `applyOrder(rec, table: typeof account | typeof categoryGroup | typeof category, scope: SQL | undefined, ids: string[]): Promise<void>` (422 `order_mismatch` unless `ids` lists every row in `scope` once).
  - Account commands:
    - `updateAccount(rec, id, input): Promise<{ name }>`
    - `setAccountClosed(rec, id, closed: boolean): Promise<{ name }>`
    - `deleteAccount(rec, id): Promise<{ name }>`
    - `reorderAccounts(rec, ids): Promise<void>`
  - Error codes: `account_type_change`, `account_field_not_allowed`, `account_name_taken`, `account_balance_not_zero`, `account_in_use`, `order_mismatch` (422); `not_found` (404).
  - Endpoints:
    - `PATCH /api/accounts/:id`, `POST /api/accounts/:id/close` and `POST /api/accounts/:id/reopen` → `AccountDto`
    - `DELETE /api/accounts/:id` → `IdResponse`
    - `PUT /api/accounts/order` → `ReorderResponse`

- [ ] **Step 1: Write the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-routes.test.ts b/src/server/accounts/account-routes.test.ts
index bc8f98c..ad4b6c4 100644
--- a/src/server/accounts/account-routes.test.ts
+++ b/src/server/accounts/account-routes.test.ts
@@ -2,7 +2,7 @@ import { and, eq } from 'drizzle-orm';
 import { afterEach, beforeEach, describe, expect, it } from 'vitest';
 import type { AccountDto } from '../../shared/api/accounts';
 import { systemCategoryId, systemGroupId, systemPayeeId } from '../db/lookups';
-import { category, payee, target, transaction } from '../db/schema';
+import { account, assignment, category, payee, target, transaction } from '../db/schema';
 import { createTestApp, type TestApp } from '../test/app';
 import { setUpBudget } from '../test/auth';
 import { createTestDatabase, type TestDatabase } from '../test/db';
@@ -258,3 +258,181 @@ describe('GET /api/accounts', () => {
     expect(res.body.accounts[0]!.id).toBe(cash.id);
   });
 });
+
+describe('PATCH /api/accounts/:id', () => {
+  it('renames the transfer payee and payment category with the account, and edits note and credit fields', async () => {
+    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card', note: 'old' });
+    const res = await json<AccountDto>(
+      await ctx.client.send('PATCH', `/api/accounts/${card.id}`, {
+        name: 'Visa Gold',
+        type: 'line_of_credit',
+        note: '',
+        interestRate: '21.5',
+        minPayment: 7_500,
+      }),
+    );
+    expect(res.status).toBe(200);
+    expect(res.body).toMatchObject({
+      name: 'Visa Gold',
+      type: 'line_of_credit',
+      note: null,
+      interestRate: '21.5000',
+      minPayment: 7_500,
+    });
+    const [transferPayee] = await t.db.select().from(payee).where(eq(payee.id, card.transferPayeeId));
+    const [payment] = await t.db.select().from(category).where(eq(category.id, card.paymentCategoryId!));
+    expect([transferPayee!.name, payment!.name]).toEqual(['Transfer : Visa Gold', 'Visa Gold']);
+
+    await ctx.client.post('/api/undo');
+    expect((await json<AccountDto>(await ctx.client.get('/api/accounts'))).body).toMatchObject({
+      accounts: [{ name: 'Visa', type: 'credit_card', note: 'old', interestRate: null }],
+    });
+  });
+
+  it("renames a loan's paired category and clears fields with null", async () => {
+    const loan = await createAccount(ctx.client, {
+      name: 'Mortgage',
+      type: 'mortgage',
+      minPayment: 1,
+      escrowAmount: 2,
+      createPairedCategory: true,
+    });
+    const res = await json<AccountDto>(
+      await ctx.client.send('PATCH', `/api/accounts/${loan.id}`, { name: 'Home loan', escrowAmount: null }),
+    );
+    expect(res.body).toMatchObject({ name: 'Home loan', escrowAmount: null, minPayment: 1 });
+    const [paired] = await t.db.select().from(category).where(eq(category.id, loan.pairedCategoryId!));
+    expect(paired!.name).toBe('Home loan');
+  });
+
+  it('changes the type only within its class, and a loan only to another loan type', async () => {
+    const checking = await createAccount(ctx.client, { name: 'mBank' });
+    const loan = await createAccount(ctx.client, { name: 'Car', type: 'auto_loan' });
+    const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/accounts/${id}`, body);
+    expect((await json<AccountDto>(await patch(checking.id, { type: 'savings' }))).body.type).toBe('savings');
+    expect((await json<AccountDto>(await patch(loan.id, { type: 'personal_loan' }))).body.type).toBe('personal_loan');
+    const refused = {
+      status: 422,
+      body: {
+        code: 'account_type_change',
+        message: "An account's type can only change within its class, and a loan only to another loan type.",
+      },
+    };
+    expect(await json(await patch(checking.id, { type: 'credit_card' }))).toEqual(refused);
+    expect(await json(await patch(loan.id, { type: 'other_asset' }))).toEqual(refused);
+  });
+
+  it('refuses fields the type does not take, a taken name and unknown accounts', async () => {
+    const checking = await createAccount(ctx.client, { name: 'mBank' });
+    await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
+    const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/accounts/${id}`, body);
+    expect(await json(await patch(checking.id, { minPayment: 100 }))).toEqual({
+      status: 422,
+      body: { code: 'account_field_not_allowed', message: 'Only loans and credit accounts have a minimum payment.' },
+    });
+    expect(await json(await patch(checking.id, { name: 'savings' }))).toMatchObject({
+      status: 422,
+      body: { code: 'account_name_taken' },
+    });
+    expect((await json(await patch(checking.id, { name: 'MBANK' }))).status).toBe(200);
+    expect(await json(await patch(crypto.randomUUID(), { note: 'x' }))).toEqual({
+      status: 404,
+      body: { code: 'not_found', message: 'Account not found.' },
+    });
+    expect((await patch('not-a-uuid', { note: 'x' })).status).toBe(400);
+  });
+});
+
+describe('closing and reopening', () => {
+  it('closes an account only at a zero balance, and reopens it', async () => {
+    const full = await createAccount(ctx.client, { name: 'Cash', type: 'cash', startingBalance: 1_000 });
+    expect(await json(await ctx.client.post(`/api/accounts/${full.id}/close`))).toEqual({
+      status: 422,
+      body: { code: 'account_balance_not_zero', message: 'Bring the balance to 0 before closing the account.' },
+    });
+
+    const empty = await createAccount(ctx.client, { name: 'Old savings', type: 'savings' });
+    const closed = await json<AccountDto>(await ctx.client.post(`/api/accounts/${empty.id}/close`));
+    expect([closed.status, closed.body.closed]).toEqual([200, true]);
+    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
+      undo: { label: 'Close account "Old savings"' },
+    });
+    const reopened = await json<AccountDto>(await ctx.client.post(`/api/accounts/${empty.id}/reopen`));
+    expect([reopened.status, reopened.body.closed]).toEqual([200, false]);
+  });
+});
+
+describe('DELETE /api/accounts/:id', () => {
+  it('removes an account that only has its starting balance, with everything created with it', async () => {
+    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card', startingBalance: -5_000 });
+    await t.db.insert(assignment).values({ categoryId: card.paymentCategoryId!, month: '2026-11-01', amount: 5_000 });
+    const loan = await createAccount(ctx.client, {
+      name: 'Mortgage',
+      type: 'mortgage',
+      minPayment: 1,
+      createPairedCategory: true,
+    });
+    const before = await snapshot(t.db);
+
+    for (const id of [card.id, loan.id]) {
+      expect(await json(await ctx.client.send('DELETE', `/api/accounts/${id}`))).toEqual({ status: 200, body: { id } });
+    }
+    expect(await t.db.select().from(account)).toEqual([]);
+    expect(await t.db.select().from(category).where(eq(category.linkedAccountId, card.id))).toEqual([]);
+    expect(await t.db.select().from(payee).where(eq(payee.id, card.transferPayeeId))).toEqual([]);
+    const after = await snapshot(t.db);
+
+    await ctx.client.post('/api/undo');
+    await ctx.client.post('/api/undo');
+    expect(await snapshot(t.db)).toEqual(before);
+    await ctx.client.post('/api/redo');
+    await ctx.client.post('/api/redo');
+    expect(await snapshot(t.db)).toEqual(after);
+  });
+
+  it('refuses while anything else refers to the account or its linked category', async () => {
+    const checking = await createAccount(ctx.client, { name: 'mBank' });
+    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
+    const loan = await createAccount(ctx.client, {
+      name: 'Car',
+      type: 'auto_loan',
+      minPayment: 1,
+      createPairedCategory: true,
+    });
+    const line = { date: '2026-11-20', amount: -100, amountBase: -100 };
+    await t.db.insert(transaction).values([
+      { ...line, accountId: checking.id, deletedAt: new Date() },
+      { ...line, accountId: savings.id, transferAccountId: checking.id },
+      { ...line, accountId: savings.id, categoryId: loan.pairedCategoryId },
+    ]);
+    const inUse = {
+      status: 422,
+      body: { code: 'account_in_use', message: 'This account has transactions. Close it instead.' },
+    };
+    for (const id of [checking.id, savings.id, loan.id]) {
+      expect(await json(await ctx.client.send('DELETE', `/api/accounts/${id}`))).toEqual(inUse);
+    }
+  });
+});
+
+describe('PUT /api/accounts/order', () => {
+  it('stores the new order, which must list every account once', async () => {
+    const a = await createAccount(ctx.client, { name: 'A' });
+    const b = await createAccount(ctx.client, { name: 'B' });
+    const c = await createAccount(ctx.client, { name: 'C', type: 'cash' });
+    const order = (ids: string[]) => ctx.client.send('PUT', '/api/accounts/order', { ids });
+
+    expect(await json(await order([c.id, a.id, b.id]))).toEqual({ status: 200, body: { ids: [c.id, a.id, b.id] } });
+    const listed = await json<{ accounts: AccountDto[] }>(await ctx.client.get('/api/accounts'));
+    expect(listed.body.accounts.map((x) => [x.name, x.sortOrder])).toEqual([
+      ['C', 1],
+      ['A', 2],
+      ['B', 3],
+    ]);
+    expect(await json(await order([a.id, b.id]))).toEqual({
+      status: 422,
+      body: { code: 'order_mismatch', message: 'The new order must list every item exactly once.' },
+    });
+    expect((await order([a.id, a.id, b.id])).status).toBe(400);
+  });
+});
PATCH
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/accounts/account-routes.test.ts`
Expected: FAIL with `Tests  8 failed | 9 passed (17)`. The new routes don't exist yet, so the tests get `{ status: 404, … }` (e.g. `expected { status: 404, body: { …(2) } } to deeply equal { status: 422, body: { …(2) } }`).

- [ ] **Step 3: Add the edit schema**

```bash
git apply <<'PATCH'
diff --git a/src/shared/api/accounts.ts b/src/shared/api/accounts.ts
index d946d81..4088a16 100644
--- a/src/shared/api/accounts.ts
+++ b/src/shared/api/accounts.ts
@@ -69,6 +69,19 @@ export const createAccountRequestSchema = z
 
 export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;
 
+/** PATCH /api/accounts/:id. Omitted fields stay as they are; null (or an empty note) clears a field. */
+export const updateAccountRequestSchema = z.object({
+  name: nameSchema.optional(),
+  note: noteSchema.nullable().optional(),
+  /** Only within the account's class, and loans only to other loan types. */
+  type: z.enum(ACCOUNT_TYPES).optional(),
+  interestRate: interestRateSchema.nullable().optional(),
+  minPayment: nonNegativeMoneySchema.nullable().optional(),
+  escrowAmount: nonNegativeMoneySchema.nullable().optional(),
+});
+
+export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;
+
 export interface AccountBalances {
   /** Cleared and reconciled transactions. */
   cleared: number;
PATCH
```

- [ ] **Step 4: Add the generic reorder helper**

Create `src/server/commands/reorder.ts`:

```ts
import { eq, type SQL } from 'drizzle-orm';
import { account, category, categoryGroup } from '../db/schema';
import { DomainError } from '../http/errors';
import type { ChangeRecorder } from './recorder';

type Sortable = typeof account | typeof categoryGroup | typeof category;

/**
 * Sets sort_order 1..n in the order of `ids`, which must list every row in `scope` exactly once (the client sends the
 * whole list after a drag). Rows already in place aren't touched.
 */
export async function applyOrder(
  rec: ChangeRecorder,
  table: Sortable,
  scope: SQL | undefined,
  ids: string[],
): Promise<void> {
  const rows = await rec.tx.select({ id: table.id }).from(table).where(scope);
  const known = new Set(rows.map((row) => row.id));
  if (rows.length !== ids.length || !ids.every((id) => known.has(id))) {
    throw new DomainError('order_mismatch', 'The new order must list every item exactly once.');
  }
  for (const [index, id] of ids.entries()) {
    await rec.update(table, eq(table.id, id), { sortOrder: index + 1 });
  }
}
```

- [ ] **Step 5: Write the commands**

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-commands.ts b/src/server/accounts/account-commands.ts
index e977f75..af0d8bb 100644
--- a/src/server/accounts/account-commands.ts
+++ b/src/server/accounts/account-commands.ts
@@ -1,12 +1,32 @@
-import { and, eq, ne, sql } from 'drizzle-orm';
-import { accountClassOf } from '../../shared/accounts';
-import { BASE_CURRENCY, type CreateAccountRequest } from '../../shared/api/accounts';
+import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
+import { accountClassOf, isLoanType } from '../../shared/accounts';
+import {
+  accountFieldsAllowed,
+  BASE_CURRENCY,
+  type CreateAccountRequest,
+  type UpdateAccountRequest,
+} from '../../shared/api/accounts';
 import { type IsoDate, convertToBase, monthOf } from '../../engine';
 import type { ChangeRecorder } from '../commands/recorder';
+import { applyOrder } from '../commands/reorder';
 import type { Executor } from '../db/client';
 import { nextSortOrder, systemCategoryId, systemGroupId, systemPayeeId } from '../db/lookups';
-import { account, category, payee, target, transaction } from '../db/schema';
-import { DomainError } from '../http/errors';
+import {
+  account,
+  assignment,
+  category,
+  loanInterestOverride,
+  payee,
+  scheduledSubtransaction,
+  scheduledTransaction,
+  subtransaction,
+  target,
+  transaction,
+} from '../db/schema';
+import { AppError, DomainError } from '../http/errors';
+import { getAccount } from './account-queries';
+
+type AccountRow = typeof account.$inferSelect;
 
 /** Spec §4.4: every account has one transfer payee named after it. */
 export const transferPayeeName = (accountName: string) => `Transfer : ${accountName}`;
@@ -98,3 +118,147 @@ export async function createAccount(
   }
   return { id: accountId };
 }
+
+async function loadAccount(db: Executor, id: string): Promise<AccountRow> {
+  const [row] = await db.select().from(account).where(eq(account.id, id)).for('update');
+  if (!row) throw new AppError(404, 'not_found', 'Account not found.');
+  return row;
+}
+
+const FIELD_MESSAGES = {
+  interestRate: 'Only loans and credit accounts have an interest rate.',
+  minPayment: 'Only loans and credit accounts have a minimum payment.',
+  escrowAmount: 'Only loans have escrow.',
+} as const;
+
+/** Edits name, note, type and loan/credit fields; a rename carries over to the transfer payee and linked category. */
+export async function updateAccount(
+  rec: ChangeRecorder,
+  id: string,
+  input: UpdateAccountRequest,
+): Promise<{ name: string }> {
+  const current = await loadAccount(rec.tx, id);
+  if (input.type !== undefined && input.type !== current.type) {
+    // Loans keep a loan type, so their loan fields and paired category stay meaningful.
+    const sameClass = accountClassOf(input.type) === current.accountClass;
+    if (!sameClass || isLoanType(input.type) !== isLoanType(current.type)) {
+      throw new DomainError(
+        'account_type_change',
+        "An account's type can only change within its class, and a loan only to another loan type.",
+      );
+    }
+  }
+  const allowed = accountFieldsAllowed(input.type ?? current.type);
+  for (const field of ['interestRate', 'minPayment', 'escrowAmount'] as const) {
+    const value = input[field];
+    if (value !== undefined && value !== null && !allowed[field]) {
+      throw new DomainError('account_field_not_allowed', FIELD_MESSAGES[field]);
+    }
+  }
+  const name = input.name ?? current.name;
+  if (name !== current.name) await assertAccountNameFree(rec.tx, name, id);
+
+  await rec.update(account, eq(account.id, id), {
+    name,
+    note: input.note === undefined ? undefined : input.note || null,
+    type: input.type,
+    interestRate: input.interestRate,
+    minPayment: input.minPayment,
+    escrowAmount: input.escrowAmount,
+  });
+  if (name !== current.name) {
+    await rec.update(payee, eq(payee.transferAccountId, id), { name: transferPayeeName(name) });
+    // Spec §10: a credit card payment category is named after its account; a paired loan category follows too.
+    await rec.update(category, and(eq(category.linkedAccountId, id), isNull(category.deletedAt)), { name });
+  }
+  return { name };
+}
+
+/** Spec §10: closing needs a zero balance (in the account's currency); reopening is always allowed. */
+export async function setAccountClosed(rec: ChangeRecorder, id: string, closed: boolean): Promise<{ name: string }> {
+  const current = await loadAccount(rec.tx, id);
+  if (closed && (await getAccount(rec.tx, id)).balance.working !== 0) {
+    throw new DomainError('account_balance_not_zero', 'Bring the balance to 0 before closing the account.');
+  }
+  await rec.update(account, eq(account.id, id), { closed });
+  return { name: current.name };
+}
+
+/**
+ * True when anything but the account's own starting balance, transfer payee and linked categories (with their
+ * assignments and target) refers to the account. Soft-deleted transactions count: they still reference the rows.
+ */
+async function isAccountInUse(db: Executor, id: string): Promise<boolean> {
+  const linked = db.select({ id: category.id }).from(category).where(eq(category.linkedAccountId, id));
+  const checks = [
+    db
+      .select({ id: transaction.id })
+      .from(transaction)
+      .where(
+        or(
+          and(eq(transaction.accountId, id), eq(transaction.isStartingBalance, false)),
+          eq(transaction.transferAccountId, id),
+          inArray(transaction.categoryId, linked),
+        ),
+      ),
+    db
+      .select({ id: subtransaction.id })
+      .from(subtransaction)
+      .where(or(eq(subtransaction.transferAccountId, id), inArray(subtransaction.categoryId, linked))),
+    db
+      .select({ id: scheduledTransaction.id })
+      .from(scheduledTransaction)
+      .where(
+        or(
+          eq(scheduledTransaction.accountId, id),
+          eq(scheduledTransaction.transferAccountId, id),
+          inArray(scheduledTransaction.categoryId, linked),
+        ),
+      ),
+    db
+      .select({ id: scheduledSubtransaction.id })
+      .from(scheduledSubtransaction)
+      .where(
+        or(eq(scheduledSubtransaction.transferAccountId, id), inArray(scheduledSubtransaction.categoryId, linked)),
+      ),
+    db
+      .select({ id: loanInterestOverride.accountId })
+      .from(loanInterestOverride)
+      .where(eq(loanInterestOverride.accountId, id)),
+    db.select({ id: payee.id }).from(payee).where(inArray(payee.lastCategoryId, linked)),
+  ];
+  for (const check of checks) if ((await check.limit(1)).length > 0) return true;
+  return false;
+}
+
+/**
+ * Spec §10: only an account with nothing but its starting balance can be deleted. Removes it with everything
+ * createAccount made (transfer payee, starting balance, linked category with its assignments and target).
+ */
+export async function deleteAccount(rec: ChangeRecorder, id: string): Promise<{ name: string }> {
+  const current = await loadAccount(rec.tx, id);
+  if (await isAccountInUse(rec.tx, id)) {
+    throw new DomainError('account_in_use', 'This account has transactions. Close it instead.');
+  }
+  const linked = await rec.tx
+    .select({ id: category.id })
+    .from(category)
+    .where(eq(category.linkedAccountId, id));
+  const linkedIds = linked.map((row) => row.id);
+  // account.paired_category_id and category.linked_account_id point at each other: unlink first.
+  await rec.update(account, eq(account.id, id), { pairedCategoryId: null });
+  if (linkedIds.length > 0) {
+    await rec.delete(target, inArray(target.categoryId, linkedIds));
+    await rec.delete(assignment, inArray(assignment.categoryId, linkedIds));
+  }
+  await rec.delete(transaction, eq(transaction.accountId, id));
+  await rec.delete(payee, eq(payee.transferAccountId, id));
+  if (linkedIds.length > 0) await rec.delete(category, inArray(category.id, linkedIds));
+  await rec.delete(account, eq(account.id, id));
+  return { name: current.name };
+}
+
+/** PUT /api/accounts/order: `ids` lists every account (open and closed). */
+export function reorderAccounts(rec: ChangeRecorder, ids: string[]): Promise<void> {
+  return applyOrder(rec, account, undefined, ids);
+}
PATCH
```

`deleteAccount` clears `account.paired_category_id` first (recorded) because the account and its paired category point at each other. Undo then replays the deletes in reverse order and relinks last.

- [ ] **Step 6: Add the routes**

Replace the whole of `src/server/accounts/account-routes.ts` with:

```ts
import { Hono } from 'hono';
import {
  type AccountDto,
  type AccountListResponse,
  createAccountRequestSchema,
  updateAccountRequestSchema,
} from '../../shared/api/accounts';
import { idParamSchema, type IdResponse, type ReorderResponse, reorderRequestSchema } from '../../shared/api/common';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import { type Named, runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { createAccount, deleteAccount, reorderAccounts, setAccountClosed, updateAccount } from './account-commands';
import { getAccount, listAccounts } from './account-queries';

/** /api/accounts (spec §10 "Accounts"): every change is one undoable command. */
export function accountRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/', async (c) => c.json<AccountListResponse>({ accounts: await listAccounts(deps.db) }))
    .post('/', validate('json', createAccountRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const { id } = await runCommand(deps, `Create account "${body.name}"`, (rec) =>
        createAccount(rec, body, today()),
      );
      return c.json<AccountDto>(await getAccount(deps.db, id), 201);
    })
    .put('/order', validate('json', reorderRequestSchema), async (c) => {
      const { ids } = c.req.valid('json');
      await runCommand(deps, 'Reorder accounts', (rec) => reorderAccounts(rec, ids));
      return c.json<ReorderResponse>({ ids });
    })
    .patch('/:id', validate('param', idParamSchema), validate('json', updateAccountRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      await runCommand(deps, (r: Named) => `Edit account "${r.name}"`, (rec) => updateAccount(rec, id, body));
      return c.json<AccountDto>(await getAccount(deps.db, id));
    })
    .post('/:id/close', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(deps, (r: Named) => `Close account "${r.name}"`, (rec) => setAccountClosed(rec, id, true));
      return c.json<AccountDto>(await getAccount(deps.db, id));
    })
    .post('/:id/reopen', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(deps, (r: Named) => `Reopen account "${r.name}"`, (rec) => setAccountClosed(rec, id, false));
      return c.json<AccountDto>(await getAccount(deps.db, id));
    })
    .delete('/:id', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(deps, (r: Named) => `Delete account "${r.name}"`, (rec) => deleteAccount(rec, id));
      return c.json<IdResponse>({ id });
    });
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project server src/server/accounts/account-routes.test.ts`
Expected: `Tests  17 passed (17)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  33 passed (33)`, `Tests  326 passed (326)`; both checks exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/shared/api/accounts.ts src/server/commands/reorder.ts src/server/accounts
git commit -m "feat(server): edit, close, reopen, delete and reorder accounts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Category groups and categories

Spec §3, §4.3 and §10 "Categories".

**`GET /api/categories`** returns every live group with its live categories in display order. That includes the hidden Internal group with Ready to Assign and Uncategorized; each row has a `kind`, so the UI can leave system rows out.

**Groups:**
- Users create, rename and delete only `normal` groups.
- Credit Card Payments and Debt Payments can be hidden and reordered; Internal can't be changed at all.
- A group can be deleted when it has no live categories; deletion is a soft delete (`deleted_at`).

**Categories:**
- Categories are created in, and moved to, normal groups only. A moved category goes to the end of its new group.
- Credit card payment and paired loan categories take only `note` and `hidden`: their name follows the account (Tasks 4–5).
- System categories take nothing.
- Reordering works within any group except Internal.

**Files:**
- Create: `src/shared/api/categories.ts`, `src/server/categories/category-queries.ts`, `src/server/categories/group-commands.ts`, `src/server/categories/category-commands.ts`, `src/server/categories/group-routes.ts`, `src/server/categories/category-routes.ts`
- Modify: `src/server/http/app.ts`, `src/server/test/fixtures.ts`
- Test: `src/server/categories/group-routes.test.ts`, `src/server/categories/category-routes.test.ts`

**Interfaces:**
- Consumes: `applyOrder` (Task 5); `nextSortOrder`, `systemGroupId`, `systemCategoryId` (Task 4); `runCommand`, `Named` (Task 2); `idParamSchema`, `nameSchema`, `noteSchema`, `reorderRequestSchema` (Task 4).
- Produces:
  - `src/shared/api/categories.ts`:
    - kinds: `CategoryGroupKind = 'normal' | 'cc_payments' | 'debt_payments' | 'internal'`, `CategoryKind = 'normal' | 'rta' | 'uncategorized' | 'cc_payment' | 'debt_payment'`
    - DTOs: `CategoryDto { id, groupId, name, kind, hidden, note, sortOrder, linkedAccountId }`, `CategoryGroupDto { id, name, kind, hidden, sortOrder, categories }`, `CategoryListResponse { groups }`
    - schemas: `createGroupRequestSchema { name }`, `updateGroupRequestSchema { name?, hidden? }`, `createCategoryRequestSchema { groupId, name, note? }`, `updateCategoryRequestSchema { name?, note?, hidden?, groupId? }`, `reorderCategoriesRequestSchema { groupId, ids }`
    - types: `UpdateGroupRequest`, `CreateCategoryRequest`, `UpdateCategoryRequest`
  - `src/server/categories/category-queries.ts`:
    - `categoryKindOf(row, groupKind): CategoryKind`
    - `listCategoryGroups(db, where?): Promise<CategoryGroupDto[]>`
    - `getCategoryGroup(db, id)` (404 `Category group not found.`), `getCategory(db, id)` (404 `Category not found.`)
  - `src/server/categories/group-commands.ts`:
    - `loadGroup(db, id)`
    - `createGroup(rec, name): Promise<{ id }>`
    - `updateGroup(rec, id, input): Promise<{ name }>`
    - `deleteGroup(rec, id, now: Date): Promise<{ name }>`
    - `reorderGroups(rec, ids)`
  - `src/server/categories/category-commands.ts`:
    - `loadCategory(db, id): Promise<CategoryRow & { kind }>` (404)
    - `createCategory(rec, input): Promise<{ id }>`
    - `updateCategory(rec, id, input): Promise<{ name }>`
    - `reorderCategories(rec, groupId, ids)`
  - Error codes (422): `system_group`, `group_not_empty`, `invalid_group`, `system_category`, `linked_category`, `order_mismatch`.
  - `groupRoutes(deps)` at `/api/category-groups`, `categoryRoutes(deps)` at `/api/categories`.
  - Test helpers `createGroup(client, name)` and `createCategory(client, groupId, name)`.

- [ ] **Step 1: Write the test helpers and the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/server/test/fixtures.ts b/src/server/test/fixtures.ts
index ec19371..836ef27 100644
--- a/src/server/test/fixtures.ts
+++ b/src/server/test/fixtures.ts
@@ -1,12 +1,25 @@
 import type { AccountDto, CreateAccountRequest } from '../../shared/api/accounts';
+import type { CategoryDto, CategoryGroupDto } from '../../shared/api/categories';
 import type { TestClient } from './http-client';
 
+async function created<T>(res: Response, what: string): Promise<T> {
+  if (res.status !== 201) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
+  return (await res.json()) as T;
+}
+
 /** Creates an account through the API (defaults: checking, PLN, starting balance 0). */
 export async function createAccount(
   client: TestClient,
   body: Partial<CreateAccountRequest> & { name: string },
 ): Promise<AccountDto> {
   const res = await client.post('/api/accounts', { type: 'checking', startingBalance: 0, ...body });
-  if (res.status !== 201) throw new Error(`createAccount failed: ${res.status} ${await res.text()}`);
-  return (await res.json()) as AccountDto;
+  return created(res, 'createAccount');
+}
+
+export async function createGroup(client: TestClient, name: string): Promise<CategoryGroupDto> {
+  return created(await client.post('/api/category-groups', { name }), 'createGroup');
+}
+
+export async function createCategory(client: TestClient, groupId: string, name: string): Promise<CategoryDto> {
+  return created(await client.post('/api/categories', { groupId, name }), 'createCategory');
 }
PATCH
```

Create `src/server/categories/group-routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CategoryGroupDto, CategoryListResponse } from '../../shared/api/categories';
import { systemGroupId } from '../db/lookups';
import { category, categoryGroup } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createCategory, createGroup } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db);
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/category-groups/${id}`, body);
const remove = (id: string) => ctx.client.send('DELETE', `/api/category-groups/${id}`);

async function groups() {
  return (await json<CategoryListResponse>(await ctx.client.get('/api/categories'))).body.groups;
}

describe('/api/category-groups', () => {
  it('creates groups at the end, then renames and hides them', async () => {
    const res = await json<CategoryGroupDto>(await ctx.client.post('/api/category-groups', { name: ' Bills ' }));
    expect(res).toEqual({
      status: 201,
      body: { id: expect.any(String), name: 'Bills', kind: 'normal', hidden: false, sortOrder: 3, categories: [] },
    });
    const edited = await json<CategoryGroupDto>(await patch(res.body.id, { name: 'Utilities', hidden: true }));
    expect(edited.body).toMatchObject({ name: 'Utilities', hidden: true });
    expect((await groups()).map((g) => [g.name, g.kind, g.hidden])).toEqual([
      ['Internal', 'internal', true],
      ['Credit Card Payments', 'cc_payments', false],
      ['Debt Payments', 'debt_payments', false],
      ['Utilities', 'normal', true],
    ]);
    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Edit group "Utilities"' },
    });
  });

  it("protects the app's groups: they can be hidden but not renamed or deleted, and Internal is locked", async () => {
    const cards = await systemGroupId(t.db, 'cc_payments');
    const internal = await systemGroupId(t.db, 'internal');
    const notYours = {
      status: 422,
      body: { code: 'system_group', message: 'Only your own groups can be renamed or deleted.' },
    };
    expect(await json(await patch(cards, { name: 'Cards' }))).toEqual(notYours);
    expect(await json(await remove(cards))).toEqual(notYours);
    expect((await json<CategoryGroupDto>(await patch(cards, { hidden: true }))).body.hidden).toBe(true);
    expect((await json(await patch(cards, { name: 'Credit Card Payments' }))).status).toBe(200);
    expect(await json(await patch(internal, { hidden: false }))).toEqual({
      status: 422,
      body: { code: 'system_group', message: 'This group is managed by the app.' },
    });
    expect(await json(await patch(crypto.randomUUID(), { hidden: true }))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Category group not found.' },
    });
  });

  it('deletes only groups without live categories, as an undoable soft delete', async () => {
    const bills = await createGroup(ctx.client, 'Bills');
    const rent = await createCategory(ctx.client, bills.id, 'Rent');
    expect(await json(await remove(bills.id))).toEqual({
      status: 422,
      body: { code: 'group_not_empty', message: "Move or delete this group's categories first." },
    });

    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, rent.id));
    const before = await snapshot(t.db);
    expect(await json(await remove(bills.id))).toEqual({ status: 200, body: { id: bills.id } });
    const [row] = await t.db.select().from(categoryGroup).where(eq(categoryGroup.id, bills.id));
    expect(row!.deletedAt).toEqual(ctx.clock.now());
    expect((await groups()).map((g) => g.name)).not.toContain('Bills');
    expect((await json(await patch(bills.id, { name: 'Again' }))).status).toBe(404);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('reorders every live group except the internal one', async () => {
    const bills = await createGroup(ctx.client, 'Bills');
    const cards = await systemGroupId(t.db, 'cc_payments');
    const debts = await systemGroupId(t.db, 'debt_payments');
    const order = (ids: string[]) => ctx.client.send('PUT', '/api/category-groups/order', { ids });

    expect(await json(await order([bills.id, debts, cards]))).toEqual({
      status: 200,
      body: { ids: [bills.id, debts, cards] },
    });
    expect((await groups()).map((g) => g.name)).toEqual(['Internal', 'Bills', 'Debt Payments', 'Credit Card Payments']);
    expect((await json(await order([bills.id, cards]))).body).toMatchObject({ code: 'order_mismatch' });
    const internal = await systemGroupId(t.db, 'internal');
    const withInternal = await order([internal, bills.id, debts, cards]);
    expect((await json(withInternal)).body).toMatchObject({ code: 'order_mismatch' });
  });
});
```

Create `src/server/categories/category-routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CategoryDto, CategoryListResponse } from '../../shared/api/categories';
import { systemCategoryId, systemGroupId } from '../db/lookups';
import { category } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup } from '../test/fixtures';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db);
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/categories/${id}`, body);

async function list() {
  return (await json<CategoryListResponse>(await ctx.client.get('/api/categories'))).body.groups;
}

describe('GET /api/categories', () => {
  it('lists live groups and categories in order, flagging system and account-linked rows by kind', async () => {
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const loan = await createAccount(ctx.client, {
      name: 'Car',
      type: 'auto_loan',
      minPayment: 1,
      createPairedCategory: true,
    });
    const bills = await createGroup(ctx.client, 'Bills');
    await createCategory(ctx.client, bills.id, 'Rent');
    const gone = await createCategory(ctx.client, bills.id, 'Old');
    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, gone.id));

    const groups = await list();
    const rows = groups.map((g) => [g.kind, g.categories.map((c) => [c.name, c.kind, c.hidden, c.linkedAccountId])]);
    expect(rows).toEqual([
      [
        'internal',
        [
          ['Ready to Assign', 'rta', true, null],
          ['Uncategorized', 'uncategorized', true, null],
        ],
      ],
      ['cc_payments', [['Visa', 'cc_payment', false, card.id]]],
      ['debt_payments', [['Car', 'debt_payment', false, loan.id]]],
      ['normal', [['Rent', 'normal', false, null]]],
    ]);
  });
});

describe('POST /api/categories', () => {
  it('appends a category to a normal group', async () => {
    const bills = await createGroup(ctx.client, 'Bills');
    await createCategory(ctx.client, bills.id, 'Rent');
    const res = await json<CategoryDto>(
      await ctx.client.post('/api/categories', { groupId: bills.id, name: 'Power', note: 'Tauron' }),
    );
    expect(res).toEqual({
      status: 201,
      body: {
        id: expect.any(String),
        groupId: bills.id,
        name: 'Power',
        kind: 'normal',
        hidden: false,
        note: 'Tauron',
        sortOrder: 2,
        linkedAccountId: null,
      },
    });
  });

  it('refuses groups the user does not own', async () => {
    const invalid = {
      status: 422,
      body: { code: 'invalid_group', message: 'Choose one of your own category groups.' },
    };
    for (const groupId of [
      await systemGroupId(t.db, 'cc_payments'),
      await systemGroupId(t.db, 'internal'),
      crypto.randomUUID(),
    ]) {
      expect(await json(await ctx.client.post('/api/categories', { groupId, name: 'X' }))).toEqual(invalid);
    }
  });
});

describe('PATCH /api/categories/:id', () => {
  it('renames, notes, hides and moves a normal category, each edit undoable', async () => {
    const bills = await createGroup(ctx.client, 'Bills');
    const home = await createGroup(ctx.client, 'Home');
    await createCategory(ctx.client, home.id, 'Furniture');
    const rent = await createCategory(ctx.client, bills.id, 'Rent');

    const res = await json<CategoryDto>(
      await patch(rent.id, { name: 'Rent & fees', note: 'Due 10th', hidden: true, groupId: home.id }),
    );
    expect(res).toEqual({
      status: 200,
      body: { ...rent, name: 'Rent & fees', note: 'Due 10th', hidden: true, groupId: home.id, sortOrder: 2 },
    });
    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Edit category "Rent & fees"' },
    });
    const [row] = await t.db.select().from(category).where(eq(category.id, rent.id));
    expect(row).toMatchObject({ name: 'Rent', note: null, hidden: false, groupId: bills.id, sortOrder: 1 });

    expect((await json<CategoryDto>(await patch(rent.id, { note: '' }))).body.note).toBeNull();
    const toCards = await patch(rent.id, { groupId: await systemGroupId(t.db, 'cc_payments') });
    expect((await json(toCards)).body).toMatchObject({ code: 'invalid_group' });
  });

  it('lets payment and paired categories change only their note and hidden flag', async () => {
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const bills = await createGroup(ctx.client, 'Bills');
    const linked = {
      status: 422,
      body: { code: 'linked_category', message: "This category follows its account: it can't be renamed or moved." },
    };
    expect(await json(await patch(card.paymentCategoryId!, { name: 'Card' }))).toEqual(linked);
    expect(await json(await patch(card.paymentCategoryId!, { groupId: bills.id }))).toEqual(linked);
    const hidden = await json<CategoryDto>(
      await patch(card.paymentCategoryId!, { name: 'Visa', hidden: true, note: 'Pay monthly' }),
    );
    expect(hidden.body).toMatchObject({ name: 'Visa', hidden: true, note: 'Pay monthly', kind: 'cc_payment' });
  });

  it('locks the system categories and answers 404 for unknown or deleted ones', async () => {
    expect(await json(await patch(await systemCategoryId(t.db, 'rta'), { hidden: false }))).toEqual({
      status: 422,
      body: { code: 'system_category', message: "System categories can't be changed." },
    });
    const bills = await createGroup(ctx.client, 'Bills');
    const gone = await createCategory(ctx.client, bills.id, 'Old');
    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, gone.id));
    for (const id of [gone.id, crypto.randomUUID()]) {
      expect(await json(await patch(id, { name: 'X' }))).toEqual({
        status: 404,
        body: { code: 'not_found', message: 'Category not found.' },
      });
    }
  });
});

describe('PUT /api/categories/order', () => {
  it('reorders the live categories of one group', async () => {
    const bills = await createGroup(ctx.client, 'Bills');
    const rent = await createCategory(ctx.client, bills.id, 'Rent');
    const power = await createCategory(ctx.client, bills.id, 'Power');
    const order = (groupId: string, ids: string[]) => ctx.client.send('PUT', '/api/categories/order', { groupId, ids });

    expect(await json(await order(bills.id, [power.id, rent.id]))).toEqual({
      status: 200,
      body: { ids: [power.id, rent.id] },
    });
    const groups = await list();
    expect(groups.find((g) => g.id === bills.id)!.categories.map((c) => c.name)).toEqual(['Power', 'Rent']);
    expect((await json(await order(bills.id, [power.id]))).body).toMatchObject({ code: 'order_mismatch' });
    const internal = await systemGroupId(t.db, 'internal');
    const system = [await systemCategoryId(t.db, 'uncategorized'), await systemCategoryId(t.db, 'rta')];
    expect((await json(await order(internal, system))).body).toMatchObject({ code: 'invalid_group' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/categories`
Expected: FAIL with `Tests  11 failed (11)`, mostly `Error: createGroup failed: 404 {"code":"not_found","message":"Not found."}`.

- [ ] **Step 3: Add the shared category API**

Create `src/shared/api/categories.ts`:

```ts
import { z } from 'zod';
import { idSchema, nameSchema, noteSchema, reorderRequestSchema } from './common';

/** `internal` holds the system categories and is never shown; the others are rendered as groups. */
export type CategoryGroupKind = 'normal' | 'cc_payments' | 'debt_payments' | 'internal';

/**
 * - `rta`, `uncategorized`: system categories (internal group, never editable)
 * - `cc_payment`: a credit card's payment category, named after its account (spec §5.3)
 * - `debt_payment`: a loan's paired category, named after its account (spec §8)
 * - `normal`: everything the user created
 */
export type CategoryKind = 'normal' | 'rta' | 'uncategorized' | 'cc_payment' | 'debt_payment';

export interface CategoryDto {
  id: string;
  groupId: string;
  name: string;
  kind: CategoryKind;
  hidden: boolean;
  note: string | null;
  sortOrder: number;
  /** The credit or loan account of a `cc_payment` / `debt_payment` category. */
  linkedAccountId: string | null;
}

export interface CategoryGroupDto {
  id: string;
  name: string;
  kind: CategoryGroupKind;
  hidden: boolean;
  sortOrder: number;
  /** Live categories in display order. */
  categories: CategoryDto[];
}

/** GET /api/categories: every live group (internal included) with its live categories, in display order. */
export interface CategoryListResponse {
  groups: CategoryGroupDto[];
}

export const createGroupRequestSchema = z.object({ name: nameSchema });

/** Renaming is for normal groups only; any group but the internal one can be hidden. */
export const updateGroupRequestSchema = z.object({
  name: nameSchema.optional(),
  hidden: z.boolean().optional(),
});

export const createCategoryRequestSchema = z.object({
  groupId: idSchema,
  name: nameSchema,
  note: noteSchema.optional(),
});

/**
 * Normal categories take every field; credit card payment and paired loan categories take only `note` and `hidden`
 * (their name follows the account); system categories take none. Moving (`groupId`) appends to a normal group.
 */
export const updateCategoryRequestSchema = z.object({
  name: nameSchema.optional(),
  note: noteSchema.nullable().optional(),
  hidden: z.boolean().optional(),
  groupId: idSchema.optional(),
});

/** PUT /api/categories/order: every live category of one group, in the new order. */
export const reorderCategoriesRequestSchema = reorderRequestSchema.extend({ groupId: idSchema });

export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;
export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>;
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;
```

- [ ] **Step 4: Write the read model**

Create `src/server/categories/category-queries.ts`:

```ts
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { CategoryDto, CategoryGroupDto, CategoryGroupKind, CategoryKind } from '../../shared/api/categories';
import type { Executor } from '../db/client';
import { category, categoryGroup } from '../db/schema';
import { AppError } from '../http/errors';

type CategoryRow = typeof category.$inferSelect;

export function categoryKindOf(
  row: Pick<CategoryRow, 'systemKind' | 'linkedAccountId'>,
  groupKind: CategoryGroupKind,
): CategoryKind {
  if (row.systemKind) return row.systemKind;
  if (row.linkedAccountId) return groupKind === 'cc_payments' ? 'cc_payment' : 'debt_payment';
  return 'normal';
}

function toDto(row: CategoryRow, groupKind: CategoryGroupKind): CategoryDto {
  return {
    id: row.id,
    groupId: row.groupId,
    name: row.name,
    kind: categoryKindOf(row, groupKind),
    hidden: row.hidden,
    note: row.note,
    sortOrder: row.sortOrder,
    linkedAccountId: row.linkedAccountId,
  };
}

/** Live groups with their live categories, both in display order. */
export async function listCategoryGroups(db: Executor, where?: SQL): Promise<CategoryGroupDto[]> {
  const groups = await db
    .select()
    .from(categoryGroup)
    .where(and(isNull(categoryGroup.deletedAt), where))
    .orderBy(asc(categoryGroup.sortOrder), asc(categoryGroup.createdAt), asc(categoryGroup.id));
  if (groups.length === 0) return [];
  const categories = await db
    .select()
    .from(category)
    .where(and(isNull(category.deletedAt), inArray(category.groupId, groups.map((g) => g.id))))
    .orderBy(asc(category.sortOrder), asc(category.createdAt), asc(category.id));
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    kind: g.kind,
    hidden: g.hidden,
    sortOrder: g.sortOrder,
    categories: categories.filter((c) => c.groupId === g.id).map((c) => toDto(c, g.kind)),
  }));
}

export async function getCategoryGroup(db: Executor, id: string): Promise<CategoryGroupDto> {
  const [group] = await listCategoryGroups(db, eq(categoryGroup.id, id));
  if (!group) throw new AppError(404, 'not_found', 'Category group not found.');
  return group;
}

export async function getCategory(db: Executor, id: string): Promise<CategoryDto> {
  const [row] = await db
    .select({ category, groupKind: categoryGroup.kind })
    .from(category)
    .innerJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
    .where(and(eq(category.id, id), isNull(category.deletedAt)));
  if (!row) throw new AppError(404, 'not_found', 'Category not found.');
  return toDto(row.category, row.groupKind);
}
```

- [ ] **Step 5: Write the group commands**

Create `src/server/categories/group-commands.ts`:

```ts
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { UpdateGroupRequest } from '../../shared/api/categories';
import type { ChangeRecorder } from '../commands/recorder';
import { applyOrder } from '../commands/reorder';
import type { Executor } from '../db/client';
import { nextSortOrder } from '../db/lookups';
import { category, categoryGroup } from '../db/schema';
import { AppError, DomainError } from '../http/errors';

type GroupRow = typeof categoryGroup.$inferSelect;

/** A live group, locked for the rest of the command. */
export async function loadGroup(db: Executor, id: string): Promise<GroupRow> {
  const [row] = await db
    .select()
    .from(categoryGroup)
    .where(and(eq(categoryGroup.id, id), isNull(categoryGroup.deletedAt)))
    .for('update');
  if (!row) throw new AppError(404, 'not_found', 'Category group not found.');
  return row;
}

const appManaged = () => new DomainError('system_group', 'This group is managed by the app.');
const notYours = () => new DomainError('system_group', 'Only your own groups can be renamed or deleted.');

export async function createGroup(rec: ChangeRecorder, name: string): Promise<{ id: string }> {
  const [group] = await rec.insert(categoryGroup, {
    name,
    kind: 'normal',
    sortOrder: await nextSortOrder(rec.tx, categoryGroup, isNull(categoryGroup.deletedAt)),
  });
  return { id: group!.id };
}

export async function updateGroup(
  rec: ChangeRecorder,
  id: string,
  input: UpdateGroupRequest,
): Promise<{ name: string }> {
  const group = await loadGroup(rec.tx, id);
  if (group.kind === 'internal') throw appManaged();
  if (input.name !== undefined && input.name !== group.name && group.kind !== 'normal') throw notYours();
  await rec.update(categoryGroup, eq(categoryGroup.id, id), { name: input.name, hidden: input.hidden });
  return { name: input.name ?? group.name };
}

/** Spec §10: a group can be deleted only when empty. Soft delete: deleted categories still point at it. */
export async function deleteGroup(rec: ChangeRecorder, id: string, now: Date): Promise<{ name: string }> {
  const group = await loadGroup(rec.tx, id);
  if (group.kind !== 'normal') throw notYours();
  const [live] = await rec.tx
    .select({ id: category.id })
    .from(category)
    .where(and(eq(category.groupId, id), isNull(category.deletedAt)))
    .limit(1);
  if (live) throw new DomainError('group_not_empty', "Move or delete this group's categories first.");
  await rec.update(categoryGroup, eq(categoryGroup.id, id), { deletedAt: now });
  return { name: group.name };
}

/** `ids` lists every live group except the internal one. */
export function reorderGroups(rec: ChangeRecorder, ids: string[]): Promise<void> {
  return applyOrder(rec, categoryGroup, and(isNull(categoryGroup.deletedAt), ne(categoryGroup.kind, 'internal')), ids);
}
```

- [ ] **Step 6: Write the category commands**

Create `src/server/categories/category-commands.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import type { CategoryKind, CreateCategoryRequest, UpdateCategoryRequest } from '../../shared/api/categories';
import type { ChangeRecorder } from '../commands/recorder';
import { applyOrder } from '../commands/reorder';
import type { Executor } from '../db/client';
import { nextSortOrder } from '../db/lookups';
import { category, categoryGroup } from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { categoryKindOf } from './category-queries';

type CategoryRow = typeof category.$inferSelect;

/** A live category with its kind, locked for the rest of the command. */
export async function loadCategory(db: Executor, id: string): Promise<CategoryRow & { kind: CategoryKind }> {
  const [row] = await db
    .select({ category, groupKind: categoryGroup.kind })
    .from(category)
    .innerJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
    .where(and(eq(category.id, id), isNull(category.deletedAt)))
    .for('update', { of: category });
  if (!row) throw new AppError(404, 'not_found', 'Category not found.');
  return { ...row.category, kind: categoryKindOf(row.category, row.groupKind) };
}

/** Categories can only be created in, and moved to, a live group the user owns. */
async function assertNormalGroup(db: Executor, groupId: string): Promise<void> {
  const [group] = await db
    .select({ kind: categoryGroup.kind })
    .from(categoryGroup)
    .where(and(eq(categoryGroup.id, groupId), isNull(categoryGroup.deletedAt)));
  if (group?.kind !== 'normal') throw new DomainError('invalid_group', 'Choose one of your own category groups.');
}

const lastIn = (db: Executor, groupId: string) =>
  nextSortOrder(db, category, and(eq(category.groupId, groupId), isNull(category.deletedAt)));

export async function createCategory(rec: ChangeRecorder, input: CreateCategoryRequest): Promise<{ id: string }> {
  await assertNormalGroup(rec.tx, input.groupId);
  const [created] = await rec.insert(category, {
    groupId: input.groupId,
    name: input.name,
    note: input.note || null,
    sortOrder: await lastIn(rec.tx, input.groupId),
  });
  return { id: created!.id };
}

/** Spec §10 "Categories": rename, note, hide and move; what a category accepts depends on its kind. */
export async function updateCategory(
  rec: ChangeRecorder,
  id: string,
  input: UpdateCategoryRequest,
): Promise<{ name: string }> {
  const current = await loadCategory(rec.tx, id);
  if (current.kind === 'rta' || current.kind === 'uncategorized') {
    throw new DomainError('system_category', "System categories can't be changed.");
  }
  const renamed = input.name !== undefined && input.name !== current.name;
  const moved = input.groupId !== undefined && input.groupId !== current.groupId;
  if (current.kind !== 'normal' && (renamed || moved)) {
    throw new DomainError('linked_category', "This category follows its account: it can't be renamed or moved.");
  }
  let sortOrder: number | undefined;
  if (moved) {
    await assertNormalGroup(rec.tx, input.groupId!);
    sortOrder = await lastIn(rec.tx, input.groupId!);
  }
  await rec.update(category, eq(category.id, id), {
    name: input.name,
    note: input.note === undefined ? undefined : input.note || null,
    hidden: input.hidden,
    groupId: moved ? input.groupId : undefined,
    sortOrder,
  });
  return { name: input.name ?? current.name };
}

/** `ids` lists every live category of the group (any group but the internal one). */
export async function reorderCategories(rec: ChangeRecorder, groupId: string, ids: string[]): Promise<void> {
  const [group] = await rec.tx
    .select({ kind: categoryGroup.kind })
    .from(categoryGroup)
    .where(and(eq(categoryGroup.id, groupId), isNull(categoryGroup.deletedAt)));
  if (!group || group.kind === 'internal') {
    throw new DomainError('invalid_group', 'Choose one of your own category groups.');
  }
  await applyOrder(rec, category, and(eq(category.groupId, groupId), isNull(category.deletedAt)), ids);
}
```

- [ ] **Step 7: Add the routes and mount them**

Create `src/server/categories/group-routes.ts`:

```ts
import { Hono } from 'hono';
import {
  type CategoryGroupDto,
  createGroupRequestSchema,
  updateGroupRequestSchema,
} from '../../shared/api/categories';
import { idParamSchema, type IdResponse, type ReorderResponse, reorderRequestSchema } from '../../shared/api/common';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { type Named, runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { getCategoryGroup } from './category-queries';
import { createGroup, deleteGroup, reorderGroups, updateGroup } from './group-commands';

/** /api/category-groups (spec §10 "Categories"). The list itself is GET /api/categories. */
export function groupRoutes(deps: AppDeps) {
  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .post('/', validate('json', createGroupRequestSchema), async (c) => {
      const { name } = c.req.valid('json');
      const { id } = await runCommand(deps, `Create group "${name}"`, (rec) => createGroup(rec, name));
      return c.json<CategoryGroupDto>(await getCategoryGroup(deps.db, id), 201);
    })
    .put('/order', validate('json', reorderRequestSchema), async (c) => {
      const { ids } = c.req.valid('json');
      await runCommand(deps, 'Reorder groups', (rec) => reorderGroups(rec, ids));
      return c.json<ReorderResponse>({ ids });
    })
    .patch('/:id', validate('param', idParamSchema), validate('json', updateGroupRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      await runCommand(deps, (r: Named) => `Edit group "${r.name}"`, (rec) => updateGroup(rec, id, body));
      return c.json<CategoryGroupDto>(await getCategoryGroup(deps.db, id));
    })
    .delete('/:id', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(deps, (r: Named) => `Delete group "${r.name}"`, (rec) => deleteGroup(rec, id, deps.clock.now()));
      return c.json<IdResponse>({ id });
    });
}
```

Create `src/server/categories/category-routes.ts`:

```ts
import { Hono } from 'hono';
import {
  type CategoryDto,
  type CategoryListResponse,
  createCategoryRequestSchema,
  reorderCategoriesRequestSchema,
  updateCategoryRequestSchema,
} from '../../shared/api/categories';
import { idParamSchema, type ReorderResponse } from '../../shared/api/common';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { type Named, runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { createCategory, reorderCategories, updateCategory } from './category-commands';
import { getCategory, listCategoryGroups } from './category-queries';

/** /api/categories (spec §10 "Categories"): every change is one undoable command. */
export function categoryRoutes(deps: AppDeps) {
  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/', async (c) => c.json<CategoryListResponse>({ groups: await listCategoryGroups(deps.db) }))
    .post('/', validate('json', createCategoryRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const { id } = await runCommand(deps, `Create category "${body.name}"`, (rec) => createCategory(rec, body));
      return c.json<CategoryDto>(await getCategory(deps.db, id), 201);
    })
    .put('/order', validate('json', reorderCategoriesRequestSchema), async (c) => {
      const { groupId, ids } = c.req.valid('json');
      await runCommand(deps, 'Reorder categories', (rec) => reorderCategories(rec, groupId, ids));
      return c.json<ReorderResponse>({ ids });
    })
    .patch('/:id', validate('param', idParamSchema), validate('json', updateCategoryRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      await runCommand(deps, (r: Named) => `Edit category "${r.name}"`, (rec) => updateCategory(rec, id, body));
      return c.json<CategoryDto>(await getCategory(deps.db, id));
    });
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.ts b/src/server/http/app.ts
index a39432e..931c72e 100644
--- a/src/server/http/app.ts
+++ b/src/server/http/app.ts
@@ -8,6 +8,8 @@ import { accountRoutes } from '../accounts/account-routes';
 import { loginRoutes } from '../auth/login-routes';
 import { securityRoutes } from '../auth/security-routes';
 import { setupRoutes } from '../auth/setup-routes';
+import { categoryRoutes } from '../categories/category-routes';
+import { groupRoutes } from '../categories/group-routes';
 import type { Clock } from '../clock';
 import { redoRoutes, undoRoutes } from '../commands/undo-routes';
 import type { Config } from '../config';
@@ -70,7 +72,9 @@ export function createApp(deps: AppDeps) {
     // route is private by default (app.test.ts walks app.routes to keep it that way).
     .route('/api/undo', undoRoutes(deps))
     .route('/api/redo', redoRoutes(deps))
-    .route('/api/accounts', accountRoutes(deps));
+    .route('/api/accounts', accountRoutes(deps))
+    .route('/api/category-groups', groupRoutes(deps))
+    .route('/api/categories', categoryRoutes(deps));
 
   app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
   app.onError(errorHandler);
PATCH
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run --project server src/server/categories`
Expected: `Tests  11 passed (11)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  35 passed (35)`, `Tests  337 passed (337)`; both checks exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/shared/api/categories.ts src/server/categories src/server/http/app.ts src/server/test/fixtures.ts
git commit -m "feat(server): category groups and categories" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Assignments, move money and month notes

Spec §3, §4.3 and §5.4.

**Assigned:**
- `PUT …/assignments/:categoryId` sets Assigned for one category and month. Assignments are sparse, so 0 deletes the row.
- Amounts are safe integers and may be negative.
- Credit card payment and paired loan categories accept assignments; Ready to Assign and Uncategorized don't (422 `category_not_assignable`).

**Move money:** changes one or two categories' Assigned in one command; `null` stands for Ready to Assign.

**Month note:** setting an empty note deletes it.

**Month range:** months run from the budget start to the current month + 24 (the P2 carry-over cap and the UI's navigation limit). Per §5.1, the budget start is the earlier of `app_user.budget_start_month` and the month of the earliest live transaction.

**Files:**
- Create: `src/shared/api/budget.ts`, `src/server/budget/assignments.ts`, `src/server/budget/budget-routes.ts`
- Modify: `src/server/http/app.ts`
- Test: `src/server/budget/budget-routes.test.ts`

**Interfaces:**
- Consumes: `runCommand`, `Named`, `ChangeRecorder` (Task 2); `moneySchema`, `positiveMoneySchema`, `monthSchema`, `idSchema`, `noteSchema` (Task 4); `addMonths`, `monthOf`, `Month`, `Money`, `IsoDate` from `src/engine`.
- Produces:
  - `src/shared/api/budget.ts`:
    - schemas: `monthParamSchema { month }`, `assignmentParamSchema { month, categoryId }`, `setAssignmentRequestSchema { amount }`, `moveMoneyRequestSchema { from: id | null, to: id | null, amount > 0 }` (from ≠ to), `monthNoteRequestSchema { note }`
    - types: `MoveMoneyRequest`, `AssignmentDto { month: 'YYYY-MM', categoryId, amount }`, `MoveMoneyResponse { assignments }`, `MonthNoteDto { month, note: string | null }`
  - `src/server/budget/assignments.ts`:
    - `MONTHS_AHEAD = 24`, `monthStart(month): IsoDate`
    - `budgetStartMonth(db): Promise<Month>`, `assertBudgetMonth(db, month, today)` (422 `month_out_of_range`)
    - `assignableCategory(db, id): Promise<{ name }>` (404 / 422 `category_not_assignable`), `assignedIn(db, categoryId, month): Promise<Money>`
    - `setAssigned(rec, categoryId, month, amount)`, `addAssigned(rec, categoryId, month, delta)` (422 `amount_too_large`)
    - `moveMoney(rec, month, move): Promise<string[]>` (the category ids it changed), `setMonthNote(rec, month, note)`
  - `budgetRoutes(deps)` at `/api/budget`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/budget/budget-routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CategoryDto } from '../../shared/api/categories';
import { systemCategoryId } from '../db/lookups';
import { assignment, category, monthNote } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let groceries: CategoryDto;
let rent: CategoryDto;
beforeEach(async () => {
  t = await createTestDatabase();
  // Setup on 20 November 2026 makes 2026-11 the budget start month.
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
  const group = await createGroup(ctx.client, 'Everyday');
  groceries = await createCategory(ctx.client, group.id, 'Groceries');
  rent = await createCategory(ctx.client, group.id, 'Rent');
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const assign = (month: string, categoryId: string, amount: unknown) =>
  ctx.client.send('PUT', `/api/budget/${month}/assignments/${categoryId}`, { amount });
const move = (month: string, body: object) => ctx.client.post(`/api/budget/${month}/move`, body);
const assignments = () => t.db.select().from(assignment).orderBy(assignment.month, assignment.amount);

describe('PUT /api/budget/:month/assignments/:categoryId', () => {
  it('sets, changes and clears Assigned, each change undoable', async () => {
    const empty = await snapshot(t.db);
    expect(await json(await assign('2026-11', groceries.id, 150_000))).toEqual({
      status: 200,
      body: { month: '2026-11', categoryId: groceries.id, amount: 150_000 },
    });
    await assign('2026-11', groceries.id, 120_000);
    expect(await assignments()).toEqual([{ categoryId: groceries.id, month: '2026-11-01', amount: 120_000 }]);
    await assign('2026-11', groceries.id, 0);
    expect(await assignments()).toEqual([]);

    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Assign money to "Groceries"' },
    });
    await ctx.client.post('/api/undo');
    expect(await assignments()).toEqual([{ categoryId: groceries.id, month: '2026-11-01', amount: 120_000 }]);
    await ctx.client.post('/api/undo');
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(empty);
  });

  it('accepts negative amounts and credit card payment categories, but not system or unknown categories', async () => {
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    expect((await assign('2026-11', card.paymentCategoryId!, 37_500)).status).toBe(200);
    expect((await assign('2026-11', rent.id, -5_000)).status).toBe(200);

    const notAssignable = {
      status: 422,
      body: { code: 'category_not_assignable', message: "Money can't be assigned to this category." },
    };
    for (const kind of ['rta', 'uncategorized'] as const) {
      expect(await json(await assign('2026-11', await systemCategoryId(t.db, kind), 1))).toEqual(notAssignable);
    }
    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, rent.id));
    for (const id of [rent.id, crypto.randomUUID()]) {
      expect(await json(await assign('2026-11', id, 1))).toEqual({
        status: 404,
        body: { code: 'not_found', message: 'Category not found.' },
      });
    }
  });

  it('allows months from the budget start to 24 months ahead', async () => {
    const outOfRange = (first: string) => ({
      status: 422,
      body: { code: 'month_out_of_range', message: `Pick a month from ${first} to 2028-11.` },
    });
    expect((await assign('2028-11', groceries.id, 1)).status).toBe(200);
    expect(await json(await assign('2028-12', groceries.id, 1))).toEqual(outOfRange('2026-11'));
    expect(await json(await assign('2026-10', groceries.id, 1))).toEqual(outOfRange('2026-11'));

    // An earlier transaction moves the budget start back (spec §5.1).
    await createAccount(ctx.client, { name: 'Cash', type: 'cash', startingDate: '2026-03-15' });
    expect((await assign('2026-03', groceries.id, 1)).status).toBe(200);
    expect(await json(await assign('2026-02', groceries.id, 1))).toEqual(outOfRange('2026-03'));
  });

  it('validates the month format and whole, safe amounts', async () => {
    const fieldErrors = async (res: Response) =>
      ((await res.json()) as { fieldErrors: Record<string, string[]> }).fieldErrors;
    expect(await fieldErrors(await assign('2026-13', groceries.id, 1))).toEqual({ month: ['Use the format YYYY-MM.'] });
    expect(await fieldErrors(await assign('2026-11', groceries.id, 1.5))).toEqual({
      amount: ['Enter a whole amount in minor units.'],
    });
    expect(await fieldErrors(await assign('2026-11', groceries.id, 2 ** 53))).toEqual({
      amount: ['Enter a whole amount in minor units.'],
    });
  });
});

describe('POST /api/budget/:month/move', () => {
  it('moves money between two categories as one undoable command', async () => {
    await assign('2026-11', groceries.id, 10_000);
    const before = await snapshot(t.db);
    expect(await json(await move('2026-11', { from: groceries.id, to: rent.id, amount: 4_000 }))).toEqual({
      status: 200,
      body: {
        assignments: [
          { month: '2026-11', categoryId: groceries.id, amount: 6_000 },
          { month: '2026-11', categoryId: rent.id, amount: 4_000 },
        ],
      },
    });
    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({ undone: { label: 'Move money' } });
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('moves to and from Ready to Assign by changing only the other category', async () => {
    await move('2026-12', { from: null, to: groceries.id, amount: 3_000 });
    await move('2026-12', { from: groceries.id, to: null, amount: 3_000 });
    await move('2026-12', { from: rent.id, to: null, amount: 500 });
    expect(await assignments()).toEqual([{ categoryId: rent.id, month: '2026-12-01', amount: -500 }]);
  });

  it('rejects moves without two different places, non-positive amounts and system categories', async () => {
    const bad = async (body: object) => (await json(await move('2026-11', body))).body;
    expect(await bad({ from: null, to: null, amount: 1 })).toMatchObject({
      fieldErrors: { to: ['Choose two different places to move money between.'] },
    });
    expect(await bad({ from: rent.id, to: rent.id, amount: 1 })).toMatchObject({ code: 'validation' });
    expect(await bad({ from: rent.id, to: groceries.id, amount: 0 })).toMatchObject({
      fieldErrors: { amount: ['Enter an amount greater than 0.'] },
    });
    expect(await bad({ from: await systemCategoryId(t.db, 'rta'), to: rent.id, amount: 1 })).toMatchObject({
      code: 'category_not_assignable',
    });
    await assign('2026-11', rent.id, Number.MAX_SAFE_INTEGER);
    expect(await bad({ from: null, to: rent.id, amount: 1 })).toEqual({
      code: 'amount_too_large',
      message: 'That amount is too large.',
    });
  });
});

describe('PUT /api/budget/:month/note', () => {
  it('sets, replaces and deletes the month note', async () => {
    const put = (note: string) => ctx.client.send('PUT', '/api/budget/2026-11/note', { note });
    expect(await json(await put('  Holiday gifts  '))).toEqual({
      status: 200,
      body: { month: '2026-11', note: 'Holiday gifts' },
    });
    await put('Holiday gifts and car insurance');
    expect(await t.db.select({ month: monthNote.month, note: monthNote.note }).from(monthNote)).toEqual([
      { month: '2026-11-01', note: 'Holiday gifts and car insurance' },
    ]);
    expect(await json(await put(''))).toEqual({ status: 200, body: { month: '2026-11', note: null } });
    expect(await t.db.select().from(monthNote)).toEqual([]);
    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Edit the note for 2026-11' },
    });
    expect(await t.db.select({ note: monthNote.note }).from(monthNote)).toEqual([
      { note: 'Holiday gifts and car insurance' },
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/budget/budget-routes.test.ts`
Expected: FAIL with `Tests  8 failed (8)`; every request gets `{ status: 404, … }` (e.g. `expected 404 to be 200`).

- [ ] **Step 3: Add the shared budget API**

Create `src/shared/api/budget.ts`:

```ts
import { z } from 'zod';
import { idSchema, moneySchema, monthSchema, noteSchema, positiveMoneySchema } from './common';

export const monthParamSchema = z.object({ month: monthSchema });
export const assignmentParamSchema = z.object({ month: monthSchema, categoryId: idSchema });

/** PUT /api/budget/:month/assignments/:categoryId — the category's new Assigned amount (0 clears it). */
export const setAssignmentRequestSchema = z.object({ amount: moneySchema });

/** POST /api/budget/:month/move — null stands for Ready to Assign (spec §3). */
export const moveMoneyRequestSchema = z
  .object({ from: idSchema.nullable(), to: idSchema.nullable(), amount: positiveMoneySchema })
  .refine((body) => body.from !== body.to, {
    path: ['to'],
    message: 'Choose two different places to move money between.',
  });

/** PUT /api/budget/:month/note — an empty note deletes it. */
export const monthNoteRequestSchema = z.object({ note: noteSchema });

export type MoveMoneyRequest = z.infer<typeof moveMoneyRequestSchema>;

export interface AssignmentDto {
  /** 'YYYY-MM' */
  month: string;
  categoryId: string;
  /** Assigned in minor units (0 = no assignment). */
  amount: number;
}

export interface MoveMoneyResponse {
  /** The categories whose Assigned changed (one or two). */
  assignments: AssignmentDto[];
}

export interface MonthNoteDto {
  month: string;
  note: string | null;
}
```

- [ ] **Step 4: Write the assignment commands**

Create `src/server/budget/assignments.ts`. `min(date)` is read as a raw `sql` value; Drizzle's postgres.js driver returns `date` values as `'YYYY-MM-DD'` strings:

```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { MoveMoneyRequest } from '../../shared/api/budget';
import { addMonths, type IsoDate, type Money, type Month, monthOf } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { appUser, assignment, category, monthNote, transaction } from '../db/schema';
import { AppError, DomainError } from '../http/errors';

/** P2 carry-over: assignments may reach at most 24 months past the current month (the UI's navigation limit). */
export const MONTHS_AHEAD = 24;

/** Months are 'YYYY-MM' in the API and the engine, and their first day in the database. */
export const monthStart = (month: Month): IsoDate => `${month}-01`;

/** Spec §5.1: the budget starts at budget_start_month or the month of the earliest transaction, whichever is first. */
export async function budgetStartMonth(db: Executor): Promise<Month> {
  const [user] = await db.select({ start: appUser.budgetStartMonth }).from(appUser);
  const [earliest] = await db
    .select({ date: sql<IsoDate | null>`min(${transaction.date})` })
    .from(transaction)
    .where(isNull(transaction.deletedAt));
  const starts = [user!.start, earliest?.date].filter((d): d is IsoDate => !!d).map(monthOf);
  return starts.reduce((a, b) => (a < b ? a : b));
}

export async function assertBudgetMonth(db: Executor, month: Month, today: IsoDate): Promise<void> {
  const first = await budgetStartMonth(db);
  const last = addMonths(monthOf(today), MONTHS_AHEAD);
  if (month < first || month > last) {
    throw new DomainError('month_out_of_range', `Pick a month from ${first} to ${last}.`);
  }
}

/** A live category that can hold assignments: anything but Ready to Assign and Uncategorized (spec §3). */
export async function assignableCategory(db: Executor, id: string): Promise<{ name: string }> {
  const [row] = await db
    .select({ name: category.name, systemKind: category.systemKind })
    .from(category)
    .where(and(eq(category.id, id), isNull(category.deletedAt)));
  if (!row) throw new AppError(404, 'not_found', 'Category not found.');
  if (row.systemKind) throw new DomainError('category_not_assignable', "Money can't be assigned to this category.");
  return { name: row.name };
}

const assignmentWhere = (categoryId: string, month: Month) =>
  and(eq(assignment.categoryId, categoryId), eq(assignment.month, monthStart(month)));

export async function assignedIn(db: Executor, categoryId: string, month: Month): Promise<Money> {
  const [row] = await db
    .select({ amount: assignment.amount })
    .from(assignment)
    .where(assignmentWhere(categoryId, month));
  return row?.amount ?? 0;
}

/** Sets Assigned(category, month); assignments are sparse, so 0 deletes the row (spec §4.3). */
export async function setAssigned(rec: ChangeRecorder, categoryId: string, month: Month, amount: Money): Promise<void> {
  if (!Number.isSafeInteger(amount)) throw new DomainError('amount_too_large', 'That amount is too large.');
  const where = assignmentWhere(categoryId, month);
  if (amount === 0) {
    await rec.delete(assignment, where);
  } else if ((await assignedIn(rec.tx, categoryId, month)) !== 0) {
    await rec.update(assignment, where, { amount });
  } else {
    await rec.insert(assignment, { categoryId, month: monthStart(month), amount });
  }
}

export async function addAssigned(rec: ChangeRecorder, categoryId: string, month: Month, delta: Money): Promise<void> {
  await setAssigned(rec, categoryId, month, (await assignedIn(rec.tx, categoryId, month)) + delta);
}

/** Spec §3: moving to or from Ready to Assign (null) changes only the other category's Assigned. */
export async function moveMoney(rec: ChangeRecorder, month: Month, move: MoveMoneyRequest): Promise<string[]> {
  const touched: string[] = [];
  for (const [id, delta] of [
    [move.from, -move.amount],
    [move.to, move.amount],
  ] as const) {
    if (id === null) continue;
    await assignableCategory(rec.tx, id);
    await addAssigned(rec, id, month, delta);
    touched.push(id);
  }
  return touched;
}

/** Sets the month's note; an empty note deletes it. */
export async function setMonthNote(rec: ChangeRecorder, month: Month, note: string): Promise<void> {
  const where = eq(monthNote.month, monthStart(month));
  const [existing] = await rec.tx.select({ month: monthNote.month }).from(monthNote).where(where);
  if (note === '') await rec.delete(monthNote, where);
  else if (existing) await rec.update(monthNote, where, { note });
  else await rec.insert(monthNote, { month: monthStart(month), note });
}
```

- [ ] **Step 5: Add the routes and mount them**

Create `src/server/budget/budget-routes.ts`:

```ts
import { Hono } from 'hono';
import {
  type AssignmentDto,
  assignmentParamSchema,
  type MonthNoteDto,
  monthNoteRequestSchema,
  monthParamSchema,
  type MoveMoneyResponse,
  moveMoneyRequestSchema,
  setAssignmentRequestSchema,
} from '../../shared/api/budget';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import { type Named, runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { assertBudgetMonth, assignableCategory, assignedIn, moveMoney, setAssigned, setMonthNote } from './assignments';

/** /api/budget/:month (spec §3, §5.4): assigning, moving money and the month note; months are 'YYYY-MM'. */
export function budgetRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .put(
      '/:month/assignments/:categoryId',
      validate('param', assignmentParamSchema),
      validate('json', setAssignmentRequestSchema),
      async (c) => {
        const { month, categoryId } = c.req.valid('param');
        const { amount } = c.req.valid('json');
        await runCommand(
          deps,
          (r: Named) => `Assign money to "${r.name}"`,
          async (rec) => {
            await assertBudgetMonth(rec.tx, month, today());
            const target = await assignableCategory(rec.tx, categoryId);
            await setAssigned(rec, categoryId, month, amount);
            return target;
          },
        );
        return c.json<AssignmentDto>({ month, categoryId, amount });
      },
    )
    .post('/:month/move', validate('param', monthParamSchema), validate('json', moveMoneyRequestSchema), async (c) => {
      const { month } = c.req.valid('param');
      const body = c.req.valid('json');
      const touched = await runCommand(deps, 'Move money', async (rec) => {
        await assertBudgetMonth(rec.tx, month, today());
        return moveMoney(rec, month, body);
      });
      const assignments = await Promise.all(
        touched.map(async (categoryId) => ({
          month,
          categoryId,
          amount: await assignedIn(deps.db, categoryId, month),
        })),
      );
      return c.json<MoveMoneyResponse>({ assignments });
    })
    .put('/:month/note', validate('param', monthParamSchema), validate('json', monthNoteRequestSchema), async (c) => {
      const { month } = c.req.valid('param');
      const { note } = c.req.valid('json');
      await runCommand(deps, `Edit the note for ${month}`, async (rec) => {
        await assertBudgetMonth(rec.tx, month, today());
        await setMonthNote(rec, month, note);
      });
      return c.json<MonthNoteDto>({ month, note: note || null });
    });
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.ts b/src/server/http/app.ts
index 931c72e..c77fb94 100644
--- a/src/server/http/app.ts
+++ b/src/server/http/app.ts
@@ -8,6 +8,7 @@ import { accountRoutes } from '../accounts/account-routes';
 import { loginRoutes } from '../auth/login-routes';
 import { securityRoutes } from '../auth/security-routes';
 import { setupRoutes } from '../auth/setup-routes';
+import { budgetRoutes } from '../budget/budget-routes';
 import { categoryRoutes } from '../categories/category-routes';
 import { groupRoutes } from '../categories/group-routes';
 import type { Clock } from '../clock';
@@ -74,7 +75,8 @@ export function createApp(deps: AppDeps) {
     .route('/api/redo', redoRoutes(deps))
     .route('/api/accounts', accountRoutes(deps))
     .route('/api/category-groups', groupRoutes(deps))
-    .route('/api/categories', categoryRoutes(deps));
+    .route('/api/categories', categoryRoutes(deps))
+    .route('/api/budget', budgetRoutes(deps));
 
   app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
   app.onError(errorHandler);
PATCH
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project server src/server/budget/budget-routes.test.ts`
Expected: `Tests  8 passed (8)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  36 passed (36)`, `Tests  345 passed (345)`; both checks exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/shared/api/budget.ts src/server/budget src/server/http/app.ts
git commit -m "feat(server): assignments, move money and month notes" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Delete a category into another; P2b1 docs

Spec §10 "Categories". `DELETE /api/categories/:id { destinationCategoryId }` re-points everything that uses the category:
- transactions (soft-deleted ones too, so no row points at a deleted category), split lines, scheduled transactions and their lines, and `payee.last_category_id`;
- assignments, summed per month into the destination (a zero sum deletes the row).

It then deletes the category's target and soft-deletes the category, all in one undoable command. The destination must be a live, normal category other than the deleted one.

Credit card payment and paired loan categories can't be deleted on their own; they go with their account (Task 5). This also settles the P2 carry-over about a deleted payment category making `computeBudget` throw. Finally, the carry-over notes are updated.

**Files:**
- Modify: `src/shared/api/categories.ts`, `src/server/categories/category-commands.ts`, `src/server/categories/category-routes.ts`
- Modify (docs): spec §10 "Categories", `docs/superpowers/notes/p2-carry-over.md`
- Test: `src/server/categories/category-routes.test.ts`

**Interfaces:**
- Consumes: `addAssigned` (Task 7); `loadCategory`, `categoryKindOf` (Task 6); recorder updates on `transaction`, `subtransaction`, `scheduledTransaction`, `scheduledSubtransaction`, `payee`, `assignment`, `target`, `category`.
- Produces:
  - `deleteCategoryRequestSchema { destinationCategoryId }`
  - `deleteCategory(rec, id, destinationId, now: Date): Promise<{ name }>` (422 `system_category`, `linked_category` or `invalid_destination`; 404 `not_found`)
  - `DELETE /api/categories/:id` → `IdResponse`

- [ ] **Step 1: Write the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/server/categories/category-routes.test.ts b/src/server/categories/category-routes.test.ts
index ac4432d..bfe90f9 100644
--- a/src/server/categories/category-routes.test.ts
+++ b/src/server/categories/category-routes.test.ts
@@ -2,11 +2,21 @@ import { eq } from 'drizzle-orm';
 import { afterEach, beforeEach, describe, expect, it } from 'vitest';
 import type { CategoryDto, CategoryListResponse } from '../../shared/api/categories';
 import { systemCategoryId, systemGroupId } from '../db/lookups';
-import { category } from '../db/schema';
+import {
+  assignment,
+  category,
+  payee,
+  scheduledSubtransaction,
+  scheduledTransaction,
+  subtransaction,
+  target,
+  transaction,
+} from '../db/schema';
 import { createTestApp, type TestApp } from '../test/app';
 import { setUpBudget } from '../test/auth';
 import { createTestDatabase, type TestDatabase } from '../test/db';
 import { createAccount, createCategory, createGroup } from '../test/fixtures';
+import { snapshot } from '../test/snapshot';
 
 let t: TestDatabase;
 let ctx: TestApp;
@@ -173,3 +183,115 @@ describe('PUT /api/categories/order', () => {
     expect((await json(await order(internal, system))).body).toMatchObject({ code: 'invalid_group' });
   });
 });
+
+describe('DELETE /api/categories/:id', () => {
+  const remove = (id: string, destinationCategoryId: string) =>
+    ctx.client.send('DELETE', `/api/categories/${id}`, { destinationCategoryId });
+
+  it('moves everything to the destination, sums assignments per month, and is one undoable command', async () => {
+    const food = await createGroup(ctx.client, 'Food');
+    const groceries = await createCategory(ctx.client, food.id, 'Groceries');
+    const dining = await createCategory(ctx.client, food.id, 'Dining out');
+    const checking = await createAccount(ctx.client, { name: 'mBank' });
+    const assign = (categoryId: string, month: string, amount: number) =>
+      ctx.client.send('PUT', `/api/budget/${month}/assignments/${categoryId}`, { amount });
+    await assign(groceries.id, '2026-11', 5_000);
+    await assign(groceries.id, '2026-12', 3_000);
+    await assign(dining.id, '2026-11', 2_000);
+    await assign(dining.id, '2026-12', -3_000);
+    await t.db.insert(target).values({
+      categoryId: groceries.id,
+      kind: 'spending',
+      cadence: 'monthly',
+      amount: 50_000,
+      startMonth: '2026-11-01',
+    });
+    const line = { accountId: checking.id, date: '2026-11-20', amount: -100, amountBase: -100 };
+    const [txn, deletedTxn, split] = await t.db
+      .insert(transaction)
+      .values([
+        { ...line, categoryId: groceries.id },
+        { ...line, categoryId: groceries.id, deletedAt: new Date() },
+        { ...line, isSplit: true },
+      ])
+      .returning();
+    const [splitLine] = await t.db
+      .insert(subtransaction)
+      .values({ txnId: split!.id, amount: -100, amountBase: -100, categoryId: groceries.id })
+      .returning();
+    const [schedule] = await t.db
+      .insert(scheduledTransaction)
+      .values({
+        accountId: checking.id,
+        categoryId: groceries.id,
+        amount: -100,
+        frequency: 'monthly',
+        anchorDate: '2026-12-01',
+        nextDate: '2026-12-01',
+      })
+      .returning();
+    const [scheduleLine] = await t.db
+      .insert(scheduledSubtransaction)
+      .values({ scheduledId: schedule!.id, amount: -100, categoryId: groceries.id })
+      .returning();
+    const [shop] = await t.db.insert(payee).values({ name: 'Biedronka', lastCategoryId: groceries.id }).returning();
+    const before = await snapshot(t.db);
+
+    expect(await json(await remove(groceries.id, dining.id))).toEqual({ status: 200, body: { id: groceries.id } });
+
+    const categoryOf = async (table: typeof transaction | typeof subtransaction, id: string) =>
+      (await t.db.select({ categoryId: table.categoryId }).from(table).where(eq(table.id, id)))[0]!.categoryId;
+    for (const id of [txn!.id, deletedTxn!.id]) expect(await categoryOf(transaction, id)).toBe(dining.id);
+    expect(await categoryOf(subtransaction, splitLine!.id)).toBe(dining.id);
+    const schedules = await t.db.select({ categoryId: scheduledTransaction.categoryId }).from(scheduledTransaction);
+    const scheduleLines = await t.db
+      .select({ categoryId: scheduledSubtransaction.categoryId })
+      .from(scheduledSubtransaction)
+      .where(eq(scheduledSubtransaction.id, scheduleLine!.id));
+    expect([...schedules, ...scheduleLines]).toEqual([{ categoryId: dining.id }, { categoryId: dining.id }]);
+    expect((await t.db.select().from(payee).where(eq(payee.id, shop!.id)))[0]!.lastCategoryId).toBe(dining.id);
+    // 2026-12: 3 000 + (−3 000) = 0, so the row is gone (assignments are sparse).
+    expect(await t.db.select().from(assignment)).toEqual([
+      { categoryId: dining.id, month: '2026-11-01', amount: 7_000 },
+    ]);
+    expect(await t.db.select().from(target)).toEqual([]);
+    const [deleted] = await t.db.select().from(category).where(eq(category.id, groceries.id));
+    expect(deleted!.deletedAt).toEqual(ctx.clock.now());
+    expect((await list()).flatMap((g) => g.categories.map((c) => c.name))).not.toContain('Groceries');
+    const after = await snapshot(t.db);
+
+    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
+      undone: { label: 'Delete category "Groceries"' },
+    });
+    expect(await snapshot(t.db)).toEqual(before);
+    await ctx.client.post('/api/redo');
+    expect(await snapshot(t.db)).toEqual(after);
+  });
+
+  it('refuses system and account-linked categories, and destinations that are not live normal categories', async () => {
+    const food = await createGroup(ctx.client, 'Food');
+    const groceries = await createCategory(ctx.client, food.id, 'Groceries');
+    const gone = await createCategory(ctx.client, food.id, 'Gone');
+    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, gone.id));
+    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
+    const rta = await systemCategoryId(t.db, 'rta');
+
+    expect((await json(await remove(rta, groceries.id))).body).toMatchObject({ code: 'system_category' });
+    expect(await json(await remove(card.paymentCategoryId!, groceries.id))).toEqual({
+      status: 422,
+      body: { code: 'linked_category', message: "This category belongs to an account and can't be deleted." },
+    });
+    const invalid = {
+      status: 422,
+      body: {
+        code: 'invalid_destination',
+        message: 'Choose another regular category to receive the money and transactions.',
+      },
+    };
+    for (const destination of [groceries.id, card.paymentCategoryId!, rta, gone.id, crypto.randomUUID()]) {
+      expect(await json(await remove(groceries.id, destination))).toEqual(invalid);
+    }
+    expect((await remove(gone.id, groceries.id)).status).toBe(404);
+    expect((await ctx.client.send('DELETE', `/api/categories/${groceries.id}`, {})).status).toBe(400);
+  });
+});
PATCH
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/categories/category-routes.test.ts`
Expected: FAIL with `Tests  2 failed | 7 passed (9)`. `DELETE` isn't routed yet, so both tests get 404: `expected { status: 404, body: { …(2) } } to deeply equal { status: 200, …(1) }`.

- [ ] **Step 3: Add the request schema**

```bash
git apply <<'PATCH'
diff --git a/src/shared/api/categories.ts b/src/shared/api/categories.ts
index 74b9f75..6de6e41 100644
--- a/src/shared/api/categories.ts
+++ b/src/shared/api/categories.ts
@@ -67,6 +67,12 @@ export const updateCategoryRequestSchema = z.object({
 /** PUT /api/categories/order: every live category of one group, in the new order. */
 export const reorderCategoriesRequestSchema = reorderRequestSchema.extend({ groupId: idSchema });
 
+/**
+ * DELETE /api/categories/:id (spec §10): transactions, split lines, schedules, payee defaults and assignments move to
+ * this live, normal category first.
+ */
+export const deleteCategoryRequestSchema = z.object({ destinationCategoryId: idSchema });
+
 export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;
 export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>;
 export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;
PATCH
```

- [ ] **Step 4: Write the command**

`loadCategory` is split into a non-throwing `findCategory` (used for the destination, which is a body reference and gives 422, not 404) plus the throwing wrapper:

```bash
git apply <<'PATCH'
diff --git a/src/server/categories/category-commands.ts b/src/server/categories/category-commands.ts
index b887ea5..89c7a41 100644
--- a/src/server/categories/category-commands.ts
+++ b/src/server/categories/category-commands.ts
@@ -1,25 +1,41 @@
 import { and, eq, isNull } from 'drizzle-orm';
 import type { CategoryKind, CreateCategoryRequest, UpdateCategoryRequest } from '../../shared/api/categories';
+import { addAssigned } from '../budget/assignments';
 import type { ChangeRecorder } from '../commands/recorder';
 import { applyOrder } from '../commands/reorder';
 import type { Executor } from '../db/client';
 import { nextSortOrder } from '../db/lookups';
-import { category, categoryGroup } from '../db/schema';
+import {
+  assignment,
+  category,
+  categoryGroup,
+  payee,
+  scheduledSubtransaction,
+  scheduledTransaction,
+  subtransaction,
+  target,
+  transaction,
+} from '../db/schema';
 import { AppError, DomainError } from '../http/errors';
 import { categoryKindOf } from './category-queries';
 
 type CategoryRow = typeof category.$inferSelect;
 
-/** A live category with its kind, locked for the rest of the command. */
-export async function loadCategory(db: Executor, id: string): Promise<CategoryRow & { kind: CategoryKind }> {
+/** A live category with its kind, locked for the rest of the command; null if there is none. */
+async function findCategory(db: Executor, id: string): Promise<(CategoryRow & { kind: CategoryKind }) | null> {
   const [row] = await db
     .select({ category, groupKind: categoryGroup.kind })
     .from(category)
     .innerJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
     .where(and(eq(category.id, id), isNull(category.deletedAt)))
     .for('update', { of: category });
+  return row ? { ...row.category, kind: categoryKindOf(row.category, row.groupKind) } : null;
+}
+
+export async function loadCategory(db: Executor, id: string): Promise<CategoryRow & { kind: CategoryKind }> {
+  const row = await findCategory(db, id);
   if (!row) throw new AppError(404, 'not_found', 'Category not found.');
-  return { ...row.category, kind: categoryKindOf(row.category, row.groupKind) };
+  return row;
 }
 
 /** Categories can only be created in, and moved to, a live group the user owns. */
@@ -86,3 +102,42 @@ export async function reorderCategories(rec: ChangeRecorder, groupId: string, id
   }
   await applyOrder(rec, category, and(eq(category.groupId, groupId), isNull(category.deletedAt)), ids);
 }
+
+/**
+ * Spec §10: moves every transaction, split line, schedule, payee default and assignment (summed per month) to the
+ * destination, then deletes the target and soft-deletes the category. Children are re-pointed explicitly, never by
+ * cascades, so undo sees each row.
+ */
+export async function deleteCategory(
+  rec: ChangeRecorder,
+  id: string,
+  destinationId: string,
+  now: Date,
+): Promise<{ name: string }> {
+  const doomed = await loadCategory(rec.tx, id);
+  if (doomed.kind === 'rta' || doomed.kind === 'uncategorized') {
+    throw new DomainError('system_category', "System categories can't be changed.");
+  }
+  if (doomed.kind !== 'normal') {
+    throw new DomainError('linked_category', "This category belongs to an account and can't be deleted.");
+  }
+  const destination = destinationId === id ? null : await findCategory(rec.tx, destinationId);
+  if (destination?.kind !== 'normal') {
+    throw new DomainError(
+      'invalid_destination',
+      'Choose another regular category to receive the money and transactions.',
+    );
+  }
+
+  const to = { categoryId: destinationId };
+  await rec.update(transaction, eq(transaction.categoryId, id), to);
+  await rec.update(subtransaction, eq(subtransaction.categoryId, id), to);
+  await rec.update(scheduledTransaction, eq(scheduledTransaction.categoryId, id), to);
+  await rec.update(scheduledSubtransaction, eq(scheduledSubtransaction.categoryId, id), to);
+  await rec.update(payee, eq(payee.lastCategoryId, id), { lastCategoryId: destinationId });
+  const moved = await rec.delete(assignment, eq(assignment.categoryId, id));
+  for (const row of moved) await addAssigned(rec, destinationId, row.month.slice(0, 7), row.amount);
+  await rec.delete(target, eq(target.categoryId, id));
+  await rec.update(category, eq(category.id, id), { deletedAt: now });
+  return { name: doomed.name };
+}
PATCH
```

- [ ] **Step 5: Add the route**

```bash
git apply <<'PATCH'
diff --git a/src/server/categories/category-routes.ts b/src/server/categories/category-routes.ts
index 3ff51a8..6107838 100644
--- a/src/server/categories/category-routes.ts
+++ b/src/server/categories/category-routes.ts
@@ -3,15 +3,16 @@ import {
   type CategoryDto,
   type CategoryListResponse,
   createCategoryRequestSchema,
+  deleteCategoryRequestSchema,
   reorderCategoriesRequestSchema,
   updateCategoryRequestSchema,
 } from '../../shared/api/categories';
-import { idParamSchema, type ReorderResponse } from '../../shared/api/common';
+import { idParamSchema, type IdResponse, type ReorderResponse } from '../../shared/api/common';
 import { type AuthedEnv, requireSession } from '../auth/sessions';
 import { type Named, runCommand } from '../commands/run-command';
 import type { AppDeps } from '../http/app';
 import { validate } from '../http/validate';
-import { createCategory, reorderCategories, updateCategory } from './category-commands';
+import { createCategory, deleteCategory, reorderCategories, updateCategory } from './category-commands';
 import { getCategory, listCategoryGroups } from './category-queries';
 
 /** /api/categories (spec §10 "Categories"): every change is one undoable command. */
@@ -34,5 +35,15 @@ export function categoryRoutes(deps: AppDeps) {
       const body = c.req.valid('json');
       await runCommand(deps, (r: Named) => `Edit category "${r.name}"`, (rec) => updateCategory(rec, id, body));
       return c.json<CategoryDto>(await getCategory(deps.db, id));
+    })
+    .delete('/:id', validate('param', idParamSchema), validate('json', deleteCategoryRequestSchema), async (c) => {
+      const { id } = c.req.valid('param');
+      const { destinationCategoryId } = c.req.valid('json');
+      await runCommand(
+        deps,
+        (r: Named) => `Delete category "${r.name}"`,
+        (rec) => deleteCategory(rec, id, destinationCategoryId, deps.clock.now()),
+      );
+      return c.json<IdResponse>({ id });
     });
 }
PATCH
```

- [ ] **Step 6: Update the spec and the carry-over notes**

```bash
git apply <<'PATCH'
diff --git a/docs/superpowers/notes/p2-carry-over.md b/docs/superpowers/notes/p2-carry-over.md
index dc444a7..37d9764 100644
--- a/docs/superpowers/notes/p2-carry-over.md
+++ b/docs/superpowers/notes/p2-carry-over.md
@@ -21,11 +21,6 @@ These items were found in the P1 final review and deferred. Fold them into the P
 ## Validation and behaviour
 - `autoAssign` should throw when `month` isn't in the computed budget instead of treating it as empty.
 - Validate the schedule anchor date (`nextOccurrence` returns an anchor ahead of `after` unchecked).
-- Cap the assignment month range server-side (e.g. no more than 24 months ahead). `computeBudget` widens its range
-  to the latest assignment.
-- Spec §10 allows deleting a closed card's payment category, but its historic card lines then make `computeBudget`
-  throw ("has no payment category"). Either forbid the deletion or keep soft-deleted payment categories in the
-  engine input.
 - Build a month-view adapter that creates `TargetContext` (carry, assigned, available, `assignedIn`, debt data incl.
   escrow) from a `BudgetResult`.
 - Validate the sign of `TargetDef.amount`. Make a `null` spending `mode` default to `set_aside` explicitly.
@@ -40,27 +35,13 @@ These items were found in the P1 final review and deferred. Fold them into the P
 - Engine purity lint now also blocks dynamic `import()`, `globalThis.*`, `Date.now()`, `new Date()` and `Math.random()`.
 
 ## From P2a final review
-- P2b first task: make every new router deny-by-default (`.use('*', requireSession)` on its own prefix) + a test
-  walking `app.routes` expecting 401 for every /api route outside /api/auth.
-- P2b: cast SQL sums `::bigint` (never `.mapWith(Number)`).
-- P2b: DB cascades (scheduled_subtransaction ON DELETE CASCADE, transaction.scheduled_id SET NULL) bypass the undo
-  ChangeRecorder; record children explicitly or remove the cascades.
-- P2b: timestamps come from two clocks; exclude timestamps from undo conflict checks.
-- P2b: exclude transfer/system payees from `payee_name_live`; add partial unique indexes on payee.system_kind, live
-  category.linked_account_id, non-normal category_group.kind; seed system payees.
-- P2b: category_group has no deleted_at but soft-deleted categories reference it; decide group deletion.
-- P2b: v_ledger_line month is 'YYYY-MM-01' and the engine uses 'YYYY-MM' (adapter); any migration touching view
+- P2b2: v_ledger_line month is 'YYYY-MM-01' and the engine uses 'YYYY-MM' (adapter); any migration touching view
   columns must drop/recreate the view.
-- P2b: enforce date ≤ today on write (§5.6); the view does not filter future dates.
-- P2b: nested validation errors lose paths in z.flattenError; return issue paths for nested bodies (split lines).
-- P2b: FK indexes on transaction.category_id/payee_id; `.$type<AccountClass>()` on account.accountClass and the view
-  class columns.
-- P2b: todayIn should use formatToParts instead of the en-CA format.
-- P2b: ledger view test gaps (deleted split parent with live lines; amount ≠ amount_base).
-- P2b: amend spec §4 "unless noted" for tables without timestamps.
+- P2c: enforce date ≤ today on transaction writes (§5.6); the view does not filter future dates. (Starting balances
+  already enforce it.)
+- P2c: nested validation errors lose paths in z.flattenError; return issue paths for nested bodies (split lines).
 - P2c: shutdown hardening (SIGTERM during migrations, close timeout, exit code on db close failure, `init: true` in
   compose).
-- P2c: keep a registry of advisory-lock keys (login uses 727274001).
 - P3: TOTP replay protection (store the last used timeStep).
 - P3: /status should refresh the cookie; clear stale cookie on 401; Retry-After on 429; friendly .max messages.
 - P3: global lockout DoS — amend spec (device cookies, count failures since last success/lockout) before internet
@@ -69,3 +50,36 @@ These items were found in the P1 final review and deferred. Fold them into the P
 - P3: rate-limit setup-token attempts.
 - P3: CSP img-src blocks data: QR → render SVG; web tsconfig DOM lib; SPA fallback for non-/api paths; document single
   trusted proxy.
+
+## Resolved in P2b1
+- Every router outside /api/auth is mounted on its own prefix behind `.use('*', requireSession)`; `app.test.ts`
+  walks `app.routes` and expects 401 for each one.
+- Migration 0002: `payee_name_live` skips transfer/system payees; partial unique indexes on `payee.system_kind`, live
+  `category.linked_account_id` and non-normal `category_group.kind`; `category_group.deleted_at`; FK indexes on
+  `transaction.category_id`/`payee_id` and `subtransaction.category_id`; timestamps are `timestamptz(3)`; no FK has an
+  ON DELETE action any more; the three system payees are inserted (idempotent). `.$type<AccountClass>()` on
+  `account.accountClass` and the view's class columns.
+- Undo conflict checks ignore `created_at`/`updated_at`.
+- `todayIn` builds the date from `formatToParts`; ledger view tests cover a deleted split parent and amount ≠
+  amount_base; spec §4 lists the tables without UUIDs or timestamps.
+- Assignments are capped to [budget start, current month + 24] server-side.
+- Advisory-lock keys are listed in `engineering-notes.md` (727274001 login, 727274002 commands and undo/redo).
+- Credit card payment (and paired loan) categories can't be deleted on their own, so `computeBudget` never sees card
+  lines without a payment category.
+
+## From P2b1
+- P2b2: hide a credit card payment category automatically when its account is closed with Available = 0 (spec §10);
+  it needs the budget read model. Closing currently only sets `account.closed`.
+- P2b2: a paired loan category's `debt/min_payment` target reads `account.min_payment`, which PATCH can clear (null);
+  the month view must treat null as 0.
+- P2b2: reuse `budgetStartMonth()` and `MONTHS_AHEAD` from `src/server/budget/assignments.ts` for the month view and
+  auto-assign, and `setAssigned`/`addAssigned` for auto-assign writes.
+- P2c: deleting an account is refused while soft-deleted transactions still reference it; decide whether account
+  deletion should purge soft-deleted history.
+- P2c: undo/redo replays row by row (two queries per changed row); bulk operations over thousands of rows may need
+  batching.
+- P2d: foreign keys have no ON DELETE actions. Deleting a scheduled transaction must delete its
+  `scheduled_subtransaction` rows and clear `transaction.scheduled_id` through the ChangeRecorder.
+- P2d: the scheduled-transaction job writes outside `runCommand` (no undo entry, redo kept) but should hold
+  `lockCommands()` (advisory key 727274002) so it can't interleave with an undo replay.
+- P2d: `fxRate` is required to create a foreign-currency account; make it optional once the NBP lookup exists.
diff --git a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
index 1ed3fce..841fe7f 100644
--- a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
+++ b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
@@ -405,10 +405,12 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
 
 **Categories**
 - Create, rename, reorder (drag), hide, and move between groups.
-- **Delete** requires choosing a destination category. Transactions, lines, schedules and assignments move there
-  (assignments summed per month), then the category is soft-deleted together with its target.
-- A group can be deleted only when empty.
-- Credit card payment categories can't be deleted while their account is open; they are hidden automatically when the
+- **Delete** requires choosing a destination category (a live, normal one). Transactions, lines, schedules, payees'
+  last-used category and assignments move there (assignments summed per month), then the category is soft-deleted
+  together with its target.
+- A group can be deleted only when it has no live categories; groups are soft-deleted.
+- Credit card payment and paired loan categories follow their account: they can't be renamed, moved or deleted on
+  their own (deleting the account removes them). Credit card payment categories are hidden automatically when the
   account is closed with Available = 0.
 
 **Accounts**
PATCH
```

- [ ] **Step 7: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/categories/category-routes.test.ts`
Expected: `Tests  9 passed (9)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  36 passed (36)`, `Tests  347 passed (347)`; both checks exit 0.
Run: `npm run db:generate -- --name check && npm run build`
Expected: `No schema changes, nothing to migrate 😴`, then esbuild's `Done`.

- [ ] **Step 8: Commit**

```bash
git add src/shared/api/categories.ts src/server/categories docs
git commit -m "feat(server): delete a category into another; P2b1 docs" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Spec coverage (P2b1)

| Spec | Task |
|---|---|
| §2 write path: one transaction per command, `ChangeRecorder`, `undo_entry`; mutations return affected ids/DTOs | 2, 4–8 |
| §3 account classes; type changes only within the class | 4, 5 |
| §3 system categories take no assignments; moving money to/from Ready to Assign | 7 |
| §4 tables without UUIDs/timestamps (spec amended); ms timestamps; no `ON DELETE` actions | 1 |
| §4.2 account columns incl. loan and credit fields | 4, 5 |
| §4.3 groups (incl. `deleted_at`), categories, assignments (sparse), month notes | 1, 6, 7, 8 |
| §4.4 one transfer payee per account; system payees; payee name uniqueness | 1, 4, 5 |
| §4.5 `undo_entry` (`pk` objects; spec amended) | 2, 3 |
| §4.6 ledger view (recreated unchanged; P2a test gaps) | 1 |
| §5.1 budget start month (lower bound of the assignment months) | 7 |
| §5.6 date ≤ today on write (starting balance) | 4 |
| §9 foreign starting balance: `amount_base = convertToBase(amount, rate)`, manual rate | 4 |
| §10 Starting balance | 4 |
| §10 Accounts: create, edit (name, note, type, loan fields), close at zero, reopen, delete, reorder | 4, 5 |
| §10 Categories: create, rename, reorder, hide, move, delete with destination, delete empty groups | 6, 8 |
| §10 Undo/redo: before/after images, reverse/forward replay, conflict check, redo cleared, 100 kept, auth not undoable | 2, 3 |
| §11 Header Undo/Redo, account order, 24 months ahead | 3, 5, 7 |
| §12 every `/api` route except auth requires a session | 3 |
| §13 400 / 404 / 409 / 422 errors; one transaction per command; categories soft-deleted | all |
| §14 Server: happy path and domain errors per handler; undo → redo round trips (incl. bulk and category delete) | 2–8 |
| P2 carry-over: deny-by-default + route walk; `::bigint`; cascades; timestamps in conflict checks; payee/category/group indexes; system payees; group soft delete; FK indexes; `$type<AccountClass>`; `todayIn`; ledger view test gaps; spec §4 "unless noted"; 24-month cap; payment-category deletion | 1, 2, 3, 4, 7, 8 |

Deferred:
- P2b2: the budget month read API, targets CRUD, auto-assign, and hiding a credit card payment category automatically when its account is closed with Available = 0.
- P2c: payees, transactions, splits, transfers and the register.
- P2d: scheduled transactions, reconciliation, NBP rates, loans and export.
- P3: the web app.

The new deferrals are listed in `p2-carry-over.md` under "From P2b1".

## Decisions

Choices made where the spec is silent, ambiguous or in conflict with the brief:

1. **Undo conflict status.** §13 lists "undo conflict" among the 422 domain errors; P2b1 uses **409 `undo_conflict`** ("Can't undo: data changed since." / "Can't redo: data changed since.") and amends §13. An empty stack is 409 `nothing_to_undo` / `nothing_to_redo`.
2. **Undo/redo responses.** `GET /api/undo` → `{ undo, redo }`, each `{ label } | null`. `POST /api/undo` adds `undone: { label }` and `POST /api/redo` adds `redone: { label }`. Undo takes the newest `done` entry; redo takes the oldest `undone` entry (the most recently undone one).
3. **Change format.** `undo_entry.changes` holds `[{ table, pk, before, after }]`; `pk` is an object because `assignment` and `loan_interest_override` have composite keys (§4.5 said `id`; amended). Images are keyed by Drizzle property name and leave out generated columns.
4. **Exact timestamps.** Every timestamp column becomes `timestamptz(3)` so that a JS `Date` round-trips exactly; µs values would be truncated on undo. This changes every table, and the migration drops and recreates `v_ledger_line` around the type change.
5. **No-op commands.** `rec.update` skips rows whose values don't change (`IS DISTINCT FROM`). A command that changes nothing leaves no entry and does **not** clear redo.
6. **Serialization.** Commands and undo/redo take `pg_advisory_xact_lock(727274002)`, so replays can't interleave with commands and name checks can't race.
7. **Cascades removed** rather than worked around: `scheduled_subtransaction.scheduled_id` (`CASCADE`) and `transaction.scheduled_id` (`SET NULL`) now have no `ON DELETE` action, so a write that would bypass the recorder fails loudly. P2d must delete schedule lines and clear `scheduled_id` explicitly.
8. **System payees** come from the migration (`INSERT … ON CONFLICT DO NOTHING`). That works for existing and fresh databases and runs before setup; `seedBudget` is unchanged.
9. **Labels** are English and name the row: `Create account "mBank"`, `Edit account "…"`, `Close account "…"`, `Reopen account "…"`, `Delete account "…"`, `Reorder accounts`, `Create group "…"`, `Edit group "…"`, `Delete group "…"`, `Reorder groups`, `Create category "…"`, `Edit category "…"`, `Delete category "…"`, `Reorder categories`, `Assign money to "…"`, `Move money`, `Edit the note for YYYY-MM`.
10. **Status codes and shapes.** Create → 201 + DTO; edit/close/reopen → 200 + DTO; delete → 200 `{ id }`; reorder → 200 `{ ids }`. A reorder must list every row in its scope exactly once (422 `order_mismatch`): all accounts, every live group except Internal, or every live category of one group.
11. **404 vs 422.** An unknown or deleted resource in the URL is 404. In bodies, an unsuitable or unknown group is 422 `invalid_group` and an unsuitable or unknown delete destination is 422 `invalid_destination`; unknown categories in move-money bodies reuse the URL rule (404) through `assignableCategory`.
12. **Account names are unique**, ignoring case (422 `account_name_taken`). This keeps "Transfer : <name>" payees and linked category names unambiguous. The check runs inside the command lock, with no DB index.
13. **Create validation.** Type/field rules, the currency format and the `fxRate` requirement are zod refinements → 400 with field errors. `interestRate` and `minPayment` are allowed for loans and credit accounts, `escrowAmount` and `createPairedCategory` for loans only, and `createPairedCategory` requires `minPayment`. An `fxRate` on a PLN account is refused. The currency must be 3 capital letters known to `Intl.supportedValuesOf('currency')`.
14. **Edit validation needs the stored type**, so the PATCH field rules are 422 `account_field_not_allowed`.
15. **Type changes** stay within the class, and loan types change only to loan types (`account_type_change`). That is stricter than §3, but it keeps escrow, interest and the paired category meaningful.
16. **Renames:** a renamed account also renames its paired loan category; §10 mentions only the credit card payment category. Linked categories can't be renamed or moved themselves (`linked_category`).
17. **Starting balance** is always created, even at 0. A future starting date is 422 `starting_date_in_future`. Foreign rates are stored with `fx_rate_manual = true`.
18. **Balances:** cleared = cleared + reconciled; base balances are Σ booked `amount_base`. The "≈ X zł at the latest NBP rate" display comes with NBP in P2d.
19. **Close** looks at the native working balance; closing or reopening twice is a no-op.
20. **Account delete** is refused (`account_in_use`) if anything else refers to the account or its linked category. That includes soft-deleted transactions, which still hold the foreign key. P2c may decide to purge them.
21. **The paired loan target** is `kind 'debt', cadence 'monthly', debtMode 'min_payment', amount 0, startMonth = current month`; the engine ignores the cadence of debt targets.
22. **Category kinds.** Both DTOs carry a `kind`: groups `normal | cc_payments | debt_payments | internal`, categories `normal | rta | uncategorized | cc_payment | debt_payment`. The list includes the Internal group so the client sees system rows explicitly.
23. **Group rules.** Credit Card Payments and Debt Payments can be hidden and reordered but not renamed or deleted (`system_group`); Internal accepts no change. A moved category is appended to its new group.
24. **Category delete** re-points soft-deleted transactions too. The destination must be live, normal and different (`invalid_destination`). System categories (`system_category`) and linked categories (`linked_category`) can't be deleted.
25. **Assignment range:** from min(`budget_start_month`, month of the earliest live transaction) per §5.1 to the current month + 24 (422 `month_out_of_range`). Negative amounts are allowed (§5.2 mentions negative assignments), and so are hidden, credit card payment and paired categories. Overflow beyond 2^53 is 422 `amount_too_large`.
26. **Move money** doesn't check Available, so a source can go negative, as in YNAB. `from = to` is a 400, and so is `null → null`.
27. **Text fields:** names are trimmed and 1–100 characters; notes are trimmed and up to 2000 characters, and an empty note is stored as null (or deletes the month note).
28. **Command label typing:** a label function must annotate its parameter (`(r: Named) => …`); TypeScript can't infer it from `fn` because both arguments are context-sensitive.
