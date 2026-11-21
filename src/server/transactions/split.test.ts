import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionDto } from '../../shared/api/transactions';
import { systemCategoryId, systemPayeeId } from '../db/lookups';
import { ledgerLine, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import {
  createAccount,
  createCategory,
  createGroup,
  createPayee,
  createTransaction,
  ledgerLines,
} from '../test/fixtures';
import { snapshot } from '../test/snapshot';
import { type Draft, planTransaction } from './plan';

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

const post = (body: object) => ctx.client.post('/api/transactions', body);
const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;

async function setUp() {
  const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
  const savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings' });
  const food = await createGroup(ctx.client, 'Food');
  const groceries = await createCategory(ctx.client, food.id, 'Groceries');
  const household = await createCategory(ctx.client, food.id, 'Household');
  return { checking, savings, groceries, household };
}

describe('splits', () => {
  it('creates a split whose lines the budget sees instead of the split itself', async () => {
    const { checking, groceries, household } = await setUp();
    const drugstore = await createPayee(ctx.client, 'Rossmann');
    const before = await snapshot(t.db);

    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeName: 'Biedronka',
      amount: -10_000,
      lines: [
        { amount: -6_000, categoryId: groceries.id, memo: ' food ' },
        { amount: -4_000, categoryId: household.id, payeeId: drugstore.id },
      ],
    });
    expect(split).toMatchObject({ isSplit: true, categoryId: null, amount: -10_000, amountBase: -10_000 });
    expect(split.lines).toEqual([
      {
        id: expect.any(String),
        amount: -6_000,
        amountBase: -6_000,
        payeeId: null,
        payeeName: null,
        categoryId: groceries.id,
        categoryName: 'Groceries',
        memo: 'food',
        transfer: null,
      },
      {
        id: expect.any(String),
        amount: -4_000,
        amountBase: -4_000,
        payeeId: drugstore.id,
        payeeName: 'Rossmann',
        categoryId: household.id,
        categoryName: 'Household',
        memo: null,
        transfer: null,
      },
    ]);
    const rows = await t.db.select().from(subtransaction).orderBy(asc(subtransaction.sortOrder));
    expect(rows.map((r) => [r.txnId, r.sortOrder, r.amount])).toEqual([
      [split.id, 0, -6_000],
      [split.id, 1, -4_000],
    ]);
    const lines = await ledgerLines(t.db, eq(ledgerLine.txnId, split.id));
    expect(lines.map((l) => [l.subtxnId, l.categoryId, l.amountBase])).toEqual([
      [split.lines[0]!.id, groceries.id, -6_000],
      [split.lines[1]!.id, household.id, -4_000],
    ]);
    const after = await snapshot(t.db);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('gives the rounding remainder of a foreign split to its last line', async () => {
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    const split = await createTransaction(ctx.client, {
      accountId: euro.id,
      amount: -1_000,
      fxRate: '4.3333',
      lines: [{ amount: -500 }, { amount: -500 }],
    });
    // −1 000 × 4.3333 = −4 333; each line rounds to −2 167, so the last one takes −2 166.
    expect([split.amountBase, ...split.lines.map((l) => l.amountBase)]).toEqual([-4_333, -2_167, -2_166]);
    const lines = await ledgerLines(t.db, eq(ledgerLine.txnId, split.id));
    expect(lines.reduce((sum, l) => sum + l.amountBase, 0)).toBe(-4_333);
  });

  it("keeps a split's amount_base equal to the sum of its live lines' bases", async () => {
    const { checking, groceries, household } = await setUp();
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    const pocket = await createAccount(ctx.client, {
      name: 'Pocket',
      type: 'savings',
      currency: 'EUR',
      fxRate: '4.25',
    });
    const plain = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -10_001,
      lines: [
        { amount: -3_333, categoryId: groceries.id },
        { amount: -6_668, categoryId: household.id },
      ],
    });
    // A foreign split whose last line, a transfer, takes the rounding remainder.
    const foreign = await createTransaction(ctx.client, {
      accountId: euro.id,
      amount: -1_000,
      fxRate: '4.3333',
      lines: [{ amount: -500 }, { amount: -500, payeeId: pocket.transferPayeeId }],
    });
    for (const split of [plain, foreign]) {
      const [parent] = await t.db.select().from(transaction).where(eq(transaction.id, split.id));
      const live = await t.db
        .select()
        .from(subtransaction)
        .where(and(eq(subtransaction.txnId, split.id), isNull(subtransaction.deletedAt)));
      expect(live).toHaveLength(2);
      expect(live.reduce((sum, l) => sum + l.amountBase, 0)).toBe(parent!.amountBase);
    }
    expect([foreign.amountBase, ...foreign.lines.map((l) => l.amountBase)]).toEqual([-4_333, -2_167, -2_166]);
    expect((await get(foreign.lines[1]!.transfer!.transactionId)).amountBase).toBe(2_166);
  });

  it('turns a transfer line into a counterpart transaction in the target account', async () => {
    const { checking, savings, groceries } = await setUp();
    const before = await snapshot(t.db);
    const split = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -50_000,
      lines: [
        { amount: -30_000, categoryId: groceries.id },
        { amount: -20_000, payeeId: savings.transferPayeeId, memo: 'save the rest' },
      ],
    });
    const transferLine = split.lines[1]!;
    expect(transferLine.transfer).toEqual({
      accountId: savings.id,
      accountName: 'Savings',
      transactionId: expect.any(String),
    });
    const counterpart = await get(transferLine.transfer!.transactionId);
    expect(counterpart).toMatchObject({
      accountId: savings.id,
      payeeName: 'Transfer : mBank',
      categoryId: null,
      memo: 'save the rest',
      amount: 20_000,
      amountBase: 20_000,
      cleared: 'uncleared',
      isSplit: false,
      transfer: {
        accountId: checking.id,
        transactionId: split.id,
        splitLineId: transferLine.id,
        amount: -20_000,
        currency: 'PLN',
      },
    });
    const [row] = await t.db.select().from(transaction).where(eq(transaction.id, counterpart.id));
    expect(row).toMatchObject({
      transferTxnId: split.id,
      transferSubtxnId: transferLine.id,
      transferAccountId: checking.id,
    });
    const lines = await ledgerLines(t.db, inArray(ledgerLine.txnId, [split.id, counterpart.id]));
    expect(lines.map((l) => [l.accountId, l.categoryId, l.amountBase, l.isTransfer, l.counterAccountClass])).toEqual([
      [checking.id, groceries.id, -30_000, false, null],
      [checking.id, null, -20_000, true, 'cash'],
      [savings.id, null, 20_000, true, 'cash'],
    ]);
    const after = await snapshot(t.db);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('puts the category of a budget↔tracking transfer line on the budget side', async () => {
    const { checking, groceries } = await setUp();
    const loan = await createAccount(ctx.client, {
      name: 'Car',
      type: 'auto_loan',
      minPayment: 1,
      createPairedCategory: true,
    });
    const rta = await systemCategoryId(t.db, 'rta');
    const lines = (categoryId: string | null) => [
      { amount: -1_000, categoryId: groceries.id },
      { amount: -5_000, payeeId: loan.transferPayeeId, categoryId },
    ];

    expect(await json(await post({ accountId: checking.id, amount: -6_000, lines: lines(null) }))).toMatchObject({
      status: 422,
      body: { code: 'category_required', fieldErrors: { 'lines.1.categoryId': [expect.any(String)] } },
    });
    const payment = await createTransaction(ctx.client, {
      accountId: checking.id,
      amount: -6_000,
      lines: lines(loan.pairedCategoryId),
    });
    expect(payment.lines[1]!.categoryId).toBe(loan.pairedCategoryId);
    // A split in the tracking account: its transfer line's category goes to the budget-side counterpart.
    const payout = await createTransaction(ctx.client, {
      accountId: loan.id,
      amount: -3_000,
      lines: [{ amount: -1_000 }, { amount: -2_000, payeeId: checking.transferPayeeId, categoryId: rta }],
    });
    expect(payout.lines.map((l) => l.categoryId)).toEqual([null, null]);
    expect((await get(payout.lines[1]!.transfer!.transactionId)).categoryId).toBe(rta);
  });

  it('compares the lines with the amount exactly, even past 2^53', async () => {
    const { checking } = await setUp();
    // Requests can't send such amounts; P2d's internal drafts go through the same planner. In JS numbers,
    // (2^53 − 1) + 1 + 1 − 2 rounds to 2^53 − 2.
    const big = Number.MAX_SAFE_INTEGER;
    const draft: Draft = {
      accountId: checking.id,
      date: '2026-11-20',
      payeeId: null,
      categoryId: null,
      memo: null,
      amount: big - 1,
      transferAmount: null,
      fxRate: null,
      cleared: 'uncleared',
      approved: true,
      flag: null,
      lines: [big, 1, 1, -2].map((amount) => ({ amount, payeeId: null, categoryId: null, memo: null })),
    };
    await expect(planTransaction(t.db, draft)).rejects.toMatchObject({ code: 'split_sum' });
  });

  it('reports invalid lines with the path of the field', async () => {
    const { checking, savings, groceries } = await setUp();
    const card = await createAccount(ctx.client, { name: 'Visa', type: 'credit_card' });
    const loan = await createAccount(ctx.client, { name: 'Car', type: 'auto_loan' });
    const euro = await createAccount(ctx.client, { name: 'Revolut', currency: 'EUR', fxRate: '4.25' });
    const split = (lines: object[], extra: object = {}) => ({ accountId: checking.id, amount: -300, lines, ...extra });
    const ok = { amount: -100 };
    const error = async (body: object) =>
      (await json<{ code: string; fieldErrors: Record<string, string[]> }>(await post(body))).body;

    expect((await error(split([{ amount: -300 }]))).fieldErrors).toEqual({
      lines: ['A split needs at least two lines.'],
    });
    expect((await error(split([ok, { amount: 1.5 }]))).fieldErrors).toEqual({
      'lines.1.amount': ['Enter a whole amount in minor units.'],
    });
    expect((await error(split([ok, ok], { categoryId: groceries.id }))).fieldErrors).toEqual({
      categoryId: ["A split's categories go on its lines."],
    });
    expect(await error(split([ok, ok]))).toEqual({
      code: 'split_sum',
      message: 'The lines must add up to the transaction amount.',
      fieldErrors: { lines: ['The lines must add up to the transaction amount.'] },
    });
    const third = (line: object) => split([ok, ok, { amount: -100, ...line }]);
    const fieldOf = async (body: object) => {
      const { code, fieldErrors } = await error(body);
      return [code, Object.keys(fieldErrors)];
    };
    expect(await fieldOf(third({ categoryId: card.paymentCategoryId }))).toEqual([
      'card_payment_category',
      ['lines.2.categoryId'],
    ]);
    expect(await fieldOf(third({ payeeId: crypto.randomUUID() }))).toEqual(['invalid_payee', ['lines.2.payeeId']]);
    expect(await fieldOf(third({ payeeId: await systemPayeeId(t.db, 'starting_balance') }))).toEqual([
      'system_payee',
      ['lines.2.payeeId'],
    ]);
    expect(await fieldOf(third({ payeeId: checking.transferPayeeId }))).toEqual([
      'transfer_to_self',
      ['lines.2.payeeId'],
    ]);
    expect(await fieldOf(third({ payeeId: euro.transferPayeeId }))).toEqual([
      'split_transfer_currency',
      ['lines.2.payeeId'],
    ]);
    expect(await fieldOf(third({ payeeId: savings.transferPayeeId, categoryId: groceries.id }))).toEqual([
      'category_not_allowed',
      ['lines.2.categoryId'],
    ]);
    expect(await fieldOf({ ...third({ categoryId: groceries.id }), accountId: loan.id })).toEqual([
      'category_not_allowed',
      ['lines.2.categoryId'],
    ]);
    expect(await fieldOf(split([ok, ok, ok], { payeeId: savings.transferPayeeId }))).toEqual([
      'split_transfer',
      ['payeeId'],
    ]);
  });

  it('schedules a future split with its lines', async () => {
    const { checking, savings, groceries } = await setUp();
    const res = await json<{ kind: string; scheduledId: string }>(
      await post({
        accountId: checking.id,
        date: '2026-12-24',
        amount: -3_000,
        lines: [
          { amount: -1_000, categoryId: groceries.id },
          { amount: -2_000, payeeId: savings.transferPayeeId, memo: 'gift fund' },
        ],
      }),
    );
    expect(res.body.kind).toBe('scheduled');
    expect(await t.db.select().from(scheduledTransaction)).toMatchObject([{ isSplit: true, amount: -3_000 }]);
    const rows = await t.db.select().from(scheduledSubtransaction).orderBy(asc(scheduledSubtransaction.sortOrder));
    expect(rows.map((r) => [r.scheduledId, r.amount, r.categoryId, r.payeeId, r.transferAccountId, r.memo])).toEqual([
      [res.body.scheduledId, -1_000, groceries.id, null, null, null],
      [res.body.scheduledId, -2_000, null, savings.transferPayeeId, savings.id, 'gift fund'],
    ]);
    expect(await t.db.select().from(transaction).where(eq(transaction.date, '2026-12-24'))).toEqual([]);
  });
});
