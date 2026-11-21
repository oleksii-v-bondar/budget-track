import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionDto } from '../../shared/api/transactions';
import { payee, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, createPayee, createTransaction } from '../test/fixtures';
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

const bulk = (ids: string[], action: object, extra: object = {}) =>
  ctx.client.post('/api/transactions/bulk', { ids, action, ...extra });
const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;
const undoLabel = async () =>
  (await json<{ undo: { label: string } }>(await ctx.client.get('/api/undo'))).body.undo.label;

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
  const wallet = await createAccount(ctx.client, { name: 'Wallet', type: 'cash' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  const shop = await createPayee(ctx.client, 'Biedronka');
  const add = (body: object = {}) => createTransaction(ctx.client, { accountId: checking.id, amount: -100, ...body });
  return { checking, savings, wallet, groceries, shop, add };
}

describe('POST /api/transactions/bulk', () => {
  it('categorizes the selection as one undoable command', async () => {
    const { groceries, shop, add } = await setUp();
    const rows = [await add({ payeeId: shop.id }), await add(), await add({ amount: 500 })];
    const ids = rows.map((r) => r.id);
    const before = await snapshot(t.db);

    expect(await json(await bulk(ids, { type: 'categorize', categoryId: groceries.id }))).toEqual({
      status: 200,
      body: { ids },
    });
    for (const id of ids) expect((await get(id)).categoryId).toBe(groceries.id);
    expect((await t.db.select().from(payee).where(eq(payee.id, shop.id)))[0]!.lastCategoryId).toBe(groceries.id);
    expect(await undoLabel()).toBe('Categorize 3 transactions');
    const after = await snapshot(t.db);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('rolls back the rows already replayed when undoing a bulk command hits a changed row', async () => {
    const { groceries, add } = await setUp();
    const rows = [await add(), await add(), await add()];
    await bulk(rows.map((r) => r.id), { type: 'categorize', categoryId: groceries.id });
    // Undo replays the newest change first, so the first row is checked last; change it outside the command layer.
    await t.db.update(transaction).set({ memo: 'changed elsewhere' }).where(eq(transaction.id, rows[0]!.id));
    const before = await snapshot(t.db);

    expect(await json(await ctx.client.post('/api/undo'))).toEqual({
      status: 409,
      body: { code: 'undo_conflict', message: "Can't undo: data changed since." },
    });
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('checks every row like a single edit and changes nothing when one fails', async () => {
    const { groceries, add } = await setUp();
    const loan = await createAccount(ctx.client, { name: 'Car', type: 'auto_loan' });
    const ok = await add();
    const tracking = await createTransaction(ctx.client, { accountId: loan.id, amount: -100 });
    const before = await snapshot(t.db);

    expect(await json(await bulk([ok.id, tracking.id], { type: 'categorize', categoryId: groceries.id }))).toEqual({
      status: 422,
      body: {
        code: 'category_not_allowed',
        message: "Transactions in tracking accounts don't take a category.",
        fieldErrors: { 'ids.1': ["Transactions in tracking accounts don't take a category."] },
      },
    });
    expect(await snapshot(t.db)).toEqual(before);
    expect(await json(await bulk([ok.id, crypto.randomUUID()], { type: 'approve' }))).toMatchObject({
      status: 404,
      body: { code: 'not_found', fieldErrors: { 'ids.1': ['Transaction not found.'] } },
    });
    const status = async (ids: string[], action: object) => (await bulk(ids, action)).status;
    expect(await status([], { type: 'approve' })).toBe(400);
    expect(await status([ok.id, ok.id], { type: 'approve' })).toBe(400);
    expect(await status([ok.id], { type: 'paint' })).toBe(400);
    expect(await status([ok.id], { type: 'categorize' })).toBe(400);
  });

  it('sets the payee, the flag and approval', async () => {
    const { shop, add } = await setUp();
    const ids = [(await add({ payeeName: 'Lidl' })).id, (await add()).id];
    await ctx.client.send('PATCH', `/api/transactions/${ids[0]}`, { approved: false });

    await bulk(ids, { type: 'setPayee', payeeId: shop.id });
    expect(await undoLabel()).toBe('Set the payee of 2 transactions');
    await bulk(ids, { type: 'setFlag', flag: 'purple' });
    expect(await undoLabel()).toBe('Flag 2 transactions');
    await bulk(ids, { type: 'approve' });
    expect(await undoLabel()).toBe('Approve 2 transactions');
    for (const id of ids) expect(await get(id)).toMatchObject({ payeeId: shop.id, flag: 'purple', approved: true });
    await bulk(ids, { type: 'setFlag', flag: null });
    expect(await undoLabel()).toBe('Remove the flag of 2 transactions');
    for (const id of ids) expect((await get(id)).flag).toBeNull();
  });

  it('sets the cleared state of each side, confirming reconciled rows', async () => {
    const { savings, add } = await setUp();
    const plain = await add();
    const sent = await add({ payeeId: savings.transferPayeeId });
    await t.db.update(transaction).set({ cleared: 'reconciled' }).where(eq(transaction.id, plain.id));

    expect(await json(await bulk([sent.id, plain.id], { type: 'setCleared', cleared: 'cleared' }))).toMatchObject({
      status: 409,
      body: { code: 'confirm_reconciled', fieldErrors: { 'ids.1': [expect.any(String)] } },
    });
    const clear = { type: 'setCleared', cleared: 'cleared' };
    expect((await bulk([sent.id, plain.id], clear, { confirmReconciled: true })).status).toBe(200);
    expect(await undoLabel()).toBe('Mark 2 transactions cleared');
    expect((await get(plain.id)).cleared).toBe('cleared');
    expect((await get(sent.id)).cleared).toBe('cleared');
    expect((await get(sent.transfer!.transactionId)).cleared).toBe('uncleared');
  });

  it('moves the selection to an account in the same currency', async () => {
    const { savings, wallet, add } = await setUp();
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    const plain = await add();
    const sent = await add({ payeeId: savings.transferPayeeId });

    await bulk([plain.id, sent.id], { type: 'moveAccount', accountId: wallet.id });
    expect(await undoLabel()).toBe('Move 2 transactions');
    expect((await get(plain.id)).accountId).toBe(wallet.id);
    expect(await get(sent.transfer!.transactionId)).toMatchObject({ payeeName: 'Transfer : Wallet' });
    expect((await json(await bulk([plain.id], { type: 'moveAccount', accountId: euro.id }))).body).toMatchObject({
      code: 'move_currency',
      fieldErrors: { 'ids.0': [expect.any(String)] },
    });
  });

  it('skips a row that an earlier row deleted, such as the other side of a transfer it ended', async () => {
    const { savings, shop, add } = await setUp();
    const sent = await add({ payeeId: savings.transferPayeeId });
    const received = sent.transfer!.transactionId;
    const gone = await add();
    await ctx.client.send('DELETE', `/api/transactions/${gone.id}`);
    const before = await snapshot(t.db);

    expect(await json(await bulk([sent.id, received], { type: 'setPayee', payeeId: shop.id }))).toEqual({
      status: 200,
      body: { ids: [sent.id, received] },
    });
    expect(await get(sent.id)).toMatchObject({ payeeId: shop.id, transfer: null });
    expect((await ctx.client.get(`/api/transactions/${received}`)).status).toBe(404);
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    // A row deleted before the command is still not found.
    expect(await json(await bulk([sent.id, gone.id], { type: 'approve' }))).toMatchObject({
      status: 404,
      body: { fieldErrors: { 'ids.1': ['Transaction not found.'] } },
    });
  });

  it('deletes the selection, including both sides of transfers and splits with their line counterparts', async () => {
    const { savings, add } = await setUp();
    const plain = await add();
    const sent = await add({ payeeId: savings.transferPayeeId });
    const split = await add({
      amount: -300,
      lines: [{ amount: -100 }, { amount: -200, payeeId: savings.transferPayeeId }],
    });
    const lineSide = split.lines[1]!.transfer!.transactionId;
    const ids = [lineSide, sent.transfer!.transactionId, plain.id, sent.id, split.id];
    const before = await snapshot(t.db);

    expect((await bulk(ids, { type: 'delete' })).status).toBe(200);
    const rows = await t.db.select().from(transaction).where(inArray(transaction.id, ids));
    expect(rows.map((r) => r.deletedAt)).toEqual(ids.map(() => ctx.clock.now()));
    expect(await undoLabel()).toBe('Delete 5 transactions');
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });
});
