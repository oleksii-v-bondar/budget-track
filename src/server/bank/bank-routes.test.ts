import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BankStatus } from '../../shared/api/bank';
import { bankAccount, bankConnection, payee, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, createTransaction } from '../test/fixtures';
import { stubFx } from '../test/fx';
import { snapshot } from '../test/snapshot';

const REDIRECT = 'http://localhost:3080/api/bank/callback';
const BASIC = `Basic ${Buffer.from('client:secret').toString('base64')}`;
const HOUR = 60 * 60 * 1000;

const ACCOUNTS = [
  { id: 'pko-1', name: 'Konto Za Zero', currency: 'PLN', provider: { name: 'PKO BP' }, number: { iban: 'PL00' } },
  // No top-level currency: it is read from the balance.
  { id: 'rev-eur', name: 'EUR', booked: { value: 5, currency: 'EUR' }, provider: { name: 'Revolut' } },
];

/** The stub Aiia server: what it was asked, the tokens it handed out, and the transactions it serves (2 a page). */
interface StubRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown> | undefined;
}
let requests: StubRequest[];
let generation: number;
let refuseRefresh: boolean;
let bankTransactions: Record<string, unknown[]>;
let server: Server;
let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
  requests = [];
  generation = 0;
  refuseRefresh = false;
  bankTransactions = {};
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      const path = new URL(req.url!, 'http://stub').pathname;
      requests.push({ method: req.method!, path, authorization: req.headers.authorization, body });
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const tokens = () => {
        generation++;
        return { access_token: `access-${generation}`, refresh_token: `refresh-${generation}`, expires_in: 3600 };
      };
      if (path === '/v1/oauth/token') {
        if (req.headers.authorization !== BASIC) return reply(401, {});
        if (body?.grant_type === 'authorization_code' && body.code === 'good-code') return reply(200, tokens());
        const current = body?.refresh_token === `refresh-${generation}`;
        if (body?.grant_type === 'refresh_token' && current && !refuseRefresh) return reply(200, tokens());
        return reply(400, { error: 'invalid_grant' });
      }
      if (req.headers.authorization !== `Bearer access-${generation}`) return reply(401, {});
      if (path === '/v1/accounts') return reply(200, { accounts: ACCOUNTS });
      const query = /^\/v1\/accounts\/([^/]+)\/transactions\/query$/.exec(path);
      if (!query) return reply(404, {});
      const all = bankTransactions[decodeURIComponent(query[1]!)] ?? [];
      const start = Number(body?.pagingToken ?? 0);
      const next = start + 2 < all.length ? String(start + 2) : null;
      return reply(200, { transactions: all.slice(start, start + 2), pagingToken: next });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await t.drop();
});

/** Friday 20 November 2026, 11:00 in Warsaw; EUR is 4.30 zł at NBP. */
async function bankApp(): Promise<TestApp> {
  const { port } = server.address() as AddressInfo;
  const app = createTestApp(t.db, {
    now: '2026-11-20T10:00:00Z',
    fx: stubFx({ EUR: '4.3' }),
    config: {
      aiia: { clientId: 'client', clientSecret: 'secret', baseUrl: `http://127.0.0.1:${port}`, redirectUri: REDIRECT },
    },
  });
  await setUpBudget(app);
  return app;
}

/** Goes through the consent flow as the browser does; returns where the callback sends it. */
async function connect({ client }: TestApp, code = 'good-code'): Promise<string | null> {
  const start = await client.get('/api/bank/connect');
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const back = await client.get(`/api/bank/callback?code=${code}&state=${state}`);
  expect(back.status).toBe(302);
  return back.headers.get('location');
}

const status = async ({ client }: TestApp) => (await (await client.get('/api/bank/status')).json()) as BankStatus;
const link = ({ client }: TestApp, id: string, accountId: string | null) =>
  client.send('PUT', `/api/bank/accounts/${id}/link`, { accountId });
const sync = ({ client }: TestApp) => client.post('/api/bank/sync');
const queried = () => requests.filter((r) => r.path.endsWith('/transactions/query'));

function imported() {
  return t.db
    .select({
      accountId: transaction.accountId,
      importId: transaction.importId,
      date: transaction.date,
      payee: payee.name,
      categoryId: transaction.categoryId,
      amount: transaction.amount,
      amountBase: transaction.amountBase,
      fxRate: transaction.fxRate,
      cleared: transaction.cleared,
      approved: transaction.approved,
    })
    .from(transaction)
    .leftJoin(payee, eq(payee.id, transaction.payeeId))
    .where(isNotNull(transaction.importId))
    .orderBy(asc(transaction.importId));
}

