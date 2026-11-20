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
