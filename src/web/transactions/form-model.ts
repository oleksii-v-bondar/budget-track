import { type AccountDto, BASE_CURRENCY, fxRateSchema } from '../../shared/api/accounts';
import { nameSchema } from '../../shared/api/common';
import type { PayeeDto } from '../../shared/api/payees';
import type {
  CreateTransactionInput,
  FlagColor,
  SplitLineDto,
  SplitLineRequest,
  TransactionDto,
  UpdateTransactionRequest,
} from '../../shared/api/transactions';
import { isOnBudget } from '../accounts/account-groups';
import { amountToExpression } from '../lib/amount-expression';
import { formatDate, parseDate } from '../lib/format';
import { formatRate, rateInput } from '../lib/fx';
import { readAmount } from '../ui/amount-field';

export type Direction = 'outflow' | 'inflow';

/** The payee field: nothing, a payee picked from the list, or a new name (the server creates it). */
export type PayeeValue = { kind: 'none' } | { kind: 'existing'; id: string; name: string } | { kind: 'new'; name: string };

/** A split line (spec §10): its amount counts in the transaction's direction; a minus sign goes the other way. */
export interface LineValues {
  /** React key. */
  key: string;
  amount: string;
  payeeId: string | null;
  categoryId: string | null;
  memo: string;
}

/** What the transaction sheet edits. Amounts the owner types stay text until the form is sent. */
export interface FormValues {
  direction: Direction;
  /** Minor units, ≥ 0; `direction` gives the sign. */
  amount: number;
  accountId: string;
  payee: PayeeValue;
  categoryId: string | null;
  /** dd.MM.yyyy */
  date: string;
  memo: string;
  flag: FlagColor | null;
  cleared: boolean;
  /** Empty: the NBP rate (or, when editing, the stored one). */
  fxRate: string;
  /** Transfers between currencies: the other account's amount, as a positive amount. */
  transferAmount: string;
  /** Approving a transaction that waits for approval (bank import, #2). */
  approve: boolean;
  /** A split's lines; null for a plain transaction. */
  lines: LineValues[] | null;
}

/** What a link may prefill on a new transaction: a register's Add transaction passes its account. */
export interface Prefill {
  accountId?: string;
}

export interface FormContext {
  accounts: AccountDto[];
  payees: PayeeDto[];
}

/** Request field paths the form shows under its fields (server errors use the same dotted paths). */
export const FORM_FIELDS = [
  'amount',
  'accountId',
  'payeeId',
  'payeeName',
  'categoryId',
  'date',
  'memo',
  'fxRate',
  'transferAmount',
  'flag',
  'cleared',
];

export const signedAmount = (values: Pick<FormValues, 'direction' | 'amount'>) =>
  values.direction === 'outflow' && values.amount !== 0 ? -values.amount : values.amount;

let lineKeys = 0;

export function newLine(fields: Partial<LineValues> = {}): LineValues {
  return { key: `line-${++lineKeys}`, amount: '', payeeId: null, categoryId: null, memo: '', ...fields };
}

/** Saved lines (signed) as line values relative to the transaction's direction. */
function linesOf(lines: SplitLineDto[], direction: Direction): LineValues[] {
  return lines.map((line) =>
    newLine({
      amount: amountToExpression(direction === 'outflow' ? -line.amount : line.amount),
      payeeId: line.payeeId,
      categoryId: line.categoryId,
      memo: line.memo ?? '',
    }),
  );
}

/** A line's signed amount, or null while its text isn't an amount. */
export function lineAmount(line: LineValues, direction: Direction): number | null {
  const amount = readAmount(line.amount);
  if (!amount.ok) return null;
  return direction === 'outflow' && amount.value !== 0 ? -amount.value : amount.value;
}

/** "Remaining to assign" (spec §11): the amount the lines don't cover yet, in the transaction's direction. */
export function remainingToAssign(values: Pick<FormValues, 'amount' | 'lines'>): number {
  return (values.lines ?? []).reduce((left, line) => {
    const amount = readAmount(line.amount);
    return amount.ok ? left - amount.value : left;
  }, values.amount);
}

/** The fields a split's lines show their errors under. */
export function lineFields(lines: LineValues[] | null): string[] {
  return ['lines', ...(lines ?? []).flatMap((_, i) => ['amount', 'payeeId', 'categoryId', 'memo'].map((f) => `lines.${i}.${f}`))];
}

export function newValues(today: string, context: FormContext, prefill: Prefill = {}): FormValues {
  const open = context.accounts.filter((a) => !a.closed);
  const accountId = open.find((a) => a.id === prefill.accountId)?.id ?? open[0]?.id ?? '';
  return {
    direction: 'outflow',
    amount: 0,
    accountId,
    payee: { kind: 'none' },
    categoryId: null,
    date: formatDate(today),
    memo: '',
    flag: null,
    cleared: false,
    fxRate: '',
    transferAmount: '',
    approve: false,
    lines: null,
  };
}

