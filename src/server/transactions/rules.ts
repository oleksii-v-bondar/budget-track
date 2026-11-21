import { and, eq, isNull } from 'drizzle-orm';
import type { AccountClass } from '../../shared/accounts';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import { MAX_BASE_AMOUNT } from '../../shared/api/common';
import type { PayeeKind } from '../../shared/api/payees';
import { convertToBase, type Money } from '../../engine';
import { categoryKindOf } from '../categories/category-queries';
import type { Executor } from '../db/client';
import { account, category, categoryGroup, payee } from '../db/schema';
import { DomainError } from '../http/errors';
import { payeeKindOf } from '../payees/payee-queries';

export interface AccountInfo {
  id: string;
  name: string;
  currency: string;
  accountClass: AccountClass;
  closed: boolean;
  /** Its "Transfer : <name>" payee, which the other side of a transfer to this account uses. */
  transferPayeeId: string;
}

export interface PayeeInfo {
  id: string;
  name: string;
  kind: PayeeKind;
  transferAccountId: string | null;
}

/** Spec §3: cash and credit accounts are on the budget; tracking accounts are not. */
export const onBudget = (a: Pick<AccountInfo, 'accountClass'>) => a.accountClass !== 'tracking';

export async function findAccount(db: Executor, id: string): Promise<AccountInfo | null> {
  const [row] = await db
    .select({
      id: account.id,
      name: account.name,
      currency: account.currency,
      accountClass: account.accountClass,
      closed: account.closed,
      transferPayeeId: payee.id,
    })
    .from(account)
    .innerJoin(payee, eq(payee.transferAccountId, account.id))
    .where(eq(account.id, id));
  return row ?? null;
}

export async function requireAccount(db: Executor, id: string, field: string): Promise<AccountInfo> {
  const found = await findAccount(db, id);
  if (!found) throw new DomainError('invalid_account', 'Choose one of your accounts.', field);
  return found;
}

/** Closed accounts take no new transactions (rows that already exist there stay editable). */
export function assertOpen(target: AccountInfo, field: string): void {
  if (target.closed) {
    throw new DomainError('account_closed', `"${target.name}" is closed. Reopen it to add transactions.`, field);
  }
}

export async function requirePayee(db: Executor, id: string, field: string): Promise<PayeeInfo> {
  const [row] = await db
    .select()
    .from(payee)
    .where(and(eq(payee.id, id), isNull(payee.deletedAt)));
  if (!row) throw new DomainError('invalid_payee', 'Choose one of your payees.', field);
  return { id: row.id, name: row.name, kind: payeeKindOf(row), transferAccountId: row.transferAccountId };
}

/** System payees (Starting Balance, reconciliation and FX adjustments) are set by the app only. */
export function assertNotSystemPayee(found: PayeeInfo, field: string): void {
  if (found.kind === 'system') throw new DomainError('system_payee', 'This payee is reserved for the app.', field);
}

/**
 * Spec §5.5 and §11: a transaction line can use Ready to Assign, a regular category or a loan's paired category;
 * never a credit card payment category, and never Uncategorized explicitly (no category means Uncategorized).
 * Hidden categories are fine.
 */
export async function assertUsableCategory(db: Executor, id: string, field: string): Promise<void> {
  const [row] = await db
    .select({ category, groupKind: categoryGroup.kind })
    .from(category)
    .innerJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
    .where(and(eq(category.id, id), isNull(category.deletedAt)));
  const kind = row && categoryKindOf(row.category, row.groupKind);
  if (kind === undefined) throw new DomainError('invalid_category', 'Choose one of your categories.', field);
  if (kind === 'uncategorized') {
    throw new DomainError('invalid_category', 'Leave the category empty to keep it uncategorized.', field);
  }
  if (kind === 'cc_payment') {
    throw new DomainError(
      'card_payment_category',
      "Credit card payment categories can't be used on transactions: they move with card spending and payments.",
      field,
    );
  }
}

export function categoryNotAllowed(message: string, field: string): DomainError {
  return new DomainError('category_not_allowed', message, field);
}

export const TRACKING_NO_CATEGORY = "Transactions in tracking accounts don't take a category.";

/**
 * Spec §5.5: a transfer between a budget and a tracking account carries a category on its budget side (wherever it
 * was entered from); transfers between two budget or two tracking accounts carry none.
 */
export async function placeTransferCategory(
  db: Executor,
  here: AccountInfo,
  there: AccountInfo,
  categoryId: string | null,
  field: string,
): Promise<{ here: string | null; there: string | null }> {
  if (onBudget(here) === onBudget(there)) {
    if (categoryId !== null) {
      throw categoryNotAllowed(
        "Transfers between two budget accounts, or two tracking accounts, don't take a category.",
        field,
      );
    }
    return { here: null, there: null };
  }
  if (categoryId === null) {
    throw new DomainError(
      'category_required',
      'Choose a category for the budget side of a transfer to or from a tracking account.',
      field,
    );
  }
  await assertUsableCategory(db, categoryId, field);
  return onBudget(here) ? { here: categoryId, there: null } : { here: null, there: categoryId };
}

export function assertNotSelf(here: AccountInfo, there: AccountInfo, field: string): void {
  if (here.id === there.id) throw new DomainError('transfer_to_self', 'A transfer needs two different accounts.', field);
}

/** Picks the rate a foreign amount is booked at: the one sent with the request, else the one already stored. */
export interface Rates {
  /** The `fxRate` of the request. */
  input: string | null;
  /** Rates of the saved transaction by currency (edits keep them). */
  stored: Map<string, string>;
  /** Set once `input` has been used, so an unneeded rate can be refused. */
  used: boolean;
}

export function rateFor(rates: Rates, currency: string): string {
  const rate = rates.input ?? rates.stored.get(currency);
  if (rate === undefined) {
    throw new DomainError('fx_rate_required', `Enter the exchange rate of ${currency} to ${BASE_CURRENCY}.`, 'fxRate');
  }
  if (rates.input !== null) rates.used = true;
  return rate;
}

/** Throws when the request sent a rate that nothing used. */
export function assertRateUsed(rates: Rates): void {
  if (rates.input !== null && !rates.used) {
    throw new DomainError('fx_rate_not_allowed', "This transaction doesn't need an exchange rate.", 'fxRate');
  }
}

/** Spec §4.4: a PLN amount computed from a foreign one stays within ±MAX_BASE_AMOUNT (1e14), so sums stay exact. */
export function assertBaseAmount(base: Money, field: string): Money {
  if (!(Math.abs(base) <= MAX_BASE_AMOUNT)) {
    throw new DomainError('amount_too_large', 'That amount is too large.', field);
  }
  return base;
}

export function toBase(amount: Money, rate: string, field: string): Money {
  return assertBaseAmount(convertToBase(amount, rate), field);
}

/** Native amount → PLN (spec §9): PLN amounts are their own base; foreign ones need a rate. */
export function bookedBase(
  currency: string,
  amount: Money,
  rates: Rates,
): { amountBase: Money; fxRate: string | null } {
  if (currency === BASE_CURRENCY) return { amountBase: amount, fxRate: null };
  const rate = rateFor(rates, currency);
  return { amountBase: toBase(amount, rate, 'amount'), fxRate: rate };
}
