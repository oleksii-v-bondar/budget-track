import { count, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionDto } from '../../shared/api/transactions';
import { ledgerLine, payee, subtransaction, transaction, undoEntry } from '../db/schema';
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

const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/transactions/${id}`, body);
const edit = async (id: string, body: object) => {
  const res = await json<TransactionDto>(await patch(id, body));
  if (res.status !== 200) throw new Error(`edit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;
const rowOf = async (id: string) => (await t.db.select().from(transaction).where(eq(transaction.id, id)))[0]!;
const undoCount = async () => (await t.db.select({ n: count() }).from(undoEntry))[0]!.n;

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  const household = await createCategory(ctx.client, food.id, 'Household');
  return { checking, savings, groceries, household };
}

describe('PATCH /api/transactions/:id', () => {
  it('edits a plain transaction as one undoable command, and records nothing for a no-op', async () => {
    const { checking, groceries, household } = await setUp();
    const txn = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeName: 'Biedronka',
      categoryId: groceries.id,
      amount: -100,
    });
    const before = await snapshot(t.db);

    const edited = await edit(txn.id, {
      date: '2026-11-18',
      payeeName: 'Lidl',
      categoryId: household.id,
      memo: ' cheaper ',
      amount: -150,
      cleared: 'cleared',
      approved: false,
      flag: 'red',
    });
    expect(edited).toMatchObject({
      date: '2026-11-18',
      payeeName: 'Lidl',
      categoryId: household.id,
      memo: 'cheaper',
      amount: -150,
      amountBase: -150,
      cleared: 'cleared',
      approved: false,
      flag: 'red',
    });
    const [lidl] = await t.db.select().from(payee).where(eq(payee.name, 'Lidl'));
    expect(lidl!.lastCategoryId).toBe(household.id);
    const lines = await ledgerLines(t.db, eq(ledgerLine.txnId, txn.id));
    expect(lines.map((l) => [l.date, l.categoryId, l.amountBase])).toEqual([['2026-11-18', household.id, -150]]);
    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Edit transaction "Lidl"' },
    });

    const entries = await undoCount();
    expect(await edit(txn.id, { memo: 'cheaper', flag: 'red' })).toEqual(edited);
    expect(await undoCount()).toBe(entries);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('updates the payee’s default category only when the payee or the category changes', async () => {
    const { checking, groceries, household } = await setUp();
    const shop = await createPayee(ctx.client, 'Biedronka');
    const old = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: shop.id,
      categoryId: groceries.id,
      amount: -1,
    });
    await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: shop.id,
      categoryId: household.id,
      amount: -1,
    });
    const lastCategory = async () => (await t.db.select().from(payee).where(eq(payee.id, shop.id)))[0]!.lastCategoryId;

    await edit(old.id, { memo: 'old receipt', amount: -2 });
    expect(await lastCategory()).toBe(household.id);
    await edit(old.id, { categoryId: groceries.id, payeeId: shop.id });
    expect(await lastCategory()).toBe(household.id);
    await edit(old.id, { categoryId: null });
    await edit(old.id, { categoryId: groceries.id });
    expect(await lastCategory()).toBe(groceries.id);
  });

  it('rebooks a foreign amount at the stored rate unless a new one is sent', async () => {
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    const txn = await createTransaction(ctx.client, { accountId: euro.id, amount: -1_000, fxRate: '4.3' });

    expect(await edit(txn.id, { amount: -2_000 })).toMatchObject({ amountBase: -8_600, fxRate: '4.300000' });
    expect(await edit(txn.id, { fxRate: '4.5' })).toMatchObject({ amountBase: -9_000, fxRate: '4.500000' });
    const { checking } = await setUp();
    const pln = await createTransaction(ctx.client, { accountId: checking.id, amount: -1 });
    expect((await json(await patch(pln.id, { fxRate: '4.5' }))).body).toMatchObject({ code: 'fx_rate_not_allowed' });
  });

  it('mirrors date, amount and memo to the other side of a transfer; cleared stays per side', async () => {
    const { checking, savings } = await setUp();
    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: savings.transferPayeeId,
      amount: -500,
    });
    const receivedId = sent.transfer!.transactionId;
    const before = await snapshot(t.db);

    // Edited from the receiving side.
    const received = await edit(receivedId, { date: '2026-11-19', amount: 700, memo: 'more', cleared: 'cleared' });
    expect(received).toMatchObject({ amount: 700, cleared: 'cleared', transfer: { amount: -700 } });
    expect(await get(sent.id)).toMatchObject({
      date: '2026-11-19',
      amount: -700,
      amountBase: -700,
      memo: 'more',
      cleared: 'uncleared',
    });
    const lines = await ledgerLines(t.db, inArray(ledgerLine.txnId, [sent.id, receivedId]));
    expect(lines.map((l) => [l.date, l.amountBase])).toEqual([
      ['2026-11-19', -700],
      ['2026-11-19', 700],
    ]);
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('changes the other side’s amount of a transfer between currencies only when it is sent', async () => {
    const { checking } = await setUp();
    const euro = await createAccount(ctx.client, { name: 'Revolut', type: 'savings', currency: 'EUR', fxRate: '4.25' });
    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: euro.transferPayeeId,
      amount: -40_000,
      transferAmount: 9_300,
    });
    const otherId = sent.transfer!.transactionId;

    await edit(sent.id, { amount: -42_000 });
    expect(await get(otherId)).toMatchObject({ amount: 9_300, amountBase: 42_000 });
    await edit(sent.id, { transferAmount: 9_800 });
    expect(await get(otherId)).toMatchObject({ amount: 9_800, amountBase: 42_000, effectiveRate: '4.285714' });
    expect((await json(await patch(sent.id, { amount: 100 }))).body).toMatchObject({ code: 'transfer_amount_sign' });
  });

  it('turns a transaction into a transfer, retargets it and turns it back as the payee changes', async () => {
    const { checking, savings, groceries } = await setUp();
    const wallet = await createAccount(ctx.client, { name: 'Wallet', type: 'cash' });
    const txn = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeName: 'Biedronka',
      categoryId: groceries.id,
      amount: -100,
    });

    expect((await json(await patch(txn.id, { payeeId: savings.transferPayeeId }))).body).toMatchObject({
      code: 'category_not_allowed',
    });
    const toSavings = await edit(txn.id, { payeeId: savings.transferPayeeId, categoryId: null });
    const first = toSavings.transfer!.transactionId;
    expect(await get(first)).toMatchObject({ accountId: savings.id, amount: 100 });

    const toWallet = await edit(txn.id, { payeeId: wallet.transferPayeeId });
    const second = toWallet.transfer!.transactionId;
    expect(second).not.toBe(first);
    expect((await rowOf(first)).deletedAt).toEqual(ctx.clock.now());
    expect(await get(second)).toMatchObject({ accountId: wallet.id, amount: 100, transfer: { transactionId: txn.id } });

    const plain = await edit(txn.id, { payeeName: 'Biedronka', categoryId: groceries.id });
    expect(plain).toMatchObject({ payeeName: 'Biedronka', categoryId: groceries.id, transfer: null });
    expect(await rowOf(txn.id)).toMatchObject({ transferAccountId: null, transferTxnId: null });
    expect((await rowOf(second)).deletedAt).toEqual(ctx.clock.now());
    expect((await ledgerLines(t.db, eq(ledgerLine.accountId, wallet.id))).map((l) => l.txnId)).not.toContain(second);
  });

  it('drops the other side when the tracking side of a loan payment gets a regular payee', async () => {
    const { checking } = await setUp();
    const loan = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      minPayment: 1,
      createPairedCategory: true,
    });
    const payment = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: loan.transferPayeeId,
      categoryId: loan.pairedCategoryId,
      amount: -1_000,
    });
    const loanSide = payment.transfer!.transactionId;
    expect(await edit(loanSide, { payeeName: 'Bank fee' })).toMatchObject({ categoryId: null, transfer: null });
    expect((await rowOf(payment.id)).deletedAt).not.toBeNull();
  });

  it('mirrors a split’s date to its line counterparts, which take only memo, cleared, approved, flag', async () => {
    const { checking, savings, groceries } = await setUp();
    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -300,
      lines: [
        { amount: -100, categoryId: groceries.id },
        { amount: -200, payeeId: savings.transferPayeeId },
      ],
    });
    const counterpartId = split.lines[1]!.transfer!.transactionId;

    expect(await edit(counterpartId, { memo: 'savings', cleared: 'cleared', flag: 'green' })).toMatchObject({
      memo: 'savings',
      cleared: 'cleared',
      flag: 'green',
    });
    expect((await get(split.id)).lines[1]!.memo).toBe('savings');
    await edit(split.id, { date: '2026-11-15', memo: 'monthly' });
    expect(await get(counterpartId)).toMatchObject({ date: '2026-11-15', memo: 'savings', cleared: 'cleared' });
    expect((await ledgerLines(t.db, eq(ledgerLine.txnId, split.id))).map((l) => l.date)).toEqual([
      '2026-11-15',
      '2026-11-15',
    ]);

    expect(await json(await patch(counterpartId, { amount: 250 }))).toEqual({
      status: 422,
      body: {
        code: 'split_counterpart',
        message: 'This transfer is a line of a split in "mBank": change it there.',
        fieldErrors: { amount: ['This transfer is a line of a split in "mBank": change it there.'] },
      },
    });
    expect((await json(await patch(split.id, { amount: -400 }))).body).toMatchObject({ code: 'split_sum' });
    expect((await json(await patch(split.id, { categoryId: groceries.id }))).body).toMatchObject({
      code: 'category_not_allowed',
    });
    const [line] = await t.db.select().from(subtransaction).where(eq(subtransaction.id, split.lines[1]!.id));
    expect(line!.transferTxnId).toBe(counterpartId);
  });

  it('refuses future dates, a new payee or category on a starting balance, and unknown transactions', async () => {
    const { checking, groceries } = await setUp();
    const txn = await createTransaction(ctx.client, { accountId: checking.id, amount: -1 });
    expect(await json(await patch(txn.id, { date: '2026-11-21' }))).toMatchObject({
      status: 422,
      body: { code: 'date_in_future', fieldErrors: { date: [expect.any(String)] } },
    });
    expect(await json(await patch(txn.id, { date: '1969-12-31' }))).toMatchObject({
      status: 400,
      body: { fieldErrors: { date: ['Use a date from 1970-01-01 on.'] } },
    });

    const [opening] = await t.db
      .select()
      .from(transaction)
      .where(eq(transaction.isStartingBalance, true));
    expect(await edit(opening!.id, { amount: 120_000, date: '2026-11-01', memo: 'opening' })).toMatchObject({
      amount: 120_000,
      isStartingBalance: true,
    });
    expect((await json(await patch(opening!.id, { categoryId: groceries.id }))).body).toMatchObject({
      code: 'starting_balance',
    });
    expect((await json(await patch(opening!.id, { payeeName: 'Me' }))).body).toMatchObject({
      code: 'starting_balance',
    });
    const split = { lines: [{ amount: 60_000 }, { amount: 60_000 }] };
    const { body } = await json<{ code: string; fieldErrors: object }>(await patch(opening!.id, split));
    expect([body.code, Object.keys(body.fieldErrors)]).toEqual(['starting_balance', ['lines']]);
    await t.db.update(transaction).set({ deletedAt: new Date() }).where(eq(transaction.id, txn.id));
    for (const id of [txn.id, crypto.randomUUID()]) {
      expect(await json(await patch(id, { memo: 'x' }))).toEqual({
        status: 404,
        body: { code: 'not_found', message: 'Transaction not found.' },
      });
    }
  });
});

