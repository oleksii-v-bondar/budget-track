import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { ClearedStatus, FlagColor } from '../../shared/api/transactions';
import { type IsoDate, type Money, transferBases } from '../../engine';
import type { Executor } from '../db/client';
import { DomainError } from '../http/errors';
import {
  type AccountInfo,
  assertNotSelf,
  assertNotSystemPayee,
  assertOpen,
  assertRateUsed,
  assertUsableCategory,
  bookedBase,
  categoryNotAllowed,
  onBudget,
  type PayeeInfo,
  placeTransferCategory,
  rateFor,
  type Rates,
  requireAccount,
  requirePayee,
  TRACKING_NO_CATEGORY,
} from './rules';

/** A transaction as the user describes it, before the rules of spec §5.5 and §9 turn it into rows. */
export interface Draft {
  accountId: string;
  date: IsoDate;
  payeeId: string | null;
  /** For a transfer between a budget and a tracking account: the budget side's category. */
  categoryId: string | null;
  memo: string | null;
  amount: Money;
  /** Transfers between currencies: the other side's native amount. */
  transferAmount: Money | null;
  /** The rate sent with the request (null = none sent). */
  fxRate: string | null;
  cleared: ClearedStatus;
  approved: boolean;
  flag: FlagColor | null;
}

/** The columns of one `transaction` row that a plan decides. */
export interface RowPlan {
  accountId: string;
  date: IsoDate;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  amount: Money;
  amountBase: Money;
  fxRate: string | null;
  fxRateManual: boolean;
  transferAccountId: string | null;
}

export interface Plan {
  main: RowPlan & { cleared: ClearedStatus; approved: boolean; flag: FlagColor | null };
  account: AccountInfo;
  payee: PayeeInfo | null;
  /** The other side of a transfer. */
  counterpart: RowPlan | null;
  /** The other account of a transfer. */
  transfer: AccountInfo | null;
  /** Spec §10: saving a categorized, non-transfer transaction makes its category the payee's default. */
  payeeDefault: { payeeId: string; categoryId: string } | null;
}

const rateColumns = (rate: string | null) => ({ fxRate: rate, fxRateManual: rate !== null });

/**
 * Spec §9: both sides of a transfer net to zero in PLN. Same-currency transfers mirror the amount; transfers between
 * currencies take both native amounts. The sending side (the outflow; this side for 0) decides the base amounts:
 * a PLN side gives them directly, otherwise the sending currency's rate converts.
 */
function transferSides(main: AccountInfo, other: AccountInfo, draft: Draft, rates: Rates) {
  let otherAmount: Money;
  if (main.currency === other.currency) {
    if (draft.transferAmount !== null) {
      throw new DomainError(
        'transfer_amount_not_allowed',
        'Both accounts use the same currency, so the other side mirrors this amount.',
        'transferAmount',
      );
    }
    otherAmount = -draft.amount;
  } else {
    if (draft.transferAmount === null) {
      throw new DomainError(
        'transfer_amount_required',
        `Enter the amount in ${other.currency} that "${other.name}" receives or sends.`,
        'transferAmount',
      );
    }
    if (draft.amount === 0 || Math.sign(draft.transferAmount) !== -Math.sign(draft.amount)) {
      throw new DomainError(
        'transfer_amount_sign',
        'The two sides of a transfer need opposite, non-zero amounts.',
        'transferAmount',
      );
    }
    otherAmount = draft.transferAmount;
  }
  const here = { amount: draft.amount, currency: main.currency };
  const there = { amount: otherAmount, currency: other.currency };
  const mainSends = draft.amount <= 0;
  const from = mainSends ? here : there;
  const to = mainSends ? there : here;
  const rate = from.currency !== BASE_CURRENCY && to.currency !== BASE_CURRENCY ? rateFor(rates, from.currency) : null;
  const { fromBase, toBase } = transferBases(BASE_CURRENCY, { ...from, rate }, { ...to, rate: null });
  if (!Number.isSafeInteger(fromBase)) throw new DomainError('amount_too_large', 'That amount is too large.', 'amount');
  return mainSends
    ? { mainBase: fromBase, mainRate: rate, otherAmount, otherBase: toBase, otherRate: null }
    : { mainBase: toBase, mainRate: null, otherAmount, otherBase: fromBase, otherRate: rate };
}

/** Validates a draft against spec §5.5 and §9 and computes the rows to write. */
export async function planTransaction(db: Executor, draft: Draft): Promise<Plan> {
  const main = await requireAccount(db, draft.accountId, 'accountId');
  assertOpen(main, 'accountId');
  const payee = draft.payeeId === null ? null : await requirePayee(db, draft.payeeId, 'payeeId');
  if (payee) assertNotSystemPayee(payee, 'payeeId');
  const rates: Rates = { input: draft.fxRate, stored: new Map(), used: false };
  const row = {
    accountId: draft.accountId,
    date: draft.date,
    payeeId: draft.payeeId,
    memo: draft.memo,
    amount: draft.amount,
  };
  const status = { cleared: draft.cleared, approved: draft.approved, flag: draft.flag };

  if (payee?.transferAccountId) {
    const other = await requireAccount(db, payee.transferAccountId, 'payeeId');
    assertNotSelf(main, other, 'payeeId');
    assertOpen(other, 'payeeId');
    const category = await placeTransferCategory(db, main, other, draft.categoryId, 'categoryId');
    const sides = transferSides(main, other, draft, rates);
    assertRateUsed(rates);
    return {
      main: {
        ...row,
        ...status,
        categoryId: category.here,
        amountBase: sides.mainBase,
        ...rateColumns(sides.mainRate),
        transferAccountId: other.id,
      },
      account: main,
      payee,
      counterpart: {
        accountId: other.id,
        date: draft.date,
        payeeId: main.transferPayeeId,
        categoryId: category.there,
        memo: draft.memo,
        amount: sides.otherAmount,
        amountBase: sides.otherBase,
        ...rateColumns(sides.otherRate),
        transferAccountId: main.id,
      },
      transfer: other,
      payeeDefault: null,
    };
  }

  if (draft.transferAmount !== null) {
    throw new DomainError('transfer_amount_not_allowed', 'Only transfers take a second amount.', 'transferAmount');
  }
  if (draft.categoryId !== null) {
    if (!onBudget(main)) throw categoryNotAllowed(TRACKING_NO_CATEGORY, 'categoryId');
    await assertUsableCategory(db, draft.categoryId, 'categoryId');
  }
  const { amountBase, fxRate } = bookedBase(main.currency, draft.amount, rates);
  assertRateUsed(rates);
  return {
    main: {
      ...row,
      ...status,
      categoryId: draft.categoryId,
      amountBase,
      ...rateColumns(fxRate),
      transferAccountId: null,
    },
    account: main,
    payee,
    counterpart: null,
    transfer: null,
    payeeDefault:
      payee?.kind === 'user' && draft.categoryId !== null ? { payeeId: payee.id, categoryId: draft.categoryId } : null,
  };
}
