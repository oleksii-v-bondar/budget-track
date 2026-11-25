import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountListResponse } from '../../shared/api/accounts';
import type { AddToBudgetResponse, BankStatus } from '../../shared/api/bank';
import { bankAccount, bankConnection, payee, payeeAlias, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, createPayee, createTransaction } from '../test/fixtures';
import { stubFx } from '../test/fx';
import { snapshot } from '../test/snapshot';

const APP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const REDIRECT = 'http://localhost:3080/api/bank/callback';
/** Friday 20 November 2026, 11:00 in Warsaw. */
const NOW = '2026-11-20T10:00:00Z';
const NOW_S = Date.parse(NOW) / 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const ASPSPS = [
  { name: 'Revolut', country: 'PL', logo: 'https://enablebanking.com/brands/PL/Revolut/', maximum_consent_validity: 90 * 86400, psu_types: ['personal', 'business'], beta: false },
  { name: 'PKO BP', country: 'PL', logo: 'https://enablebanking.com/brands/PL/PKO%20BP/', maximum_consent_validity: 365 * 86400, psu_types: ['personal'], beta: false },
  { name: 'Bank Firmowy', country: 'PL', logo: 'https://enablebanking.com/brands/PL/Firmowy/', maximum_consent_validity: 86400, psu_types: ['business'], beta: false },
];

const PKO_IBAN = 'PL61109010140000071219812874';
const pkoSession = (id: string, uids: [string, string]) => ({
  session_id: id,
  aspsp: { name: 'PKO BP', country: 'PL' },
  psu_type: 'personal',
  access: { valid_until: '2027-05-19T09:50:00.000000+00:00' },
  accounts: [
    { uid: uids[0], account_id: { iban: PKO_IBAN }, name: 'Jan Kowalski', product: 'Konto Za Zero', currency: 'PLN', identification_hash: 'h1' },
    { uid: uids[1], account_id: { iban: 'PL27114020040000300201355387' }, name: 'Jan Kowalski', details: 'Oszczędności', currency: 'PLN', identification_hash: 'h2' },
  ],
});
const REVOLUT_SESSION = {
  session_id: 'rev-session',
  aspsp: { name: 'Revolut', country: 'PL' },
  psu_type: 'personal',
  access: { valid_until: '2027-02-18T09:50:00Z' },
  accounts: [
    { uid: 'rev-eur', account_id: { iban: 'LT603250000000000001' }, name: 'Jan Kowalski', currency: 'EUR', identification_hash: 'h3' },
    // No uid: Enable Banking can't read it (e.g. a closed account), so it is left out.
    { account_id: { iban: 'LT603250000000000001' }, name: 'Jan Kowalski', currency: 'USD', identification_hash: 'h4' },
  ],
};

/** The stub Enable Banking API: what it was asked (with the JWT checked), and what it answers. */
interface StubRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
  token: string;
  jwt: { header: unknown; claims: unknown; verified: boolean };
}
let requests: StubRequest[];
let sessions: Record<string, unknown>;
let expired: Set<string>;
let failing: Set<string>;
let bankTransactions: Record<string, unknown[]>;
/** Without balances, the bank fails to give them, so "Add to budget" fails and the account stays unlinked. */
let bankBalances: Record<string, unknown[]>;
let server: Server;
let t: TestDatabase;

function readJwt(authorization: string | undefined) {
  const token = authorization?.replace(/^Bearer /, '') ?? '';
  const [header = '', claims = '', signature = ''] = token.split('.');
  const decode = (part: string): unknown => {
    try {
      return JSON.parse(Buffer.from(part, 'base64url').toString());
    } catch {
      return null;
    }
  };
  const verified = verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'));
  return { token, jwt: { header: decode(header), claims: decode(claims), verified } };
}

