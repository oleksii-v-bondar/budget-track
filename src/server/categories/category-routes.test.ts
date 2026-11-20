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
