import { eq } from 'drizzle-orm';
import type { CreateTransactionRequest, UpdateTransactionRequest } from '../../shared/api/transactions';
import type { IsoDate } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { payee, subtransaction, transaction } from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { findOrCreatePayee } from '../payees/payee-commands';
import { accountsOf, type Aggregate, draftOf, loadAggregate, storedRates } from './aggregate';
import { type Draft, type DraftLine, type Plan, type PlanContext, planTransaction, type RowPlan } from './plan';
import { findAccount } from './rules';
import { insertPlan, insertSchedule, rememberCategory, softDelete, syncPlan } from './write';

export interface SavedTransaction {
  kind: 'transaction' | 'scheduled';
  /** The transaction's id, or the schedule's. */
  id: string;
  date: IsoDate;
  /** For the undo label. */
  payeeName: string | null;
}

/** "Add transaction "Biedronka"" / "Schedule transaction "Biedronka"" */
export function savedLabel(saved: SavedTransaction): string {
  const verb = saved.kind === 'scheduled' ? 'Schedule transaction' : 'Add transaction';
  return saved.payeeName === null ? verb : `${verb} "${saved.payeeName}"`;
}

/** Resolves a payee name the user typed: the command finds or creates the payee, a dry run only looks it up. */
export type PayeeByName = (name: string) => Promise<string | null>;

/** The new transaction as a draft (manual transactions are approved). */
export async function createDraft(
  input: CreateTransactionRequest,
  today: IsoDate,
  payeeByName: PayeeByName,
): Promise<Draft> {
  const payeeId = input.payeeName === undefined ? (input.payeeId ?? null) : await payeeByName(input.payeeName);
  return {
    accountId: input.accountId,
    date: input.date ?? today,
    payeeId,
    categoryId: input.categoryId,
    memo: input.memo || null,
    amount: input.amount,
    transferAmount: input.transferAmount ?? null,
    fxRate: input.fxRate ?? null,
    cleared: input.cleared,
    approved: true,
    flag: input.flag,
    lines: input.lines?.map((line) => ({ ...line, memo: line.memo || null })) ?? null,
  };
}

/**
 * Spec §10 "Creating and editing": a new payee name creates the payee; a date after today becomes a one-time
 * scheduled transaction (spec §5.6). A foreign amount without `fxRate` is booked at `defaults`, the NBP rates the
 * caller quoted for its date (spec §9); a schedule stores the rate sent, or none (the NBP rate of the day it is
 * entered applies then).
 */
export async function createTransaction(
  rec: ChangeRecorder,
  input: CreateTransactionRequest,
  today: IsoDate,
  defaults = new Map<string, string>(),
): Promise<SavedTransaction> {
  const draft = await createDraft(input, today, (name) => findOrCreatePayee(rec, name));
  const future = draft.date > today;
  const plan = await planTransaction(rec.tx, draft, future ? { unknownRates: new Set() } : { defaults });
  const payeeName = plan.payee?.name ?? null;
  if (future) {
    if (plan.transfer && plan.transfer.currency !== plan.account.currency) {
      // A schedule has no column for the other side's amount.
      throw new DomainError(
        'future_transfer_currency',
        "Transfers between currencies can't be dated in the future yet.",
        'date',
      );
    }
    return { kind: 'scheduled', id: await insertSchedule(rec, draft, plan), date: draft.date, payeeName };
  }
  return { kind: 'transaction', id: await insertPlan(rec, plan), date: draft.date, payeeName };
}

export interface EditContext {
  today: IsoDate;
  now: Date;
  /** Spec §9: NBP rates for the edited date by currency, quoted before the command (none for bulk edits). */
  defaults?: Map<string, string>;
}

/** The payee's name for undo labels. */
async function payeeNameOf(rec: ChangeRecorder, id: string | null): Promise<string | null> {
  if (id === null) return null;
  const [row] = await rec.tx.select({ name: payee.name }).from(payee).where(eq(payee.id, id));
  return row?.name ?? null;
}

/** "Edit transaction "Biedronka"" */
export const editLabel = (r: { payeeName: string | null }) =>
  r.payeeName === null ? 'Edit transaction' : `Edit transaction "${r.payeeName}"`;

type TxnRow = Aggregate['main'];

/** Spec §10 "Reconciled transactions": does the change move a reconciled row's amount, date, account or transfer? */
function touchesReconciled(row: TxnRow | null, next: RowPlan | null): boolean {
  if (row?.cleared !== 'reconciled') return false;
  return (
    next === null ||
    next.amount !== row.amount ||
    next.date !== row.date ||
    next.accountId !== row.accountId ||
    next.transferAccountId !== row.transferAccountId
  );
}

