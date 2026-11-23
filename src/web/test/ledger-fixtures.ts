import { accountClassOf } from '../../shared/accounts';
import type { AccountBalances, AccountDto } from '../../shared/api/accounts';
import type { CategoryDto, CategoryGroupDto } from '../../shared/api/categories';
import type { PayeeDto } from '../../shared/api/payees';
import type { RegisterResponse, SplitLineDto, TransactionDto } from '../../shared/api/transactions';

/** DTOs for the accounts, register and transaction tests: every field has a neutral default. */

/** A stable UUID for a test key (`idFor('account:Checking')`), so tests can name ids instead of spelling them. */
export function idFor(key: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const char of key) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 0x100000001b3n);
  const hex = hash.toString(16).padStart(16, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(0, 3)}-${hex.slice(4, 16)}`;
}

/** Balances with `working` in total, `uncleared` of it not cleared yet. */
export function balances(working: number, uncleared = 0): AccountBalances {
  return { cleared: working - uncleared, uncleared, working };
}

export function account(fields: Partial<AccountDto> & Pick<AccountDto, 'name'>): AccountDto {
  const type = fields.type ?? 'checking';
  const balance = fields.balance ?? balances(0);
  return {
    id: idFor(`account:${fields.name}`),
    type,
    accountClass: accountClassOf(type),
    currency: 'PLN',
    closed: false,
    sortOrder: 0,
    note: null,
    interestRate: null,
    minPayment: null,
    escrowAmount: null,
    lastReconciledAt: null,
    lastReconciledBalance: null,
    transferPayeeId: idFor(`transfer:${fields.name}`),
    paymentCategoryId: null,
    pairedCategoryId: null,
    balance,
    balanceBase: balance,
    latestRate: null,
    balanceAtLatestRate: null,
    unapprovedCount: 0,
    ...fields,
  };
}

/** A transaction in `owner`, with the id `idFor('txn:<key>')`: an uncleared, approved 10 zł outflow by default. */
export function transaction(owner: AccountDto, key: string, fields: Partial<TransactionDto> = {}): TransactionDto {
  const amount = fields.amount ?? -1000;
  return {
    id: idFor(`txn:${key}`),
    accountId: owner.id,
    accountName: owner.name,
    currency: owner.currency,
    date: '2026-11-20',
    payeeId: null,
    payeeName: null,
    categoryId: null,
    categoryName: null,
    memo: null,
    amount,
    amountBase: amount,
    fxRate: null,
    fxRateManual: false,
    effectiveRate: null,
    cleared: 'uncleared',
    approved: true,
    flag: null,
    isStartingBalance: false,
    isSplit: false,
    transfer: null,
    lines: [],
    ...fields,
  };
}

/** A split line of `amount` with the id `idFor('line:<key>')`. */
export function splitLine(key: string, amount: number, fields: Partial<SplitLineDto> = {}): SplitLineDto {
  return {
    id: idFor(`line:${key}`),
    amount,
    amountBase: amount,
    payeeId: null,
    payeeName: null,
    categoryId: null,
    categoryName: null,
    memo: null,
    transfer: null,
    ...fields,
  };
}

/** One page of GET /api/transactions. */
export function registerPage(
  transactions: TransactionDto[],
  { nextCursor = null, owner }: { nextCursor?: string | null; owner?: AccountDto } = {},
): RegisterResponse {
  return {
    transactions,
    nextCursor,
    balances: owner ? { balance: owner.balance, balanceBase: owner.balanceBase } : null,
  };
}

export function payee(fields: Partial<PayeeDto> & Pick<PayeeDto, 'name'>): PayeeDto {
  return {
    id: idFor(`payee:${fields.name}`),
    kind: 'user',
    transferAccountId: null,
    lastCategoryId: null,
    usageCount: 0,
    ...fields,
  };
}

/** The "Transfer : <name>" payee of an account. */
export function transferPayee(target: AccountDto): PayeeDto {
  return payee({
    id: target.transferPayeeId,
    name: `Transfer : ${target.name}`,
    kind: 'transfer',
    transferAccountId: target.id,
  });
}

export function category(fields: Partial<CategoryDto> & Pick<CategoryDto, 'name'>): CategoryDto {
  return {
    id: idFor(`category:${fields.name}`),
    groupId: idFor('group:Everyday'),
    kind: 'normal',
    hidden: false,
    note: null,
    sortOrder: 0,
    linkedAccountId: null,
    ...fields,
  };
}

export const RTA = category({ name: 'Ready to Assign', kind: 'rta', hidden: true, groupId: idFor('group:Internal') });
export const UNCATEGORIZED = category({
  name: 'Uncategorized',
  kind: 'uncategorized',
  hidden: true,
  groupId: idFor('group:Internal'),
});

/** GET /api/categories: the internal group (Ready to Assign, Uncategorized) plus `groups`. */
export function categoryGroups(
  groups: (Partial<CategoryGroupDto> & Pick<CategoryGroupDto, 'name'> & { categories: CategoryDto[] })[],
): { groups: CategoryGroupDto[] } {
  const internal: CategoryGroupDto = {
    id: idFor('group:Internal'),
    name: 'Internal',
    kind: 'internal',
    hidden: true,
    sortOrder: 0,
    categories: [RTA, UNCATEGORIZED],
  };
  return {
    groups: [
      internal,
      ...groups.map((group, index) => ({
        id: idFor(`group:${group.name}`),
        kind: 'normal' as const,
        hidden: false,
        sortOrder: index + 1,
        ...group,
        categories: group.categories.map((c) => ({ ...c, groupId: idFor(`group:${group.name}`) })),
      })),
    ],
  };
}
