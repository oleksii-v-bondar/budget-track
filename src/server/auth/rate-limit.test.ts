import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type Db } from '../db/client';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { FakeClock } from '../test/fake-clock';
import { LOGIN_LOCK_KEY, withLoginLock } from './rate-limit';

let t: TestDatabase;
const pools: Database[] = [];
beforeEach(async () => {
  t = await createTestDatabase();
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  await t.drop();
});

function connect(max: number): Db {
  const pool = createDatabase(t.url, { max });
  pools.push(pool);
  return pool.db;
}

/** Takes the login lock on another connection, as a second server process would; the result releases it. */
async function holdLoginLock(): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const isHeld = new Promise<void>((resolve) => (held = resolve));
  const done = connect(1).transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOGIN_LOCK_KEY}::bigint)`);
    held();
    await released;
  });
  await isHeld;
  return async () => {
    release();
    await done;
  };
}

const clock = new FakeClock('2026-11-20T10:00:00Z');

describe('withLoginLock', () => {
  it('queues sign-ins in memory, so the waiting ones hold no pooled connection', async () => {
    const db = connect(2);
    const release = await holdLoginLock();
    const signIns = [1, 2, 3].map((n) => withLoginLock(db, clock, `198.51.100.${n}`, async () => n));
    const otherRequest = db.execute(sql`select 1`).then(() => 'answered');
    expect(await Promise.race([otherRequest, sleep(1000, 'starved')])).toBe('answered');
    await release();
    expect(await Promise.all(signIns)).toEqual([1, 2, 3]);
  });

  it('gives up with 503 busy when another process holds the lock too long', async () => {
    const release = await holdLoginLock();
    try {
      const signIn = withLoginLock(t.db, clock, '198.51.100.1', async () => 'signed in', { lockTimeoutMs: 100 });
      await expect(signIn).rejects.toMatchObject({ status: 503, code: 'busy', headers: { 'Retry-After': '1' } });
    } finally {
      await release();
    }
    expect(await withLoginLock(t.db, clock, '198.51.100.1', async () => 'signed in')).toBe('signed in');
  });
});
