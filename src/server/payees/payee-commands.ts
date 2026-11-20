import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { payee, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { payeeKindOf, payeeUsage } from './payee-queries';

type PayeeRow = typeof payee.$inferSelect;

/** Live user payees: neither transfer nor system payees (spec §4.4 name uniqueness applies to these only). */
const isUserPayee = and(isNull(payee.deletedAt), isNull(payee.transferAccountId), isNull(payee.systemKind));

async function loadPayee(db: Executor, id: string): Promise<PayeeRow> {
  const [row] = await db
    .select()
    .from(payee)
    .where(and(eq(payee.id, id), isNull(payee.deletedAt)));
  if (!row) throw new AppError(404, 'not_found', 'Payee not found.');
  return row;
}

/** Spec §10: transfer and system payees are named and used by the app. */
function assertUserPayee(row: PayeeRow): void {
  if (payeeKindOf(row) !== 'user') {
    throw new DomainError('payee_not_editable', "Transfer and system payees can't be renamed, merged or deleted.");
  }
}

/** The live user payee with this name (ignoring case), if any. */
export async function findUserPayeeByName(db: Executor, name: string, exceptId?: string): Promise<PayeeRow | null> {
  const [row] = await db
    .select()
    .from(payee)
    .where(and(isUserPayee, sql`lower(${payee.name}) = lower(${name})`, exceptId ? ne(payee.id, exceptId) : undefined))
    .limit(1);
  return row ?? null;
}

export async function createPayee(rec: ChangeRecorder, name: string): Promise<{ id: string }> {
  if (await findUserPayeeByName(rec.tx, name)) {
    throw new DomainError('payee_name_taken', 'You already have a payee with this name.');
  }
  const [created] = await rec.insert(payee, { name });
  return { id: created!.id };
}

/** The transaction sheet creates payees inline: an existing user payee with the same name (ignoring case) is reused. */
export async function findOrCreatePayee(rec: ChangeRecorder, name: string): Promise<string> {
  return (await findUserPayeeByName(rec.tx, name))?.id ?? (await createPayee(rec, name)).id;
}

export async function renamePayee(rec: ChangeRecorder, id: string, name: string): Promise<{ name: string }> {
  const current = await loadPayee(rec.tx, id);
  assertUserPayee(current);
  if (await findUserPayeeByName(rec.tx, name, id)) {
    throw new DomainError('payee_name_taken', 'You already have a payee with this name. Merge the two instead.');
  }
  await rec.update(payee, eq(payee.id, id), { name });
  return { name: current.name };
}

/**
 * Spec §10: every transaction, split line, schedule and schedule line of the payee moves to the target (soft-deleted
 * transactions too, so undoing their deletion never resurrects a deleted payee), then the payee is soft-deleted.
 * The target keeps its own default category, or inherits the merged payee's.
 */
export async function mergePayee(
  rec: ChangeRecorder,
  id: string,
  targetId: string,
  now: Date,
): Promise<{ name: string; targetName: string }> {
  const source = await loadPayee(rec.tx, id);
  assertUserPayee(source);
  const [target] = await rec.tx
    .select()
    .from(payee)
    .where(and(eq(payee.id, targetId), isUserPayee));
  if (!target || target.id === id) {
    throw new DomainError('invalid_merge_target', 'Choose another of your payees to merge into.');
  }
  const to = { payeeId: targetId };
  await rec.update(transaction, eq(transaction.payeeId, id), to);
  await rec.update(subtransaction, eq(subtransaction.payeeId, id), to);
  await rec.update(scheduledTransaction, eq(scheduledTransaction.payeeId, id), to);
  await rec.update(scheduledSubtransaction, eq(scheduledSubtransaction.payeeId, id), to);
  if (target.lastCategoryId === null && source.lastCategoryId !== null) {
    await rec.update(payee, eq(payee.id, targetId), { lastCategoryId: source.lastCategoryId });
  }
  await rec.update(payee, eq(payee.id, id), { deletedAt: now });
  return { name: source.name, targetName: target.name };
}

/** Spec §10: only an unused payee can be deleted (soft delete); otherwise merge it into another one. */
export async function deletePayee(rec: ChangeRecorder, id: string, now: Date): Promise<{ name: string }> {
  const current = await loadPayee(rec.tx, id);
  assertUserPayee(current);
  if ((await payeeUsage(rec.tx, id)) > 0) {
    throw new DomainError('payee_in_use', 'This payee is used by transactions. Merge it into another payee instead.');
  }
  await rec.update(payee, eq(payee.id, id), { deletedAt: now });
  return { name: current.name };
}
