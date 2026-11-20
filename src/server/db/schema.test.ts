import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_TYPES, accountClassOf } from '../../shared/accounts';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { account, appUser, assignment, category, categoryGroup, payee } from './schema';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});

describe('migrations', () => {
  it('create every table from spec §4', async () => {
    const rows = await t.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'account',
      'app_user',
      'assignment',
      'category',
      'category_group',
      'fx_rate',
      'loan_interest_override',
      'login_attempt',
      'month_note',
      'payee',
      'scheduled_subtransaction',
      'scheduled_transaction',
      'session',
      'subtransaction',
      'target',
      'transaction',
      'undo_entry',
    ]);
  });
});

describe('int8 handling', () => {
  it('returns bigint columns and bigint aggregates as exact JS numbers', async () => {
    const [created] = await t.db
      .insert(account)
      .values({ name: 'Big', type: 'checking', minPayment: Number.MAX_SAFE_INTEGER })
      .returning();
    expect(created?.minPayment).toBe(Number.MAX_SAFE_INTEGER);
    const [row] = await t.db.execute<{ total: number }>(
      sql`select sum(x)::bigint as total from (values (1::bigint), (2::bigint)) v(x)`,
    );
    expect(row?.total).toBe(3);
  });

  it('refuses int8 values outside the safe integer range', async () => {
    const error = await t.db.execute(sql`select 9007199254740993::bigint as v`).then(
      () => undefined,
      (e: unknown) => e,
    );
    // Drizzle wraps driver errors ("Failed query: ...") and keeps the original as `cause`.
    expect(String((error as Error | undefined)?.cause)).toContain('safe integer range');
  });
});

describe('constraints', () => {
  it('allows at most one app_user row', async () => {
    const row = { passwordHash: 'x', totpSecretEnc: 'y', budgetStartMonth: '2026-11-01' };
    await t.db.insert(appUser).values(row);
    await expect(t.db.insert(appUser).values(row)).rejects.toThrow();
  });

  it('derives account_class from the account type exactly like accountClassOf', async () => {
    const rows = await t.db
      .insert(account)
      .values(ACCOUNT_TYPES.map((type) => ({ name: `acc-${type}`, type })))
      .returning({ type: account.type, accountClass: account.accountClass });
    for (const row of rows) expect(row.accountClass).toBe(accountClassOf(row.type));
  });

  it('keeps assignments sparse and on the first day of a month', async () => {
    const [group] = await t.db.insert(categoryGroup).values({ name: 'Bills' }).returning();
    const [rent] = await t.db.insert(category).values({ name: 'Rent', groupId: group!.id }).returning();
    await expect(
      t.db.insert(assignment).values({ categoryId: rent!.id, month: '2026-11-15', amount: 100 }),
    ).rejects.toThrow();
    await expect(t.db.insert(assignment).values({ categoryId: rent!.id, month: '2026-11-01', amount: 0 })).rejects.toThrow();
    await t.db.insert(assignment).values({ categoryId: rent!.id, month: '2026-11-01', amount: 100 });
  });

  it('keeps live payee names unique, ignoring case, but frees the name on soft delete', async () => {
    const [first] = await t.db.insert(payee).values({ name: 'Biedronka' }).returning();
    await expect(t.db.insert(payee).values({ name: 'BIEDRONKA' })).rejects.toThrow();
    await t.db.execute(sql`update payee set deleted_at = now() where id = ${first!.id}`);
    await t.db.insert(payee).values({ name: 'biedronka' });
  });

  it('rejects malformed currency codes', async () => {
    await expect(t.db.insert(account).values({ name: 'Bad', type: 'checking', currency: 'pln' })).rejects.toThrow();
  });
});