/**
 * A saved transaction as form values. A budget↔tracking transfer seen from its tracking side has no category in
 * its DTO (it lives on the budget side): pass the other side's as `categoryId`.
 */
export function editValues(transaction: TransactionDto, categoryId = transaction.categoryId): FormValues {
  const payee: PayeeValue =
    transaction.payeeId === null
      ? { kind: 'none' }
      : { kind: 'existing', id: transaction.payeeId, name: transaction.payeeName ?? '' };
  const direction: Direction = transaction.amount > 0 ? 'inflow' : 'outflow';
  return {
    direction,
    amount: Math.abs(transaction.amount),
    accountId: transaction.accountId,
    payee,
    categoryId,
    date: formatDate(transaction.date),
    memo: transaction.memo ?? '',
    flag: transaction.flag,
    cleared: transaction.cleared !== 'uncleared',
    fxRate: transaction.fxRate === null ? '' : formatRate(transaction.fxRate),
    transferAmount:
      transaction.transfer && transaction.transfer.currency !== transaction.currency
        ? amountToExpression(Math.abs(transaction.transfer.amount))
        : '',
    approve: false,
    lines: transaction.isSplit ? linesOf(transaction.lines, direction) : null,
  };
}

/** The account a transfer payee sends to, if the payee is one. */
export function transferTarget(payee: PayeeValue, context: FormContext): AccountDto | null {
  if (payee.kind !== 'existing') return null;
  const target = context.payees.find((p) => p.id === payee.id)?.transferAccountId;
  return context.accounts.find((a) => a.id === target) ?? null;
}

/**
 * Spec §5.5: a budget transaction may have a category (none means Uncategorized); a budget↔tracking transfer must
 * have one (it is stored on the budget side, whichever side enters it); tracking transactions and transfers between
 * two budget or two tracking accounts take none.
 */
export function categoryRule(account: AccountDto | undefined, target: AccountDto | null): 'optional' | 'required' | 'none' {
  if (!account) return 'none';
  if (target) return isOnBudget(account) === isOnBudget(target) ? 'none' : 'required';
  return isOnBudget(account) ? 'optional' : 'none';
}

/**
 * Spec §9: the currency whose rate to PLN the transaction is booked at, or null when none is needed. A transfer
 * with a PLN side needs none (that side gives the base); between two foreign currencies the sending side's counts.
 */
export function rateCurrency(account: AccountDto | undefined, target: AccountDto | null, direction: Direction): string | null {
  if (!account) return null;
  if (!target || target.currency === account.currency) return account.currency === BASE_CURRENCY ? null : account.currency;
  if (account.currency === BASE_CURRENCY || target.currency === BASE_CURRENCY) return null;
  return direction === 'outflow' ? account.currency : target.currency;
}

export function needsTransferAmount(account: AccountDto | undefined, target: AccountDto | null): boolean {
  return Boolean(account && target && account.currency !== target.currency);
}

/** Checks the form before sending; keys are request paths, as in the server's answers. */
export function checkForm(values: FormValues, context: FormContext): Record<string, string> {
  const errors: Record<string, string> = {};
  const account = context.accounts.find((a) => a.id === values.accountId);
  const target = transferTarget(values.payee, context);
  if (!account) errors.accountId = 'Choose an account.';
  const date = parseDate(values.date);
  if (date === null) errors.date = 'Enter a date as dd.mm.yyyy.';
  else if (date < '1970-01-01') errors.date = 'Use a date from 1970-01-01 on.';
  if (values.payee.kind === 'new') {
    const name = nameSchema.safeParse(values.payee.name);
    if (!name.success) errors.payeeName = name.error.issues[0]!.message;
  }
  if (target && target.id === values.accountId) errors.payeeId = 'A transfer needs two different accounts.';
  if (categoryRule(account, target) === 'required' && values.categoryId === null) {
    errors.categoryId = 'Choose a category for the budget side of a transfer to or from a tracking account.';
  }
  if (rateCurrency(account, target, values.direction) !== null && values.fxRate.trim() !== '') {
    const rate = fxRateSchema.safeParse(rateInput(values.fxRate));
    if (!rate.success) errors.fxRate = rate.error.issues[0]!.message;
  }
  if (needsTransferAmount(account, target)) {
    const amount = readAmount(values.transferAmount);
    if (!amount.ok) errors.transferAmount = amount.error;
    else if (amount.value <= 0 || values.amount === 0) {
      errors.transferAmount = 'Both sides of a transfer between currencies need an amount.';
    }
  }
  if (values.memo.trim().length > 500) errors.memo = 'Use at most 500 characters.';
  if (values.lines) {
    if (target) errors.payeeId = "A split itself can't be a transfer: make one of its lines a transfer instead.";
    for (const [index, line] of values.lines.entries()) {
      const amount = readAmount(line.amount);
      if (!amount.ok) errors[`lines.${index}.amount`] = amount.error;
      const lineTarget = transferTarget(line.payeeId ? { kind: 'existing', id: line.payeeId, name: '' } : { kind: 'none' }, context);
      if (lineTarget?.id === values.accountId) errors[`lines.${index}.payeeId`] = 'A transfer needs two different accounts.';
      if (categoryRule(account, lineTarget) === 'required' && line.categoryId === null) {
        errors[`lines.${index}.categoryId`] = 'Choose a category for this transfer to or from a tracking account.';
      }
    }
    if (remainingToAssign(values) !== 0) errors.lines = 'The lines must add up to the transaction amount.';
  }
  return errors;
}

