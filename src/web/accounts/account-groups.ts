import type { AccountClass, AccountType } from '../../shared/accounts';
import { type AccountDto, BASE_CURRENCY } from '../../shared/api/accounts';

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  credit_card: 'Credit card',
  line_of_credit: 'Line of credit',
  mortgage: 'Mortgage',
  auto_loan: 'Auto loan',
  student_loan: 'Student loan',
  personal_loan: 'Personal loan',
  medical_debt: 'Medical debt',
  other_debt: 'Other debt',
  other_asset: 'Other asset',
  other_liability: 'Other liability',
};

/** Spec §11: the Accounts screen's groups, one per account class. */
export const ACCOUNT_GROUP_LABELS: Record<AccountClass, string> = {
  cash: 'Cash',
  credit: 'Credit',
  tracking: 'Tracking',
};

const GROUP_ORDER: AccountClass[] = ['cash', 'credit', 'tracking'];

export function isForeign(account: Pick<AccountDto, 'currency'>): boolean {
  return account.currency !== BASE_CURRENCY;
}

/** Cash and credit accounts are on the budget (spec §3). */
export function isOnBudget(account: Pick<AccountDto, 'accountClass'>): boolean {
  return account.accountClass !== 'tracking';
}

export interface AccountGroup {
  key: AccountClass;
  label: string;
  accounts: AccountDto[];
  /** PLN: the sum of the accounts' booked base balances (what the budget counts). */
  total: number;
}

/**
 * Spec §11 Accounts: the open accounts by group (Cash, Credit, Tracking; empty groups left out), in the
 * server's order, each group with its PLN total; closed accounts go to a section of their own.
 */
export function groupAccounts(accounts: AccountDto[]): { groups: AccountGroup[]; closed: AccountDto[] } {
  const open = accounts.filter((a) => !a.closed);
  const groups = GROUP_ORDER.map((key) => {
    const members = open.filter((a) => a.accountClass === key);
    const total = members.reduce((sum, a) => sum + a.balanceBase.working, 0);
    return { key, label: ACCOUNT_GROUP_LABELS[key], accounts: members, total };
  }).filter((group) => group.accounts.length > 0);
  return { groups, closed: accounts.filter((a) => a.closed) };
}