describe('reconciled transactions', () => {
  const reconcile = (...ids: string[]) =>
    t.db.update(transaction).set({ cleared: 'reconciled' }).where(inArray(transaction.id, ids));
  const confirmNeeded = {
    status: 409,
    body: { code: 'confirm_reconciled', message: 'This changes a reconciled transaction. Confirm to go ahead.' },
  };

  it('asks to confirm a new amount, date, account or transfer, or un-reconciling', async () => {
    const { checking, savings, groceries } = await setUp();
    const wallet = await createAccount(ctx.client, { name: 'Wallet', type: 'cash' });
    const txn = await createTransaction(ctx.client, { accountId: checking.id, amount: -100 });
    await reconcile(txn.id);

    for (const body of [
      { amount: -101 },
      { date: '2026-11-19' },
      { accountId: wallet.id },
      { payeeId: savings.transferPayeeId },
      { cleared: 'cleared' },
    ]) {
      expect(await json(await patch(txn.id, body))).toEqual(confirmNeeded);
    }
    expect(await edit(txn.id, { memo: 'checked', flag: 'green', categoryId: groceries.id })).toMatchObject({
      cleared: 'reconciled',
    });
    expect(await edit(txn.id, { amount: -101, confirmReconciled: true })).toMatchObject({
      amount: -101,
      cleared: 'reconciled',
    });
    expect(await edit(txn.id, { cleared: 'uncleared', confirmReconciled: true })).toMatchObject({
      cleared: 'uncleared',
    });
  });

  it('also guards the reconciled other side of a transfer and of a split line', async () => {
    const { checking, savings, groceries } = await setUp();
    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: savings.transferPayeeId,
      amount: -100,
    });
    await reconcile(sent.transfer!.transactionId);
    expect(await json(await patch(sent.id, { date: '2026-11-19' }))).toEqual(confirmNeeded);
    expect(await json(await patch(sent.id, { payeeName: 'Shop' }))).toEqual(confirmNeeded);
    expect((await patch(sent.id, { memo: 'mirrored, but not guarded' })).status).toBe(200);

    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -300,
      lines: [
        { amount: -100, categoryId: groceries.id },
        { amount: -200, payeeId: savings.transferPayeeId },
      ],
    });
    const lineSide = split.lines[1]!.transfer!.transactionId;
    await reconcile(lineSide);
    expect(await json(await patch(split.id, { lines: [{ amount: -150 }, { amount: -150 }] }))).toEqual(confirmNeeded);
    expect(await json(await patch(split.id, { date: '2026-11-19' }))).toEqual(confirmNeeded);
    expect(await json(await patch(lineSide, { cleared: 'cleared' }))).toEqual(confirmNeeded);
    expect((await patch(lineSide, { cleared: 'cleared', confirmReconciled: true })).status).toBe(200);
  });
});

