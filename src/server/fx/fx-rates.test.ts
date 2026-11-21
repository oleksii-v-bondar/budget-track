import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fxRate } from '../db/schema';
import { createLogger } from '../logger';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { FakeClock } from '../test/fake-clock';
import { type FxRates, nbpRates } from './fx-rates';

/** What the stub NBP server answers for a path: a status with a JSON body, or nothing at all (a hang). */
type Answer = { status: number; body?: unknown; raw?: string } | 'hang';

let t: TestDatabase;
let server: Server;
let requests: string[];
let answer: (path: string) => Answer;
let logs: { level: number; msg: string }[];
const hanging: ServerResponse[] = [];

beforeEach(async () => {
  t = await createTestDatabase();
  requests = [];
  logs = [];
  answer = () => ({ status: 404 });
  server = createServer((req, res) => {
    requests.push(req.url!);
    const reply = answer(req.url!);
    if (reply === 'hang') {
      hanging.push(res);
      return;
    }
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.raw ?? (reply.body === undefined ? 'Not Found' : JSON.stringify(reply.body)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterEach(async () => {
  for (const res of hanging.splice(0)) res.destroy();
  await new Promise((resolve) => server.close(resolve));
  await t.drop();
});

/** Friday 20 November 2026, 10:00 in Warsaw: today's table (published around noon) isn't out yet. */
function rates(options: { now?: string; timeoutMs?: number } = {}): FxRates {
  const { port } = server.address() as AddressInfo;
  return nbpRates({
    db: t.db,
    logger: createLogger('warn', { write: (line: string) => void logs.push(JSON.parse(line)) }),
    clock: new FakeClock(options.now ?? '2026-11-20T09:00:00Z'),
    timeZone: 'Europe/Warsaw',
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: options.timeoutMs,
  });
}

const path = (code: string, date: string) => `/api/exchangerates/rates/A/${code}/${date}/?format=json`;
const table = (code: string, effectiveDate: string, mid: number) => ({
  status: 200,
  body: { table: 'A', currency: 'euro', code, rates: [{ no: '225/A/NBP/2026', effectiveDate, mid }] },
});
const published = (days: Record<string, number>) => (url: string) => {
  const date = /\/(\d{4}-\d{2}-\d{2})\//.exec(url)![1]!;
  const mid = days[date];
  return mid === undefined ? { status: 404 } : table('EUR', date, mid);
};
const cache = () => t.db.select().from(fxRate);

describe('nbpRates', () => {
  it('steps back over a weekend to the last published day and caches the final rate', async () => {
    answer = published({ '2026-11-13': 4.2315 });
    const fx = rates();

    expect(await fx.quote('EUR', '2026-11-15')).toEqual({ rate: '4.231500', effectiveDate: '2026-11-13' });
    expect(requests).toEqual([path('EUR', '2026-11-15'), path('EUR', '2026-11-14'), path('EUR', '2026-11-13')]);
    expect(await cache()).toEqual([
      { currency: 'EUR', date: '2026-11-15', rate: '4.231500', source: 'nbp', effectiveDate: '2026-11-13' },
    ]);
  });

  it('answers from the cache without asking NBP', async () => {
    await t.db
      .insert(fxRate)
      .values({ currency: 'USD', date: '2026-11-18', rate: '3.912300', effectiveDate: '2026-11-18' });
    expect(await rates().quote('USD', '2026-11-18')).toEqual({ rate: '3.912300', effectiveDate: '2026-11-18' });
    expect(requests).toEqual([]);
  });

  it("doesn't cache today's fallback to yesterday, so today's table is fetched once it is out", async () => {
    answer = published({ '2026-11-19': 4.25 });
    const fx = rates();
    expect(await fx.quote('EUR', '2026-11-20')).toEqual({ rate: '4.250000', effectiveDate: '2026-11-19' });
    expect(await cache()).toEqual([]);

    answer = published({ '2026-11-19': 4.25, '2026-11-20': 4.26 });
    expect(await fx.quote('EUR', '2026-11-20')).toEqual({ rate: '4.260000', effectiveDate: '2026-11-20' });
    expect(await cache()).toMatchObject([{ date: '2026-11-20', rate: '4.260000', effectiveDate: '2026-11-20' }]);
    expect(requests).toHaveLength(3);
  });

  it('gives up after 7 days back (8 days of 404) and logs a warning', async () => {
    expect(await rates().quote('XAU', '2026-11-18')).toBeNull();
    expect(requests).toEqual(
      ['18', '17', '16', '15', '14', '13', '12', '11'].map((day) => path('XAU', `2026-11-${day}`)),
    );
    expect(logs).toMatchObject([{ level: 40, msg: 'no NBP rate within 7 days' }]);
    expect(await cache()).toEqual([]);
  });

  it('returns null when NBP times out', async () => {
    answer = () => 'hang';
    const started = Date.now();
    expect(await rates({ timeoutMs: 100 }).quote('EUR', '2026-11-18')).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(logs).toMatchObject([{ level: 40, msg: 'NBP rate unavailable' }]);
  });

  it('returns null for malformed answers and server errors', async () => {
    answer = () => ({ status: 200, raw: '{"rates": [' });
    expect(await rates().quote('EUR', '2026-11-18')).toBeNull();
    answer = () => ({ status: 200, body: { rates: [{ effectiveDate: '2026-11-18', mid: 'x' }] } });
    expect(await rates().quote('EUR', '2026-11-18')).toBeNull();
    answer = () => ({ status: 500, body: { error: 'boom' } });
    expect(await rates().quote('EUR', '2026-11-18')).toBeNull();
    // A server error is not a missing table: no stepping back.
    expect(requests).toHaveLength(3);
    expect(logs.map((l) => l.msg)).toEqual(Array(3).fill('NBP rate unavailable'));
    expect(await cache()).toEqual([]);
  });

  it('returns null when the answer is for another currency', async () => {
    answer = () => table('USD', '2026-11-18', 3.9);
    expect(await rates().quote('EUR', '2026-11-18')).toBeNull();
    expect(requests).toHaveLength(1);
    expect(await cache()).toEqual([]);
  });

  it('returns null when the answer is for another day than the one asked for', async () => {
    answer = () => table('EUR', '2026-11-17', 4.25);
    expect(await rates().quote('EUR', '2026-11-18')).toBeNull();
    expect(requests).toHaveLength(1);
    expect(await cache()).toEqual([]);
  });

  it('returns null for a mid that rounds to 0 at 6 decimals', async () => {
    answer = () => table('EUR', '2026-11-18', 0.0000004);
    expect(await rates().quote('EUR', '2026-11-18')).toBeNull();
    expect(await cache()).toEqual([]);
  });

  it('returns null without a request for PLN and malformed codes, and when NBP is unreachable', async () => {
    const fx = rates();
    expect(await fx.quote('PLN', '2026-11-18')).toBeNull();
    expect(await fx.quote('eur/../x', '2026-11-18')).toBeNull();
    expect(requests).toEqual([]);

    await new Promise((resolve) => server.close(resolve));
    expect(await fx.quote('EUR', '2026-11-18')).toBeNull();
    expect(logs).toMatchObject([{ level: 40, msg: 'NBP rate unavailable' }]);
  });
});