/** 409 unless the client confirmed a change to reconciled rows (the UI asks first). */
export function assertConfirmed(touches: boolean, confirmed: boolean): void {
  if (touches && !confirmed) {
    throw new AppError(409, 'confirm_reconciled', 'This changes a reconciled transaction. Confirm to go ahead.');
  }
}

/** Reconciled rows the edit changes: un-reconciling, replaced lines, and mirrored or removed transfer sides count. */
function editTouchesReconciled(agg: Aggregate, plan: Plan, replaceLines: boolean): boolean {
  const { main, counterpart } = agg;
  const sameSide = plan.counterpart && plan.counterpart.accountId === counterpart?.accountId ? plan.counterpart : null;
  return (
    touchesReconciled(main, plan.main) ||
    (main.cleared === 'reconciled' && (plan.main.cleared !== 'reconciled' || replaceLines)) ||
    touchesReconciled(counterpart, sameSide) ||
    agg.lines.some(({ counterpart: lineSide }, index) =>
      touchesReconciled(lineSide, replaceLines ? null : (plan.lines?.[index]?.counterpart ?? null)),
    )
  );
}

/** Fields that a split line's counterpart takes; everything else belongs to the split (spec §10 "Splits"). */
const COUNTERPART_FIELDS = new Set(['memo', 'cleared', 'approved', 'flag', 'confirmReconciled']);

/** The counterpart of a split line: its memo mirrors the line's; cleared, approved and flag are its own. */
async function updateLineCounterpart(
  rec: ChangeRecorder,
  agg: Aggregate & { owner: NonNullable<Aggregate['owner']> },
  patch: UpdateTransactionRequest,
): Promise<void> {
  const field = Object.keys(patch).find(
    (key) => patch[key as keyof UpdateTransactionRequest] !== undefined && !COUNTERPART_FIELDS.has(key),
  );
  if (field !== undefined) {
    const split = await findAccount(rec.tx, agg.owner.parent.accountId);
    throw new DomainError(
      'split_counterpart',
      `This transfer is a line of a split in "${split!.name}": change it there.`,
      field,
    );
  }
  const unreconciles = agg.main.cleared === 'reconciled' && patch.cleared !== undefined;
  assertConfirmed(unreconciles, patch.confirmReconciled);
  const memo = patch.memo === undefined ? undefined : patch.memo || null;
  await rec.update(transaction, eq(transaction.id, agg.main.id), {
    memo,
    cleared: patch.cleared,
    approved: patch.approved,
    flag: patch.flag,
  });
  await rec.update(subtransaction, eq(subtransaction.id, agg.owner.line.id), { memo });
}

const sameLines = (a: DraftLine[] | null, b: DraftLine[] | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.length === b.length &&
    a.every(
      (line, i) =>
        line.amount === b[i]!.amount &&
        line.payeeId === b[i]!.payeeId &&
        line.categoryId === b[i]!.categoryId &&
        line.memo === b[i]!.memo,
    ));

/** The saved draft with the request's changes applied. */
async function applyPatch(agg: Aggregate, patch: UpdateTransactionRequest, payeeByName: PayeeByName): Promise<Draft> {
  const current = draftOf(agg);
  const lines =
    patch.lines === undefined
      ? current.lines
      : (patch.lines?.map((line) => ({ ...line, memo: line.memo || null })) ?? null);
  const payeeId =
    patch.payeeName !== undefined
      ? await payeeByName(patch.payeeName)
      : patch.payeeId !== undefined
        ? patch.payeeId
        : current.payeeId;
  return {
    ...current,
    accountId: patch.accountId ?? current.accountId,
    date: patch.date ?? current.date,
    payeeId,
    // New lines leave the split itself uncategorized; a new payee keeps this row's own category, not the other
    // side's: the transfer it belonged to is gone.
    categoryId:
      patch.categoryId !== undefined
        ? patch.categoryId
        : patch.lines
          ? null
          : payeeId !== current.payeeId
            ? agg.main.categoryId
            : current.categoryId,
    memo: patch.memo === undefined ? current.memo : patch.memo || null,
    amount: patch.amount ?? current.amount,
    transferAmount: patch.transferAmount ?? null,
    fxRate: patch.fxRate ?? null,
    cleared: patch.cleared ?? current.cleared,
    approved: patch.approved ?? current.approved,
    flag: patch.flag !== undefined ? patch.flag : current.flag,
    lines,
  };
}

/** A starting balance (spec §10) keeps its account, payee and category, and can't become a split or a transfer. */
function assertStartingBalanceKept(agg: Aggregate, draft: Draft): void {
  const { main } = agg;
  if (!main.isStartingBalance) return;
  const changed = (
    [
      ['accountId', draft.accountId !== main.accountId],
      ['payeeId', draft.payeeId !== main.payeeId],
      // Before categoryId: new lines leave the split itself uncategorized.
      ['lines', draft.lines !== null],
      ['categoryId', draft.categoryId !== main.categoryId],
    ] as const
  ).find(([, differs]) => differs);
  if (changed) {
    throw new DomainError(
      'starting_balance',
      'A starting balance keeps its account, payee and category; change its amount, date or memo instead.',
      changed[0],
    );
  }
}

