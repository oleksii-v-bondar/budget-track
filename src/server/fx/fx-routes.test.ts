import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import { account, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { type StubFx, stubFx } from '../test/fx';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let fx: StubFx;
beforeEach(async () => {
  t = await createTestDatabase();
  fx = stubFx({ EUR: { '2026-11-13': '4.2315', '2026-11-20': '4.25' }, KWD: '13.2' });
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z', fx });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

describe('GET /api/fx/rates/:currency/:date', () => {
  it('returns the NBP rate of the day', async () => {
    expect(await json(await ctx.client.get('/api/fx/rates/EUR/2026-11-13'))).toEqual({
      status: 200,
      body: { rate: '4.231500', effectiveDate: '2026-11-13' },
    });
    expect(fx.calls).toEqual([{ currency: 'EUR', date: '2026-11-13' }]);
  });

  it('answers 422 when NBP has no rate, and never asks for a future date', async () => {
    expect(await json(await ctx.client.get('/api/fx/rates/USD/2026-11-13'))).toEqual({
      status: 422,
      body: { code: 'fx_rate_unavailable', message: "There's no NBP rate for USD on 2026-11-13. Enter the rate." },
    });
    expect((await json(await ctx.client.get('/api/fx/rates/EUR/2026-11-21'))).body).toMatchObject({
      code: 'fx_rate_unavailable',
    });
    expect(fx.calls).toEqual([{ currency: 'USD', date: '2026-11-13' }]);
  });

  it('validates the currency and the date', async () => {
    const errors = async (path: string) => {
      const res = await json<{ fieldErrors: Record<string, string[]> }>(await ctx.client.get(path));
      expect(res.status).toBe(400);
      return res.body.fieldErrors;
    };
    expect(await errors('/api/fx/rates/PLN/2026-11-13')).toEqual({ currency: ['PLN is the budget currency.'] });
    expect(await errors('/api/fx/rates/eur/2026-11-13')).toEqual({
      currency: ['Use a 3-letter currency code, e.g. EUR.'],
    });
    expect(await errors('/api/fx/rates/EUR/2026-13-01')).toEqual({ date: ['Use the format YYYY-MM-DD.'] });
    expect(fx.calls).toEqual([]);
  });
});

describe('POST /api/accounts in a foreign currency', () => {
  const startingBalanceOf = async (accountId: string) => {
    const [txn] = await t.db
      .select()
      .from(transaction)
      .where(and(eq(transaction.accountId, accountId), eq(transaction.isStartingBalance, true)));
    return txn!;
  };
  const create = (body: object) =>
    ctx.client.post('/api/accounts', { name: 'Revolut EUR', type: 'savings', currency: 'EUR', ...body });

  it('books the starting balance at the NBP rate of its date when no rate is sent', async () => {
    const before = await snapshot(t.db);
    const res = await json<AccountDto>(await create({ startingBalance: 10_000, startingDate: '2026-11-13' }));
    expect(res).toMatchObject({ status: 201, body: { balanceBase: { cleared: 42_315 } } });
    expect(await startingBalanceOf(res.body.id)).toMatchObject({
      amount: 10_000,
      amountBase: 42_315,
      fxRate: '4.231500',
      fxRateManual: false,
    });
    // Quoted before the command ran.
    expect(fx.calls[0]).toEqual({ currency: 'EUR', date: '2026-11-13' });
    const after = await snapshot(t.db);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('keeps a rate the user sends as manual, without asking NBP', async () => {
    const body = { startingBalance: 10_000, startingDate: '2026-11-13', fxRate: '4.1' };
    const res = await json<AccountDto>(await create(body));
    expect(await startingBalanceOf(res.body.id)).toMatchObject({
      amountBase: 41_000,
      fxRate: '4.100000',
      fxRateManual: true,
    });
    expect(fx.calls).not.toContainEqual({ currency: 'EUR', date: '2026-11-13' });
  });

  it('asks for the rate when NBP has none, and quotes nothing for a future starting date', async () => {
    expect(await json(await create({ currency: 'USD', startingBalance: 500 }))).toEqual({
      status: 422,
      body: {
        code: 'fx_rate_required',
        message: 'Enter the exchange rate of USD to PLN for the starting balance.',
        fieldErrors: { fxRate: ['Enter the exchange rate of USD to PLN for the starting balance.'] },
      },
    });
    expect((await json(await create({ startingBalance: 500, startingDate: '2026-11-21' }))).body).toMatchObject({
      code: 'starting_date_in_future',
    });
    expect(fx.calls).toEqual([{ currency: 'USD', date: '2026-11-20' }]);
    expect(await t.db.select().from(account)).toEqual([]);
  });

  it('caps the PLN amount of a starting balance booked at the NBP rate', async () => {
    const message = 'That amount is too large.';
    expect(await json(await create({ currency: 'KWD', startingBalance: 10_000_000_000_000 }))).toEqual({
      status: 422,
      body: { code: 'amount_too_large', message, fieldErrors: { startingBalance: [message] } },
    });
    expect(fx.calls).toEqual([{ currency: 'KWD', date: '2026-11-20' }]);
    expect(await t.db.select().from(account)).toEqual([]);
  });
});
