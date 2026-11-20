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
