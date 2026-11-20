import { and, eq, ne, sql } from 'drizzle-orm';
import { accountClassOf } from '../../shared/accounts';
import { BASE_CURRENCY, type CreateAccountRequest } from '../../shared/api/accounts';
import { type IsoDate, convertToBase, monthOf } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { nextSortOrder, systemCategoryId, systemGroupId, systemPayeeId } from '../db/lookups';
import { account, category, payee, target, transaction } from '../db/schema';
import { DomainError } from '../http/errors';

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

  const foreign = input.currency !== BASE_CURRENCY;
  // The schema requires fxRate exactly when the currency is foreign.
  const rate = foreign ? input.fxRate! : null;
  await rec.insert(transaction, {
    accountId,
    date: startingDate,
    payeeId: await systemPayeeId(rec.tx, 'starting_balance'),
    // Cash starting balances are income; credit and tracking ones stay off the budget.
    categoryId: accountClass === 'cash' ? await systemCategoryId(rec.tx, 'rta') : null,
    amount: input.startingBalance,
    amountBase: rate === null ? input.startingBalance : convertToBase(input.startingBalance, rate),
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
