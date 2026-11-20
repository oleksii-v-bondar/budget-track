import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { accountClassOf, isLoanType } from '../../shared/accounts';
import {
  accountFieldsAllowed,
  BASE_CURRENCY,
  type CreateAccountRequest,
  type UpdateAccountRequest,
} from '../../shared/api/accounts';
import { type IsoDate, convertToBase, monthOf } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import { applyOrder } from '../commands/reorder';
import type { Executor } from '../db/client';
import { nextSortOrder, systemCategoryId, systemGroupId, systemPayeeId } from '../db/lookups';
import {
  account,
  assignment,
  category,
  loanInterestOverride,
  payee,
  scheduledSubtransaction,
  scheduledTransaction,
  subtransaction,
  target,
  transaction,
} from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { getAccount } from './account-queries';

type AccountRow = typeof account.$inferSelect;

/** Spec §4.4: every account has one transfer payee named after it. */
export const transferPayeeName = (accountName: string) => `Transfer : ${accountName}`;

/** Account names are unique (ignoring case), so transfer payees and linked categories stay unambiguous. */
export async function assertAccountNameFree(db: Executor, name: string, exceptId?: string): Promise<void> {
  const [taken] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(sql`lower(${account.name}) = lower(${name})`, exceptId ? ne(account.id, exceptId) : undefined))
    .limit(1);
  if (taken) throw new DomainError('account_name_taken', 'You already have an account with this name.');
}

/**
 * Spec §10 "Accounts" and "Starting balance": the account, its transfer payee, its cleared starting-balance
 * transaction, and for credit accounts the credit card payment category (spec §5.3); for loans that opt in, the
 * paired Debt Payments category with a minimum-payment target (spec §8).
 */
export async function createAccount(
  rec: ChangeRecorder,
  input: CreateAccountRequest,
  today: IsoDate,
): Promise<{ id: string }> {
  const startingDate = input.startingDate ?? today;
  if (startingDate > today) {
    throw new DomainError('starting_date_in_future', "The starting balance can't be dated in the future.");
  }
  await assertAccountNameFree(rec.tx, input.name);
  const accountClass = accountClassOf(input.type);
  const foreign = input.currency !== BASE_CURRENCY;
  // The schema requires fxRate exactly when the currency is foreign.
  const rate = foreign ? input.fxRate! : null;
  const amountBase = rate === null ? input.startingBalance : convertToBase(input.startingBalance, rate);
  if (!Number.isSafeInteger(amountBase)) throw new DomainError('amount_too_large', 'That amount is too large.');

  const [created] = await rec.insert(account, {
    name: input.name,
    type: input.type,
    currency: input.currency,
    note: input.note || null,
    interestRate: input.interestRate ?? null,
    minPayment: input.minPayment ?? null,
    escrowAmount: input.escrowAmount ?? null,
    sortOrder: await nextSortOrder(rec.tx, account),
  });
  const accountId = created!.id;
  await rec.insert(payee, { name: transferPayeeName(input.name), transferAccountId: accountId });

  await rec.insert(transaction, {
    accountId,
    date: startingDate,
    payeeId: await systemPayeeId(rec.tx, 'starting_balance'),
    // Cash starting balances are income; credit and tracking ones stay off the budget.
    categoryId: accountClass === 'cash' ? await systemCategoryId(rec.tx, 'rta') : null,
    amount: input.startingBalance,
    amountBase,
    fxRate: rate,
    // Entered by the user until the NBP lookup exists (P2d).
    fxRateManual: foreign,
    cleared: 'cleared',
    isStartingBalance: true,
  });

  if (accountClass === 'credit') {
    const groupId = await systemGroupId(rec.tx, 'cc_payments');
    await rec.insert(category, {
      groupId,
      name: input.name,
      linkedAccountId: accountId,
      sortOrder: await nextSortOrder(rec.tx, category, eq(category.groupId, groupId)),
    });
  }

  if (input.createPairedCategory) {
    const groupId = await systemGroupId(rec.tx, 'debt_payments');
    const [paired] = await rec.insert(category, {
      groupId,
      name: input.name,
      linkedAccountId: accountId,
      sortOrder: await nextSortOrder(rec.tx, category, eq(category.groupId, groupId)),
    });
    await rec.insert(target, {
      categoryId: paired!.id,
      kind: 'debt',
      cadence: 'monthly',
      debtMode: 'min_payment',
      startMonth: `${monthOf(today)}-01`,
    });
    await rec.update(account, eq(account.id, accountId), { pairedCategoryId: paired!.id });
  }
  return { id: accountId };
}

async function loadAccount(db: Executor, id: string): Promise<AccountRow> {
  const [row] = await db.select().from(account).where(eq(account.id, id)).for('update');
  if (!row) throw new AppError(404, 'not_found', 'Account not found.');
  return row;
}

const FIELD_MESSAGES = {
  interestRate: 'Only loans and credit accounts have an interest rate.',
  minPayment: 'Only loans and credit accounts have a minimum payment.',
  escrowAmount: 'Only loans have escrow.',
} as const;

