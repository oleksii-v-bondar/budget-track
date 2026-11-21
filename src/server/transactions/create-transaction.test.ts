import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountListResponse } from '../../shared/api/accounts';
import type { CreateTransactionResponse, TransactionDto } from '../../shared/api/transactions';
import { systemCategoryId, systemPayeeId } from '../db/lookups';
import { category, ledgerLine, payee, scheduledTransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import {
  createAccount,
  createCategory,
  createGroup,
  createPayee,
  createTransaction,
  ledgerLines,
} from '../test/fixtures';
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

const post = (body: object) => ctx.client.post('/api/transactions', body);

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  return { checking, groceries };
}

describe('POST /api/transactions', () => {
  it('books an approved, uncleared transaction with a new payee, and remembers the payee’s category', async () => {
    const { checking, groceries } = await setUp();
    const before = await snapshot(t.db);

    const res = await json<CreateTransactionResponse>(
      await post({
        accountId: checking.id,
        date: '2026-11-19',
        payeeName: 'Biedronka',
        categoryId: groceries.id,
        memo: ' weekly shop ',
        amount: -12_345,
      }),
    );
    expect(res.status).toBe(201);
    const [created] = await t.db.select().from(payee).where(eq(payee.name, 'Biedronka'));
    expect(res.body).toEqual({
      kind: 'transaction',
      transaction: {
        id: expect.any(String),
        accountId: checking.id,
        accountName: 'mBank',
        currency: 'PLN',
        date: '2026-11-19',
        payeeId: created!.id,
        payeeName: 'Biedronka',
        categoryId: groceries.id,
        categoryName: 'Groceries',
        memo: 'weekly shop',
        amount: -12_345,
        amountBase: -12_345,
        fxRate: null,
        fxRateManual: false,
        effectiveRate: null,
        cleared: 'uncleared',
        approved: true,
        flag: null,
        isStartingBalance: false,
        isSplit: false,
        transfer: null,
        lines: [],
      },
    });
    expect(created!.lastCategoryId).toBe(groceries.id);
    const txn = (res.body as { transaction: TransactionDto }).transaction;
    expect(await ledgerLines(t.db, eq(ledgerLine.txnId, txn.id))).toEqual([
      {
        accountId: checking.id,
        accountClass: 'cash',
        date: '2026-11-19',
        month: '2026-11-01',
        categoryId: groceries.id,
        amount: -12_345,
        amountBase: -12_345,
        isTransfer: false,
        counterAccountClass: null,
        isStartingBalance: false,
        txnId: txn.id,
        subtxnId: null,
      },
    ]);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Add transaction "Biedronka"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('reuses payees by name or id, and books without a payee or a category', async () => {
    const { checking } = await setUp();
    const shop = await createPayee(ctx.client, 'Biedronka');
    const rta = await systemCategoryId(t.db, 'rta');

    const byName = await createTransaction(ctx.client, { accountId: checking.id, payeeName: 'BIEDRONKA', amount: -1 });
    expect(byName).toMatchObject({ payeeId: shop.id, date: '2026-11-20', categoryId: null, memo: null });
    const byId = await createTransaction(ctx.client, { accountId: checking.id, payeeId: shop.id, amount: -2 });
    expect(byId.payeeId).toBe(shop.id);
    expect((await t.db.select().from(payee).where(eq(payee.id, shop.id)))[0]!.lastCategoryId).toBeNull();
    const income = await createTransaction(ctx.client, {
      accountId: checking.id,
      categoryId: rta,
      amount: 500_000,
      cleared: 'cleared',
      flag: 'green',
    });
    expect(income).toMatchObject({
      payeeId: null,
      payeeName: null,
      categoryName: 'Ready to Assign',
      cleared: 'cleared',
      flag: 'green',
    });
    const lines = await ledgerLines(t.db, eq(ledgerLine.accountId, checking.id));
    expect(lines.map((l) => [l.categoryId, l.amountBase])).toEqual([
      [null, -2],
      [null, -1],
      [rta, 100_000],
      [rta, 500_000],
    ]);
  });

  it('treats payeeId: null like an omitted payee', async () => {
    const { checking } = await setUp();
    expect(await createTransaction(ctx.client, { accountId: checking.id, payeeId: null, amount: -1 })).toMatchObject({
      payeeId: null,
      payeeName: null,
    });
    const named = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: null,
      payeeName: 'Lidl',
      amount: -1,
    });
    expect(named.payeeName).toBe('Lidl');
  });

  it('books a foreign amount in PLN at the entered rate', async () => {
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    await createAccount(ctx.client, { name: 'mBank' });

    expect(await json(await post({ accountId: euro.id, amount: -333 }))).toEqual({
      status: 422,
      body: {
        code: 'fx_rate_required',
        message: 'Enter the exchange rate of EUR to PLN.',
        fieldErrors: { fxRate: ['Enter the exchange rate of EUR to PLN.'] },
      },
    });
    const txn = await createTransaction(ctx.client, { accountId: euro.id, amount: -333, fxRate: '4.3215' });
    // −333 × 4.3215 = −1 439.0595 → −1 439 (half away from zero).
    expect(txn).toMatchObject({
      currency: 'EUR',
      amount: -333,
      amountBase: -1_439,
      fxRate: '4.321500',
      effectiveRate: '4.321321',
    });
    const [row] = await t.db.select().from(transaction).where(eq(transaction.id, txn.id));
    expect(row!.fxRateManual).toBe(true);
    expect((await ledgerLines(t.db, eq(ledgerLine.txnId, txn.id))).map((l) => [l.amount, l.amountBase])).toEqual([
      [-333, -1_439],
    ]);
  });

  it('refuses a rate for PLN accounts', async () => {
    const { checking } = await setUp();
    expect((await json(await post({ accountId: checking.id, amount: -1, fxRate: '1' }))).body).toEqual({
      code: 'fx_rate_not_allowed',
      message: "This transaction doesn't need an exchange rate.",
      fieldErrors: { fxRate: ["This transaction doesn't need an exchange rate."] },
    });
  });

  it('applies the categorization rules of spec §5.5', async () => {
    const { checking, groceries } = await setUp();
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const loan = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      minPayment: 100,
      createPairedCategory: true,
    });
    const food = await createGroup(ctx.client, 'Old');
    const gone = await createCategory(ctx.client, food.id, 'Gone');
    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, gone.id));
    await t.db.update(category).set({ hidden: true }).where(eq(category.id, groceries.id));
    const code = async (body: object) => ((await json<{ code: string }>(await post(body))).body.code);

    expect(await code({ accountId: loan.id, categoryId: groceries.id, amount: -1 })).toBe('category_not_allowed');
    expect(await code({ accountId: checking.id, categoryId: card.paymentCategoryId, amount: -1 })).toBe(
      'card_payment_category',
    );
    const uncategorized = await systemCategoryId(t.db, 'uncategorized');
    expect(await json(await post({ accountId: checking.id, categoryId: uncategorized, amount: -1 }))).toMatchObject({
      status: 422,
      body: { code: 'invalid_category', message: 'Leave the category empty to keep it uncategorized.' },
    });
    for (const categoryId of [gone.id, crypto.randomUUID()]) {
      expect(await code({ accountId: checking.id, categoryId, amount: -1 })).toBe('invalid_category');
    }
    // Hidden categories, a loan's paired category and card spending are fine; tracking lines stay uncategorized.
    for (const body of [
      { accountId: checking.id, categoryId: groceries.id, amount: -1 },
      { accountId: checking.id, categoryId: loan.pairedCategoryId, amount: -1 },
      { accountId: card.id, categoryId: groceries.id, amount: -1 },
      { accountId: loan.id, amount: -1 },
    ]) {
      expect((await post(body)).status).toBe(201);
    }
  });

  it('refuses closed and unknown accounts, unknown and system payees, and malformed bodies', async () => {
    const { checking } = await setUp();
    const old = await createAccount(ctx.client, { name: 'Old', type: 'savings' });
    await ctx.client.post(`/api/accounts/${old.id}/close`);
    const gone = await createPayee(ctx.client, 'Gone');
    await ctx.client.send('DELETE', `/api/payees/${gone.id}`);

    expect(await json(await post({ accountId: old.id, amount: -1 }))).toEqual({
      status: 422,
      body: {
        code: 'account_closed',
        message: '"Old" is closed. Reopen it to add transactions.',
        fieldErrors: { accountId: ['"Old" is closed. Reopen it to add transactions.'] },
      },
    });
    const code = async (body: object) => ((await json<{ code: string }>(await post(body))).body.code);
    expect(await code({ accountId: crypto.randomUUID(), amount: -1 })).toBe('invalid_account');
    for (const payeeId of [gone.id, crypto.randomUUID()]) {
      expect(await code({ accountId: checking.id, payeeId, amount: -1 })).toBe('invalid_payee');
    }
    const startingBalance = await systemPayeeId(t.db, 'starting_balance');
    expect(await code({ accountId: checking.id, payeeId: startingBalance, amount: -1 })).toBe('system_payee');

    const fieldErrors = async (body: object) =>
      (await json<{ fieldErrors: Record<string, string[]> }>(await post(body))).body.fieldErrors;
    expect(await fieldErrors({ accountId: checking.id, payeeId: gone.id, payeeName: 'X', amount: -1 })).toEqual({
      payeeName: ['Choose a payee or type a new name, not both.'],
    });
    expect(Object.keys(await fieldErrors({ accountId: checking.id, amount: 1.5 }))).toEqual(['amount']);
    expect(Object.keys(await fieldErrors({ accountId: checking.id, amount: 1, cleared: 'reconciled' }))).toEqual([
      'cleared',
    ]);
    expect(Object.keys(await fieldErrors({ accountId: checking.id, amount: 1, flag: 'pink' }))).toEqual(['flag']);
    expect(await fieldErrors({ accountId: checking.id, amount: 1, date: '2026-02-30' })).toEqual({
      date: ['Use the format YYYY-MM-DD.'],
    });
    expect(await fieldErrors({ accountId: checking.id, amount: 1, date: '1969-12-31' })).toEqual({
      date: ['Use a date from 1970-01-01 on.'],
    });
  });

  it('creates no payee for a new name when the transaction is refused', async () => {
    await setUp();
    const old = await createAccount(ctx.client, { name: 'Old', type: 'savings' });
    await ctx.client.post(`/api/accounts/${old.id}/close`);

    for (const [accountId, code] of [
      [old.id, 'account_closed'],
      [crypto.randomUUID(), 'invalid_account'],
    ]) {
      expect(await json(await post({ accountId, payeeName: 'New', amount: -1 }))).toMatchObject({
        status: 422,
        body: { code },
      });
    }
    expect(await t.db.select().from(payee).where(eq(payee.name, 'New'))).toEqual([]);
  });

  it('saves a transaction dated after today (in the budget time zone) as a one-time schedule', async () => {
    const { checking, groceries } = await setUp();
    // 23:30 UTC is already 2026-11-21 in Warsaw.
    ctx.clock.advance(13.5 * 60 * 60 * 1000);
    const today = await json<CreateTransactionResponse>(
      await post({ accountId: checking.id, date: '2026-11-21', amount: -1 }),
    );
    expect(today.body.kind).toBe('transaction');
    const before = await snapshot(t.db);

    const res = await json<CreateTransactionResponse>(
      await post({
        accountId: checking.id,
        date: '2026-11-22',
        payeeName: 'Landlord',
        categoryId: groceries.id,
        memo: 'rent',
        amount: -200_000,
        flag: 'red',
      }),
    );
    expect(res).toEqual({
      status: 201,
      body: { kind: 'scheduled', scheduledId: expect.any(String), date: '2026-11-22' },
    });
    const [schedule] = await t.db.select().from(scheduledTransaction);
    const [landlord] = await t.db.select().from(payee).where(eq(payee.name, 'Landlord'));
    expect(schedule).toMatchObject({
      id: (res.body as { scheduledId: string }).scheduledId,
      accountId: checking.id,
      payeeId: landlord!.id,
      categoryId: groceries.id,
      memo: 'rent',
      amount: -200_000,
      fxRate: null,
      flag: 'red',
      transferAccountId: null,
      isSplit: false,
      frequency: 'once',
      anchorDate: '2026-11-22',
      nextDate: '2026-11-22',
    });
    expect(landlord!.lastCategoryId).toBe(groceries.id);
    expect(await t.db.select().from(transaction).where(eq(transaction.date, '2026-11-22'))).toEqual([]);
    expect(await ledgerLines(t.db, eq(ledgerLine.date, '2026-11-22'))).toEqual([]);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Schedule transaction "Landlord"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
  });
});

