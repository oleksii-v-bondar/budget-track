import { eq } from 'drizzle-orm';
import type { CreateTransactionRequest, UpdateTransactionRequest } from '../../shared/api/transactions';
import type { IsoDate } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import { payee, subtransaction, transaction } from '../db/schema';
import { DomainError } from '../http/errors';
import { findOrCreatePayee } from '../payees/payee-commands';
import { accountsOf, type Aggregate, draftOf, loadAggregate, storedRates } from './aggregate';
import { type Draft, planTransaction } from './plan';
import { findAccount } from './rules';
import { insertPlan, insertSchedule, rememberCategory, syncPlan } from './write';

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

/**
 * Spec §10 "Creating and editing": manual transactions are approved; a new payee name creates the payee; a date
 * after today becomes a one-time scheduled transaction (spec §5.6).
 */
export async function createTransaction(
  rec: ChangeRecorder,
  input: CreateTransactionRequest,
  today: IsoDate,
): Promise<SavedTransaction> {
  const payeeId =
    input.payeeName === undefined ? (input.payeeId ?? null) : await findOrCreatePayee(rec, input.payeeName);
  const draft: Draft = {
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
  const plan = await planTransaction(rec.tx, draft);
  const payeeName = plan.payee?.name ?? null;
  if (draft.date > today) {
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

/** Fields that a split line's counterpart takes; everything else belongs to the split (spec §10 "Splits"). */
const COUNTERPART_FIELDS = new Set(['memo', 'cleared', 'approved', 'flag']);

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
  const memo = patch.memo === undefined ? undefined : patch.memo || null;
  await rec.update(transaction, eq(transaction.id, agg.main.id), {
    memo,
    cleared: patch.cleared,
    approved: patch.approved,
    flag: patch.flag,
  });
  await rec.update(subtransaction, eq(subtransaction.id, agg.owner.line.id), { memo });
}

/** The saved draft with the request's changes applied. */
async function applyPatch(rec: ChangeRecorder, agg: Aggregate, patch: UpdateTransactionRequest): Promise<Draft> {
  const current = draftOf(agg);
  const payeeId =
    patch.payeeName !== undefined
      ? await findOrCreatePayee(rec, patch.payeeName)
      : patch.payeeId !== undefined
        ? patch.payeeId
        : current.payeeId;
  return {
    ...current,
    date: patch.date ?? current.date,
    payeeId,
    // A new payee keeps this row's own category, not the other side's: the transfer it belonged to is gone.
    categoryId:
      patch.categoryId !== undefined
        ? patch.categoryId
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
  };
}

/** A starting balance (spec §10) keeps its payee and category, and can't become a split or a transfer. */
function assertStartingBalanceKept(agg: Aggregate, draft: Draft): void {
  const { main } = agg;
  if (main.isStartingBalance && (draft.payeeId !== main.payeeId || draft.categoryId !== main.categoryId)) {
    throw new DomainError(
      'starting_balance',
      "A starting balance keeps its payee and category; change its amount, date or memo instead.",
      draft.payeeId !== main.payeeId ? 'payeeId' : 'categoryId',
    );
  }
}

/**
 * PATCH /api/transactions/:id (spec §10 "Creating and editing", "Transfers"): the edited transaction is planned again
 * with every rule of a new one, then its rows are brought in line.
 */
export async function updateTransaction(
  rec: ChangeRecorder,
  id: string,
  patch: UpdateTransactionRequest,
  context: EditContext,
): Promise<{ payeeName: string | null }> {
  const agg = await loadAggregate(rec.tx, id);
  if (agg.owner) {
    await updateLineCounterpart(rec, { ...agg, owner: agg.owner }, patch);
    return { payeeName: await payeeNameOf(rec, agg.main.payeeId) };
  }
  const draft = await applyPatch(rec, agg, patch);
  if (patch.date !== undefined && patch.date > context.today) {
    throw new DomainError(
      'date_in_future',
      "A saved transaction can't move into the future. Delete it and add it again with the new date.",
      'date',
    );
  }
  assertStartingBalanceKept(agg, draft);
  const plan = await planTransaction(rec.tx, draft, {
    existing: {
      payeeId: agg.main.payeeId,
      rates: await storedRates(rec.tx, agg),
      counterpart: agg.counterpart && { accountId: agg.counterpart.accountId, amount: agg.counterpart.amount },
      accountIds: accountsOf(agg),
    },
  });
  await syncPlan(rec, agg, plan, context.now);
  if (draft.payeeId !== agg.main.payeeId || draft.categoryId !== agg.main.categoryId) {
    await rememberCategory(rec, plan);
  }
  return { payeeName: plan.payee?.name ?? null };
}