describe('connecting a bank', () => {
  it('reports "not configured" without Aiia credentials', async () => {
    const app = createTestApp(t.db);
    await setUpBudget(app);
    expect(await status(app)).toEqual({ configured: false, connected: false, status: null, accounts: [] });
    expect((await app.client.get('/api/bank/connect')).status).toBe(404);
  });

  it('sends the browser to Aiia, exchanges the code and stores the tokens and bank accounts', async () => {
    const app = await bankApp();
    const start = await app.client.get('/api/bank/connect');
    const to = new URL(start.headers.get('location')!);
    expect(`${to.origin}${to.pathname}`).toBe(`${(app.config.aiia!).baseUrl}/v1/oauth/connect`);
    expect(Object.fromEntries(to.searchParams)).toEqual({
      client_id: 'client',
      redirect_uri: REDIRECT,
      scope: 'accounts offline_access',
      response_type: 'code',
      state: expect.stringMatching(/^[\w-]{43}$/),
    });
    expect(to.search).toContain('scope=accounts%20offline_access');
    const cookie = start.headers.get('set-cookie')!;
    for (const part of ['bt_bank_state=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api/bank']) {
      expect(cookie).toContain(part);
    }

    const back = await app.client.get(`/api/bank/callback?code=good-code&state=${to.searchParams.get('state')}`);
    expect(back.headers.get('location')).toBe('/settings');
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/v1/oauth/token',
        authorization: BASIC,
        body: { grant_type: 'authorization_code', code: 'good-code', redirect_uri: REDIRECT },
      },
      { method: 'GET', path: '/v1/accounts', authorization: 'Bearer access-1', body: undefined },
    ]);
    expect(await t.db.select().from(bankConnection)).toMatchObject([
      {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        accessExpiresAt: new Date('2026-11-20T11:00:00Z'),
        status: 'active',
      },
    ]);
    expect(await status(app)).toEqual({
      configured: true,
      connected: true,
      status: 'active',
      accounts: [
        { id: 'pko-1', name: 'Konto Za Zero', currency: 'PLN', providerName: 'PKO BP', accountId: null, lastSyncedAt: null },
        { id: 'rev-eur', name: 'EUR', currency: 'EUR', providerName: 'Revolut', accountId: null, lastSyncedAt: null },
      ],
    });
  });

  it('refuses a callback whose state is not the one it sent, and a failed code exchange', async () => {
    const app = await bankApp();
    await app.client.get('/api/bank/connect');
    const forged = await app.client.get('/api/bank/callback?code=good-code&state=forged');
    expect(forged.headers.get('location')).toBe('/settings?bank=error');
    expect(await connect(app, 'bad-code')).toBe('/settings?bank=error');
    expect(await status(app)).toMatchObject({ connected: false, accounts: [] });
  });

  it('links a bank account only to an account in its currency, and a reconnect keeps the link', async () => {
    const app = await bankApp();
    const pko = await createAccount(app.client, { name: 'PKO' });
    const euro = await createAccount(app.client, { name: 'Revolut', currency: 'EUR' });
    await connect(app);

    const mismatch = await link(app, 'pko-1', euro.id);
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({ code: 'bank_currency_mismatch' });
    expect((await link(app, 'pko-1', pko.id)).status).toBe(200);
    expect((await link(app, 'nope', pko.id)).status).toBe(404);

    expect(await connect(app)).toBe('/settings');
    expect((await status(app)).accounts.map((a) => [a.id, a.accountId])).toEqual([
      ['pko-1', pko.id],
      ['rev-eur', null],
    ]);
    await app.client.send('DELETE', '/api/bank/connection');
    expect(await status(app)).toMatchObject({ connected: false, status: null, accounts: [] });
    expect(await t.db.select().from(bankAccount)).toEqual([]);
  });
});

