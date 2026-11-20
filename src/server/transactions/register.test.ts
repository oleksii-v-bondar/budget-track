import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RegisterResponse, TransactionDto } from '../../shared/api/transactions';
import { transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, createPayee, createTransaction } from '../test/fixtures';

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

const register = async (query: Record<string, string>) => {
  const res = await json<RegisterResponse>(await ctx.client.get(`/api/transactions?${new URLSearchParams(query)}`));
  if (res.status !== 200) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
const memos = (page: RegisterResponse) => page.transactions.map((txn) => txn.memo);

async function setUp() {
  const checking = await createAccount(ctx.client, {
    name: 'mBank',
    startingBalance: 100_000,
    startingDate: '2026-11-01',
  });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings', startingDate: '2026-11-01' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  const household = await createCategory(ctx.client, food.id, 'Household');
  const shop = await createPayee(ctx.client, 'Biedronka');
  const add = (body: object) => createTransaction(ctx.client, { accountId: checking.id, amount: -100, ...body });
  const weekly = await add({
    date: '2026-11-10',
    payeeId: shop.id,
    categoryId: groceries.id,
    memo: 'weekly',
    amount: -1_000,
    cleared: 'cleared',
  });
  const transfer = await add({ date: '2026-11-15', payeeId: savings.transferPayeeId, memo: 'saving', amount: -5_000 });
  const split = await add({
    date: '2026-11-18',
    memo: 'mixed',
    amount: -300,
    flag: 'red',
    lines: [
      { amount: -100, categoryId: groceries.id, memo: '50% off' },
      { amount: -200, categoryId: household.id, payeeId: shop.id },
    ],
  });
  return { checking, savings, groceries, household, shop, weekly, transfer, split };
}

describe('GET /api/transactions', () => {
  it('lists an account’s transactions newest first, with names, transfers, split lines and balances', async () => {
    const { checking, savings, weekly, transfer, split } = await setUp();
    const page = await register({ accountId: checking.id });

    expect(page.transactions.map((txn) => [txn.date, txn.memo])).toEqual([
      ['2026-11-18', 'mixed'],
      ['2026-11-15', 'saving'],
      ['2026-11-10', 'weekly'],
      ['2026-11-01', null],
    ]);
    const byId = (id: string) => page.transactions.find((txn) => txn.id === id)!;
    expect(byId(weekly.id)).toEqual(weekly);
    expect(byId(transfer.id).transfer).toMatchObject({ accountId: savings.id, accountName: 'Savings' });
    expect(byId(split.id).lines.map((l) => [l.categoryName, l.payeeName])).toEqual([
      ['Groceries', null],
      ['Household', 'Biedronka'],
    ]);
    expect(page.transactions.at(-1)).toMatchObject({ isStartingBalance: true, payeeName: 'Starting Balance' });
    const balance = { cleared: 99_000, uncleared: -5_300, working: 93_700 };
    expect(page.balances).toEqual({ balance, balanceBase: balance });
    expect(page.nextCursor).toBeNull();
    expect(memos(await register({ accountId: savings.id }))).toEqual(['saving', null]);
  });

  it('pages by (date desc, id desc) with a cursor', async () => {
    const { checking } = await setUp();
    for (const memo of ['a', 'b', 'c']) {
      await createTransaction(ctx.client, { accountId: checking.id, amount: -1, memo });
    }
    const all = (await register({ accountId: checking.id })).transactions;
    expect(all.map((txn) => txn.date)).toEqual([...all.map((txn) => txn.date)].sort().reverse());

    const seen: TransactionDto[] = [];
    let cursor: string | null = null;
    do {
      const query = { accountId: checking.id, limit: '3', ...(cursor ? { cursor } : {}) };
      const page: RegisterResponse = await register(query);
      expect(page.transactions.length).toBeLessThanOrEqual(3);
      seen.push(...page.transactions);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.map((txn) => txn.id)).toEqual(all.map((txn) => txn.id));
    // Within a date, ids descend.
    const today = all.filter((txn) => txn.date === '2026-11-20').map((txn) => txn.id);
    expect(today).toEqual([...today].sort().reverse());

    const status = async (query: string) => (await ctx.client.get(`/api/transactions?${query}`)).status;
    expect(await status('cursor=nope')).toBe(400);
    expect(await status('limit=201')).toBe(400);
    expect(await status('limit=0')).toBe(400);
  });

  it('searches text in payees, memos and categories, split lines included', async () => {
    await setUp();
    expect(memos(await register({ q: 'BIED' }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ q: 'groc' }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ q: 'saving' }))).toEqual(['saving', 'saving']);
    expect(memos(await register({ q: 'Transfer : mBank' }))).toEqual(['saving']);
    // % is a literal: only the split line's memo "50% off" matches.
    expect(memos(await register({ q: '50%' }))).toEqual(['mixed']);
    expect(memos(await register({ q: '_' }))).toEqual([]);
  });

  it('filters by dates, amounts, account, category, payee, flag, cleared state and approval', async () => {
    const { checking, savings, groceries, household, shop, weekly } = await setUp();
    await ctx.client.send('PATCH', `/api/transactions/${weekly.id}`, { approved: false });

    expect(memos(await register({ from: '2026-11-10', to: '2026-11-15' }))).toEqual(['saving', 'saving', 'weekly']);
    expect(memos(await register({ minAmount: '-1000', maxAmount: '-300' }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ accountId: savings.id, minAmount: '1' }))).toEqual(['saving']);
    expect(memos(await register({ categoryId: groceries.id }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ categoryId: household.id }))).toEqual(['mixed']);
    expect(memos(await register({ payeeId: shop.id }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ flag: 'red' }))).toEqual(['mixed']);
    expect(memos(await register({ accountId: checking.id, cleared: 'cleared' }))).toEqual(['weekly', null]);
    expect(memos(await register({ unapproved: 'true' }))).toEqual(['weekly']);
    expect((await register({ unapproved: 'false' })).transactions).toHaveLength(6);
    expect((await register({})).balances).toBeNull();
  });

  it('leaves out deleted transactions and refuses invalid filters', async () => {
    const { checking, weekly } = await setUp();
    await t.db.update(transaction).set({ deletedAt: new Date() }).where(eq(transaction.id, weekly.id));
    expect(memos(await register({ accountId: checking.id }))).toEqual(['mixed', 'saving', null]);

    const errors = async (query: string) =>
      (await json<{ fieldErrors: Record<string, string[]> }>(await ctx.client.get(`/api/transactions?${query}`))).body
        .fieldErrors;
    expect(await errors('from=2026-11-15&to=2026-11-10')).toEqual({
      to: ['The end date must not be before the start date.'],
    });
    expect(await errors('minAmount=1.5')).toEqual({ minAmount: ['Enter a whole amount in minor units.'] });
    expect(Object.keys(await errors('flag=pink&cleared=maybe'))).toEqual(['flag', 'cleared']);
    expect(await json(await ctx.client.get(`/api/transactions?accountId=${crypto.randomUUID()}`))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Account not found.' },
    });
  });
});
