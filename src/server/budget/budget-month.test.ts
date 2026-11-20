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