describe('amount caps', () => {
  // 100 bn zł in grosze: the largest amount a request may carry.
  const MAX = 10_000_000_000_000;
  const tooLarge = ['Amount is too large.'];
  const fieldErrors = async (res: Response) =>
    (await json<{ fieldErrors: Record<string, string[]> }>(res)).body.fieldErrors;

  it('refuses amounts, other-side amounts and line amounts above 1e13, on create and on edit', async () => {
    const { checking } = await setUp();
    const euro = await createAccount(ctx.client, { name: 'Revolut', type: 'savings', currency: 'EUR', fxRate: '4' });
    const toEuro = { accountId: checking.id, payeeId: euro.transferPayeeId };

    expect(await fieldErrors(await post({ accountId: checking.id, amount: MAX + 1 }))).toEqual({ amount: tooLarge });
    expect(await fieldErrors(await post({ accountId: checking.id, amount: -MAX - 1 }))).toEqual({ amount: tooLarge });
    expect(await fieldErrors(await post({ ...toEuro, amount: -1, transferAmount: MAX + 1 }))).toEqual({
      transferAmount: tooLarge,
    });
    const lines = [{ amount: MAX + 1 }, { amount: -MAX }];
    expect(await fieldErrors(await post({ accountId: checking.id, amount: 1, lines }))).toEqual({
      'lines.0.amount': tooLarge,
    });

    const txn = await createTransaction(ctx.client, { accountId: checking.id, amount: -MAX });
    const transfer = await createTransaction(ctx.client, { ...toEuro, amount: -MAX, transferAmount: MAX });
    const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/transactions/${id}`, body);
    expect(await fieldErrors(await patch(txn.id, { amount: -MAX - 1 }))).toEqual({ amount: tooLarge });
    expect(await fieldErrors(await patch(transfer.id, { transferAmount: MAX + 1 }))).toEqual({
      transferAmount: tooLarge,
    });
    expect(await fieldErrors(await patch(txn.id, { lines: [{ amount: 1 }, { amount: -MAX - 1 }] }))).toEqual({
      'lines.1.amount': tooLarge,
    });
  });

  it('refuses a foreign amount whose PLN amount would exceed 1e14', async () => {
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4' });
    const dollar = await createAccount(ctx.client, { name: 'USD', type: 'savings', currency: 'USD', fxRate: '4' });
    const message = 'That amount is too large.';
    const error = (field: string) => ({
      status: 422,
      body: { code: 'amount_too_large', message, fieldErrors: { [field]: [message] } },
    });

    expect(await json(await post({ accountId: euro.id, amount: MAX, fxRate: '10.000001' }))).toEqual(error('amount'));
    // Received from the dollar account: the sending (EUR) amount is converted.
    const received = { accountId: dollar.id, payeeId: euro.transferPayeeId, amount: 1, transferAmount: -MAX };
    expect(await json(await post({ ...received, fxRate: '10.000001' }))).toEqual(error('transferAmount'));
    const lines = [{ amount: MAX }, { amount: -MAX + 1 }];
    expect(await json(await post({ accountId: euro.id, amount: 1, fxRate: '10.000001', lines }))).toEqual(
      error('lines.0.amount'),
    );

    // 1e13 at a rate of 10 is exactly the limit.
    const txn = await createTransaction(ctx.client, { accountId: euro.id, amount: MAX, fxRate: '10' });
    expect(txn.amountBase).toBe(10 * MAX);
    expect(await json(await ctx.client.send('PATCH', `/api/transactions/${txn.id}`, { fxRate: '10.5' }))).toEqual(
      error('amount'),
    );
  });

  it('keeps balances readable with the largest amounts it accepts', async () => {
    const { checking } = await setUp();
    // Two rows near 2^53 used to overflow every balance sum (500 on GET).
    expect((await post({ accountId: checking.id, amount: Number.MAX_SAFE_INTEGER })).status).toBe(400);
    await createTransaction(ctx.client, { accountId: checking.id, amount: MAX });
    await createTransaction(ctx.client, { accountId: checking.id, amount: MAX });

    const res = await json<AccountListResponse>(await ctx.client.get('/api/accounts'));
    expect(res.status).toBe(200);
    expect(res.body.accounts.find((a) => a.id === checking.id)!.balance.working).toBe(100_000 + 2 * MAX);
    expect((await ctx.client.get(`/api/transactions?accountId=${checking.id}`)).status).toBe(200);
    expect((await ctx.client.get('/api/budget/2026-11')).status).toBe(200);
  });
});

describe('GET /api/transactions/:id', () => {
  it('returns live transactions only', async () => {
    const { checking } = await setUp();
    const txn = await createTransaction(ctx.client, { accountId: checking.id, amount: -1 });
    expect(await json(await ctx.client.get(`/api/transactions/${txn.id}`))).toEqual({ status: 200, body: txn });

    await t.db.update(transaction).set({ deletedAt: new Date() }).where(eq(transaction.id, txn.id));
    expect(await json(await ctx.client.get(`/api/transactions/${txn.id}`))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Transaction not found.' },
    });
    expect((await ctx.client.get('/api/transactions/nope')).status).toBe(400);
  });
});
