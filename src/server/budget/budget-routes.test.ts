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
