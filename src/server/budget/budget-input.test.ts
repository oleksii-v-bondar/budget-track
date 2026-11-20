import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ActivityRow, type BudgetCategory, computeBudget } from '../../engine';
import type { AccountDto } from '../../shared/api/accounts';
import type { CategoryDto } from '../../shared/api/categories';
import { systemCategoryId } from '../db/lookups';
import { subtransaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, insertTransaction, type NewTransaction } from '../test/fixtures';
import { loadBudgetInput } from './budget-input';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  // Setup on 20 November 2026 makes 2026-11 the configured budget start month.
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

const TODAY = '2026-11-20';

const txn = (values: NewTransaction) => insertTransaction(t.db, values);

/** Both sides of a transfer of `amount` from `from` to `to`, optionally categorized on either side. */
async function transfer(
  from: AccountDto,
  to: AccountDto,
  date: string,
  amount: number,
  category: { from?: string; to?: string } = {},
) {
  const out = await txn({ accountId: from.id, date, amount: -amount, transferAccountId: to.id, categoryId: category.from });
  await txn({ accountId: to.id, date, amount, transferAccountId: from.id, transferTxnId: out.id, categoryId: category.to });
}

const assign = (month: string, categoryId: string, amount: number) =>
  ctx.client.send('PUT', `/api/budget/${month}/assignments/${categoryId}`, { amount });

