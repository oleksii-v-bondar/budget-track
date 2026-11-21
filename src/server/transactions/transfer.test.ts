import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionDto } from '../../shared/api/transactions';
import { systemCategoryId } from '../db/lookups';
import { ledgerLine, payee, scheduledTransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createPayee, createTransaction, ledgerLines } from '../test/fixtures';
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
const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;
const code = async (body: object) => (await json<{ code: string }>(await post(body))).body.code;
const linesOf = (...ids: string[]) => ledgerLines(t.db, inArray(ledgerLine.txnId, ids));

describe('transfers', () => {
  it('creates both sides of a same-currency transfer, linked through the transfer payees', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
    const before = await snapshot(t.db);

    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      date: '2026-11-19',
      payeeId: savings.transferPayeeId,
      memo: 'rainy day',
      amount: -50_000,
      cleared: 'cleared',
      flag: 'blue',
    });
    expect(sent).toMatchObject({
      payeeName: 'Transfer : Savings',
      categoryId: null,
      amountBase: -50_000,
      cleared: 'cleared',
      transfer: {
        accountId: savings.id,
        accountName: 'Savings',
        transactionId: expect.any(String),
        splitLineId: null,
        amount: 50_000,
        currency: 'PLN',
        effectiveRate: null,
      },
    });
    const received = await get(sent.transfer!.transactionId);
    expect(received).toMatchObject({
      accountId: savings.id,
      date: '2026-11-19',
      payeeId: checking.transferPayeeId,
      payeeName: 'Transfer : mBank',
      categoryId: null,
      memo: 'rainy day',
      amount: 50_000,
      amountBase: 50_000,
      cleared: 'uncleared',
      approved: true,
      flag: null,
      transfer: { accountId: checking.id, transactionId: sent.id, amount: -50_000 },
    });
    const rows = await t.db.select().from(transaction).where(inArray(transaction.id, [sent.id, received.id]));
    expect(rows.map((r) => [r.id, r.transferAccountId, r.transferTxnId]).sort()).toEqual(
      [
        [sent.id, savings.id, received.id],
        [received.id, checking.id, sent.id],
      ].sort(),
    );
    const lines = await linesOf(sent.id, received.id);
    expect(lines.map((l) => [l.accountId, l.amountBase, l.isTransfer, l.counterAccountClass])).toEqual([
      [checking.id, -50_000, true, 'cash'],
      [savings.id, 50_000, true, 'cash'],
    ]);
    const [transferPayee] = await t.db.select().from(payee).where(eq(payee.id, savings.transferPayeeId));
    expect(transferPayee!.lastCategoryId).toBeNull();
    const after = await snapshot(t.db);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Add transaction "Transfer : Savings"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('puts the category of a transfer between a budget and a tracking account on the budget side', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const loan = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      startingBalance: -1_000_000,
      minPayment: 100_000,
      createPairedCategory: true,
    });
    const rta = await systemCategoryId(t.db, 'rta');

    const payment = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: loan.transferPayeeId,
      categoryId: loan.pairedCategoryId,
      amount: -100_000,
    });
    expect(payment.categoryId).toBe(loan.pairedCategoryId);
    expect((await get(payment.transfer!.transactionId)).categoryId).toBeNull();
    // Entered from the tracking side, the category still lands on the budget side.
    const payout = await createTransaction(ctx.client, {
      accountId: loan.id,
      payeeId: checking.transferPayeeId,
      categoryId: rta,
      amount: -20_000,
    });
    expect(payout.categoryId).toBeNull();
    expect((await get(payout.transfer!.transactionId)).categoryId).toBe(rta);

    const lines = await linesOf(payment.id, payment.transfer!.transactionId, payout.id, payout.transfer!.transactionId);
    expect(lines.map((l) => [l.accountClass, l.categoryId, l.amountBase, l.counterAccountClass])).toEqual([
      ['cash', loan.pairedCategoryId, -100_000, 'tracking'],
      ['tracking', null, -20_000, 'cash'],
      ['cash', rta, 20_000, 'tracking'],
      ['tracking', null, 100_000, 'cash'],
    ]);
    const required = 'Choose a category for the budget side of a transfer to or from a tracking account.';
    expect(await json(await post({ accountId: checking.id, payeeId: loan.transferPayeeId, amount: -1 }))).toEqual({
      status: 422,
      body: { code: 'category_required', message: required, fieldErrors: { categoryId: [required] } },
    });
  });

  it('refuses categories on budget↔budget and tracking↔tracking transfers, and self or closed targets', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const loan = await createAccount(ctx.client, { name: 'Car', type: 'auto_loan' });
    const house = await createAccount(ctx.client, { name: 'House', type: 'other_asset' });
    const old = await createAccount(ctx.client, { name: 'Old', type: 'savings' });
    await ctx.client.post(`/api/accounts/${old.id}/close`);
    const rta = await systemCategoryId(t.db, 'rta');
    const transfer = (from: { id: string }, to: { transferPayeeId: string }, extra: object = {}) => ({
      accountId: from.id,
      payeeId: to.transferPayeeId,
      amount: -100,
      ...extra,
    });

    expect(await code(transfer(checking, savings, { categoryId: rta }))).toBe('category_not_allowed');
    expect(await code(transfer(loan, house, { categoryId: rta }))).toBe('category_not_allowed');
    expect(await code(transfer(checking, loan, { categoryId: card.paymentCategoryId }))).toBe('card_payment_category');
    expect(await json(await post(transfer(checking, checking)))).toMatchObject({
      status: 422,
      body: { code: 'transfer_to_self', fieldErrors: { payeeId: ['A transfer needs two different accounts.'] } },
    });
    expect((await json(await post(transfer(checking, old)))).body).toMatchObject({
      code: 'account_closed',
      fieldErrors: { payeeId: ['"Old" is closed. Reopen it to add transactions.'] },
    });
    expect(await code(transfer(checking, savings, { transferAmount: 100 }))).toBe('transfer_amount_not_allowed');
    const shop = await createPayee(ctx.client, 'Biedronka');
    expect(await code({ accountId: checking.id, payeeId: shop.id, amount: -1, transferAmount: 1 })).toBe(
      'transfer_amount_not_allowed',
    );
    // A card payment is a budget↔budget transfer.
    expect((await post(transfer(checking, card))).status).toBe(201);
  });

  it('books a PLN ↔ foreign transfer at both actual amounts, netting to zero (golden scenario 11)', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
    const euro = await createAccount(ctx.client, {
      name: 'Revolut',
      type: 'savings',
      currency: 'EUR',
      fxRate: '4.25',
    });
    const toEuro = { accountId: checking.id, payeeId: euro.transferPayeeId, amount: -40_000 };

    expect(await json(await post(toEuro))).toMatchObject({
      status: 422,
      body: { code: 'transfer_amount_required', message: 'Enter the amount in EUR that "Revolut" receives or sends.' },
    });
    expect(await code({ ...toEuro, transferAmount: -9_300 })).toBe('transfer_amount_sign');
    expect(await code({ ...toEuro, transferAmount: 9_300, fxRate: '4.3' })).toBe('fx_rate_not_allowed');

    const sent = await createTransaction(ctx.client, { ...toEuro, transferAmount: 9_300 });
    expect(sent).toMatchObject({
      amount: -40_000,
      amountBase: -40_000,
      transfer: { accountId: euro.id, amount: 9_300, currency: 'EUR', effectiveRate: '4.301075' },
    });
    expect(await get(sent.transfer!.transactionId)).toMatchObject({
      currency: 'EUR',
      amount: 9_300,
      amountBase: 40_000,
      fxRate: null,
      effectiveRate: '4.301075',
    });
    // From the EUR side, the PLN side still decides the base amounts.
    const back = await createTransaction(ctx.client, {
      accountId: euro.id,
      payeeId: checking.transferPayeeId,
      amount: -1_000,
      transferAmount: 4_200,
    });
    expect([back.amountBase, (await get(back.transfer!.transactionId)).amountBase]).toEqual([-4_200, 4_200]);
    const lines = await linesOf(sent.id, sent.transfer!.transactionId, back.id, back.transfer!.transactionId);
    expect(lines.reduce((sum, l) => sum + l.amountBase, 0)).toBe(0);
    expect(lines.filter((l) => l.accountId === euro.id).map((l) => [l.amount, l.amountBase])).toEqual([
      [-1_000, -4_200],
      [9_300, 40_000],
    ]);
  });

  it('converts a foreign ↔ foreign transfer at the sending currency’s rate', async () => {
    const euro = await createAccount(ctx.client, { name: 'EUR', type: 'savings', currency: 'EUR', fxRate: '4.25' });
    const dollar = await createAccount(ctx.client, { name: 'USD', type: 'savings', currency: 'USD', fxRate: '3.9' });
    const toDollar = { accountId: euro.id, payeeId: dollar.transferPayeeId, amount: -10_000, transferAmount: 11_500 };

    expect((await json(await post(toDollar))).body).toMatchObject({
      code: 'fx_rate_required',
      message: 'Enter the exchange rate of EUR to PLN.',
    });
    const sent = await createTransaction(ctx.client, { ...toDollar, fxRate: '4.3' });
    expect(sent).toMatchObject({ amountBase: -43_000, fxRate: '4.300000', effectiveRate: '4.300000' });
    expect(await get(sent.transfer!.transactionId)).toMatchObject({
      amount: 11_500,
      amountBase: 43_000,
      fxRate: null,
      effectiveRate: '3.739130',
    });
    // Entered on the receiving side, the rate is still the sending (EUR) side's, and stored there.
    const received = await createTransaction(ctx.client, {
      accountId: dollar.id,
      payeeId: euro.transferPayeeId,
      amount: 11_500,
      transferAmount: -10_000,
      fxRate: '4.3',
    });
    expect(received).toMatchObject({ amountBase: 43_000, fxRate: null });
    expect(await get(received.transfer!.transactionId)).toMatchObject({ amountBase: -43_000, fxRate: '4.300000' });
  });

  it('mirrors a transfer between two accounts in the same foreign currency, booked at its rate', async () => {
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    const pocket = await createAccount(ctx.client, {
      name: 'Pocket',
      type: 'savings',
      currency: 'EUR',
      fxRate: '4.25',
    });
    const toPocket = { accountId: euro.id, payeeId: pocket.transferPayeeId, amount: -1_000 };
    const before = await snapshot(t.db);

    expect(await code(toPocket)).toBe('fx_rate_required');
    expect(await code({ ...toPocket, fxRate: '4.3', transferAmount: 1_000 })).toBe('transfer_amount_not_allowed');
    const sent = await createTransaction(ctx.client, { ...toPocket, fxRate: '4.3' });
    expect(sent).toMatchObject({
      amount: -1_000,
      amountBase: -4_300,
      fxRate: '4.300000',
      transfer: { accountId: pocket.id, amount: 1_000, currency: 'EUR', effectiveRate: '4.300000' },
    });
    expect(await get(sent.transfer!.transactionId)).toMatchObject({
      currency: 'EUR',
      amount: 1_000,
      amountBase: 4_300,
      fxRate: null,
      transfer: { transactionId: sent.id },
    });
    const after = await snapshot(t.db);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('schedules a future transfer, except one between currencies', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
    const euro = await createAccount(ctx.client, {
      name: 'Revolut',
      type: 'savings',
      currency: 'EUR',
      fxRate: '4.25',
    });

    const res = await json<{ kind: string }>(
      await post({ accountId: checking.id, date: '2026-12-01', payeeId: savings.transferPayeeId, amount: -100 }),
    );
    expect(res).toMatchObject({ status: 201, body: { kind: 'scheduled' } });
    expect(await t.db.select().from(scheduledTransaction)).toMatchObject([
      { accountId: checking.id, payeeId: savings.transferPayeeId, transferAccountId: savings.id, amount: -100 },
    ]);
    expect(
      await json(
        await post({
          accountId: checking.id,
          date: '2026-12-01',
          payeeId: euro.transferPayeeId,
          amount: -100,
          transferAmount: 25,
        }),
      ),
    ).toMatchObject({ status: 422, body: { code: 'future_transfer_currency' } });
  });
});