beforeEach(async () => {
  t = await createTestDatabase();
  requests = [];
  sessions = { 'pko-code': pkoSession('pko-session', ['pko-1', 'pko-2']), 'rev-code': REVOLUT_SESSION };
  expired = new Set();
  failing = new Set();
  bankTransactions = {};
  bankBalances = {};
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://stub');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      const { token, jwt } = readJwt(req.headers.authorization);
      const path = url.pathname;
      requests.push({ method: req.method!, path, query: Object.fromEntries(url.searchParams), body, token, jwt });
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (!jwt.verified) return reply(401, { code: 401, error: 'UNAUTHORIZED_ACCESS', message: 'Unauthorized access' });
      if (req.method === 'GET' && path === '/aspsps') return reply(200, { aspsps: ASPSPS });
      if (req.method === 'POST' && path === '/auth') {
        return reply(200, { url: 'https://tilisy.enablebanking.com/welcome?sessionid=auth-1', authorization_id: 'auth-1' });
      }
      if (req.method === 'POST' && path === '/sessions') {
        const session = sessions[String(body?.code)];
        if (!session) return reply(400, { code: 400, error: 'WRONG_AUTHORIZATION_CODE', message: 'Wrong code' });
        return reply(200, session);
      }
      const deleted = /^\/sessions\/([^/]+)$/.exec(path);
      if (req.method === 'DELETE' && deleted) {
        if (failing.has(deleted[1]!)) return reply(500, { code: 500, error: 'ASPSP_ERROR', message: 'Bank error' });
        return reply(200, { message: 'OK' });
      }
      const balances = /^\/accounts\/([^/]+)\/balances$/.exec(path);
      if (req.method === 'GET' && balances) {
        const found = bankBalances[decodeURIComponent(balances[1]!)];
        if (!found) return reply(500, { code: 500, error: 'ASPSP_ERROR', message: 'Bank error' });
        return reply(200, { balances: found });
      }
      const listed = /^\/accounts\/([^/]+)\/transactions$/.exec(path);
      if (req.method === 'GET' && listed) {
        const uid = decodeURIComponent(listed[1]!);
        const session = uid.startsWith('rev') ? 'rev-session' : 'pko-session';
        if (expired.has(session)) return reply(401, { code: 401, error: 'EXPIRED_SESSION', message: 'Session is expired' });
        if (failing.has(session)) return reply(500, { code: 500, error: 'ASPSP_ERROR', message: 'Bank error' });
        const all = bankTransactions[uid] ?? [];
        const start = Number(url.searchParams.get('continuation_key') ?? 0);
        const next = start + 2 < all.length ? String(start + 2) : null;
        return reply(200, { transactions: all.slice(start, start + 2), continuation_key: next });
      }
      return reply(404, { code: 404, message: 'Not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await t.drop();
});

async function bankApp(): Promise<TestApp> {
  const { port } = server.address() as AddressInfo;
  const app = createTestApp(t.db, {
    now: NOW,
    fx: stubFx({ EUR: '4.3' }),
    config: { enableBanking: { appId: APP_ID, privateKey, baseUrl: `http://127.0.0.1:${port}`, redirectUri: REDIRECT } },
  });
  await setUpBudget(app);
  return app;
}

const connectPath = (bank: string) => `/api/bank/connect?bank=${encodeURIComponent(bank)}`;
const lastAuth = () => requests.findLast((r) => r.path === '/auth');

/** Goes through the consent flow as the browser does; returns where the callback sends it. */
async function connect({ client }: TestApp, bank: string, code: string): Promise<string | null> {
  const start = await client.get(connectPath(bank));
  expect(start.status).toBe(302);
  const back = await client.get(`/api/bank/callback?code=${code}&state=${String(lastAuth()?.body?.state)}`);
  expect(back.status).toBe(302);
  return back.headers.get('location');
}

const status = async ({ client }: TestApp) => (await (await client.get('/api/bank/status')).json()) as BankStatus;
const connectionOf = async (app: TestApp, bank: string) => (await status(app)).connections.find((c) => c.bank === bank)!;
const link = ({ client }: TestApp, uid: string, accountId: string | null) =>
  client.send('PUT', `/api/bank/accounts/${uid}/link`, { accountId });
const sync = ({ client }: TestApp) => client.post('/api/bank/sync');
const listed = () => requests.filter((r) => r.path.endsWith('/transactions'));
const addToBudget = ({ client }: TestApp, uid: string) => client.post(`/api/bank/accounts/${uid}/create-account`);
const accountsOf = async ({ client }: TestApp) =>
  ((await (await client.get('/api/accounts')).json()) as AccountListResponse).accounts;
const startingBalances = () =>
  t.db
    .select({
      accountId: transaction.accountId,
      date: transaction.date,
      amount: transaction.amount,
      amountBase: transaction.amountBase,
      fxRate: transaction.fxRate,
    })
    .from(transaction)
    .where(eq(transaction.isStartingBalance, true))
    .orderBy(asc(transaction.createdAt));

const booked = (fields: Record<string, unknown>) => ({ status: 'BOOK', credit_debit_indicator: 'DBIT', ...fields });
const pln = (amount: string) => ({ transaction_amount: { currency: 'PLN', amount } });
const balance = (balance_type: string, amount: string, currency = 'PLN') => ({
  name: balance_type,
  balance_amount: { currency, amount },
  balance_type,
  reference_date: '2026-11-20',
});

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
    .orderBy(asc(transaction.date), asc(transaction.importId));
}

describe('connecting a bank', () => {
  it('is off without an app id or a readable key', async () => {
    const app = createTestApp(t.db);
    await setUpBudget(app);
    expect(await status(app)).toEqual({ configured: false, connections: [] });
    expect((await app.client.get('/api/bank/aspsps')).status).toBe(404);
    expect((await app.client.get(connectPath('PKO BP'))).headers.get('location')).toBe('/settings?bank=error');
    expect(requests).toEqual([]);
  });

  it('signs every call with the application JWT, reused until 5 minutes before it expires; banks are cached a day', async () => {
    const app = await bankApp();
    const banks = await app.client.get('/api/bank/aspsps');
    // Personal banks only, by name.
    expect(await banks.json()).toEqual({ aspsps: [{ name: 'PKO BP' }, { name: 'Revolut' }] });
    expect(requests).toEqual([
      expect.objectContaining({ method: 'GET', path: '/aspsps', query: { country: 'PL' } }),
    ]);
    expect(requests[0]!.jwt).toEqual({
      header: { typ: 'JWT', alg: 'RS256', kid: APP_ID },
      claims: { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: NOW_S, exp: NOW_S + 3600 },
      verified: true,
    });

    await app.client.get('/api/bank/aspsps');
    expect(requests).toHaveLength(1);
    app.clock.advance(54 * MINUTE);
    await app.client.get(connectPath('PKO BP'));
    expect(lastAuth()!.token).toBe(requests[0]!.token);
    app.clock.advance(MINUTE);
    await app.client.get(connectPath('PKO BP'));
    expect(lastAuth()!.jwt).toMatchObject({ claims: { iat: NOW_S + 55 * 60, exp: NOW_S + 55 * 60 + 3600 }, verified: true });

    app.clock.advance(DAY);
    await app.client.get('/api/bank/aspsps');
    expect(requests.filter((r) => r.path === '/aspsps')).toHaveLength(2);
  });

  it('sends the browser to the bank with a state cookie, then stores the session and its accounts', async () => {
    const app = await bankApp();
    const start = await app.client.get(connectPath('PKO BP'));
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toBe('https://tilisy.enablebanking.com/welcome?sessionid=auth-1');
    const cookie = start.headers.get('set-cookie')!;
    for (const part of ['bt_bank_state=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api/bank']) {
      expect(cookie).toContain(part);
    }
    // PKO BP allows a year: the consent asks for 180 days (less a 10-minute margin for clock skew).
    expect(lastAuth()!.body).toEqual({
      access: { valid_until: new Date(Date.parse(NOW) + 180 * DAY - 10 * MINUTE).toISOString() },
      aspsp: { name: 'PKO BP', country: 'PL' },
      state: expect.stringMatching(/^[\w-]{43}$/),
      redirect_url: REDIRECT,
      psu_type: 'personal',
    });
    expect(cookie).toContain(`bt_bank_state=${String(lastAuth()!.body!.state)}`);

    const back = await app.client.get(`/api/bank/callback?code=pko-code&state=${String(lastAuth()!.body!.state)}`);
    expect(back.headers.get('location')).toBe('/settings');
    expect(requests.find((r) => r.path === '/sessions')).toMatchObject({ method: 'POST', body: { code: 'pko-code' } });
    const { connections } = await status(app);
    expect(connections).toEqual([
      {
        id: expect.any(String),
        bank: 'PKO BP',
        status: 'active',
        validUntil: '2027-05-19T09:50:00.000Z',
        accounts: [
          { uid: 'pko-1', name: 'Konto Za Zero', iban: PKO_IBAN, currency: 'PLN', accountId: null, lastSyncedAt: null },
          {
            uid: 'pko-2',
            name: 'Oszczędności',
            iban: 'PL27114020040000300201355387',
            currency: 'PLN',
            accountId: null,
            lastSyncedAt: null,
          },
        ],
      },
    ]);
    expect(await t.db.select({ sessionId: bankConnection.sessionId }).from(bankConnection)).toEqual([
      { sessionId: 'pko-session' },
    ]);
  });

  it('refuses an unknown bank, a forged state, a refused consent and a bad code', async () => {
    const app = await bankApp();
    expect((await app.client.get(connectPath('Nope'))).headers.get('location')).toBe('/settings?bank=error');
    expect(lastAuth()).toBeUndefined();

    await app.client.get(connectPath('PKO BP'));
    const forged = await app.client.get('/api/bank/callback?code=pko-code&state=forged');
    expect(forged.headers.get('location')).toBe('/settings?bank=error');
    await app.client.get(connectPath('PKO BP'));
    const state = String(lastAuth()!.body!.state);
    const refused = await app.client.get(`/api/bank/callback?error=access_denied&state=${state}`);
    expect(refused.headers.get('location')).toBe('/settings?bank=error');
    expect(await connect(app, 'PKO BP', 'bad-code')).toBe('/settings?bank=error');
    expect(requests.filter((r) => r.path === '/sessions').map((r) => r.body)).toEqual([{ code: 'bad-code' }]);
    expect(await status(app)).toEqual({ configured: true, connections: [] });
  });

  it('keeps a connection per bank; a reconnect replaces its own and keeps the links; disconnect ends the session', async () => {
    const app = await bankApp();
    const pko = await createAccount(app.client, { name: 'PKO' });
    const euro = await createAccount(app.client, { name: 'Revolut', currency: 'EUR' });
    expect(await connect(app, 'PKO BP', 'pko-code')).toBe('/settings');
    expect(await connect(app, 'Revolut', 'rev-code')).toBe('/settings');
    // Revolut allows 90 days.
    expect(lastAuth()!.body!.access).toEqual({
      valid_until: new Date(Date.parse(NOW) + 90 * DAY - 10 * MINUTE).toISOString(),
    });
    const first = await status(app);
    expect(first.connections.map((c) => [c.bank, c.status, c.validUntil, c.accounts.map((a) => a.uid)])).toEqual([
      ['PKO BP', 'active', '2027-05-19T09:50:00.000Z', ['pko-1', 'pko-2']],
      ['Revolut', 'active', '2027-02-18T09:50:00.000Z', ['rev-eur']],
    ]);

    const mismatch = await link(app, 'pko-1', euro.id);
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({ code: 'bank_currency_mismatch', fieldErrors: { accountId: [expect.any(String)] } });
    expect((await link(app, 'pko-1', pko.id)).status).toBe(200);
    expect((await link(app, 'rev-eur', euro.id)).status).toBe(200);
    expect((await link(app, 'nope', pko.id)).status).toBe(404);

    // The new session has new account uids; the link follows the IBAN.
    sessions['pko-code'] = pkoSession('pko-session-2', ['pko-1b', 'pko-2b']);
    expect(await connect(app, 'PKO BP', 'pko-code')).toBe('/settings');
    expect(requests).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/sessions/pko-session' }));
    const second = await status(app);
    expect(second.connections.map((c) => [c.bank, c.accounts.map((a) => [a.uid, a.accountId])])).toEqual([
      ['PKO BP', [['pko-1b', pko.id], ['pko-2b', null]]],
      ['Revolut', [['rev-eur', euro.id]]],
    ]);
    expect(second.connections[0]!.id).not.toBe(first.connections[0]!.id);
    expect(second.connections[1]!.id).toBe(first.connections[1]!.id);

    // Enable Banking's answer to the session's deletion doesn't matter.
    failing.add('rev-session');
    const gone = await app.client.send('DELETE', `/api/bank/connections/${second.connections[1]!.id}`);
    expect(gone.status).toBe(200);
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/sessions/rev-session' });
    expect(((await gone.json()) as BankStatus).connections.map((c) => c.bank)).toEqual(['PKO BP']);
    expect(await t.db.select({ uid: bankAccount.uid }).from(bankAccount).orderBy(bankAccount.uid)).toEqual([
      { uid: 'pko-1b' },
      { uid: 'pko-2b' },
    ]);
    expect((await app.client.send('DELETE', `/api/bank/connections/${second.connections[1]!.id}`)).status).toBe(404);
  });
});

describe('POST /api/bank/sync', () => {
  async function linkedBanks() {
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
    await connect(app, 'PKO BP', 'pko-code');
    await connect(app, 'Revolut', 'rev-code');
    await link(app, 'pko-1', pko.id);
    await link(app, 'rev-eur', euro.id);
    bankTransactions = {
      'pko-1': [
        booked({
          entry_reference: 'E1',
          ...pln('45.99'),
          booking_date: '2026-11-18',
          value_date: '2026-11-17',
          creditor: { name: 'Biedronka' },
          debtor: { name: 'Jan Kowalski' },
          remittance_information: ['Zakup kartą'],
        }),
        booked({
          entry_reference: 'E2',
          ...pln('5000.00'),
          credit_debit_indicator: 'CRDT',
          value_date: '2026-11-19',
          creditor: { name: 'Jan Kowalski' },
          debtor: { name: 'ACME Sp. z o.o.' },
          remittance_information: ['Wynagrodzenie'],
        }),
        booked({ entry_reference: 'E3', ...pln('12.50'), status: 'PDNG', booking_date: '2026-11-20', creditor: { name: 'Lidl' } }),
        booked({ transaction_id: 'T4', ...pln('20.00'), transaction_date: '2026-11-17', remittance_information: [' ', 'BLIK na telefon'] }),
        booked({ entry_reference: 'E5', ...pln('1.00'), booking_date: '2026-09-30', creditor: { name: 'Before the start' } }),
        booked({ ...pln('3.00'), credit_debit_indicator: 'CRDT', booking_date: '2026-11-16' }),
        { unexpected: true },
      ],
      'pko-2': [booked({ entry_reference: 'X', ...pln('1.00'), booking_date: '2026-11-18' })],
      'rev-eur': [
        booked({
          entry_reference: 'R1',
          transaction_amount: { currency: 'EUR', amount: '10.00' },
          booking_date: '2026-11-19',
          creditor: { name: 'Uber' },
        }),
      ],
    };
    requests = [];
    return { app, pko, euro, groceries };
  }

  it('imports booked transactions, unapproved, as one undoable "Bank sync", and only once', async () => {
    const { app, pko, euro, groceries } = await linkedBanks();
    const before = await snapshot(t.db);

    const res = await sync(app);
    expect(await res.json()).toEqual({ imported: 5, reconnectNeeded: [], failed: [] });
    // The first sync goes back 90 days, but not past the starting balance; every page is read; pko-2 isn't linked.
    const dates = { date_from: '2026-10-01', date_to: '2026-11-20' };
    expect(listed().map((r) => [r.path, r.query])).toEqual([
      ['/accounts/pko-1/transactions', dates],
      ['/accounts/pko-1/transactions', { ...dates, continuation_key: '2' }],
      ['/accounts/pko-1/transactions', { ...dates, continuation_key: '4' }],
      ['/accounts/pko-1/transactions', { ...dates, continuation_key: '6' }],
      ['/accounts/rev-eur/transactions', dates],
    ]);
    const unnamed = createHash('sha256').update('2026-11-16|300|').digest('hex');
    const flags = { cleared: 'cleared', approved: false, fxRate: null };
    expect(await imported()).toEqual([
      { accountId: pko.id, importId: `pko-1:${unnamed}`, date: '2026-11-16', payee: 'Unknown', categoryId: null, amount: 300, amountBase: 300, ...flags },
      { accountId: pko.id, importId: 'pko-1:T4', date: '2026-11-17', payee: 'BLIK na telefon', categoryId: null, amount: -2000, amountBase: -2000, ...flags },
      { accountId: pko.id, importId: 'pko-1:E1', date: '2026-11-18', payee: 'Biedronka', categoryId: groceries.id, amount: -4599, amountBase: -4599, ...flags },
      { accountId: pko.id, importId: 'pko-1:E2', date: '2026-11-19', payee: 'ACME', categoryId: null, amount: 500_000, amountBase: 500_000, ...flags },
      { accountId: euro.id, importId: 'rev-eur:R1', date: '2026-11-19', payee: 'Uber', categoryId: null, amount: -1000, amountBase: -4300, ...flags, fxRate: '4.300000' },
    ]);
    expect(await (await app.client.get('/api/undo')).json()).toEqual({ undo: { label: 'Bank sync' }, redo: null });
    const { accounts } = (await (await app.client.get('/api/accounts')).json()) as AccountListResponse;
    expect(accounts.map((a) => [a.name, a.unapprovedCount])).toEqual([
      ['PKO', 4],
      ['Revolut', 1],
    ]);
    const after = await snapshot(t.db);
    expect((await status(app)).connections.flatMap((c) => c.accounts.map((a) => [a.uid, a.lastSyncedAt]))).toEqual([
      ['pko-1', '2026-11-20T10:00:00.000Z'],
      ['pko-2', null],
      ['rev-eur', '2026-11-20T10:00:00.000Z'],
    ]);

    // The next sync overlaps the last by 5 days and imports nothing new, so it adds no undo entry.
    requests = [];
    app.clock.advance(30 * MINUTE);
    expect(await (await sync(app)).json()).toEqual({ imported: 0, reconnectNeeded: [], failed: [] });
    expect(listed()[0]!.query).toEqual({ date_from: '2026-11-15', date_to: '2026-11-20' });
    expect(await snapshot(t.db)).toEqual(after);

    expect((await app.client.post('/api/undo')).status).toBe(200);
    expect(await snapshot(t.db)).toEqual(before);
    expect((await app.client.post('/api/redo')).status).toBe(200);
    expect(await snapshot(t.db)).toEqual(after);

    // A reconnect gives the bank account a new uid: what was imported under the old one isn't imported again.
    sessions['pko-code'] = pkoSession('pko-session-2', ['pko-1b', 'pko-2b']);
    expect(await connect(app, 'PKO BP', 'pko-code')).toBe('/settings');
    bankTransactions['pko-1b'] = bankTransactions['pko-1']!;
    requests = [];
    expect(await (await sync(app)).json()).toEqual({ imported: 0, reconnectNeeded: [], failed: [] });
    expect(listed()[0]).toMatchObject({
      path: '/accounts/pko-1b/transactions',
      query: { date_from: '2026-11-15', date_to: '2026-11-20' },
    });
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('skips a bank whose session has expired or that fails, and asks for a reconnect', async () => {
    const { app, euro } = await linkedBanks();
    expired.add('rev-session');
    failing.add('pko-session');
    expect(await (await sync(app)).json()).toEqual({ imported: 0, reconnectNeeded: ['Revolut'], failed: ['PKO BP'] });
    expect((await status(app)).connections.map((c) => [c.bank, c.status])).toEqual([
      ['PKO BP', 'active'],
      ['Revolut', 'reconnect_needed'],
    ]);

    failing.clear();
    requests = [];
    expect(await (await sync(app)).json()).toEqual({ imported: 4, reconnectNeeded: ['Revolut'], failed: [] });
    expect(listed().every((r) => r.path.startsWith('/accounts/pko-1/'))).toBe(true);

    expired.clear();
    expect(await connect(app, 'Revolut', 'rev-code')).toBe('/settings');
    expect(await connectionOf(app, 'Revolut')).toMatchObject({
      status: 'active',
      accounts: [{ uid: 'rev-eur', accountId: euro.id }],
    });

    // Past its valid_until, a session isn't even tried.
    await t.db
      .update(bankConnection)
      .set({ validUntil: new Date('2026-11-20T09:59:59Z') })
      .where(eq(bankConnection.aspspName, 'PKO BP'));
    expect((await connectionOf(app, 'PKO BP')).status).toBe('reconnect_needed');
    requests = [];
    expect(await (await sync(app)).json()).toEqual({ imported: 1, reconnectNeeded: ['PKO BP'], failed: [] });
    expect(listed().map((r) => r.path)).toEqual(['/accounts/rev-eur/transactions']);
  });
});

describe('payee memory', () => {
  async function linkedPko() {
    const app = await bankApp();
    const pko = await createAccount(app.client, { name: 'PKO', startingDate: '2026-10-01' });
    const food = (await createGroup(app.client, 'Bills')).id;
    const groceries = await createCategory(app.client, food, 'Groceries');
    const phone = await createCategory(app.client, food, 'Phone');
    await connect(app, 'PKO BP', 'pko-code');
    await link(app, 'pko-1', pko.id);
    bankTransactions['pko-1'] = [];
    return { app, pko, groceries, phone };
  }
  /** Adds a booked transaction to the bank's list, then syncs. */
  async function bankSends(app: TestApp, ref: string, fields: Record<string, unknown>) {
    bankTransactions['pko-1']!.push(booked({ entry_reference: ref, ...pln('10.00'), booking_date: '2026-11-18', ...fields }));
    app.clock.advance(MINUTE);
    expect(await (await sync(app)).json()).toMatchObject({ imported: 1 });
    const [row] = await t.db.select().from(transaction).where(eq(transaction.importId, `pko-1:${ref}`));
    return row!;
  }
  const lastImport = async () => (await imported()).findLast(() => true)!;
  const patch = ({ client }: TestApp, id: string, body: Record<string, unknown>) =>
    client.send('PATCH', `/api/transactions/${id}`, body);
  const aliases = () => t.db.select({ key: payeeAlias.key, payeeId: payeeAlias.payeeId }).from(payeeAlias).orderBy(payeeAlias.key);

  it("gives another store of the same shop its payee and the category it was approved with", async () => {
    const { app, groceries } = await linkedPko();
    const first = await bankSends(app, 'E1', { creditor: { name: 'BIEDRONKA 1234 WARSZAWA' } });
    expect(first.importedPayee).toBe('BIEDRONKA 1234 WARSZAWA');
    expect(await lastImport()).toMatchObject({ payee: 'Biedronka', categoryId: null, approved: false });
    expect((await patch(app, first.id, { categoryId: groceries.id, approved: true })).status).toBe(200);

    await bankSends(app, 'E2', { creditor: { name: 'BIEDRONKA 5678 KRAKOW' } });
    expect(await lastImport()).toMatchObject({ payee: 'Biedronka', categoryId: groceries.id, approved: false });
    await bankSends(app, 'E3', { remittance_information: ['ZAKUP PRZY UŻYCIU KARTY 4321********1234 BIEDRONKA 1234'] });
    expect(await lastImport()).toMatchObject({ payee: 'Biedronka', categoryId: groceries.id, approved: false });
    expect(await t.db.select({ name: payee.name }).from(payee).where(eq(payee.name, 'Biedronka'))).toHaveLength(1);
  });

  it('learns a new payee for a bank text, undoably, and keeps it through merges and renames', async () => {
    const { app, phone } = await linkedPko();
    const first = await bankSends(app, 'E1', { creditor: { name: 'P4 SP. Z O.O.' } });
    expect(await lastImport()).toMatchObject({ payee: 'P4', categoryId: null });
    const before = await snapshot(t.db);

    expect((await patch(app, first.id, { payeeName: 'Play', categoryId: phone.id })).status).toBe(200);
    const play = (await t.db.select().from(payee).where(eq(payee.name, 'Play')))[0]!;
    expect(await aliases()).toEqual([{ key: 'p4', payeeId: play.id }]);
    const after = await snapshot(t.db);
    expect((await app.client.post('/api/undo')).status).toBe(200);
    expect(await aliases()).toEqual([]);
    expect(await snapshot(t.db)).toEqual(before);
    expect((await app.client.post('/api/redo')).status).toBe(200);
    expect(await snapshot(t.db)).toEqual(after);

    // The alias wins over the payee named "P4".
    await bankSends(app, 'E2', { creditor: { name: 'P4 Sp. z o.o.' } });
    expect(await lastImport()).toMatchObject({ payee: 'Play', categoryId: phone.id });

    // Merging moves the aliases, and the merged payee's name, to the target.
    const mobile = await createPayee(app.client, 'Play Mobile');
    expect((await app.client.post(`/api/payees/${play.id}/merge`, { targetId: mobile.id })).status).toBe(200);
    expect(await aliases()).toEqual([
      { key: 'p4', payeeId: mobile.id },
      { key: 'play', payeeId: mobile.id },
    ]);
    await bankSends(app, 'E3', { creditor: { name: 'P4 SP. Z O.O.' } });
    expect(await lastImport()).toMatchObject({ payee: 'Play Mobile', categoryId: phone.id });

    // Renaming keeps the old name's imports; deleting a payee forgets its aliases.
    expect((await app.client.send('PATCH', `/api/payees/${mobile.id}`, { name: 'Telefon' })).status).toBe(200);
    expect((await aliases()).map((a) => a.key)).toEqual(['p4', 'play', 'play mobile']);
    const unused = await createPayee(app.client, 'Netia');
    await t.db.insert(payeeAlias).values({ key: 'netia sa', payeeId: unused.id });
    expect((await app.client.send('DELETE', `/api/payees/${unused.id}`)).status).toBe(200);
    expect((await aliases()).map((a) => a.key)).toEqual(['p4', 'play', 'play mobile']);
  });
});

describe('Add to budget', () => {
  it("adds a connected bank's account: the bank balance less this month's transactions, which arrive unapproved", async () => {
    const app = await bankApp();
    // Revolut names the account after its holder: the account is named after the bank instead.
    sessions['rev-code'] = {
      ...REVOLUT_SESSION,
      accounts: [
        { uid: 'rev-pln', account_id: { iban: 'LT603250000000000099' }, name: 'Jan Kowalski', cash_account_type: 'CACC', currency: 'PLN' },
      ],
    };
    // No interim booked balance: the closing booked one comes next.
    bankBalances['rev-pln'] = [balance('ITAV', '1300.00'), balance('XPCD', '1200.00'), balance('CLBD', '1234.56')];
    bankTransactions['rev-pln'] = [
      booked({ entry_reference: 'R1', ...pln('45.99'), booking_date: '2026-11-18', creditor: { name: 'Biedronka' } }),
      booked({ entry_reference: 'R2', ...pln('5000.00'), credit_debit_indicator: 'CRDT', booking_date: '2026-11-01', debtor: { name: 'ACME' } }),
      booked({ entry_reference: 'R3', ...pln('12.50'), status: 'PDNG', booking_date: '2026-11-20', creditor: { name: 'Lidl' } }),
      booked({ entry_reference: 'R4', ...pln('99.00'), booking_date: '2026-10-31', creditor: { name: 'Last month' } }),
    ];

    expect(await connect(app, 'Revolut', 'rev-code')).toBe('/settings');
    const accounts = await accountsOf(app);
    expect(accounts.map((a) => [a.name, a.type, a.currency, a.balance.working, a.unapprovedCount])).toEqual([
      ['Revolut', 'checking', 'PLN', 123_456, 2],
    ]);
    // 1234.56 − (5000.00 − 45.99), on the 1st.
    expect(await startingBalances()).toEqual([
      { accountId: accounts[0]!.id, date: '2026-11-01', amount: -371_945, amountBase: -371_945, fxRate: null },
    ]);
    expect((await imported()).map((i) => [i.importId, i.date, i.amount, i.approved])).toEqual([
      ['rev-pln:R2', '2026-11-01', 500_000, false],
      ['rev-pln:R1', '2026-11-18', -4599, false],
    ]);
    expect((await connectionOf(app, 'Revolut')).accounts).toEqual([
      expect.objectContaining({ uid: 'rev-pln', accountId: accounts[0]!.id, lastSyncedAt: '2026-11-20T10:00:00.000Z' }),
    ]);
    // This month only, for the starting balance and then the sync.
    expect(requests.some((r) => r.path === '/accounts/rev-pln/balances')).toBe(true);
    expect(new Set(listed().map((r) => `${r.query.date_from}..${r.query.date_to}`))).toEqual(
      new Set(['2026-11-01..2026-11-20']),
    );

    // Two undo entries: the sync, then the account.
    expect(await (await app.client.post('/api/undo')).json()).toMatchObject({ undone: { label: 'Bank sync' } });
    expect(await (await app.client.post('/api/undo')).json()).toMatchObject({
      undone: { label: 'Create account "Revolut"' },
    });
    expect((await connectionOf(app, 'Revolut')).accounts).toMatchObject([{ uid: 'rev-pln', accountId: null }]);
  });

  it('names accounts after the bank, with the currency and the IBAN when needed, and types them', async () => {
    const app = await bankApp();
    await createAccount(app.client, { name: 'pko bp eur' });
    const owner = { name: 'Jan Kowalski', product: 'Konto' };
    sessions['pko-code'] = {
      ...pkoSession('pko-session', ['unused-1', 'unused-2']),
      accounts: [
        { uid: 'pko-card', account_id: { iban: 'PL00000000000000000000001111' }, ...owner, cash_account_type: 'CARD', currency: 'PLN' },
        { uid: 'pko-svgs', account_id: { iban: 'PL00000000000000000000002222' }, ...owner, cash_account_type: 'SVGS', currency: 'PLN' },
        { uid: 'pko-eur', account_id: { iban: 'PL00000000000000000000003333' }, ...owner, cash_account_type: 'OTHR', currency: 'EUR' },
      ],
    };
    bankBalances = {
      'pko-card': [balance('ITBD', '-250.00'), balance('CLBD', '-300.00')],
      'pko-svgs': [balance('INFO', '10000.00')],
      // A balance in another currency doesn't count.
      'pko-eur': [balance('ITBD', '1.00', 'PLN'), balance('ITAV', '100.00', 'EUR')],
    };
    bankTransactions['pko-eur'] = [
      booked({ entry_reference: 'E1', transaction_amount: { currency: 'EUR', amount: '10.00' }, booking_date: '2026-11-19', creditor: { name: 'Uber' } }),
    ];

    expect(await connect(app, 'PKO BP', 'pko-code')).toBe('/settings');
    const accounts = await accountsOf(app);
    expect(accounts.map((a) => [a.name, a.type, a.currency, a.balance.working, a.balanceBase.working])).toEqual([
      ['pko bp eur', 'checking', 'PLN', 0, 0],
      ['PKO BP PLN ••1111', 'credit_card', 'PLN', -25_000, -25_000],
      ['PKO BP PLN ••2222', 'savings', 'PLN', 1_000_000, 1_000_000],
      // The EUR starting balance at NBP's rate (the stub's 4.3), the import at its date's.
      ['PKO BP EUR 2', 'checking', 'EUR', 10_000, 47_300 - 4300],
    ]);
    expect((await startingBalances()).at(-1)).toEqual({
      accountId: accounts[3]!.id,
      date: '2026-11-01',
      amount: 11_000,
      amountBase: 47_300,
      fxRate: '4.300000',
    });
    const links = Object.fromEntries((await connectionOf(app, 'PKO BP')).accounts.map((a) => [a.uid, a.accountId]));
    expect(links).toEqual({ 'pko-card': accounts[1]!.id, 'pko-svgs': accounts[2]!.id, 'pko-eur': accounts[3]!.id });
  });

  it("leaves a bank account unlinked when its balance can't be read; Settings adds it later", async () => {
    const app = await bankApp();
    expect(await connect(app, 'Revolut', 'rev-code')).toBe('/settings');
    expect((await connectionOf(app, 'Revolut')).accounts).toMatchObject([{ uid: 'rev-eur', accountId: null }]);
    expect(await accountsOf(app)).toEqual([]);

    const failed = await addToBudget(app, 'rev-eur');
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: 'bank_unavailable' });
    expect(await accountsOf(app)).toEqual([]);

    bankBalances['rev-eur'] = [balance('ITBD', '20.00', 'EUR')];
    const added = await addToBudget(app, 'rev-eur');
    expect(added.status).toBe(201);
    const body = (await added.json()) as AddToBudgetResponse;
    const accounts = await accountsOf(app);
    expect(accounts.map((a) => [a.name, a.currency, a.balance.working])).toEqual([['Revolut', 'EUR', 2000]]);
    expect(body).toEqual({ name: 'Revolut', status: await status(app) });
    expect(body.status.connections[0]!.accounts[0]!.accountId).toBe(accounts[0]!.id);

    expect(await (await addToBudget(app, 'rev-eur')).json()).toMatchObject({ code: 'bank_account_linked' });
    expect((await addToBudget(app, 'nope')).status).toBe(404);
  });
});
