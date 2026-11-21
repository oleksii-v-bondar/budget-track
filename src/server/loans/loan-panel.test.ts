import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import type { AutoAssignResponse, BudgetCategoryDto, BudgetMonthDto } from '../../shared/api/budget';
import { loadLinkedAccounts } from '../targets/target-model';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction } from '../test/fixtures';
import { stubFx } from '../test/fx';

let t: TestDatabase;
let ctx: TestApp;
let nbp: Record<string, string>;
let checking: AccountDto;
let savings: AccountDto;
beforeEach(async () => {
  t = await createTestDatabase();
  nbp = { CHF: '4.5' };
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z', fx: stubFx(nbp) });
  await setUpBudget(ctx);
  checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 1_000_000 });
  savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings', startingBalance: 1_000_000 });
});
afterEach(async () => {
  await t.drop();
});

async function json<T>(res: Response) {
  return (await res.json()) as T;
}

const categoryRow = async (id: string) => {
  const month = await json<BudgetMonthDto>(await ctx.client.get('/api/budget/2026-11'));
  return month.groups.flatMap((g) => g.categories).find((c) => c.id === id)!;
};
const setTarget = (categoryId: string, body: object) =>
  ctx.client.send('PUT', `/api/categories/${categoryId}/target`, { kind: 'debt', startMonth: '2026-11', ...body });

/** 100 000 zł at 6 % APR from 1 October, with a minimum payment of 1 000 zł. */
const mortgage = () =>
  createAccount(ctx.client, {
    name: 'Mortgage',
    type: 'mortgage',
    startingBalance: -10_000_000,
    startingDate: '2026-10-01',
    interestRate: '6',
    minPayment: 100_000,
    createPairedCategory: true,
  });

describe('the loan panel of a paired category', () => {
  it('shows balance, APR, payments, the projected payoff and a Record-payment prefill', async () => {
    const loan = await mortgage();
    // 139 payments of 1 000 zł from November 2026 pay off 100 000 zł at 0.5 % a month.
    expect((await categoryRow(loan.pairedCategoryId!)).loan).toEqual<BudgetCategoryDto['loan']>({
      accountId: loan.id,
      accountName: 'Mortgage',
      currency: 'PLN',
      balance: -10_000_000,
      balanceBase: -10_000_000,
      interestRate: '6.0000',
      minPayment: 100_000,
      escrowAmount: null,
      projectedPayoff: '2038-05',
      // No payment yet: the first open cash account pays the month's target need.
      recordPayment: {
        accountId: checking.id,
        payeeId: loan.transferPayeeId,
        categoryId: loan.pairedCategoryId!,
        amount: -100_000,
      },
    });

    await createTransaction(ctx.client, {
      accountId: savings.id,
      date: '2026-11-05',
      payeeId: loan.transferPayeeId,
      categoryId: loan.pairedCategoryId,
      amount: -100_000,
    });
    // Paid this month (with 500 zł interest): 138 more payments from December.
    expect((await categoryRow(loan.pairedCategoryId!)).loan).toMatchObject({
      balance: -9_950_000,
      projectedPayoff: '2038-05',
      recordPayment: { accountId: savings.id, amount: -100_000 },
    });
    // A closed account is no longer suggested.
    await createTransaction(ctx.client, { accountId: savings.id, amount: -900_000 });
    await ctx.client.post(`/api/accounts/${savings.id}/close`);
    expect((await categoryRow(loan.pairedCategoryId!)).loan!.recordPayment.accountId).toBe(checking.id);
  });

  it("projects from this month after a reconciliation adjustment, which isn't a payment", async () => {
    const loan = await mortgage();
    const reconciled = await ctx.client.post(`/api/accounts/${loan.id}/reconcile`, {
      statementBalance: -9_990_000,
      createAdjustment: true,
    });
    expect(reconciled.status).toBe(200);
    // No interest was charged, so 99 900 zł is paid off from November (from December it would end in 2038-06).
    expect((await categoryRow(loan.pairedCategoryId!)).loan).toMatchObject({
      balance: -9_990_000,
      projectedPayoff: '2038-05',
    });
  });

  it("projects with a fixed target's amount, and never pays off when it doesn't beat the interest", async () => {
    const loan = await mortgage();
    expect((await setTarget(loan.pairedCategoryId!, { debtMode: 'fixed', amount: 40_000 })).status).toBe(200);
    expect((await categoryRow(loan.pairedCategoryId!)).loan).toMatchObject({
      projectedPayoff: 'never',
      recordPayment: { amount: -40_000 },
    });
  });
});

describe('debt targets of foreign-currency loans', () => {
  it('convert the minimum payment and escrow at the latest NBP rate, or flag the target incomplete', async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Franc mortgage',
      type: 'mortgage',
      currency: 'CHF',
      startingBalance: -1_000_000,
      startingDate: '2026-10-01',
      fxRate: '4',
      interestRate: '6',
      minPayment: 100_000,
      escrowAmount: 10_000,
      createPairedCategory: true,
    });
    // 1 000 CHF at 4.50.
    expect((await categoryRow(loan.pairedCategoryId!)).targetEvaluation).toMatchObject({
      need: 450_000,
      incomplete: false,
    });
    const rates = new Map([['CHF', { rate: '4.500000', effectiveDate: '2026-11-20' }]]);
    const linked = (await loadLinkedAccounts(t.db, '2026-11', '2026-11-20', rates)).get(loan.pairedCategoryId!);
    expect(linked).toMatchObject({ debt: { minPayment: 450_000, escrow: 45_000 }, missing: { rate: false } });
    const assigned = await json<AutoAssignResponse>(
      await ctx.client.post('/api/budget/2026-11/auto-assign', {
        strategy: 'underfunded',
        scope: { type: 'category', id: loan.pairedCategoryId },
      }),
    );
    expect(assigned.assignments).toEqual([{ month: '2026-11', categoryId: loan.pairedCategoryId, amount: 450_000 }]);

    delete nbp.CHF;
    expect((await categoryRow(loan.pairedCategoryId!)).targetEvaluation).toMatchObject({
      need: 0,
      incomplete: true,
    });
  });
});
