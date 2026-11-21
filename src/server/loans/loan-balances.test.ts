import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto, AccountListResponse, ReconcileResponse } from '../../shared/api/accounts';
import type { RegisterResponse } from '../../shared/api/transactions';
import { loanInterestOverride } from '../db/schema';
import { loadLinkedAccounts } from '../targets/target-model';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction } from '../test/fixtures';
import { loanBalances, loanCharges } from './loan-balances';

let t: TestDatabase;
let ctx: TestApp;
let checking: AccountDto;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
  checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 1_000_000 });
});
afterEach(async () => {
  await t.drop();
});

async function json<T>(res: Response) {
  return (await res.json()) as T;
}

/** 100 000 zł at 6 % APR from 1 October, with escrow 200 zł; paid 1 000 zł on 5 November unless `paid` is false. */
async function mortgage(extra: object = {}, paid = true) {
  const loan = await createAccount(ctx.client, {
    name: 'Mortgage',
    type: 'mortgage',
    startingBalance: -10_000_000,
    startingDate: '2026-10-01',
    interestRate: '6',
    minPayment: 100_000,
    escrowAmount: 20_000,
    createPairedCategory: true,
    ...extra,
  });
  if (paid) await pay(loan);
  return loan;
}

/** Pays 1 000 zł from mBank into `loan` on 5 November; returns the id of the loan's side, which is uncleared. */
async function pay(loan: AccountDto): Promise<string> {
  const sent = await createTransaction(ctx.client, {
    accountId: checking.id,
    date: '2026-11-05',
    payeeId: loan.transferPayeeId,
    categoryId: loan.pairedCategoryId,
    amount: -100_000,
  });
  return sent.transfer!.transactionId;
}

const clear = (transactionId: string) =>
  ctx.client.send('PATCH', `/api/transactions/${transactionId}`, { cleared: 'cleared' });

const accountNamed = async (name: string) =>
  (await json<AccountListResponse>(await ctx.client.get('/api/accounts'))).accounts.find((a) => a.name === name)!;

