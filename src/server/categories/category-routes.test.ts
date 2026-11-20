import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CategoryDto, CategoryListResponse } from '../../shared/api/categories';
import { systemCategoryId, systemGroupId } from '../db/lookups';
import {
  assignment,
  category,
  payee,
  scheduledSubtransaction,
  scheduledTransaction,
  subtransaction,
  target,
  transaction,
} from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup } from '../test/fixtures';
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

describe('DELETE /api/categories/:id', () => {
  const remove = (id: string, destinationCategoryId: string) =>
    ctx.client.send('DELETE', `/api/categories/${id}?destinationCategoryId=${destinationCategoryId}`);

  it('moves everything to the destination, sums assignments per month, and is one undoable command', async () => {
    const food = await createGroup(ctx.client, 'Food');
    const groceries = await createCategory(ctx.client, food.id, 'Groceries');
    const dining = await createCategory(ctx.client, food.id, 'Dining out');
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const assign = (categoryId: string, month: string, amount: number) =>
      ctx.client.send('PUT', `/api/budget/${month}/assignments/${categoryId}`, { amount });
    await assign(groceries.id, '2026-11', 5_000);
    await assign(groceries.id, '2026-12', 3_000);
    await assign(dining.id, '2026-11', 2_000);
    await assign(dining.id, '2026-12', -3_000);
    await t.db.insert(target).values({
      categoryId: groceries.id,
      kind: 'spending',
      cadence: 'monthly',
      amount: 50_000,
      startMonth: '2026-11-01',
    });
    const line = { accountId: checking.id, date: '2026-11-20', amount: -100, amountBase: -100 };
    const [txn, deletedTxn, split] = await t.db
      .insert(transaction)
      .values([
        { ...line, categoryId: groceries.id },
        { ...line, categoryId: groceries.id, deletedAt: new Date() },
        { ...line, isSplit: true },
      ])
      .returning();
    const [splitLine] = await t.db
      .insert(subtransaction)
      .values({ txnId: split!.id, amount: -100, amountBase: -100, categoryId: groceries.id })
      .returning();
    const [schedule] = await t.db
      .insert(scheduledTransaction)
      .values({
        accountId: checking.id,
        categoryId: groceries.id,
        amount: -100,
        frequency: 'monthly',
        anchorDate: '2026-12-01',
        nextDate: '2026-12-01',
      })
      .returning();
    const [scheduleLine] = await t.db
      .insert(scheduledSubtransaction)
      .values({ scheduledId: schedule!.id, amount: -100, categoryId: groceries.id })
      .returning();
    const [shop] = await t.db.insert(payee).values({ name: 'Biedronka', lastCategoryId: groceries.id }).returning();
    const before = await snapshot(t.db);

    expect(await json(await remove(groceries.id, dining.id))).toEqual({ status: 200, body: { id: groceries.id } });

    const categoryOf = async (table: typeof transaction | typeof subtransaction, id: string) =>
      (await t.db.select({ categoryId: table.categoryId }).from(table).where(eq(table.id, id)))[0]!.categoryId;
    for (const id of [txn!.id, deletedTxn!.id]) expect(await categoryOf(transaction, id)).toBe(dining.id);
    expect(await categoryOf(subtransaction, splitLine!.id)).toBe(dining.id);
    const schedules = await t.db.select({ categoryId: scheduledTransaction.categoryId }).from(scheduledTransaction);
    const scheduleLines = await t.db
      .select({ categoryId: scheduledSubtransaction.categoryId })
      .from(scheduledSubtransaction)
      .where(eq(scheduledSubtransaction.id, scheduleLine!.id));
    expect([...schedules, ...scheduleLines]).toEqual([{ categoryId: dining.id }, { categoryId: dining.id }]);
    expect((await t.db.select().from(payee).where(eq(payee.id, shop!.id)))[0]!.lastCategoryId).toBe(dining.id);
    // 2026-12: 3 000 + (−3 000) = 0, so the row is gone (assignments are sparse).
    expect(await t.db.select().from(assignment)).toEqual([
      { categoryId: dining.id, month: '2026-11-01', amount: 7_000 },
    ]);
    expect(await t.db.select().from(target)).toEqual([]);
    const [deleted] = await t.db.select().from(category).where(eq(category.id, groceries.id));
    expect(deleted!.deletedAt).toEqual(ctx.clock.now());
    expect((await list()).flatMap((g) => g.categories.map((c) => c.name))).not.toContain('Groceries');
    const after = await snapshot(t.db);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Delete category "Groceries"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('refuses system and account-linked categories, and destinations that are not live normal categories', async () => {
    const food = await createGroup(ctx.client, 'Food');
    const groceries = await createCategory(ctx.client, food.id, 'Groceries');
    const gone = await createCategory(ctx.client, food.id, 'Gone');
    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, gone.id));
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const rta = await systemCategoryId(t.db, 'rta');

    expect((await json(await remove(rta, groceries.id))).body).toMatchObject({ code: 'system_category' });
    expect(await json(await remove(card.paymentCategoryId!, groceries.id))).toEqual({
      status: 422,
      body: { code: 'linked_category', message: "This category belongs to an account and can't be deleted." },
    });
    const invalid = {
      status: 422,
      body: {
        code: 'invalid_destination',
        message: 'Choose another regular category to receive the money and transactions.',
      },
    };
    for (const destination of [groceries.id, card.paymentCategoryId!, rta, gone.id, crypto.randomUUID()]) {
      expect(await json(await remove(groceries.id, destination))).toEqual(invalid);
    }
    expect((await remove(gone.id, groceries.id)).status).toBe(404);
    const missing = await json(await ctx.client.send('DELETE', `/api/categories/${groceries.id}`));
    expect(missing).toMatchObject({ status: 400, body: { fieldErrors: { destinationCategoryId: expect.any(Array) } } });
    expect((await remove(groceries.id, 'not-an-id')).status).toBe(400);
  });
});
