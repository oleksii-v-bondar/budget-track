import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto, ReconcileResponse, ReconcileStatusDto } from '../../shared/api/accounts';
import type { BudgetMonthDto } from '../../shared/api/budget';
import { systemCategoryId } from '../db/lookups';
import { transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction } from '../test/fixtures';
import { stubFx } from '../test/fx';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let checking: AccountDto;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z', fx: stubFx({ EUR: { '2026-11-20': '4.3' } }) });
  await setUpBudget(ctx);
  checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const status = async (id: string) =>
  (await json<ReconcileStatusDto>(await ctx.client.get(`/api/accounts/${id}/reconcile`))).body;
const reconcile = (id: string, body: object) => ctx.client.post(`/api/accounts/${id}/reconcile`, body);
const clearedOf = async (accountId: string) =>
  (await t.db.select().from(transaction).where(eq(transaction.accountId, accountId)))
    .map((r) => [r.amount, r.cleared])
    .sort((a, b) => Number(a[0]) - Number(b[0]));
const readyToAssign = async () =>
  (await json<BudgetMonthDto>(await ctx.client.get('/api/budget/2026-11'))).body.rta.readyToAssign;

describe('reconcile', () => {
  it('shows the cleared balance, and reconciles every cleared transaction when the statement matches', async () => {
    await createTransaction(ctx.client, { accountId: checking.id, amount: -5_000, cleared: 'cleared' });
    const open = await createTransaction(ctx.client, { accountId: checking.id, amount: -20_000 });
    expect(await status(checking.id)).toEqual({
      accountId: checking.id,
      currency: 'PLN',
      clearedBalance: 95_000,
      lastReconciledAt: null,
      lastReconciledBalance: null,
    });
    const before = await snapshot(t.db);

    const res = await json<ReconcileResponse>(await reconcile(checking.id, { statementBalance: 95_000 }));
    expect(res).toEqual({
      status: 200,
      body: {
        accountId: checking.id,
        currency: 'PLN',
        clearedBalance: 95_000,
        lastReconciledAt: '2026-11-20T10:00:00.000Z',
        lastReconciledBalance: 95_000,
        adjustment: null,
        reconciledCount: 2,
      },
    });
    expect(await clearedOf(checking.id)).toEqual([
      [-20_000, 'uncleared'],
      [-5_000, 'reconciled'],
      [100_000, 'reconciled'],
    ]);
    const after = await snapshot(t.db);
    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Reconcile "mBank"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);

    // P2c's rules still guard reconciled rows; the uncleared one is free.
    const [opening] = await t.db.select().from(transaction).where(eq(transaction.isStartingBalance, true));
    const path = `/api/transactions/${opening!.id}`;
    expect((await json(await ctx.client.send('PATCH', path, { amount: 1 }))).body).toMatchObject({
      code: 'confirm_reconciled',
    });
    expect((await ctx.client.send('PATCH', path, { amount: 1, confirmReconciled: true })).status).toBe(200);
    expect((await ctx.client.send('PATCH', `/api/transactions/${open.id}`, { amount: -1 })).status).toBe(200);
  });

  it('refuses a different statement balance unless asked to create an adjustment', async () => {
    const before = await snapshot(t.db);
    expect(await json(await reconcile(checking.id, { statementBalance: 99_000 }))).toEqual({
      status: 422,
      body: {
        code: 'reconcile_mismatch',
        message: "The cleared balance doesn't match the statement. Review the transactions, or create an adjustment.",
        difference: -1_000,
      },
    });
    expect(await snapshot(t.db)).toEqual(before);

    const res = await json<ReconcileResponse>(
      await reconcile(checking.id, { statementBalance: 99_000, createAdjustment: true }),
    );
    expect(res.body).toMatchObject({ clearedBalance: 99_000, lastReconciledBalance: 99_000, reconciledCount: 2 });
    expect(res.body.adjustment).toMatchObject({
      date: '2026-11-20',
      payeeName: 'Reconciliation Balance Adjustment',
      categoryId: await systemCategoryId(t.db, 'rta'),
      amount: -1_000,
      amountBase: -1_000,
      cleared: 'reconciled',
    });
    expect(await readyToAssign()).toBe(99_000);
    // One command: a single undo removes the adjustment and the reconciliation.
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('books a foreign adjustment at today’s NBP rate or the one sent; tracking accounts take no category', async () => {
    const euro = await createAccount(ctx.client, {
      name: 'Revolut',
      type: 'savings',
      currency: 'EUR',
      startingBalance: 1_000,
      fxRate: '4.25',
    });
    const nbp = await json<ReconcileResponse>(
      await reconcile(euro.id, { statementBalance: 1_100, createAdjustment: true }),
    );
    expect(nbp.body.adjustment).toMatchObject({ amount: 100, amountBase: 430, fxRateManual: false });

    const loan = await createAccount(ctx.client, {
      name: 'Car loan',
      type: 'auto_loan',
      currency: 'USD',
      startingBalance: -5_000,
      fxRate: '3.9',
    });
    const statement = { statementBalance: -5_200, createAdjustment: true };
    expect((await json(await reconcile(loan.id, statement))).body).toMatchObject({ code: 'fx_rate_required' });
    const manual = await json<ReconcileResponse>(await reconcile(loan.id, { ...statement, fxRate: '4' }));
    expect(manual.body.adjustment).toMatchObject({
      categoryId: null,
      amount: -200,
      amountBase: -800,
      fxRate: '4.000000',
      fxRateManual: true,
    });
  });

  it('keeps the adjustment within ±MAX_BASE_AMOUNT in PLN', async () => {
    const tooLarge = {
      status: 422,
      body: {
        code: 'amount_too_large',
        message: 'That amount is too large.',
        fieldErrors: { statementBalance: ['That amount is too large.'] },
      },
    };
    for (let i = 0; i < 9; i++) {
      await createTransaction(ctx.client, { accountId: checking.id, amount: 10_000_000_000_000, cleared: 'cleared' });
    }
    const euro = await createAccount(ctx.client, { name: 'Revolut', type: 'savings', currency: 'EUR', fxRate: '4.3' });
    const before = await snapshot(t.db);
    // A PLN adjustment of −10^13 − (9 × 10^13 + 10^5 cleared), and 10^13 EUR at 10.000001 zł.
    const pln = { statementBalance: -10_000_000_000_000, createAdjustment: true };
    const eur = { statementBalance: 10_000_000_000_000, createAdjustment: true };
    expect(await json(await reconcile(checking.id, pln))).toEqual(tooLarge);
    expect(await json(await reconcile(euro.id, { ...eur, fxRate: '10.000001' }))).toEqual(tooLarge);
    expect(await snapshot(t.db)).toEqual(before);

    const plnRes = await json<ReconcileResponse>(
      await reconcile(checking.id, { ...pln, statementBalance: -9_999_999_900_000 }),
    );
    expect(plnRes.body.adjustment).toMatchObject({ amount: -100_000_000_000_000, amountBase: -100_000_000_000_000 });
    const eurRes = await json<ReconcileResponse>(await reconcile(euro.id, { ...eur, fxRate: '10' }));
    expect(eurRes.body.adjustment).toMatchObject({ amount: 10_000_000_000_000, amountBase: 100_000_000_000_000 });
  });

  it('refuses closed and unknown accounts, and a rate without an adjustment', async () => {
    const old = await createAccount(ctx.client, { name: 'Old', type: 'savings' });
    await ctx.client.post(`/api/accounts/${old.id}/close`);
    expect((await json(await reconcile(old.id, { statementBalance: 0 }))).body).toMatchObject({
      code: 'account_closed',
    });
    expect((await reconcile(crypto.randomUUID(), { statementBalance: 0 })).status).toBe(404);
    expect((await ctx.client.get(`/api/accounts/${crypto.randomUUID()}/reconcile`)).status).toBe(404);
    expect((await json(await reconcile(checking.id, { statementBalance: 1, fxRate: '4' }))).body).toMatchObject({
      code: 'validation',
      fieldErrors: { fxRate: ['Only an adjustment takes an exchange rate.'] },
    });
    expect((await json(await reconcile(checking.id, { statementBalance: 10_000_000_000_001 }))).body).toMatchObject({
      code: 'validation',
      fieldErrors: { statementBalance: ['Amount is too large.'] },
    });
  });
});