/** Edits name, note, type and loan/credit fields; a rename carries over to the transfer payee and linked category. */
export async function updateAccount(
  rec: ChangeRecorder,
  id: string,
  input: UpdateAccountRequest,
): Promise<{ name: string }> {
  const current = await loadAccount(rec.tx, id);
  if (input.type !== undefined && input.type !== current.type) {
    // Loans keep a loan type, so their loan fields and paired category stay meaningful.
    const sameClass = accountClassOf(input.type) === current.accountClass;
    if (!sameClass || isLoanType(input.type) !== isLoanType(current.type)) {
      throw new DomainError(
        'account_type_change',
        "An account's type can only change within its class, and a loan only to another loan type.",
      );
    }
  }
  const allowed = accountFieldsAllowed(input.type ?? current.type);
  for (const field of ['interestRate', 'minPayment', 'escrowAmount'] as const) {
    const value = input[field];
    if (value !== undefined && value !== null && !allowed[field]) {
      throw new DomainError('account_field_not_allowed', FIELD_MESSAGES[field]);
    }
  }
  const name = input.name ?? current.name;
  if (name !== current.name) await assertAccountNameFree(rec.tx, name, id);

  await rec.update(account, eq(account.id, id), {
    name,
    note: input.note === undefined ? undefined : input.note || null,
    type: input.type,
    interestRate: input.interestRate,
    minPayment: input.minPayment,
    escrowAmount: input.escrowAmount,
  });
  if (name !== current.name) {
    await rec.update(payee, eq(payee.transferAccountId, id), { name: transferPayeeName(name) });
    // Spec §10: a credit card payment category is named after its account; a paired loan category follows too.
    await rec.update(category, and(eq(category.linkedAccountId, id), isNull(category.deletedAt)), { name });
  }
  return { name };
}

/** Spec §10: closing needs a zero balance (in the account's currency); reopening is always allowed. */
export async function setAccountClosed(rec: ChangeRecorder, id: string, closed: boolean): Promise<{ name: string }> {
  const current = await loadAccount(rec.tx, id);
  if (closed && (await getAccount(rec.tx, id)).balance.working !== 0) {
    throw new DomainError('account_balance_not_zero', 'Bring the balance to 0 before closing the account.');
  }
  await rec.update(account, eq(account.id, id), { closed });
  return { name: current.name };
}

/**
 * True when anything but the account's own starting balance, transfer payee and linked categories (with their
 * assignments and target) refers to the account. Soft-deleted transactions count: they still reference the rows.
 */
async function isAccountInUse(db: Executor, id: string): Promise<boolean> {
  const linked = db.select({ id: category.id }).from(category).where(eq(category.linkedAccountId, id));
  const checks = [
    db
      .select({ id: transaction.id })
      .from(transaction)
      .where(
        or(
          and(eq(transaction.accountId, id), eq(transaction.isStartingBalance, false)),
          eq(transaction.transferAccountId, id),
          inArray(transaction.categoryId, linked),
        ),
      ),
    db
      .select({ id: subtransaction.id })
      .from(subtransaction)
      .where(or(eq(subtransaction.transferAccountId, id), inArray(subtransaction.categoryId, linked))),
    db
      .select({ id: scheduledTransaction.id })
      .from(scheduledTransaction)
      .where(
        or(
          eq(scheduledTransaction.accountId, id),
          eq(scheduledTransaction.transferAccountId, id),
          inArray(scheduledTransaction.categoryId, linked),
        ),
      ),
    db
      .select({ id: scheduledSubtransaction.id })
      .from(scheduledSubtransaction)
      .where(
        or(eq(scheduledSubtransaction.transferAccountId, id), inArray(scheduledSubtransaction.categoryId, linked)),
      ),
    db
      .select({ id: loanInterestOverride.accountId })
      .from(loanInterestOverride)
      .where(eq(loanInterestOverride.accountId, id)),
    db.select({ id: payee.id }).from(payee).where(inArray(payee.lastCategoryId, linked)),
  ];
  for (const check of checks) if ((await check.limit(1)).length > 0) return true;
  return false;
}

/**
 * Spec §10: only an account with nothing but its starting balance can be deleted. Removes it with everything
 * createAccount made (transfer payee, starting balance, linked category with its assignments and target).
 */
export async function deleteAccount(rec: ChangeRecorder, id: string): Promise<{ name: string }> {
  const current = await loadAccount(rec.tx, id);
  if (await isAccountInUse(rec.tx, id)) {
    throw new DomainError('account_in_use', 'This account has transactions. Close it instead.');
  }
  const linked = await rec.tx
    .select({ id: category.id })
    .from(category)
    .where(eq(category.linkedAccountId, id));
  const linkedIds = linked.map((row) => row.id);
  // account.paired_category_id and category.linked_account_id point at each other: unlink first.
  await rec.update(account, eq(account.id, id), { pairedCategoryId: null });
  if (linkedIds.length > 0) {
    await rec.delete(target, inArray(target.categoryId, linkedIds));
    await rec.delete(assignment, inArray(assignment.categoryId, linkedIds));
  }
  await rec.delete(transaction, eq(transaction.accountId, id));
  await rec.delete(payee, eq(payee.transferAccountId, id));
  if (linkedIds.length > 0) await rec.delete(category, inArray(category.id, linkedIds));
  await rec.delete(account, eq(account.id, id));
  return { name: current.name };
}

/** PUT /api/accounts/order: `ids` lists every account (open and closed). */
export function reorderAccounts(rec: ChangeRecorder, ids: string[]): Promise<void> {
  return applyOrder(rec, account, undefined, ids);
}
