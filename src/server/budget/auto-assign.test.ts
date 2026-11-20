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
    await assign('2026-11', groceries.id, 30_000);
    // The budget starts in 2026-10, so the average covers October (20 zł) and November (30 zł).
    expect((await json(await autoAssign('2026-12', 'average_assigned', { type: 'category', id: groceries.id }))).body)
      .toEqual({ assignments: [{ month: '2026-12', categoryId: groceries.id, amount: 25_000 }] });
    expect((await json(await autoAssign('2026-11', 'reset_assigned'))).body).toEqual({
      assignments: [
        { month: '2026-11', categoryId: visa.paymentCategoryId, amount: 0 },
        { month: '2026-11', categoryId: groceries.id, amount: 0 },
      ],
    });
    expect((await undoState()).undo).toEqual({ label: 'Auto-assign: Reset assigned' });
  });

  it('average spent: assigns what was spent on average in earlier months', async () => {
    const spend = (date: string, amount: number) =>
      insertTransaction(t.db, { accountId: checking.id, date, amount: -amount, categoryId: groceries.id });
    await spend('2026-10-12', 3_000);
    await spend('2026-11-12', 6_000);
    // October and November, not just November's 60 zł.
    expect((await json(await autoAssign('2026-12', 'average_spent', { type: 'category', id: groceries.id }))).body)
      .toEqual({ assignments: [{ month: '2026-12', categoryId: groceries.id, amount: 4_500 }] });
    expect((await undoState()).undo).toEqual({ label: 'Auto-assign: Average spent' });
  });

  it('underfunded skips snoozed targets', async () => {
    await ctx.client.post(`/api/categories/${groceries.id}/target/snooze`, { month: '2026-11' });
    // Groceries gets nothing although 25 zł is left to assign.
    expect((await json(await autoAssign('2026-11', 'underfunded'))).body).toEqual({
      assignments: [
        { month: '2026-11', categoryId: visa.paymentCategoryId, amount: 5_000 },
        { month: '2026-11', categoryId: rent.id, amount: 70_000 },
      ],
    });
  });

  it('handles targets whose underfunded amount is beyond the safe-integer range', async () => {
    // 5 Mondays in November 2026: 1e16 underfunded, more than Number.MAX_SAFE_INTEGER.
    const weekly = { kind: 'spending', cadence: 'weekly', amount: 2e15, dueWeekday: 1 };
    expect((await ctx.client.send('PUT', `/api/categories/${groceries.id}/target`, weekly)).status).toBe(200);
    await assign('2026-11', groceries.id, 1_000);
    expect(await json(await autoAssign('2026-11', 'reset_assigned'))).toEqual({
      status: 200,
      body: { assignments: [{ month: '2026-11', categoryId: groceries.id, amount: 0 }] },
    });
    // Capped at Ready to Assign: Groceries gets the 95 zł left after Visa.
    expect(await json(await autoAssign('2026-11', 'underfunded'))).toEqual({
      status: 200,
      body: {
        assignments: [
          { month: '2026-11', categoryId: visa.paymentCategoryId, amount: 5_000 },
          { month: '2026-11', categoryId: groceries.id, amount: 95_000 },
        ],
      },
    });
    expect((await json<BudgetMonthDto>(await ctx.client.get('/api/budget/2026-11'))).body.rta.readyToAssign).toBe(0);
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
      fieldErrors: { 'scope.id': [expect.any(String)] },
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
