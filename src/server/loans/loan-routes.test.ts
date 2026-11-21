import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto, AccountListResponse } from '../../shared/api/accounts';
import type { LoanDto } from '../../shared/api/loans';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let checking: AccountDto;
let loan: AccountDto;
/** The loan's side of the November payment (uncleared). */
let payment: string;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
  checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 2_000_000 });
  // 100 000 zł at 6 % APR, paid 1 000 zł a month.
  loan = await createAccount(ctx.client, {
    name: 'Mortgage',
    type: 'mortgage',
    startingBalance: -10_000_000,
    startingDate: '2026-10-01',
    interestRate: '6',
    minPayment: 100_000,
    createPairedCategory: true,
  });
  const sent = await createTransaction(ctx.client, {
    accountId: checking.id,
    date: '2026-11-05',
    payeeId: loan.transferPayeeId,
    categoryId: loan.pairedCategoryId,
    amount: -100_000,
  });
  payment = sent.transfer!.transactionId;
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const schedule = async (id = loan.id) => json<LoanDto>(await ctx.client.get(`/api/accounts/${id}/loan`));
const november = async () => (await schedule()).body.months.find((m) => m.month === '2026-11')!;
const override = (month: string, body: object, id = loan.id) =>
  ctx.client.send('PUT', `/api/accounts/${id}/interest-overrides/${month}`, body);
const reset = (month: string) => ctx.client.send('DELETE', `/api/accounts/${loan.id}/interest-overrides/${month}`);

describe('GET /api/accounts/:id/loan', () => {
  it('splits a payment into interest, escrow and principal (golden scenario 9)', async () => {
    expect(await schedule()).toEqual({
      status: 200,
      body: {
        accountId: loan.id,
        currency: 'PLN',
        interestRate: '6.0000',
        minPayment: 100_000,
        escrowAmount: null,
        months: [
          expect.objectContaining({ month: '2026-10', interest: 0, chargedOn: null, endBalance: -10_000_000 }),
          {
            month: '2026-11',
            startBalance: -10_000_000,
            transactionsTotal: 100_000,
            interest: 50_000,
            interestBase: 50_000,
            interestOverridden: false,
            escrow: 0,
            escrowBase: 0,
            endBalance: -9_950_000,
            principalPaid: 50_000,
            chargedOn: '2026-11-05',
            chargesCleared: false,
          },
        ],
      },
    });

    // With escrow 200 zł, the same payment pays 300 zł of principal.
    await ctx.client.send('PATCH', `/api/accounts/${loan.id}`, { escrowAmount: 20_000 });
    expect(await november()).toMatchObject({ interest: 50_000, escrow: 20_000, principalPaid: 30_000 });
    const { accounts } = (await json<AccountListResponse>(await ctx.client.get('/api/accounts'))).body;
    expect(accounts.find((a) => a.id === loan.id)!.balance.working).toBe(-9_970_000);
  });

  it("clears a month's interest and escrow rows once all its payments are cleared", async () => {
    await ctx.client.send('PATCH', `/api/accounts/${loan.id}`, { escrowAmount: 20_000 });
    expect(await november()).toMatchObject({ interest: 50_000, escrow: 20_000, chargesCleared: false });
    const { accounts } = (await json<AccountListResponse>(await ctx.client.get('/api/accounts'))).body;
    expect(accounts.find((a) => a.id === loan.id)!.balance).toEqual({
      cleared: -10_000_000,
      uncleared: 30_000,
      working: -9_970_000,
    });

    await ctx.client.send('PATCH', `/api/transactions/${payment}`, { cleared: 'cleared' });
    expect(await november()).toMatchObject({ interest: 50_000, escrow: 20_000, chargesCleared: true });
  });

  it('is for loans only', async () => {
    expect(await schedule(checking.id)).toEqual({
      status: 422,
      body: { code: 'not_a_loan', message: 'Only loans have interest and escrow.' },
    });
    expect((await schedule(crypto.randomUUID())).status).toBe(404);
  });
});

describe('interest overrides', () => {
  it("replaces a month's computed interest until it is reset; each change is undoable", async () => {
    const before = await snapshot(t.db);
    const res = await json<LoanDto>(await override('2026-11', { amount: 40_000 }));
    expect(res.status).toBe(200);
    expect(res.body.months[1]).toMatchObject({ interest: 40_000, interestOverridden: true, principalPaid: 60_000 });
    const after = await snapshot(t.db);
    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Set the interest of "Mortgage" for 2026-11' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);

    await override('2026-11', { amount: 45_000 });
    expect(await november()).toMatchObject({ interest: 45_000, interestOverridden: true });
    const changed = await snapshot(t.db);
    expect((await json<LoanDto>(await reset('2026-11'))).body.months[1]).toMatchObject({
      interest: 50_000,
      interestOverridden: false,
    });
    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Reset the interest of "Mortgage" for 2026-11' },
    });
    expect(await snapshot(t.db)).toEqual(changed);
    await ctx.client.post('/api/redo');
    expect(await json(await reset('2026-11'))).toMatchObject({ status: 404 });
  });

  it('takes months from the first transaction to the current one, on loans only', async () => {
    expect(await json(await override('2026-09', { amount: 1 }))).toEqual({
      status: 422,
      body: {
        code: 'month_out_of_range',
        message: 'Pick a month from 2026-10 to 2026-11.',
        fieldErrors: { month: ['Pick a month from 2026-10 to 2026-11.'] },
      },
    });
    expect((await json(await override('2026-12', { amount: 1 }))).body).toMatchObject({ code: 'month_out_of_range' });
    expect((await override('2026-10', { amount: 0 })).status).toBe(200);
    expect((await json(await override('2026-11', { amount: 1 }, checking.id))).body).toMatchObject({
      code: 'not_a_loan',
    });
    expect((await json(await override('2026-11', { amount: -1 }))).body).toMatchObject({
      code: 'validation',
      fieldErrors: { amount: ['Enter 0 or more.'] },
    });
    expect((await json(await override('2026-11', { amount: 10_000_000_000_001 }))).body).toMatchObject({
      code: 'validation',
      fieldErrors: { amount: ['Amount is too large.'] },
    });
    expect((await override('2026-11', { amount: 10_000_000_000_000 })).status).toBe(200);
    expect((await json(await override('2026-13', { amount: 1 }))).body).toMatchObject({
      fieldErrors: { month: ['Use the format YYYY-MM.'] },
    });
  });
});