/** The lines as the API takes them: signed, the category only where the line takes one. */
function lineBodies(values: FormValues, context: FormContext): SplitLineRequest[] | null {
  if (!values.lines) return null;
  const account = context.accounts.find((a) => a.id === values.accountId);
  return values.lines.map((line) => {
    const lineTarget = transferTarget(line.payeeId ? { kind: 'existing', id: line.payeeId, name: '' } : { kind: 'none' }, context);
    return {
      amount: lineAmount(line, values.direction) ?? 0,
      payeeId: line.payeeId,
      categoryId: categoryRule(account, lineTarget) === 'none' ? null : line.categoryId,
      memo: line.memo.trim(),
    };
  });
}

const payeeKey = (payee: PayeeValue) =>
  payee.kind === 'existing' ? `id:${payee.id}` : payee.kind === 'new' ? `new:${payee.name.trim()}` : 'none';

function payeeFields(payee: PayeeValue): { payeeId?: string; payeeName?: string } {
  if (payee.kind === 'existing') return { payeeId: payee.id };
  if (payee.kind === 'new') return { payeeName: payee.name.trim() };
  return {};
}

/** The other side's signed amount: opposite to this side's. */
function transferAmountOf(values: FormValues): number {
  const amount = readAmount(values.transferAmount);
  const abs = amount.ok ? Math.abs(amount.value) : 0;
  return values.direction === 'outflow' ? abs : -abs;
}

/** POST /api/transactions for checked values. */
export function createTransactionBody(values: FormValues, context: FormContext): CreateTransactionInput {
  const account = context.accounts.find((a) => a.id === values.accountId);
  const target = transferTarget(values.payee, context);
  const lines = lineBodies(values, context);
  const body: CreateTransactionInput = {
    accountId: values.accountId,
    date: parseDate(values.date)!,
    ...payeeFields(values.payee),
    categoryId: lines || categoryRule(account, target) === 'none' ? null : values.categoryId,
    memo: values.memo.trim(),
    amount: signedAmount(values),
    cleared: values.cleared ? 'cleared' : 'uncleared',
    flag: values.flag,
  };
  if (lines) body.lines = lines;
  if (needsTransferAmount(account, target)) body.transferAmount = transferAmountOf(values);
  if (rateCurrency(account, target, values.direction) !== null && values.fxRate.trim() !== '') {
    body.fxRate = rateInput(values.fxRate);
  }
  return body;
}

/** PATCH /api/transactions/:id: only what changed (an unchanged rate stays as stored, NBP or not). */
export function updateTransactionBody(
  values: FormValues,
  original: FormValues,
  context: FormContext,
): Omit<UpdateTransactionRequest, 'confirmReconciled'> {
  const account = context.accounts.find((a) => a.id === values.accountId);
  const target = transferTarget(values.payee, context);
  const body: Omit<UpdateTransactionRequest, 'confirmReconciled'> = {};
  if (values.accountId !== original.accountId) body.accountId = values.accountId;
  const date = parseDate(values.date)!;
  if (date !== parseDate(original.date)) body.date = date;
  if (payeeKey(values.payee) !== payeeKey(original.payee)) {
    Object.assign(body, values.payee.kind === 'none' ? { payeeId: null } : payeeFields(values.payee));
  }
  const categoryId = values.lines || categoryRule(account, target) === 'none' ? null : values.categoryId;
  if (categoryId !== (original.lines ? null : original.categoryId)) body.categoryId = categoryId;
  const lines = lineBodies(values, context);
  if (JSON.stringify(lines) !== JSON.stringify(lineBodies(original, context))) body.lines = lines;
  if (values.memo.trim() !== original.memo.trim()) body.memo = values.memo.trim();
  if (signedAmount(values) !== signedAmount(original)) body.amount = signedAmount(values);
  if (needsTransferAmount(account, target) && values.transferAmount.trim() !== original.transferAmount.trim()) {
    body.transferAmount = transferAmountOf(values);
  }
  if (rateCurrency(account, target, values.direction) !== null && values.fxRate.trim() !== original.fxRate.trim()) {
    if (values.fxRate.trim() !== '') body.fxRate = rateInput(values.fxRate);
  }
  if (values.cleared !== original.cleared) body.cleared = values.cleared ? 'cleared' : 'uncleared';
  if (values.flag !== original.flag) body.flag = values.flag;
  if (values.approve) body.approved = true;
  return body;
}
