import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import { systemCategoryId, systemGroupId, systemPayeeId } from '../db/lookups';
import {
  account,
  assignment,
  category,
  payee,
  scheduledSubtransaction,
  scheduledTransaction,
  target,
  transaction,
} from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, insertTransaction } from '../test/fixtures';
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

  it('refuses a foreign starting balance whose PLN amount is too large to store exactly', async () => {
    const huge = { name: 'Huge', type: 'savings', currency: 'EUR', startingBalance: Number.MAX_SAFE_INTEGER };
    expect(await json(await ctx.client.post('/api/accounts', { ...huge, fxRate: '4.25' }))).toEqual({
      status: 422,
      body: { code: 'amount_too_large', message: 'That amount is too large.' },
    });
    expect(await t.db.select().from(account)).toEqual([]);
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
    expect(await errors({ type: 'cash', startingDate: '1969-12-31' })).toEqual({
      startingDate: ['Use a date from 1970-01-01 on.'],
    });
    expect(await errors({ type: 'cash', startingDate: '1969-13-01' })).toEqual({
      startingDate: ['Use the format YYYY-MM-DD.'],
    });
    const earliest = await createAccount(ctx.client, { name: 'Old', type: 'cash', startingDate: '1970-01-01' });
    expect((await startingBalanceOf(earliest.id)).date).toBe('1970-01-01');
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

describe('PATCH /api/accounts/:id', () => {
  it('renames the transfer payee and payment category with the account, and edits note and credit fields', async () => {
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card', note: 'old' });
    const res = await json<AccountDto>(
      await ctx.client.send('PATCH', `/api/accounts/${card.id}`, {
        name: 'Visa Gold',
        type: 'line_of_credit',
        note: '',
        interestRate: '21.5',
        minPayment: 7_500,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Visa Gold',
      type: 'line_of_credit',
      note: null,
      interestRate: '21.5000',
      minPayment: 7_500,
    });
    const [transferPayee] = await t.db.select().from(payee).where(eq(payee.id, card.transferPayeeId));
    const [payment] = await t.db.select().from(category).where(eq(category.id, card.paymentCategoryId!));
    expect([transferPayee!.name, payment!.name]).toEqual(['Transfer : Visa Gold', 'Visa Gold']);

    await ctx.client.post('/api/undo');
    expect((await json<AccountDto>(await ctx.client.get('/api/accounts'))).body).toMatchObject({
      accounts: [{ name: 'Visa', type: 'credit_card', note: 'old', interestRate: null }],
    });
  });

  it("renames a loan's paired category and clears fields with null", async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      minPayment: 1,
      escrowAmount: 2,
      createPairedCategory: true,
    });
    const res = await json<AccountDto>(
      await ctx.client.send('PATCH', `/api/accounts/${loan.id}`, { name: 'Home loan', escrowAmount: null }),
    );
    expect(res.body).toMatchObject({ name: 'Home loan', escrowAmount: null, minPayment: 1 });
    const [paired] = await t.db.select().from(category).where(eq(category.id, loan.pairedCategoryId!));
    expect(paired!.name).toBe('Home loan');
  });

  it('changes the type only within its class, and a loan only to another loan type', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const loan = await createAccount(ctx.client, { name: 'Car', type: 'auto_loan' });
    const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/accounts/${id}`, body);
    expect((await json<AccountDto>(await patch(checking.id, { type: 'savings' }))).body.type).toBe('savings');
    expect((await json<AccountDto>(await patch(loan.id, { type: 'personal_loan' }))).body.type).toBe('personal_loan');
    const refused = {
      status: 422,
      body: {
        code: 'account_type_change',
        message: "An account's type can only change within its class, and a loan only to another loan type.",
      },
    };
    expect(await json(await patch(checking.id, { type: 'credit_card' }))).toEqual(refused);
    expect(await json(await patch(loan.id, { type: 'other_asset' }))).toEqual(refused);
  });

  it('refuses fields the type does not take, a taken name and unknown accounts', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
    const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/accounts/${id}`, body);
    expect(await json(await patch(checking.id, { minPayment: 100 }))).toEqual({
      status: 422,
      body: { code: 'account_field_not_allowed', message: 'Only loans and credit accounts have a minimum payment.' },
    });
    expect(await json(await patch(checking.id, { name: 'savings' }))).toMatchObject({
      status: 422,
      body: { code: 'account_name_taken' },
    });
    expect((await json(await patch(checking.id, { name: 'MBANK' }))).status).toBe(200);
    expect(await json(await patch(crypto.randomUUID(), { note: 'x' }))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Account not found.' },
    });
    expect((await patch('not-a-uuid', { note: 'x' })).status).toBe(400);
  });
});

