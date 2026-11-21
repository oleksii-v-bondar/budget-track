import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto, AccountListResponse, RevalueResponse } from '../../shared/api/accounts';
import type { BudgetMonthDto } from '../../shared/api/budget';
import type { TransactionDto } from '../../shared/api/transactions';
import { systemCategoryId, systemPayeeId } from '../db/lookups';
import { ledgerLine, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction, ledgerLines } from '../test/fixtures';
import { type StubFx, stubFx } from '../test/fx';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let fx: StubFx;
let nbp: Record<string, Record<string, string>>;
beforeEach(async () => {
  t = await createTestDatabase();
  nbp = { EUR: { '2026-11-19': '4.3', '2026-11-20': '4.4' } };
  fx = stubFx(nbp);
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z', fx });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const accounts = async () => (await json<AccountListResponse>(await ctx.client.get('/api/accounts'))).body.accounts;
const readyToAssign = async () =>
  (await json<BudgetMonthDto>(await ctx.client.get('/api/budget/2026-11'))).body.rta.readyToAssign;
const revalue = (id: string, body?: object) => ctx.client.post(`/api/accounts/${id}/revalue`, body);
const foreign = (name: string, extra: object = {}) =>
  createAccount(ctx.client, { name, type: 'savings', currency: 'EUR', startingDate: '2026-11-19', ...extra });

describe('"≈ X zł" on accounts', () => {
  it('shows foreign balances at the latest NBP rate, quoting each currency once', async () => {
    await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
    await foreign('Revolut', { startingBalance: 9_300 });
    await foreign('Wise', { startingBalance: -1_001 });
    await createAccount(ctx.client, { name: 'Dollars', type: 'savings', currency: 'USD', fxRate: '3.9' });
    fx.calls.splice(0);

    const list = await accounts();
    expect(list.map((a) => [a.name, a.balanceBase.working, a.latestRate, a.balanceAtLatestRate])).toEqual([
      ['mBank', 100_000, null, null],
      ['Revolut', 39_990, { rate: '4.400000', effectiveDate: '2026-11-20' }, 40_920],
      // −1 001 × 4.4 = −4 404.4 → −4 404
      ['Wise', -4_304, { rate: '4.400000', effectiveDate: '2026-11-20' }, -4_404],
      // NBP has no USD rate in this stub.
      ['Dollars', 0, null, null],
    ]);
    expect(fx.calls.sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([
      { currency: 'EUR', date: '2026-11-20' },
      { currency: 'USD', date: '2026-11-20' },
    ]);
  });

  it("quotes today's rate once when a foreign account dated today is created", async () => {
    fx.calls.splice(0);
    const euro = await foreign('Revolut', { startingDate: '2026-11-20', startingBalance: 1_000 });
    expect(euro).toMatchObject({ balanceBase: { working: 4_400 }, latestRate: { rate: '4.400000' } });
    expect(fx.calls).toEqual([{ currency: 'EUR', date: '2026-11-20' }]);
  });

  it('shows no "≈ X zł" for a balance beyond the safe integer range', async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Euro mortgage',
      type: 'mortgage',
      currency: 'EUR',
      startingBalance: -1,
      startingDate: '2026-10-01',
      fxRate: '1',
      escrowAmount: 10_000_000_000_000,
    });
    // As if booked by ~900 rows at the cap: the sum still fits, the escrow charged with a payment pushes it past 2^53.
    const huge = -(Number.MAX_SAFE_INTEGER - 1);
    await t.db.update(transaction).set({ amount: huge, amountBase: huge }).where(eq(transaction.accountId, loan.id));
    await createTransaction(ctx.client, {
      accountId: loan.id,
      date: '2026-11-05',
      payeeName: 'Bank',
      amount: 1,
      fxRate: '1',
    });

    const res = await ctx.client.get('/api/accounts');
    expect(res.status).toBe(200);
    const [shown] = ((await res.json()) as AccountListResponse).accounts;
    expect(shown).toMatchObject({ latestRate: { rate: '4.400000' }, balanceAtLatestRate: null });
    expect(Number.isSafeInteger(shown!.balance.working)).toBe(false);
  });
});

