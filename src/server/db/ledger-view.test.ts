import { asc, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { account, category, categoryGroup, ledgerLine, subtransaction, transaction } from './schema';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});

async function seed() {
  const [checking, visa, mortgage] = await t.db
    .insert(account)
    .values([
      { name: 'Checking', type: 'checking' },
      { name: 'Visa', type: 'credit_card' },
      { name: 'Mortgage', type: 'mortgage' },
    ])
    .returning();
  const [group] = await t.db.insert(categoryGroup).values({ name: 'Bills' }).returning();
  const [groceries, housing] = await t.db
    .insert(category)
    .values([
      { name: 'Groceries', groupId: group!.id },
      { name: 'Housing', groupId: group!.id },
    ])
    .returning();
  return { checking: checking!, visa: visa!, mortgage: mortgage!, groceries: groceries!, housing: housing! };
}

describe('v_ledger_line', () => {
  it('lists non-split lines and split lines with their parent account and date, skipping deleted rows', async () => {
    const s = await seed();
    const line = (values: Partial<typeof transaction.$inferInsert>) =>
      t.db
        .insert(transaction)
        .values({ accountId: s.checking.id, date: '2026-11-19', amount: 0, amountBase: 0, ...values })
        .returning()
        .then((rows) => rows[0]!);

    await line({ amount: 100_000, amountBase: 100_000, isStartingBalance: true, date: '2026-11-01' });
    await line({ amount: -5_000, amountBase: -5_000, categoryId: s.groceries.id });
    await line({ amount: -999, amountBase: -999, categoryId: s.groceries.id, deletedAt: new Date() });
    const payment = await line({ amount: -10_000, amountBase: -10_000, transferAccountId: s.visa.id, date: '2026-11-20' });
    await line({
      accountId: s.visa.id,
      amount: 10_000,
      amountBase: 10_000,
      transferAccountId: s.checking.id,
      transferTxnId: payment.id,
      date: '2026-11-20',
    });
    const split = await line({ amount: -8_000, amountBase: -8_000, isSplit: true, date: '2026-12-02' });
    await t.db.insert(subtransaction).values([
      { txnId: split.id, amount: -3_000, amountBase: -3_000, categoryId: s.groceries.id, sortOrder: 0 },
      {
        txnId: split.id,
        amount: -5_000,
        amountBase: -5_000,
        categoryId: s.housing.id,
        transferAccountId: s.mortgage.id,
        sortOrder: 1,
      },
      { txnId: split.id, amount: -1, amountBase: -1, categoryId: s.groceries.id, deletedAt: new Date(), sortOrder: 2 },
    ]);

    const rows = await t.db
      .select()
      .from(ledgerLine)
      .orderBy(asc(ledgerLine.date), desc(ledgerLine.amount));

    expect(
      rows.map((r) => ({
        account: r.accountId === s.visa.id ? 'visa' : 'checking',
        accountClass: r.accountClass,
        date: r.date,
        month: r.month,
        category: r.categoryId === s.groceries.id ? 'groceries' : r.categoryId === s.housing.id ? 'housing' : null,
        amountBase: r.amountBase,
        isTransfer: r.isTransfer,
        counterAccountClass: r.counterAccountClass,
        isStartingBalance: r.isStartingBalance,
        isSplitLine: r.subtxnId !== null,
        parent: r.txnId === split.id ? 'split' : 'own',
      })),
    ).toEqual([
      { account: 'checking', accountClass: 'cash', date: '2026-11-01', month: '2026-11-01', category: null, amountBase: 100_000, isTransfer: false, counterAccountClass: null, isStartingBalance: true, isSplitLine: false, parent: 'own' },
      { account: 'checking', accountClass: 'cash', date: '2026-11-19', month: '2026-11-01', category: 'groceries', amountBase: -5_000, isTransfer: false, counterAccountClass: null, isStartingBalance: false, isSplitLine: false, parent: 'own' },
      { account: 'visa', accountClass: 'credit', date: '2026-11-20', month: '2026-11-01', category: null, amountBase: 10_000, isTransfer: true, counterAccountClass: 'cash', isStartingBalance: false, isSplitLine: false, parent: 'own' },
      { account: 'checking', accountClass: 'cash', date: '2026-11-20', month: '2026-11-01', category: null, amountBase: -10_000, isTransfer: true, counterAccountClass: 'credit', isStartingBalance: false, isSplitLine: false, parent: 'own' },
      { account: 'checking', accountClass: 'cash', date: '2026-12-02', month: '2026-12-01', category: 'groceries', amountBase: -3_000, isTransfer: false, counterAccountClass: null, isStartingBalance: false, isSplitLine: true, parent: 'split' },
      { account: 'checking', accountClass: 'cash', date: '2026-12-02', month: '2026-12-01', category: 'housing', amountBase: -5_000, isTransfer: true, counterAccountClass: 'tracking', isStartingBalance: false, isSplitLine: true, parent: 'split' },
    ]);
  });

  it('drops the live lines of a deleted split parent', async () => {
    const s = await seed();
    const [split] = await t.db
      .insert(transaction)
      .values({
        accountId: s.checking.id,
        date: '2026-11-19',
        amount: -100,
        amountBase: -100,
        isSplit: true,
        deletedAt: new Date(),
      })
      .returning();
    await t.db.insert(subtransaction).values([
      { txnId: split!.id, amount: -60, amountBase: -60, categoryId: s.groceries.id },
      { txnId: split!.id, amount: -40, amountBase: -40, categoryId: s.housing.id },
    ]);
    expect(await t.db.select().from(ledgerLine).where(eq(ledgerLine.txnId, split!.id))).toEqual([]);
  });

  it('exposes the native amount next to the PLN base amount', async () => {
    const [euro] = await t.db.insert(account).values({ name: 'Euro', type: 'savings', currency: 'EUR' }).returning();
    const [txn] = await t.db
      .insert(transaction)
      .values({ accountId: euro!.id, date: '2026-11-19', amount: 10_000, amountBase: 42_512, fxRate: '4.2512' })
      .returning();
    const rows = await t.db
      .select({ amount: ledgerLine.amount, amountBase: ledgerLine.amountBase })
      .from(ledgerLine)
      .where(eq(ledgerLine.txnId, txn!.id));
    expect(rows).toEqual([{ amount: 10_000, amountBase: 42_512 }]);
  });
});