describe('loanBalances', () => {
  it('charges interest and escrow in months with a payment, in the balances and the register header', async () => {
    const loan = await mortgage();
    const { months } = (await loanBalances(t.db, [loan.id, checking.id])).get(loan.id)!;
    expect(months).toEqual([
      {
        month: '2026-10',
        startBalance: 0,
        transactionsTotal: -10_000_000,
        interest: 0,
        escrow: 0,
        endBalance: -10_000_000,
        principalPaid: 0,
        chargedOn: null,
        interestOverridden: false,
        interestBase: 0,
        escrowBase: 0,
      },
      {
        month: '2026-11',
        startBalance: -10_000_000,
        transactionsTotal: 100_000,
        interest: 50_000,
        escrow: 20_000,
        endBalance: -9_970_000,
        principalPaid: 30_000,
        chargedOn: '2026-11-05',
        interestOverridden: false,
        interestBase: 50_000,
        escrowBase: 20_000,
      },
    ]);

    // The payment is still uncleared, and so are its month's interest and escrow.
    const balance = { cleared: -10_000_000, uncleared: 30_000, working: -9_970_000 };
    expect(await accountNamed('Mortgage')).toMatchObject({ balance, balanceBase: balance });
    const register = await json<RegisterResponse>(await ctx.client.get(`/api/transactions?accountId=${loan.id}`));
    expect(register.balances).toEqual({ balance, balanceBase: balance });
    // Cash accounts are untouched.
    expect((await accountNamed('mBank')).balance.working).toBe(900_000);
  });

  it("leaves the register header's cleared balance alone when an uncleared payment is entered", async () => {
    const loan = await mortgage({}, false);
    const header = async () =>
      (await json<RegisterResponse>(await ctx.client.get(`/api/transactions?accountId=${loan.id}`))).balances!.balance;
    expect(await header()).toEqual({ cleared: -10_000_000, uncleared: 0, working: -10_000_000 });

    await pay(loan);
    expect(await header()).toEqual({ cleared: -10_000_000, uncleared: 30_000, working: -9_970_000 });
  });

  it('reconciles against a statement without an uncleared payment, and with it once it is cleared', async () => {
    const loan = await mortgage({}, false);
    const payment = await pay(loan);
    const reconcile = async (statementBalance: number) => {
      const res = await ctx.client.post(`/api/accounts/${loan.id}/reconcile`, { statementBalance });
      expect(res.status).toBe(200);
      return json<ReconcileResponse>(res);
    };
    // The statement has neither the 1 000 zł payment nor November's 500 zł interest and 200 zł escrow.
    expect(await reconcile(-10_000_000)).toMatchObject({ clearedBalance: -10_000_000, adjustment: null });

    expect((await clear(payment)).status).toBe(200);
    const balance = { cleared: -9_970_000, uncleared: 0, working: -9_970_000 };
    expect(await accountNamed('Mortgage')).toMatchObject({ balance, balanceBase: balance });
    expect(await reconcile(-9_970_000)).toMatchObject({ clearedBalance: -9_970_000, adjustment: null });
  });

  it("clears a month's interest and escrow with its first cleared payment", async () => {
    const loan = await mortgage({}, false);
    const payments = [await pay(loan), await pay(loan)];
    await clear(payments[0]!);
    // November's 700 zł of interest and escrow are cleared with the first payment; the other one is still uncleared.
    expect((await accountNamed('Mortgage')).balance).toEqual({
      cleared: -9_970_000,
      uncleared: 100_000,
      working: -9_870_000,
    });

    await clear(payments[1]!);
    expect((await accountNamed('Mortgage')).balance).toEqual({
      cleared: -9_870_000,
      uncleared: 0,
      working: -9_870_000,
    });
  });

  it("still matches the statement after another, uncleared payment in a month whose first one is cleared", async () => {
    const loan = await mortgage({}, false);
    await clear(await pay(loan));
    const reconcile = async () => {
      const res = await ctx.client.post(`/api/accounts/${loan.id}/reconcile`, { statementBalance: -9_970_000 });
      expect(res.status).toBe(200);
      return json<ReconcileResponse>(res);
    };
    expect(await reconcile()).toMatchObject({ clearedBalance: -9_970_000, adjustment: null });

    await pay(loan);
    expect(await reconcile()).toMatchObject({ clearedBalance: -9_970_000, adjustment: null });
    expect((await accountNamed('Mortgage')).balance).toEqual({
      cleared: -9_970_000,
      uncleared: 100_000,
      working: -9_870_000,
    });
  });

  it('feeds debt targets the balance with its charges', async () => {
    const loan = await mortgage();
    const linked = async (month: string) =>
      (await loadLinkedAccounts(t.db, month, '2026-11-20')).get(loan.pairedCategoryId!)!;
    expect(await linked('2026-11')).toMatchObject({
      balanceAtMonthEnd: -9_970_000,
      debt: { balanceAtMonthStart: -10_000_000 },
    });
    expect((await linked('2026-12')).debt.balanceAtMonthStart).toBe(-9_970_000);
  });

  it('uses an interest override for its month, and no interest without an APR', async () => {
    const loan = await mortgage({ interestRate: undefined, escrowAmount: undefined });
    expect((await loanBalances(t.db, [loan.id])).get(loan.id)!.months[1]).toMatchObject({ interest: 0, escrow: 0 });

    await t.db.insert(loanInterestOverride).values({ accountId: loan.id, month: '2026-11-01', amount: 40_000 });
    const loans = await loanBalances(t.db, [loan.id]);
    expect(loans.get(loan.id)!.months[1]).toMatchObject({
      interest: 40_000,
      interestOverridden: true,
      principalPaid: 60_000,
      endBalance: -9_940_000,
    });
    expect(loanCharges(loans.get(loan.id))).toEqual({
      amount: -40_000,
      amountBase: -40_000,
      cleared: { amount: 0, amountBase: 0 },
      uncleared: { amount: -40_000, amountBase: -40_000 },
    });
    expect(loanCharges(loans.get(loan.id), '2026-11')).toMatchObject({ amount: 0, amountBase: 0 });
  });

  it('reports an override as unused in a month without a payment', async () => {
    const loan = await mortgage();
    await t.db.insert(loanInterestOverride).values({ accountId: loan.id, month: '2026-10-01', amount: 40_000 });
    expect((await loanBalances(t.db, [loan.id])).get(loan.id)!.months[0]).toMatchObject({
      month: '2026-10',
      interest: 0,
      interestOverridden: false,
    });
  });

  it("books a foreign loan's charges in PLN at the rate of the month's payments", async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Franc mortgage',
      type: 'mortgage',
      currency: 'CHF',
      startingBalance: -1_000_000,
      startingDate: '2026-10-01',
      fxRate: '4',
      interestRate: '12',
      minPayment: 100_000,
      createPairedCategory: true,
    });
    await createTransaction(ctx.client, {
      accountId: checking.id,
      date: '2026-11-05',
      payeeId: loan.transferPayeeId,
      categoryId: loan.pairedCategoryId,
      amount: -430_000,
      transferAmount: 100_000,
    });
    // Interest: 1 % of 10 000 CHF = 100 CHF, booked at the payment's 4.30.
    expect(await accountNamed('Franc mortgage')).toMatchObject({
      balance: { working: -910_000 },
      balanceBase: { working: -4_000_000 + 430_000 - 43_000 },
    });
  });

  it("doesn't take a reconciliation adjustment for a payment, so it charges no interest or escrow", async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      startingBalance: -10_000_000,
      startingDate: '2026-10-01',
      interestRate: '6',
      escrowAmount: 20_000,
    });
    // Nothing was paid in November, but the statement says 100 zł less is owed.
    const res = await ctx.client.post(`/api/accounts/${loan.id}/reconcile`, {
      statementBalance: -9_990_000,
      createAdjustment: true,
    });
    expect(await json<ReconcileResponse>(res)).toMatchObject({
      clearedBalance: -9_990_000,
      adjustment: { amount: 10_000 },
    });
    expect((await accountNamed('Mortgage')).balance).toEqual({
      cleared: -9_990_000,
      uncleared: 0,
      working: -9_990_000,
    });
    expect((await loanBalances(t.db, [loan.id])).get(loan.id)!.months[1]).toMatchObject({
      transactionsTotal: 10_000,
      interest: 0,
      escrow: 0,
      chargedOn: null,
    });
  });

  it('keeps a loan open until its interest is paid too', async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Car loan',
      type: 'auto_loan',
      startingBalance: -100_000,
      startingDate: '2026-10-01',
      interestRate: '12',
      minPayment: 100_000,
      createPairedCategory: true,
    });
    await createTransaction(ctx.client, {
      accountId: checking.id,
      date: '2026-11-05',
      payeeId: loan.transferPayeeId,
      categoryId: loan.pairedCategoryId,
      amount: -100_000,
    });
    expect(await json(await ctx.client.post(`/api/accounts/${loan.id}/close`))).toMatchObject({
      code: 'account_balance_not_zero',
    });
    expect((await accountNamed('Car loan')).balance.working).toBe(-1_000);
  });
});