describe('POST /api/bank/sync', () => {
  async function linkedBank() {
    const app = await bankApp();
    const pko = await createAccount(app.client, { name: 'PKO', startingDate: '2026-10-01' });
    const euro = await createAccount(app.client, { name: 'Revolut', currency: 'EUR', startingDate: '2026-10-01' });
    const groceries = await createCategory(app.client, (await createGroup(app.client, 'Food')).id, 'Groceries');
    // Biedronka's last category is Groceries.
    await createTransaction(app.client, {
      accountId: pko.id,
      date: '2026-11-01',
      payeeName: 'Biedronka',
      categoryId: groceries.id,
      amount: -1000,
    });
    await connect(app);
    await link(app, 'pko-1', pko.id);
    await link(app, 'rev-eur', euro.id);
    bankTransactions = {
      'pko-1': [
        { id: 'a', date: '2026-11-18T00:00:00', text: 'Biedronka', amount: -45.99, currency: 'PLN', state: 'Booked' },
        { id: 'b', date: '2026-11-19', text: 'Salary', amount: { value: '5000.00', currency: 'PLN' }, state: 'Booked' },
        { id: 'c', date: '2026-11-20', text: 'Lidl', amount: -12.5, state: 'Reserved' },
        { id: 'd', date: '2026-09-30', text: 'Before the starting balance', amount: -1, state: 'Booked' },
        { id: 'e', date: '2026-11-21', text: 'Tomorrow', amount: -1, state: 'Booked' },
        { unexpected: true },
      ],
      'rev-eur': [{ id: 'x', date: '2026-11-19', text: 'Uber', amount: -10, currency: 'EUR', state: 'Booked' }],
    };
    return { app, pko, euro, groceries };
  }

  it('imports booked transactions, unapproved, as one undoable "Bank sync", and only once', async () => {
    const { app, pko, euro, groceries } = await linkedBank();
    const before = await snapshot(t.db);

    const res = await sync(app);
    expect(await res.json()).toEqual({ imported: 3 });
    // The first sync goes back 90 days, but not past the starting balance; every page is read.
    const interval = '2026-10-01T00:00:00Z/2026-11-20T10:00:00.000Z';
    expect(queried().map((r) => [r.path, r.body])).toEqual(
      expect.arrayContaining([
        ['/v1/accounts/pko-1/transactions/query', { interval, pageSize: 100 }],
        ['/v1/accounts/pko-1/transactions/query', { interval, pageSize: 100, pagingToken: '2' }],
        ['/v1/accounts/pko-1/transactions/query', { interval, pageSize: 100, pagingToken: '4' }],
        ['/v1/accounts/rev-eur/transactions/query', { interval, pageSize: 100 }],
      ]),
    );
    const flags = { cleared: 'cleared', approved: false };
    expect(await imported()).toEqual([
      {
        accountId: pko.id,
        importId: 'pko-1:a',
        date: '2026-11-18',
        payee: 'Biedronka',
        categoryId: groceries.id,
        amount: -4599,
        amountBase: -4599,
        fxRate: null,
        ...flags,
      },
      {
        accountId: pko.id,
        importId: 'pko-1:b',
        date: '2026-11-19',
        payee: 'Salary',
        categoryId: null,
        amount: 500_000,
        amountBase: 500_000,
        fxRate: null,
        ...flags,
      },
      {
        accountId: euro.id,
        importId: 'rev-eur:x',
        date: '2026-11-19',
        payee: 'Uber',
        categoryId: null,
        amount: -1000,
        amountBase: -4300,
        fxRate: '4.300000',
        ...flags,
      },
    ]);
    expect(await (await app.client.get('/api/undo')).json()).toEqual({ undo: { label: 'Bank sync' }, redo: null });
    const after = await snapshot(t.db);
    expect((await status(app)).accounts.map((a) => a.lastSyncedAt)).toEqual([
      '2026-11-20T10:00:00.000Z',
      '2026-11-20T10:00:00.000Z',
    ]);

    // The next sync overlaps the last by 5 days and imports nothing new, so it adds no undo entry.
    requests = [];
    app.clock.advance(HOUR / 2);
    expect(await (await sync(app)).json()).toEqual({ imported: 0 });
    expect(queried()[0]!.body).toMatchObject({ interval: '2026-11-15T00:00:00Z/2026-11-20T10:30:00.000Z' });
    expect(await snapshot(t.db)).toEqual(after);

    expect((await app.client.post('/api/undo')).status).toBe(200);
    expect(await snapshot(t.db)).toEqual(before);
    expect((await app.client.post('/api/redo')).status).toBe(200);
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('refreshes an expired access token and stores the new pair', async () => {
    const { app } = await linkedBank();
    app.clock.advance(2 * HOUR);
    requests = [];
    expect(await (await sync(app)).json()).toEqual({ imported: 3 });
    expect(requests[0]).toEqual({
      method: 'POST',
      path: '/v1/oauth/token',
      authorization: BASIC,
      body: { grant_type: 'refresh_token', refresh_token: 'refresh-1' },
    });
    expect(queried().every((r) => r.authorization === 'Bearer access-2')).toBe(true);
    expect(await t.db.select().from(bankConnection)).toMatchObject([
      { accessToken: 'access-2', refreshToken: 'refresh-2', accessExpiresAt: new Date('2026-11-20T13:00:00Z') },
    ]);
  });

  it('marks the connection for a reconnect when the refresh is refused', async () => {
    const { app } = await linkedBank();
    app.clock.advance(2 * HOUR);
    refuseRefresh = true;
    const res = await sync(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'bank_reconnect_needed' });
    expect(await status(app)).toMatchObject({ connected: true, status: 'reconnect_needed' });
    expect(await imported()).toEqual([]);

    requests = [];
    expect((await sync(app)).status).toBe(409);
    expect(requests).toEqual([]);
    refuseRefresh = false;
    expect(await connect(app)).toBe('/settings');
    expect(await status(app)).toMatchObject({ status: 'active' });
  });
});
