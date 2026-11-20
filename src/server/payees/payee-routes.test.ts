import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PayeeDto, PayeeListResponse } from '../../shared/api/payees';
import { systemPayeeId } from '../db/lookups';
import { payee, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createCategory, createGroup, createPayee } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const list = async () => (await json<PayeeListResponse>(await ctx.client.get('/api/payees'))).body.payees;
const rename = (id: string, name: string) => ctx.client.send('PATCH', `/api/payees/${id}`, { name });
const merge = (id: string, targetId: string) => ctx.client.post(`/api/payees/${id}/merge`, { targetId });
const remove = (id: string) => ctx.client.send('DELETE', `/api/payees/${id}`);

describe('GET /api/payees', () => {
  it('lists live payees with their kind and live usage, user payees first', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const zabka = await createPayee(ctx.client, 'żabka');
    const biedronka = await createPayee(ctx.client, 'Biedronka');
    const gone = await createPayee(ctx.client, 'Gone');
    await remove(gone.id);
    const line = { accountId: checking.id, date: '2026-11-20', amount: -100, amountBase: -100 };
    const [split] = await t.db
      .insert(transaction)
      .values([
        { ...line, payeeId: biedronka.id },
        { ...line, payeeId: biedronka.id, deletedAt: new Date() },
        { ...line, isSplit: true },
      ])
      .returning()
      .then((rows) => rows.slice(2));
    await t.db.insert(subtransaction).values([
      { txnId: split!.id, amount: -60, amountBase: -60, payeeId: biedronka.id },
      { txnId: split!.id, amount: -40, amountBase: -40, payeeId: biedronka.id, deletedAt: new Date() },
    ]);
    await t.db.insert(scheduledTransaction).values({
      accountId: checking.id,
      payeeId: zabka.id,
      amount: -100,
      frequency: 'monthly',
      anchorDate: '2026-12-01',
      nextDate: '2026-12-01',
    });

    expect((await list()).map((p) => [p.name, p.kind, p.usageCount])).toEqual([
      ['Biedronka', 'user', 2],
      ['żabka', 'user', 1],
      ['Transfer : mBank', 'transfer', 0],
      ['FX revaluation', 'system', 0],
      ['Reconciliation Balance Adjustment', 'system', 0],
      ['Starting Balance', 'system', 1],
    ]);
    expect((await list()).find((p) => p.kind === 'transfer')).toEqual({
      id: checking.transferPayeeId,
      name: 'Transfer : mBank',
      kind: 'transfer',
      transferAccountId: checking.id,
      lastCategoryId: null,
      usageCount: 0,
    });
  });
});

describe('POST /api/payees and PATCH /api/payees/:id', () => {
  it('creates a payee whose name is unique among live user payees, ignoring case', async () => {
    await createAccount(ctx.client, { name: 'mBank' });
    const res = await json<PayeeDto>(await ctx.client.post('/api/payees', { name: '  Biedronka ' }));
    expect(res).toEqual({
      status: 201,
      body: {
        id: expect.any(String),
        name: 'Biedronka',
        kind: 'user',
        transferAccountId: null,
        lastCategoryId: null,
        usageCount: 0,
      },
    });
    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Create payee "Biedronka"' },
    });
    expect(await json(await ctx.client.post('/api/payees', { name: 'BIEDRONKA' }))).toEqual({
      status: 422,
      body: { code: 'payee_name_taken', message: 'You already have a payee with this name.' },
    });
    // Transfer and system payee names don't block user payees.
    for (const name of ['Transfer : mBank', 'Starting Balance']) {
      expect((await ctx.client.post('/api/payees', { name })).status).toBe(201);
    }
    expect((await ctx.client.post('/api/payees', { name: ' ' })).status).toBe(400);
  });

  it('renames user payees only', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const shop = await createPayee(ctx.client, 'Biedronka');
    await createPayee(ctx.client, 'Lidl');

    expect(await json(await rename(shop.id, 'BIEDRONKA'))).toMatchObject({ status: 200, body: { name: 'BIEDRONKA' } });
    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Rename payee "Biedronka"' },
    });
    expect(await json(await rename(shop.id, 'lidl'))).toEqual({
      status: 422,
      body: { code: 'payee_name_taken', message: 'You already have a payee with this name. Merge the two instead.' },
    });
    const locked = {
      status: 422,
      body: { code: 'payee_not_editable', message: "Transfer and system payees can't be renamed, merged or deleted." },
    };
    expect(await json(await rename(checking.transferPayeeId, 'Mine'))).toEqual(locked);
    expect(await json(await rename(await systemPayeeId(t.db, 'starting_balance'), 'Mine'))).toEqual(locked);
    expect(await json(await rename(crypto.randomUUID(), 'X'))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Payee not found.' },
    });
  });
});

