import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BudgetMonthDto } from '../../shared/api/budget';
import type { CreateTransactionInput, RegisterResponse, TransactionDto } from '../../shared/api/transactions';
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

    // Pages of 2 break inside today's three rows, so the cursor needs the id to continue within a date.
    const seen: TransactionDto[] = [];
    let cursor: string | null = null;
    do {
      const query = { accountId: checking.id, limit: '2', ...(cursor ? { cursor } : {}) };
      const page: RegisterResponse = await register(query);
      expect(page.transactions.length).toBeLessThanOrEqual(2);
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
    const { checking } = await setUp();
    // Unescaped, "50%" would also match "500 zł", and "C:\d" would match "C:d" but not "C:\docs".
    for (const memo of ['500 zł', 'C:\\docs']) {
      await createTransaction(ctx.client, { accountId: checking.id, amount: -1, memo });
    }
    expect(memos(await register({ q: 'BIED' }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ q: 'groc' }))).toEqual(['mixed', 'weekly']);
    expect(memos(await register({ q: 'saving' }))).toEqual(['saving', 'saving']);
    expect(memos(await register({ q: 'Transfer : mBank' }))).toEqual(['saving']);
    // %, _ and \ are literals: only the split line's memo "50% off" has "50%".
    expect(memos(await register({ q: '50%' }))).toEqual(['mixed']);
    expect(memos(await register({ q: '_' }))).toEqual([]);
    expect(memos(await register({ q: 'C:\\d' }))).toEqual(['C:\\docs']);
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

  it('lists the Uncategorized activity of the month view under the Uncategorized category', async () => {
    const opened = { startingDate: '2026-11-01' };
    const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000, ...opened });
    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings', ...opened });
    const card = await createAccount(ctx.client, {
      name: 'Visa',
      type: 'credit_card',
      startingBalance: -20_000,
      ...opened,
    });
    const house = await createAccount(ctx.client, { name: 'House', type: 'other_asset', ...opened });
    const groceries = await createCategory(ctx.client, (await createGroup(ctx.client, 'Food')).id, 'Groceries');
    const add = (body: CreateTransactionInput) => createTransaction(ctx.client, body);
    await add({ accountId: checking.id, date: '2026-11-03', memo: 'plain', amount: -700 });
    await add({ accountId: card.id, date: '2026-11-04', memo: 'card', amount: -1_100 });
    // Not activity: transfers between budget accounts, tracking accounts, starting balances and categorized rows.
    await add({ accountId: checking.id, date: '2026-11-05', payeeId: savings.transferPayeeId, amount: -5_000 });
    await add({ accountId: checking.id, date: '2026-11-06', payeeId: card.transferPayeeId, amount: -2_000 });
    await add({ accountId: house.id, date: '2026-11-07', memo: 'tracking', amount: -900 });
    await add({
      accountId: checking.id,
      date: '2026-11-08',
      memo: 'split',
      amount: -600,
      lines: [
        { amount: -100 },
        { amount: -200, categoryId: groceries.id },
        { amount: -300, payeeId: savings.transferPayeeId },
      ],
    });
    await add({
      accountId: checking.id,
      date: '2026-11-09',
      memo: 'categorized split',
      amount: -100,
      lines: [
        { amount: -40, categoryId: groceries.id },
        { amount: -60, categoryId: groceries.id },
      ],
    });
    await add({ accountId: checking.id, date: '2026-11-10', categoryId: groceries.id, amount: -400 });

    const month = await json<BudgetMonthDto>(await ctx.client.get('/api/budget/2026-11'));
    const uncategorized = month.body.uncategorized!;
    const page = await register({ categoryId: uncategorized.id, from: '2026-11-01', to: '2026-11-30' });
    expect(memos(page)).toEqual(['split', 'card', 'plain']);
    const lines = page.transactions.flatMap((txn) =>
      txn.isSplit ? txn.lines.filter((line) => line.categoryId === null && line.transfer === null) : [txn],
    );
    const total = lines.reduce((sum, line) => sum + line.amountBase, 0);
    expect(total).toBe(uncategorized.activity);
    expect(total).toBe(-100 - 1_100 - 700);
  });

  it('leaves out deleted transactions and refuses invalid filters', async () => {
    const { checking, weekly } = await setUp();
    await t.db.update(transaction).set({ deletedAt: new Date() }).where(eq(transaction.id, weekly.id));
    expect(memos(await register({ accountId: checking.id }))).toEqual(['mixed', 'saving', null]);

    const errors = async (query: string) => {
      const res = await json<{ fieldErrors: Record<string, string[]> }>(
        await ctx.client.get(`/api/transactions?${query}`),
      );
      expect(res.status).toBe(400);
      return res.body.fieldErrors;
    };
    expect(await errors('from=2026-11-15&to=2026-11-10')).toEqual({
      to: ['The end date must not be before the start date.'],
    });
    expect(await errors('from=0000-01-01')).toEqual({ from: ['Use a date from 1970-01-01 on.'] });
    expect(await errors(`cursor=2026-13-45_${weekly.id}`)).toEqual({ cursor: ['Invalid cursor.'] });
    expect(await errors(`cursor=2026-11-10_${'-'.repeat(36)}`)).toEqual({ cursor: ['Invalid cursor.'] });
    expect(await errors('minAmount=1.5')).toEqual({ minAmount: ['Enter a whole amount in minor units.'] });
    expect(Object.keys(await errors('flag=pink&cleared=maybe'))).toEqual(['flag', 'cleared']);
    expect(await json(await ctx.client.get(`/api/transactions?accountId=${crypto.randomUUID()}`))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Account not found.' },
    });
  });
});