describe('closing and reopening', () => {
  it('closes an account only at a zero balance, and reopens it', async () => {
    const full = await createAccount(ctx.client, { name: 'Cash', type: 'cash', startingBalance: 1_000 });
    expect(await json(await ctx.client.post(`/api/accounts/${full.id}/close`))).toEqual({
      status: 422,
      body: { code: 'account_balance_not_zero', message: 'Bring the balance to 0 before closing the account.' },
    });

    const empty = await createAccount(ctx.client, { name: 'Old savings', type: 'savings' });
    const closed = await json<AccountDto>(await ctx.client.post(`/api/accounts/${empty.id}/close`));
    expect([closed.status, closed.body.closed]).toEqual([200, true]);
    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Close account "Old savings"' },
    });
    const reopened = await json<AccountDto>(await ctx.client.post(`/api/accounts/${empty.id}/reopen`));
    expect([reopened.status, reopened.body.closed]).toEqual([200, false]);
  });

  it('hides a closed credit card’s payment category when nothing is available in it (spec §10)', async () => {
    const checking = await createAccount(ctx.client, { name: 'Checking', startingBalance: 100_000 });
    const visa = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const amex = await createAccount(ctx.client, { name: 'Amex', type: 'credit_card' });
    const group = await createGroup(ctx.client, 'Everyday');
    const groceries = await createCategory(ctx.client, group.id, 'Groceries');
    // Visa: 50 zł of funded spending, paid off in full, leaves its payment category at 0.
    await ctx.client.send('PUT', `/api/budget/2026-11/assignments/${groceries.id}`, { amount: 5_000 });
    await insertTransaction(t.db, { accountId: visa.id, date: '2026-11-02', amount: -5_000, categoryId: groceries.id });
    const out = await insertTransaction(t.db, {
      accountId: checking.id,
      date: '2026-11-10',
      amount: -5_000,
      transferAccountId: visa.id,
    });
    await insertTransaction(t.db, {
      accountId: visa.id,
      date: '2026-11-10',
      amount: 5_000,
      transferAccountId: checking.id,
      transferTxnId: out.id,
    });
    // Amex: 20 zł is still set aside for it.
    await ctx.client.send('PUT', `/api/budget/2026-11/assignments/${amex.paymentCategoryId}`, { amount: 2_000 });
    const hidden = async (categoryId: string) =>
      (await t.db.select({ hidden: category.hidden }).from(category).where(eq(category.id, categoryId)))[0]?.hidden;

    const before = await snapshot(t.db);
    expect((await ctx.client.post(`/api/accounts/${visa.id}/close`)).status).toBe(200);
    expect(await hidden(visa.paymentCategoryId!)).toBe(true);
    expect((await ctx.client.post(`/api/accounts/${amex.id}/close`)).status).toBe(200);
    expect(await hidden(amex.paymentCategoryId!)).toBe(false);

    // Reopening leaves the category as it is; undoing the close restores it.
    await ctx.client.post(`/api/accounts/${visa.id}/reopen`);
    expect(await hidden(visa.paymentCategoryId!)).toBe(true);
    for (let i = 0; i < 3; i++) await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });
});