/** Moving a transaction keeps its amounts, so only accounts in the same currency qualify. */
async function assertSameCurrency(rec: ChangeRecorder, agg: Aggregate, draft: Draft): Promise<void> {
  if (draft.accountId === agg.main.accountId) return;
  const from = await findAccount(rec.tx, agg.main.accountId);
  const to = await findAccount(rec.tx, draft.accountId);
  if (to && to.currency !== from!.currency) {
    throw new DomainError(
      'move_currency',
      `A transaction can only move to another ${from!.currency} account.`,
      'accountId',
    );
  }
}

/** The edited transaction as a draft, with what the saved one already has for planning it. */
export async function editDraft(
  db: Executor,
  agg: Aggregate,
  patch: UpdateTransactionRequest,
  payeeByName: PayeeByName,
): Promise<{ draft: Draft; context: PlanContext }> {
  const draft = await applyPatch(agg, patch, payeeByName);
  const existing = {
    payeeId: agg.main.payeeId,
    rates: await storedRates(db, agg, draft.date === agg.main.date),
    counterpart: agg.counterpart && { accountId: agg.counterpart.accountId, amount: agg.counterpart.amount },
    accountIds: accountsOf(agg),
  };
  return { draft, context: { existing } };
}

/**
 * PATCH /api/transactions/:id (spec §10 "Creating and editing", "Transfers"): the edited transaction is planned again
 * with every rule of a new one, then its rows are brought in line. Spec §9: a new date replaces an NBP rate with that
 * day's (from `context.defaults`); a manual rate stays until a new one is sent. `deletedIds` lists the transactions
 * the edit soft-deleted (an ended or moved transfer's old side, replaced lines' counterparts).
 */
export async function updateTransaction(
  rec: ChangeRecorder,
  id: string,
  patch: UpdateTransactionRequest,
  context: EditContext,
): Promise<{ payeeName: string | null; deletedIds: string[] }> {
  const agg = await loadAggregate(rec.tx, id);
  if (agg.owner) {
    await updateLineCounterpart(rec, { ...agg, owner: agg.owner }, patch);
    return { payeeName: await payeeNameOf(rec, agg.main.payeeId), deletedIds: [] };
  }
  const prepared = await editDraft(rec.tx, agg, patch, (name) => findOrCreatePayee(rec, name));
  const draft = prepared.draft;
  if (patch.date !== undefined && patch.date > context.today) {
    throw new DomainError(
      'date_in_future',
      "A saved transaction can't move into the future. Delete it and add it again with the new date.",
      'date',
    );
  }
  assertStartingBalanceKept(agg, draft);
  await assertSameCurrency(rec, agg, draft);
  const plan = await planTransaction(rec.tx, draft, { ...prepared.context, defaults: context.defaults });
  const replaceLines = !sameLines(draftOf(agg).lines, draft.lines);
  assertConfirmed(editTouchesReconciled(agg, plan, replaceLines), patch.confirmReconciled);
  const deletedIds = await syncPlan(rec, agg, plan, context.now, replaceLines);
  if (draft.payeeId !== agg.main.payeeId || draft.categoryId !== agg.main.categoryId) {
    await rememberCategory(rec, plan);
  }
  return { payeeName: plan.payee?.name ?? null, deletedIds };
}

/** "Delete transaction "Biedronka"" */
export const deleteLabel = (r: { payeeName: string | null }) =>
  r.payeeName === null ? 'Delete transaction' : `Delete transaction "${r.payeeName}"`;

/**
 * Spec §10: deleting one side of a transfer deletes both; deleting a split deletes the counterparts of its transfer
 * lines (its lines leave the budget with it). Everything is soft-deleted. A split line's counterpart is removed by
 * editing the split.
 */
export async function deleteTransaction(
  rec: ChangeRecorder,
  id: string,
  context: { now: Date; confirmReconciled: boolean },
): Promise<{ payeeName: string | null; ids: string[] }> {
  const agg = await loadAggregate(rec.tx, id);
  if (agg.owner) {
    const split = await findAccount(rec.tx, agg.owner.parent.accountId);
    throw new DomainError(
      'split_counterpart',
      `This transfer is a line of a split in "${split!.name}": remove the line there.`,
    );
  }
  const rows = [agg.main, agg.counterpart, ...agg.lines.map((l) => l.counterpart)].filter((r) => r !== null);
  assertConfirmed(rows.some((r) => r.cleared === 'reconciled'), context.confirmReconciled);
  const ids = rows.map((r) => r.id);
  await softDelete(rec, ids, context.now);
  return { payeeName: await payeeNameOf(rec, agg.main.payeeId), ids };
}
