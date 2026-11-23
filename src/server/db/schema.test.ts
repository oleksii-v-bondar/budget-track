import { asc, eq, isNotNull, sql } from 'drizzle-orm';
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

/** Drizzle wraps driver errors ("Failed query: ...") and keeps the original as `cause`; return both texts. */
async function rejectionText(query: PromiseLike<unknown>): Promise<string> {
  const error = await Promise.resolve(query).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return `${(error as Error).message} ${String((error as Error).cause)}`;
}

describe('migrations', () => {
  it('create every table from spec §4', async () => {
    const rows = await t.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'account',
      'app_user',
      'assignment',
      'bank_account',
      'bank_connection',
      'category',
      'category_group',
      'fx_rate',
      'loan_interest_override',
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

  it('refuses to write numbers outside the safe integer range', async () => {
    const query = t.db
      .insert(account)
      .values({ name: 'Too big', type: 'checking', minPayment: Number.MAX_SAFE_INTEGER + 2 });
    expect(await rejectionText(query)).toContain('safe integer range');
  });
});

describe('constraints', () => {
  it('allows at most one app_user row', async () => {
    const row = { budgetStartMonth: '2026-11-01' };
    await t.db.insert(appUser).values(row);
    await expect(t.db.insert(appUser).values(row)).rejects.toThrow();
  });

  it('keeps budget_start_month on the first day of a month', async () => {
    const query = t.db.insert(appUser).values({ budgetStartMonth: '2026-11-15' });
    // Check constraints run before the singleton index, so the name proves which rule rejected the row.
    expect(await rejectionText(query)).toContain('app_user_budget_start_first_of_month');
  });

  it('derives account_class from the account type exactly like accountClassOf', async () => {
    const rows = await t.db
      .insert(account)
      .values(ACCOUNT_TYPES.map((type) => ({ name: `acc-${type}`, type })))
      .returning({ type: account.type, accountClass: account.accountClass });
    expect(rows).toHaveLength(ACCOUNT_TYPES.length);
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

describe('schema hardening (P2b1)', () => {
  it('creates the three system payees, one per kind', async () => {
    const rows = await t.db
      .select({ name: payee.name, systemKind: payee.systemKind })
      .from(payee)
      .where(isNotNull(payee.systemKind))
      .orderBy(asc(payee.name));
    expect(rows).toEqual([
      { name: 'FX revaluation', systemKind: 'fx_revaluation' },
      { name: 'Reconciliation Balance Adjustment', systemKind: 'reconciliation_adjustment' },
      { name: 'Starting Balance', systemKind: 'starting_balance' },
    ]);
    const query = t.db.insert(payee).values({ name: 'Another start', systemKind: 'starting_balance' });
    expect(await rejectionText(query)).toContain('payee_one_per_system_kind');
  });

  it('lets user payees reuse the names of transfer and system payees', async () => {
    const [savings] = await t.db.insert(account).values({ name: 'Savings', type: 'savings' }).returning();
    await t.db.insert(payee).values({ name: 'Transfer : Savings', transferAccountId: savings!.id });
    await t.db.insert(payee).values([{ name: 'transfer : savings' }, { name: 'starting balance' }]);
  });

  it('allows one group per non-normal kind but any number of normal groups', async () => {
    await t.db.insert(categoryGroup).values([{ name: 'Internal', kind: 'internal' }, { name: 'A' }, { name: 'B' }]);
    const query = t.db.insert(categoryGroup).values({ name: 'Internal 2', kind: 'internal' });
    expect(await rejectionText(query)).toContain('category_group_one_per_system_kind');
  });

  it('allows one live category per linked account', async () => {
    const [card] = await t.db.insert(account).values({ name: 'Visa', type: 'credit_card' }).returning();
    const [group] = await t.db.insert(categoryGroup).values({ name: 'Cards' }).returning();
    const linked = { groupId: group!.id, name: 'Visa', linkedAccountId: card!.id };
    const [first] = await t.db.insert(category).values(linked).returning();
    expect(await rejectionText(t.db.insert(category).values(linked))).toContain('category_linked_account_live');
    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, first!.id));
    await t.db.insert(category).values(linked);
  });

  it('stores timestamps with millisecond precision, so JS dates read back exactly', async () => {
    const [row] = await t.db.execute<{ micros: number }>(
      sql`insert into category_group (name, created_at) values ('Precise', '2026-11-20T10:00:00.123456Z')
          returning (extract(microseconds from created_at)::bigint % 1000) as micros`,
    );
    expect(row?.micros).toBe(0);
  });

  it('has no ON DELETE actions on recorded tables, which would bypass the undo recorder', async () => {
    const rows = await t.db.execute<{ conname: string }>(
      sql`select conname from pg_constraint where contype = 'f' and confdeltype <> 'a'`,
    );
    // bank_account isn't recorded: deleting its linked account just unlinks it.
    expect(rows.map((r) => r.conname)).toEqual(['bank_account_account_id_account_id_fk']);
  });
});

describe('transaction link indexes (P2c)', () => {
  it('indexes the links between transfer sides, split lines, counterparts and schedules', async () => {
    const rows = await t.db.execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes
          where indexname in ('transaction_transfer_txn_id', 'transaction_transfer_account_id',
            'transaction_scheduled_id', 'subtransaction_transfer_txn_id', 'scheduled_subtransaction_scheduled_id')
          order by indexname`,
    );
    expect(rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, '')])).toEqual([
      ['scheduled_subtransaction_scheduled_id', '(scheduled_id)'],
      ['subtransaction_transfer_txn_id', '(transfer_txn_id)'],
      ['transaction_scheduled_id', '(scheduled_id)'],
      ['transaction_transfer_account_id', '(transfer_account_id)'],
      ['transaction_transfer_txn_id', '(transfer_txn_id)'],
    ]);
  });
});