describe('moving a transaction to another account', () => {
  it('moves it within its currency, keeping transfer sides and split lines linked', async () => {
    const { checking, savings, groceries } = await setUp();
    const wallet = await createAccount(ctx.client, { name: 'Wallet', type: 'cash' });
    const txn = await createTransaction(ctx.client, { accountId: checking.id, categoryId: groceries.id, amount: -100 });
    expect(await edit(txn.id, { accountId: wallet.id })).toMatchObject({ accountId: wallet.id, accountName: 'Wallet' });
    expect((await ledgerLines(t.db, eq(ledgerLine.txnId, txn.id)))[0]!.accountId).toBe(wallet.id);

    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: savings.transferPayeeId,
      amount: -500,
    });
    await edit(sent.id, { accountId: wallet.id });
    expect(await get(sent.transfer!.transactionId)).toMatchObject({
      id: sent.transfer!.transactionId,
      accountId: savings.id,
      payeeName: 'Transfer : Wallet',
      transfer: { accountId: wallet.id, transactionId: sent.id },
    });

    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -300,
      lines: [
        { amount: -100, categoryId: groceries.id },
        { amount: -200, payeeId: savings.transferPayeeId },
      ],
    });
    const moved = await edit(split.id, { accountId: wallet.id });
    expect(moved.lines.map((l) => l.id)).toEqual(split.lines.map((l) => l.id));
    expect(await get(split.lines[1]!.transfer!.transactionId)).toMatchObject({
      payeeName: 'Transfer : Wallet',
      transfer: { accountId: wallet.id, transactionId: split.id },
    });
  });

  it('re-checks the rules of spec §5.5 in the new account', async () => {
    const { checking, savings, groceries } = await setUp();
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    const loan = await createAccount(ctx.client, { name: 'Car', type: 'auto_loan' });
    const old = await createAccount(ctx.client, { name: 'Old', type: 'savings' });
    await ctx.client.post(`/api/accounts/${old.id}/close`);
    const txn = await createTransaction(ctx.client, { accountId: checking.id, categoryId: groceries.id, amount: -100 });
    const code = async (id: string, body: object) => (await json<{ code: string }>(await patch(id, body))).body.code;

    expect(await json(await patch(txn.id, { accountId: euro.id }))).toMatchObject({
      status: 422,
      body: { code: 'move_currency', message: 'A transaction can only move to another PLN account.' },
    });
    expect(await code(txn.id, { accountId: old.id })).toBe('account_closed');
    expect(await code(txn.id, { accountId: loan.id })).toBe('category_not_allowed');
    expect(await edit(txn.id, { accountId: loan.id, categoryId: null })).toMatchObject({ accountId: loan.id });

    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: savings.transferPayeeId,
      amount: -500,
    });
    expect(await code(sent.id, { accountId: savings.id })).toBe('transfer_to_self');
    const [opening] = await t.db.select().from(transaction).where(eq(transaction.isStartingBalance, true));
    expect(await code(opening!.id, { accountId: savings.id })).toBe('starting_balance');
    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -300,
      lines: [{ amount: -100 }, { amount: -200, payeeId: savings.transferPayeeId }],
    });
    expect(await code(split.lines[1]!.transfer!.transactionId, { accountId: checking.id })).toBe('split_counterpart');
    expect(await code(split.id, { accountId: savings.id })).toBe('transfer_to_self');
  });
});
