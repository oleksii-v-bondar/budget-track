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
            missing: { minPayment: false, interestRate: false, rate: false },
          },
        ],
        [
          mortgage.pairedCategoryId!,
          {
            accountId: mortgage.id,
            // The November payment is charged interest (6 % / 12 of 100 000 zł = 500 zł) and escrow (200 zł).
            balanceAtMonthEnd: -10_010_000,
            debt: { minPayment: 60_000, apr: '6.0000', balanceAtMonthStart: -10_000_000, escrow: 20_000 },
            missing: { minPayment: false, interestRate: false, rate: false },
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