describe('POST /api/accounts/:id/revalue', () => {
  it('nets a PLN → EUR transfer to 0 and revalues the difference into Ready to Assign (golden 11)', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
    const euro = await foreign('Revolut');
    await createTransaction(ctx.client, {
      accountId: checking.id,
      date: '2026-11-19',
      payeeId: euro.transferPayeeId,
      amount: -40_000,
      transferAmount: 9_300,
    });
    expect(await readyToAssign()).toBe(100_000);
    const before = await snapshot(t.db);

    fx.calls.splice(0);
    const res = await json<RevalueResponse>(await revalue(euro.id));
    expect(res.status).toBe(200);
    // The latest rate is quoted once, for the revaluation and the account it answers with.
    expect(fx.calls).toEqual([{ currency: 'EUR', date: '2026-11-20' }]);
    // 9 300 × 4.4 = 40 920; 40 000 was booked.
    expect(res.body.transaction).toMatchObject<Partial<TransactionDto>>({
      accountId: euro.id,
      date: '2026-11-20',
      payeeId: await systemPayeeId(t.db, 'fx_revaluation'),
      payeeName: 'FX revaluation',
      categoryId: await systemCategoryId(t.db, 'rta'),
      amount: 0,
      amountBase: 920,
      fxRate: '4.400000',
      fxRateManual: false,
      cleared: 'cleared',
    });
    expect(res.body.account).toMatchObject<Partial<AccountDto>>({
      balance: { cleared: 0, uncleared: 9_300, working: 9_300 },
      balanceBase: { cleared: 920, uncleared: 40_000, working: 40_920 },
      balanceAtLatestRate: 40_920,
    });
    expect(await readyToAssign()).toBe(100_920);
    expect((await ledgerLines(t.db, eq(ledgerLine.txnId, res.body.transaction.id))).map((l) => l.amountBase)).toEqual([
      920,
    ]);
    const after = await snapshot(t.db);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Revalue "Revolut"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
    expect((await json(await revalue(euro.id))).body).toMatchObject({ code: 'revalue_no_difference' });
  });

  it('revalues a tracking account without a category, at a rate the user sends when NBP has none', async () => {
    delete nbp.EUR;
    const loan = await createAccount(ctx.client, {
      name: 'Car loan',
      type: 'auto_loan',
      currency: 'EUR',
      startingBalance: -10_000,
      fxRate: '4.3',
    });
    expect(await json(await revalue(loan.id))).toEqual({
      status: 422,
      body: {
        code: 'fx_rate_required',
        message: 'Enter the exchange rate of EUR to PLN.',
        fieldErrors: { fxRate: ['Enter the exchange rate of EUR to PLN.'] },
      },
    });
    const res = await json<RevalueResponse>(await revalue(loan.id, { fxRate: '4.35' }));
    expect(res.body.transaction).toMatchObject({
      categoryId: null,
      amount: 0,
      amountBase: -500,
      fxRate: '4.350000',
      fxRateManual: true,
    });
    expect(await readyToAssign()).toBe(0);
  });

  it('refuses PLN, closed and unknown accounts', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    expect(await json(await revalue(checking.id))).toEqual({
      status: 422,
      body: { code: 'revalue_pln', message: 'PLN accounts have nothing to revalue.' },
    });
    const euro = await foreign('Revolut');
    await ctx.client.post(`/api/accounts/${euro.id}/close`);
    expect((await json(await revalue(euro.id))).body).toMatchObject({ code: 'account_closed' });
    expect((await json(await revalue(crypto.randomUUID()))).status).toBe(404);
  });

  it('caps the PLN difference at MAX_BASE_AMOUNT', async () => {
    const euro = await foreign('Revolut', { startingBalance: 10_000_000_000_000, fxRate: '1' });
    const before = await snapshot(t.db);
    // 10^13 × 12 − 10^13 = 1.1 × 10^14
    expect(await json(await revalue(euro.id, { fxRate: '12' }))).toEqual({
      status: 422,
      body: {
        code: 'amount_too_large',
        message: 'That amount is too large.',
        fieldErrors: { fxRate: ['That amount is too large.'] },
      },
    });
    expect(await snapshot(t.db)).toEqual(before);
    const res = await json<RevalueResponse>(await revalue(euro.id, { fxRate: '11' }));
    expect(res.body.transaction.amountBase).toBe(100_000_000_000_000);
  });

  it('keeps an FX revaluation to its memo, flag and cleared status; deleting it takes it back', async () => {
    const euro = await foreign('Revolut', { startingBalance: 1_000 });
    const { body } = await json<RevalueResponse>(await revalue(euro.id));
    const path = `/api/transactions/${body.transaction.id}`;

    expect((await json(await ctx.client.send('PATCH', path, { memo: 'Nov', flag: 'blue' }))).body).toMatchObject({
      memo: 'Nov',
      flag: 'blue',
      amountBase: 100,
    });
    const fixed = 'An FX revaluation only takes a memo, flag or cleared status. Delete it to take it back.';
    expect(await json(await ctx.client.send('PATCH', path, { date: '2026-11-19' }))).toEqual({
      status: 422,
      body: { code: 'revaluation_fixed', message: fixed, fieldErrors: { date: [fixed] } },
    });
    expect((await ctx.client.send('DELETE', path)).status).toBe(200);
    expect((await accounts())[0]!.balanceBase.working).toBe(4_300);
  });
});
