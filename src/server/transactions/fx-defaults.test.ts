import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import type { TransactionDto } from '../../shared/api/transactions';
import { scheduledTransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction } from '../test/fixtures';
import { type StubFx, stubFx } from '../test/fx';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let fx: StubFx;
let euro: AccountDto;
beforeEach(async () => {
  t = await createTestDatabase();
  fx = stubFx({
    EUR: { '2026-11-18': '4.2', '2026-11-19': '4.3', '2026-11-20': '4.25' },
    USD: { '2026-11-19': '3.9' },
    KWD: '13.2',
  });
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z', fx });
  await setUpBudget(ctx);
  euro = await createAccount(ctx.client, { name: 'Revolut', type: 'savings', currency: 'EUR', fxRate: '4.25' });
  fx.calls.splice(0);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;
const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/transactions/${id}`, body);
const edit = async (id: string, body: object) => {
  const res = await json<TransactionDto>(await patch(id, body));
  if (res.status !== 200) throw new Error(`edit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
/** The quotes asked for since the last call. */
const quoted = () => fx.calls.splice(0);

describe('default NBP rates on new transactions', () => {
  it('books a foreign amount at the NBP rate of its date unless a rate is sent', async () => {
    const before = await snapshot(t.db);
    const nbp = await createTransaction(ctx.client, { accountId: euro.id, date: '2026-11-19', amount: -1_000 });
    expect(nbp).toMatchObject({ amountBase: -4_300, fxRate: '4.300000', fxRateManual: false });
    expect(quoted()).toEqual([{ currency: 'EUR', date: '2026-11-19' }]);
    const after = await snapshot(t.db);
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);

    const manual = await createTransaction(ctx.client, { accountId: euro.id, amount: -1_000, fxRate: '4.1' });
    expect(manual).toMatchObject({ amountBase: -4_100, fxRate: '4.100000', fxRateManual: true });
    expect(quoted()).toEqual([]);
  });

  it('asks for the rate when NBP has none for the date', async () => {
    const before = await snapshot(t.db);
    const res = await ctx.client.post('/api/transactions', { accountId: euro.id, date: '2026-11-17', amount: -1 });
    expect(await json(res)).toEqual({
      status: 422,
      body: {
        code: 'fx_rate_required',
        message: 'Enter the exchange rate of EUR to PLN.',
        fieldErrors: { fxRate: ['Enter the exchange rate of EUR to PLN.'] },
      },
    });
    expect(quoted()).toEqual([{ currency: 'EUR', date: '2026-11-17' }]);
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('stores no rate on a future-dated foreign transaction unless one is sent, and quotes nothing', async () => {
    const schedule = async (body: object) => {
      const res = await json<{ kind: string; scheduledId: string }>(
        await ctx.client.post('/api/transactions', { accountId: euro.id, date: '2026-11-25', amount: -1_000, ...body }),
      );
      expect(res).toMatchObject({ status: 201, body: { kind: 'scheduled' } });
      const [row] = await t.db
        .select()
        .from(scheduledTransaction)
        .where(eq(scheduledTransaction.id, res.body.scheduledId));
      return row!;
    };
    expect(await schedule({})).toMatchObject({ fxRate: null, fxRateManual: false });
    expect(await schedule({ lines: [{ amount: -400 }, { amount: -600 }] })).toMatchObject({
      isSplit: true,
      fxRate: null,
      fxRateManual: false,
    });
    expect(await schedule({ fxRate: '4.4' })).toMatchObject({ fxRate: '4.400000', fxRateManual: true });
    expect(quoted()).toEqual([]);
  });

  it('caps the PLN amount of a transaction booked at the NBP rate', async () => {
    const dinar = await createAccount(ctx.client, { name: 'KWD', type: 'savings', currency: 'KWD', fxRate: '13.2' });
    quoted();
    const before = await snapshot(t.db);
    // 10^13 is within the native cap; at 13.2 its PLN amount is over MAX_BASE_AMOUNT (10^14).
    const res = await ctx.client.post('/api/transactions', { accountId: dinar.id, amount: -10_000_000_000_000 });
    const message = 'That amount is too large.';
    expect(await json(res)).toEqual({
      status: 422,
      body: { code: 'amount_too_large', message, fieldErrors: { amount: [message] } },
    });
    expect(quoted()).toEqual([{ currency: 'KWD', date: '2026-11-20' }]);
    expect(await snapshot(t.db)).toEqual(before);
  });

  it("converts a split's lines at the NBP rate of its date", async () => {
    const split = await createTransaction(ctx.client, {
      accountId: euro.id,
      date: '2026-11-19',
      amount: -1_001,
      lines: [{ amount: -333 }, { amount: -668 }],
    });
    // −1 001 × 4.3 = −4 304.3 → −4 304; the last line takes the rounding remainder.
    expect(split).toMatchObject({ amountBase: -4_304, fxRate: '4.300000', fxRateManual: false });
    expect(split.lines.map((l) => l.amountBase)).toEqual([-1_432, -2_872]);
  });

  it('quotes the sending currency of a foreign ↔ foreign transfer, and nothing for PLN ↔ foreign', async () => {
    const dollar = await createAccount(ctx.client, { name: 'USD', type: 'savings', currency: 'USD', fxRate: '3.9' });
    const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
    quoted();
    // Entered on the receiving (USD) side: the sending EUR side's rate converts both.
    const received = await createTransaction(ctx.client, {
      accountId: dollar.id,
      date: '2026-11-19',
      payeeId: euro.transferPayeeId,
      amount: 11_500,
      transferAmount: -10_000,
    });
    expect(quoted()).toEqual([{ currency: 'EUR', date: '2026-11-19' }]);
    expect(received).toMatchObject({ amountBase: 43_000, fxRate: null, fxRateManual: false });
    expect(await get(received.transfer!.transactionId)).toMatchObject({
      amountBase: -43_000,
      fxRate: '4.300000',
      fxRateManual: false,
    });

    await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: euro.transferPayeeId,
      amount: -40_000,
      transferAmount: 9_300,
    });
    expect(quoted()).toEqual([]);
  });
});

describe('default NBP rates on edits', () => {
  it('re-fetches an NBP rate when the date changes and rebooks the base amounts', async () => {
    const txn = await createTransaction(ctx.client, { accountId: euro.id, date: '2026-11-19', amount: -1_000 });
    quoted();
    expect(await edit(txn.id, { amount: -2_000 })).toMatchObject({ amountBase: -8_600, fxRate: '4.300000' });
    expect(quoted()).toEqual([]);

    const before = await snapshot(t.db);
    expect(await edit(txn.id, { date: '2026-11-18' })).toMatchObject({
      amountBase: -8_400,
      fxRate: '4.200000',
      fxRateManual: false,
    });
    expect(quoted()).toEqual([{ currency: 'EUR', date: '2026-11-18' }]);
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);

    expect(await edit(txn.id, { fxRate: '4.5' })).toMatchObject({ amountBase: -9_000, fxRateManual: true });
  });

  it('rebooks split lines and the other side of a transfer at the new date’s rate', async () => {
    const split = await createTransaction(ctx.client, {
      accountId: euro.id,
      date: '2026-11-19',
      amount: -1_000,
      lines: [{ amount: -300 }, { amount: -700 }],
    });
    const moved = await edit(split.id, { date: '2026-11-18' });
    expect([moved.amountBase, ...moved.lines.map((l) => l.amountBase)]).toEqual([-4_200, -1_260, -2_940]);

    const dollar = await createAccount(ctx.client, { name: 'USD', type: 'savings', currency: 'USD', fxRate: '3.9' });
    const sent = await createTransaction(ctx.client, {
      accountId: euro.id,
      date: '2026-11-19',
      payeeId: dollar.transferPayeeId,
      amount: -10_000,
      transferAmount: 11_500,
    });
    quoted();
    // Edited on the receiving side: the sending side's NBP rate follows the new date.
    const received = await edit(sent.transfer!.transactionId, { date: '2026-11-18' });
    expect(quoted()).toEqual([{ currency: 'EUR', date: '2026-11-18' }]);
    expect(received).toMatchObject({ date: '2026-11-18', amountBase: 42_000 });
    expect(await get(sent.id)).toMatchObject({ date: '2026-11-18', amountBase: -42_000, fxRate: '4.200000' });
  });

  it('keeps a manual rate when the date changes', async () => {
    const txn = await createTransaction(ctx.client, {
      accountId: euro.id,
      date: '2026-11-19',
      amount: -1_000,
      fxRate: '4.1',
    });
    expect(await edit(txn.id, { date: '2026-11-18' })).toMatchObject({
      amountBase: -4_100,
      fxRate: '4.100000',
      fxRateManual: true,
    });
    expect(quoted()).toEqual([]);
  });

  it('asks for a rate when the new date has no NBP rate', async () => {
    const txn = await createTransaction(ctx.client, { accountId: euro.id, date: '2026-11-19', amount: -1_000 });
    const before = await snapshot(t.db);
    expect((await json(await patch(txn.id, { date: '2026-11-17' }))).body).toMatchObject({
      code: 'fx_rate_required',
      fieldErrors: { fxRate: ['Enter the exchange rate of EUR to PLN.'] },
    });
    expect(await snapshot(t.db)).toEqual(before);
    const [row] = await t.db.select().from(transaction).where(eq(transaction.id, txn.id));
    expect(row).toMatchObject({ date: '2026-11-19', fxRate: '4.300000' });
  });
});