describe('POST /api/payees/:id/merge', () => {
  it('moves every transaction, line and schedule to the target, then soft-deletes the payee', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const food = await createGroup(ctx.client, 'Food');
    const groceries = await createCategory(ctx.client, food.id, 'Groceries');
    const typo = await createPayee(ctx.client, 'Biedronak');
    const shop = await createPayee(ctx.client, 'Biedronka');
    await t.db.update(payee).set({ lastCategoryId: groceries.id }).where(eq(payee.id, typo.id));
    const line = { accountId: checking.id, date: '2026-11-20', amount: -100, amountBase: -100 };
    const [live, deleted, split] = await t.db
      .insert(transaction)
      .values([
        { ...line, payeeId: typo.id },
        { ...line, payeeId: typo.id, deletedAt: new Date() },
        { ...line, isSplit: true },
      ])
      .returning();
    const [splitLine] = await t.db
      .insert(subtransaction)
      .values({ txnId: split!.id, amount: -100, amountBase: -100, payeeId: typo.id })
      .returning();
    const [schedule] = await t.db
      .insert(scheduledTransaction)
      .values({
        accountId: checking.id,
        payeeId: typo.id,
        amount: -100,
        frequency: 'monthly',
        anchorDate: '2026-12-01',
        nextDate: '2026-12-01',
      })
      .returning();
    const [scheduleLine] = await t.db
      .insert(scheduledSubtransaction)
      .values({ scheduledId: schedule!.id, amount: -100, payeeId: typo.id })
      .returning();
    const before = await snapshot(t.db);

    const res = await json<PayeeDto>(await merge(typo.id, shop.id));
    expect(res).toMatchObject({ status: 200, body: { id: shop.id, lastCategoryId: groceries.id, usageCount: 4 } });
    const payeeOf = async (table: typeof transaction | typeof subtransaction, id: string) =>
      (await t.db.select({ payeeId: table.payeeId }).from(table).where(eq(table.id, id)))[0]!.payeeId;
    for (const id of [live!.id, deleted!.id]) expect(await payeeOf(transaction, id)).toBe(shop.id);
    expect(await payeeOf(subtransaction, splitLine!.id)).toBe(shop.id);
    const schedules = [
      ...(await t.db.select({ payeeId: scheduledTransaction.payeeId }).from(scheduledTransaction)),
      ...(await t.db
        .select({ payeeId: scheduledSubtransaction.payeeId })
        .from(scheduledSubtransaction)
        .where(eq(scheduledSubtransaction.id, scheduleLine!.id))),
    ];
    expect(schedules).toEqual([{ payeeId: shop.id }, { payeeId: shop.id }]);
    const [merged] = await t.db.select().from(payee).where(eq(payee.id, typo.id));
    expect(merged!.deletedAt).toEqual(ctx.clock.now());
    expect((await list()).map((p) => p.name)).not.toContain('Biedronak');
    const after = await snapshot(t.db);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Merge payee "Biedronak" into "Biedronka"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('refuses merges into itself, a deleted payee, or a transfer or system payee, and of app payees', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const shop = await createPayee(ctx.client, 'Biedronka');
    const gone = await createPayee(ctx.client, 'Gone');
    await remove(gone.id);
    const invalid = {
      status: 422,
      body: { code: 'invalid_merge_target', message: 'Choose another of your payees to merge into.' },
    };
    const startingBalance = await systemPayeeId(t.db, 'starting_balance');
    for (const target of [shop.id, gone.id, checking.transferPayeeId, startingBalance, crypto.randomUUID()]) {
      expect(await json(await merge(shop.id, target))).toEqual(invalid);
    }
    expect((await json(await merge(checking.transferPayeeId, shop.id))).body).toMatchObject({
      code: 'payee_not_editable',
    });
    expect((await merge(gone.id, shop.id)).status).toBe(404);
  });
});

describe('DELETE /api/payees/:id', () => {
  it('deletes only unused user payees, which frees the name', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    const shop = await createPayee(ctx.client, 'Biedronka');
    const old = await createPayee(ctx.client, 'Old shop');
    const line = { accountId: checking.id, date: '2026-11-20', amount: -100, amountBase: -100 };
    await t.db.insert(transaction).values([
      { ...line, payeeId: shop.id },
      { ...line, payeeId: old.id, deletedAt: new Date() },
    ]);

    expect(await json(await remove(shop.id))).toEqual({
      status: 422,
      body: { code: 'payee_in_use', message: 'This payee is used by transactions. Merge it into another payee instead.' },
    });
    // Only live rows count: a soft-deleted transaction still points at the (soft-deleted) payee.
    expect(await json(await remove(old.id))).toEqual({ status: 200, body: { id: old.id } });
    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Delete payee "Old shop"' },
    });
    expect((await ctx.client.post('/api/payees', { name: 'Old shop' })).status).toBe(201);
    expect((await json(await remove(checking.transferPayeeId))).body).toMatchObject({ code: 'payee_not_editable' });
    expect((await remove(old.id)).status).toBe(404);
  });
});