describe('loadBudgetInput', () => {
  it('aggregates the ledger into engine input (spec §5.1, §5.3, §5.5)', async () => {
    const checking = await createAccount(ctx.client, {
      name: 'Checking',
      startingBalance: 500_000,
      startingDate: '2026-10-01',
    });
    const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
    const visa = await createAccount(ctx.client, {
      name: 'Visa',
      type: 'credit_card',
      startingBalance: -37_500,
      startingDate: '2026-10-01',
    });
    const mortgage = await createAccount(ctx.client, {
      name: 'Mortgage',
      type: 'mortgage',
      startingBalance: -10_000_000,
      minPayment: 60_000,
      createPairedCategory: true,
    });
    const brokerage = await createAccount(ctx.client, { name: 'Brokerage', type: 'other_asset', startingBalance: 90_000 });
    const group = await createGroup(ctx.client, 'Everyday');
    const groceries = await createCategory(ctx.client, group.id, 'Groceries');
    const rent = await createCategory(ctx.client, group.id, 'Rent');
    const rta = await systemCategoryId(t.db, 'rta');
    const uncategorized = await systemCategoryId(t.db, 'uncategorized');

    await txn({ accountId: checking.id, date: '2026-10-05', amount: -30_000, categoryId: groceries.id });
    await txn({ accountId: checking.id, date: '2026-11-03', amount: -8_000, categoryId: groceries.id });
    await txn({ accountId: visa.id, date: '2026-11-04', amount: -5_000, categoryId: groceries.id });
    await txn({ accountId: visa.id, date: '2026-11-06', amount: 1_500, categoryId: groceries.id, memo: 'refund' });
    const split = await txn({ accountId: checking.id, date: '2026-11-07', amount: -5_000, isSplit: true });
    await t.db.insert(subtransaction).values([
      { txnId: split.id, amount: -3_000, amountBase: -3_000, categoryId: groceries.id },
      { txnId: split.id, amount: -2_000, amountBase: -2_000, categoryId: rent.id },
    ]);
    await txn({ accountId: checking.id, date: '2026-11-08', amount: -1_000 });
    await transfer(checking, visa, '2026-11-10', 10_000);
    await transfer(checking, savings, '2026-11-11', 20_000);
    await transfer(checking, mortgage, '2026-11-12', 60_000, { from: mortgage.pairedCategoryId! });
    await transfer(brokerage, checking, '2026-11-13', 5_000, { to: rta });
    await txn({ accountId: visa.id, date: '2026-11-14', amount: 200, categoryId: rta, memo: 'cashback' });
    await txn({ accountId: checking.id, date: '2026-11-21', amount: -999, categoryId: groceries.id });
    await txn({ accountId: checking.id, date: '2026-11-15', amount: -777, categoryId: groceries.id, deletedAt: new Date() });
    await assign('2026-11', groceries.id, 40_000);
    await assign('2026-11', visa.paymentCategoryId!, 5_000);
    await assign('2026-12', rent.id, 100_000);

    const input = await loadBudgetInput(t.db, { throughMonth: '2026-11', today: TODAY });

    const names = new Map<string, string>([
      [rta, 'RTA'],
      [uncategorized, 'Uncategorized'],
      [groceries.id, 'Groceries'],
      [rent.id, 'Rent'],
      [mortgage.pairedCategoryId!, 'Mortgage (paired)'],
      [visa.paymentCategoryId!, 'Visa (payment)'],
      [checking.id, 'Checking'],
      [savings.id, 'Savings'],
      [visa.id, 'Visa'],
    ]);
    const name = (id: string) => names.get(id) ?? id;
    expect(input).toMatchObject({ startMonth: '2026-10', throughMonth: '2026-11', rtaCategoryId: rta });
    const described = (c: BudgetCategory) => `${name(c.id)} ${c.kind} ${c.linkedAccountId ? name(c.linkedAccountId) : '-'}`;
    expect(input.categories.map(described).sort()).toEqual([
      'Groceries normal -',
      'Mortgage (paired) normal -',
      'Rent normal -',
      'Uncategorized uncategorized -',
      'Visa (payment) cc_payment Visa',
    ]);
    const line = (r: ActivityRow) => `${r.month} ${name(r.categoryId)} ${name(r.accountId)} ${r.accountClass} ${r.amount}`;
    expect(input.activity.map(line).sort()).toEqual([
      // Cash starting balances are income (Savings starts at 0); the credit and tracking ones are left out.
      '2026-10 Groceries Checking cash -30000',
      '2026-10 RTA Checking cash 500000',
      // Cash spending plus the split line; card spending net of the refund.
      '2026-11 Groceries Checking cash -11000',
      '2026-11 Groceries Visa credit -3500',
      // The categorized transfer to the mortgage counts; its tracking side and checking → savings don't.
      '2026-11 Mortgage (paired) Checking cash -60000',
      '2026-11 RTA Checking cash 5000',
      '2026-11 RTA Savings cash 0',
      '2026-11 RTA Visa credit 200',
      '2026-11 Rent Checking cash -2000',
      '2026-11 Uncategorized Checking cash -1000',
    ]);
    expect(input.cardTransfers).toEqual([{ month: '2026-11', cardAccountId: visa.id, amount: 10_000 }]);
    expect(input.assignments.map((a) => `${a.month} ${name(a.categoryId)} ${a.amount}`).sort()).toEqual([
      '2026-11 Groceries 40000',
      '2026-11 Visa (payment) 5000',
      '2026-12 Rent 100000',
    ]);
    // The engine accepts it as is.
    expect(computeBudget(input).months).toEqual(['2026-10', '2026-11', '2026-12']);
  });

  it('reproduces golden scenario 1 end to end (spec §14)', async () => {
    // Available 100, cash spend 80, card spend 50 → Available −30 yellow (creditOver 30); card payment +20.
    const checking = await createAccount(ctx.client, { name: 'Checking' });
    const visa = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const group = await createGroup(ctx.client, 'Everyday');
    const groceries: CategoryDto = await createCategory(ctx.client, group.id, 'Groceries');
    await assign('2026-11', groceries.id, 10_000);
    await txn({ accountId: checking.id, date: '2026-11-05', amount: -8_000, categoryId: groceries.id });
    await txn({ accountId: visa.id, date: '2026-11-06', amount: -5_000, categoryId: groceries.id });

    const server = computeBudget(await loadBudgetInput(t.db, { throughMonth: '2026-11', today: TODAY }));
    const uncategorized = await systemCategoryId(t.db, 'uncategorized');
    const engine = computeBudget({
      startMonth: '2026-11',
      throughMonth: '2026-11',
      rtaCategoryId: await systemCategoryId(t.db, 'rta'),
      categories: [
        { id: groceries.id, kind: 'normal' },
        { id: visa.paymentCategoryId!, kind: 'cc_payment', linkedAccountId: visa.id },
        { id: uncategorized, kind: 'uncategorized' },
      ],
      assignments: [{ month: '2026-11', categoryId: groceries.id, amount: 10_000 }],
      activity: [
        { month: '2026-11', categoryId: groceries.id, accountId: checking.id, accountClass: 'cash', amount: -8_000 },
        { month: '2026-11', categoryId: groceries.id, accountId: visa.id, accountClass: 'credit', amount: -5_000 },
      ],
    });
    expect(server).toEqual(engine);
    expect(server.byMonth['2026-11']!.categories[groceries.id]).toMatchObject({
      available: -3_000,
      cashOverspent: 0,
      creditOverspent: 3_000,
      creditOverByCard: { [visa.id]: 3_000 },
    });
    expect(server.byMonth['2026-11']!.categories[visa.paymentCategoryId!]).toMatchObject({
      activity: 2_000,
      available: 2_000,
    });
  });

  it('counts lines dated up to today only', async () => {
    const checking = await createAccount(ctx.client, { name: 'Checking' });
    const group = await createGroup(ctx.client, 'Everyday');
    const groceries = await createCategory(ctx.client, group.id, 'Groceries');
    await txn({ accountId: checking.id, date: '2026-11-20', amount: -100, categoryId: groceries.id });
    await txn({ accountId: checking.id, date: '2026-11-21', amount: -200, categoryId: groceries.id });
    const amounts = async (today: string) =>
      (await loadBudgetInput(t.db, { throughMonth: '2026-11', today })).activity
        .filter((r) => r.categoryId === groceries.id)
        .map((r) => r.amount);
    expect(await amounts('2026-11-20')).toEqual([-100]);
    expect(await amounts('2026-11-21')).toEqual([-300]);
  });

  it('starts at the first editable month: an assignment or a note left before the budget start', async () => {
    const cash = await createAccount(ctx.client, { name: 'Cash', type: 'cash', startingDate: '2026-01-15' });
    const group = await createGroup(ctx.client, 'Everyday');
    const groceries = await createCategory(ctx.client, group.id, 'Groceries');
    expect((await ctx.client.send('PUT', '/api/budget/2026-01/note', { note: 'New year' })).status).toBe(200);
    expect((await assign('2026-03', groceries.id, 1_000)).status).toBe(200);
    expect((await ctx.client.send('DELETE', `/api/accounts/${cash.id}`)).status).toBe(200);
    const start = async () => (await loadBudgetInput(t.db, { throughMonth: '2026-11', today: TODAY })).startMonth;

    // The budget start is 2026-11 again, but the note and the assignment keep their months in the budget.
    expect(await start()).toBe('2026-01');
    expect((await ctx.client.send('PUT', '/api/budget/2026-01/note', { note: '' })).status).toBe(200);
    expect(await start()).toBe('2026-03');
    expect((await assign('2026-03', groceries.id, 0)).status).toBe(200);
    expect(await start()).toBe('2026-11');
  });
});