describe('DELETE /api/accounts/:id', () => {
  it('removes an account that only has its starting balance, with everything created with it', async () => {
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card', startingBalance: -5_000 });
    await t.db.insert(assignment).values({ categoryId: card.paymentCategoryId!, month: '2026-11-01', amount: 5_000 });
    const loan = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      minPayment: 1,
      createPairedCategory: true,
    });
    const before = await snapshot(t.db);

    for (const id of [card.id, loan.id]) {
      expect(await json(await ctx.client.send('DELETE', `/api/accounts/${id}`))).toEqual({ status: 200, body: { id } });
    }
    expect(await t.db.select().from(account)).toEqual([]);
    expect(await t.db.select().from(category).where(eq(category.linkedAccountId, card.id))).toEqual([]);
    expect(await t.db.select().from(payee).where(eq(payee.id, card.transferPayeeId))).toEqual([]);
    const after = await snapshot(t.db);

    await ctx.client.post('/api/undo');
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('clears payees that remember a linked category, and refuses while rows use the transfer payee', async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Car',
      type: 'auto_loan',
      minPayment: 1,
      createPairedCategory: true,
    });
    const [bank] = await t.db
      .insert(payee)
      .values({ name: 'Bank', lastCategoryId: loan.pairedCategoryId })
      .returning();
    const before = await snapshot(t.db);
    expect((await ctx.client.send('DELETE', `/api/accounts/${loan.id}`)).status).toBe(200);
    expect((await t.db.select().from(payee).where(eq(payee.id, bank!.id)))[0]!.lastCategoryId).toBeNull();
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);

    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const [schedule] = await t.db
      .insert(scheduledTransaction)
      .values({
        accountId: checking.id,
        amount: -1,
        isSplit: true,
        frequency: 'monthly',
        anchorDate: '2026-12-01',
        nextDate: '2026-12-01',
      })
      .returning();
    // A line naming the transfer payee without its account (the API never writes one) still blocks the delete.
    await t.db
      .insert(scheduledSubtransaction)
      .values({ scheduledId: schedule!.id, amount: -1, payeeId: savings.transferPayeeId });
    expect((await json(await ctx.client.send('DELETE', `/api/accounts/${savings.id}`))).body).toMatchObject({
      code: 'account_in_use',
    });
  });

  it('refuses while anything else refers to the account or its linked category', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
    const loan = await createAccount(ctx.client, {
      name: 'Car',
      type: 'auto_loan',
      minPayment: 1,
      createPairedCategory: true,
    });
    const line = { date: '2026-11-20', amount: -100, amountBase: -100 };
    await t.db.insert(transaction).values([
      { ...line, accountId: checking.id, deletedAt: new Date() },
      { ...line, accountId: savings.id, transferAccountId: checking.id },
      { ...line, accountId: savings.id, categoryId: loan.pairedCategoryId },
    ]);
    const inUse = {
      status: 422,
      body: { code: 'account_in_use', message: 'This account has transactions. Close it instead.' },
    };
    for (const id of [checking.id, savings.id, loan.id]) {
      expect(await json(await ctx.client.send('DELETE', `/api/accounts/${id}`))).toEqual(inUse);
    }
  });
});

describe('PUT /api/accounts/order', () => {
  it('stores the new order, which must list every account once', async () => {
    const a = await createAccount(ctx.client, { name: 'A' });
    const b = await createAccount(ctx.client, { name: 'B' });
    const c = await createAccount(ctx.client, { name: 'C', type: 'cash' });
    const order = (ids: string[]) => ctx.client.send('PUT', '/api/accounts/order', { ids });

    expect(await json(await order([c.id, a.id, b.id]))).toEqual({ status: 200, body: { ids: [c.id, a.id, b.id] } });
    const listed = await json<{ accounts: AccountDto[] }>(await ctx.client.get('/api/accounts'));
    expect(listed.body.accounts.map((x) => [x.name, x.sortOrder])).toEqual([
      ['C', 1],
      ['A', 2],
      ['B', 3],
    ]);
    expect(await json(await order([a.id, b.id]))).toEqual({
      status: 422,
      body: { code: 'order_mismatch', message: 'The new order must list every item exactly once.' },
    });
    expect((await order([a.id, a.id, b.id])).status).toBe(400);
  });
});
