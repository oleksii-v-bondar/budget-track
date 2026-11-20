import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionDto } from '../../shared/api/transactions';
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

const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/transactions/${id}`, body);
const edit = async (id: string, body: object) => {
  const res = await json<TransactionDto>(await patch(id, body));
  if (res.status !== 200) throw new Error(`edit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;
const deletedAt = async (table: typeof transaction | typeof subtransaction, id: string) =>
  (await t.db.select({ deletedAt: table.deletedAt }).from(table).where(eq(table.id, id)))[0]!.deletedAt;

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
  const wallet = await createAccount(ctx.client, { name: 'Wallet', type: 'cash' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  const household = await createCategory(ctx.client, food.id, 'Household');
  const split = await createTransaction(ctx.client, {
    accountId: checking.id,
    amount: -300,
    lines: [
      { amount: -100, categoryId: groceries.id },
      { amount: -200, payeeId: savings.transferPayeeId },
    ],
  });
  return { checking, savings, wallet, groceries, household, split };
}

describe('editing splits', () => {
  it('replaces changed lines, soft-deleting the old lines and their counterparts', async () => {
    const { checking, wallet, groceries, household, split } = await setUp();
    const before = await snapshot(t.db);
    const oldCounterpart = split.lines[1]!.transfer!.transactionId;

    const edited = await edit(split.id, {
      amount: -400,
      lines: [
        { amount: -150, categoryId: groceries.id },
        { amount: -50, categoryId: household.id, memo: 'soap' },
        { amount: -200, payeeId: wallet.transferPayeeId },
      ],
    });
    expect(edited.lines.map((l) => [l.amount, l.categoryId, l.memo, l.transfer?.accountId ?? null])).toEqual([
      [-150, groceries.id, null, null],
      [-50, household.id, 'soap', null],
      [-200, null, null, wallet.id],
    ]);
    for (const line of split.lines) expect(await deletedAt(subtransaction, line.id)).toEqual(ctx.clock.now());
    expect(await deletedAt(transaction, oldCounterpart)).toEqual(ctx.clock.now());
    expect(await get(edited.lines[2]!.transfer!.transactionId)).toMatchObject({
      accountId: wallet.id,
      amount: 200,
      transfer: { transactionId: split.id, splitLineId: edited.lines[2]!.id },
    });
    const lines = await ledgerLines(t.db, inArray(ledgerLine.accountId, [checking.id, wallet.id]));
    expect(lines.filter((l) => !l.isStartingBalance).map((l) => [l.accountId, l.categoryId, l.amountBase])).toEqual([
      [checking.id, null, -200],
      [checking.id, groceries.id, -150],
      [checking.id, household.id, -50],
      [wallet.id, null, 200],
    ]);
    const after = await snapshot(t.db);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('keeps the lines and their counterparts when the same lines are sent again', async () => {
    const { savings, groceries, split } = await setUp();
    const counterpartId = split.lines[1]!.transfer!.transactionId;
    await edit(counterpartId, { cleared: 'cleared' });

    const edited = await edit(split.id, {
      memo: 'groceries and savings',
      lines: [
        { amount: -100, categoryId: groceries.id },
        { amount: -200, payeeId: savings.transferPayeeId },
      ],
    });
    expect(edited.lines.map((l) => l.id)).toEqual(split.lines.map((l) => l.id));
    expect(await get(counterpartId)).toMatchObject({ cleared: 'cleared' });
  });

  it('turns a split into a plain transaction and back', async () => {
    const { checking, savings, groceries, split } = await setUp();
    const counterpartId = split.lines[1]!.transfer!.transactionId;

    const plain = await edit(split.id, { lines: null, categoryId: groceries.id });
    expect(plain).toMatchObject({ isSplit: false, categoryId: groceries.id, lines: [] });
    expect(await deletedAt(transaction, counterpartId)).not.toBeNull();
    expect((await ledgerLines(t.db, eq(ledgerLine.txnId, split.id))).map((l) => [l.subtxnId, l.categoryId])).toEqual([
      [null, groceries.id],
    ]);

    const again = await edit(split.id, { lines: [{ amount: -1, categoryId: groceries.id }, { amount: -299 }] });
    expect(again).toMatchObject({ isSplit: true, categoryId: null });
    expect(again.lines.map((l) => l.amount)).toEqual([-1, -299]);

    // A transfer has to stop being one before it can be split.
    const transfer = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: savings.transferPayeeId,
      amount: -10,
    });
    const lines = [{ amount: -4 }, { amount: -6 }];
    expect((await json(await patch(transfer.id, { lines }))).body).toMatchObject({ code: 'split_transfer' });
    expect(await edit(transfer.id, { lines, payeeName: 'Market' })).toMatchObject({ isSplit: true, transfer: null });
    expect(await deletedAt(transaction, transfer.transfer!.transactionId)).not.toBeNull();
  });

  it('validates new lines like the lines of a new split', async () => {
    const { groceries, split } = await setUp();
    const error = async (body: object) =>
      (await json<{ code: string; fieldErrors: Record<string, string[]> }>(await patch(split.id, body))).body;

    expect((await error({ lines: [{ amount: -100 }, { amount: -100 }] })).code).toBe('split_sum');
    expect((await error({ lines: [{ amount: -300 }, { amount: 'x' }] })).fieldErrors).toEqual({
      'lines.1.amount': ['Enter a whole amount in minor units.'],
    });
    expect(
      (await error({ categoryId: groceries.id, lines: [{ amount: -100 }, { amount: -200 }] })).fieldErrors,
    ).toEqual({ categoryId: ["A split's categories go on its lines."] });
  });
});
