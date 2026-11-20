import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountListResponse } from '../../shared/api/accounts';
import { ledgerLine, subtransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, createTransaction, ledgerLines } from '../test/fixtures';
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

const remove = (id: string, body?: object) => ctx.client.send('DELETE', `/api/transactions/${id}`, body);
const deletedAt = async (table: typeof transaction | typeof subtransaction, id: string) =>
  (await t.db.select({ deletedAt: table.deletedAt }).from(table).where(eq(table.id, id)))[0]!.deletedAt;

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  return { checking, savings, groceries };
}

describe('DELETE /api/transactions/:id', () => {
  it('soft-deletes a transaction, which leaves the budget and the balance, as one undoable command', async () => {
    const { checking, groceries } = await setUp();
    const txn = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeName: 'Biedronka',
      categoryId: groceries.id,
      amount: -1_000,
    });
    const before = await snapshot(t.db);

    expect(await json(await remove(txn.id))).toEqual({ status: 200, body: { id: txn.id } });
    expect(await deletedAt(transaction, txn.id)).toEqual(ctx.clock.now());
    expect((await ctx.client.get(`/api/transactions/${txn.id}`)).status).toBe(404);
    expect(await ledgerLines(t.db, eq(ledgerLine.txnId, txn.id))).toEqual([]);
    const { accounts } = (await json<AccountListResponse>(await ctx.client.get('/api/accounts'))).body;
    expect(accounts.find((a) => a.id === checking.id)!.balance.working).toBe(100_000);
    // Deleted transactions still count as history: the account can be closed, not deleted (P2b1 decision 20).
    expect((await json(await ctx.client.send('DELETE', `/api/accounts/${checking.id}`))).body).toMatchObject({
      code: 'account_in_use',
    });
    const after = await snapshot(t.db);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Delete transaction "Biedronka"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('deletes both sides of a transfer, from either side', async () => {
    const { checking, savings } = await setUp();
    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: savings.transferPayeeId,
      amount: -500,
    });
    const received = sent.transfer!.transactionId;
    expect((await remove(received)).status).toBe(200);
    for (const id of [sent.id, received]) expect(await deletedAt(transaction, id)).toEqual(ctx.clock.now());
    expect(await ledgerLines(t.db, inArray(ledgerLine.txnId, [sent.id, received]))).toEqual([]);
  });

  it('deletes a split with the counterparts of its transfer lines', async () => {
    const { checking, savings, groceries } = await setUp();
    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -300,
      lines: [
        { amount: -100, categoryId: groceries.id },
        { amount: -200, payeeId: savings.transferPayeeId },
      ],
    });
    const counterpart = split.lines[1]!.transfer!.transactionId;
    const before = await snapshot(t.db);

    expect((await remove(split.id)).status).toBe(200);
    expect(await deletedAt(transaction, counterpart)).toEqual(ctx.clock.now());
    // The lines stay live, but the ledger drops them with their deleted split.
    for (const line of split.lines) expect(await deletedAt(subtransaction, line.id)).toBeNull();
    expect(await ledgerLines(t.db, inArray(ledgerLine.txnId, [split.id, counterpart]))).toEqual([]);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('refuses a split line’s counterpart, asks to confirm reconciled rows, and 404s unknown transactions', async () => {
    const { checking, savings } = await setUp();
    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -300,
      lines: [{ amount: -100 }, { amount: -200, payeeId: savings.transferPayeeId }],
    });
    expect(await json(await remove(split.lines[1]!.transfer!.transactionId))).toEqual({
      status: 422,
      body: {
        code: 'split_counterpart',
        message: 'This transfer is a line of a split in "mBank": remove the line there.',
      },
    });

    const sent = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: savings.transferPayeeId,
      amount: -500,
    });
    const received = sent.transfer!.transactionId;
    await t.db.update(transaction).set({ cleared: 'reconciled' }).where(eq(transaction.id, received));
    expect(await json(await remove(sent.id))).toEqual({
      status: 409,
      body: { code: 'confirm_reconciled', message: 'This changes a reconciled transaction. Confirm to go ahead.' },
    });
    expect((await remove(sent.id, { confirmReconciled: true })).status).toBe(200);
    for (const id of [sent.id, crypto.randomUUID()]) {
      expect(await json(await remove(id))).toEqual({
        status: 404,
        body: { code: 'not_found', message: 'Transaction not found.' },
      });
    }
  });
});
