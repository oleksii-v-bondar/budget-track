import type { ClearedStatus, FlagColor } from '../../shared/api/transactions';
import type { IsoDate, Money } from '../../engine';
import {
  type AccountInfo,
  assertNotSystemPayee,
  assertOpen,
  assertRateUsed,
  assertUsableCategory,
  bookedBase,
  categoryNotAllowed,
  onBudget,
  type PayeeInfo,
  type Rates,
  requireAccount,
  requirePayee,
  TRACKING_NO_CATEGORY,
} from './rules';
import type { Executor } from '../db/client';

/** A transaction as the user describes it, before the rules of spec §5.5 and §9 turn it into rows. */
export interface Draft {
  accountId: string;
  date: IsoDate;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  amount: Money;
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
}

export interface Plan {
  main: RowPlan & { cleared: ClearedStatus; approved: boolean; flag: FlagColor | null };
  account: AccountInfo;
  payee: PayeeInfo | null;
  /** Spec §10: saving a categorized, non-transfer transaction makes its category the payee's default. */
  payeeDefault: { payeeId: string; categoryId: string } | null;
}

/** Validates a draft against spec §5.5 and §9 and computes the rows to write. */
export async function planTransaction(db: Executor, draft: Draft): Promise<Plan> {
  const target = await requireAccount(db, draft.accountId, 'accountId');
  assertOpen(target, 'accountId');
  const payee = draft.payeeId === null ? null : await requirePayee(db, draft.payeeId, 'payeeId');
  if (payee) assertNotSystemPayee(payee, 'payeeId');
  const rates: Rates = { input: draft.fxRate, stored: new Map(), used: false };

  if (draft.categoryId !== null) {
    if (!onBudget(target)) throw categoryNotAllowed(TRACKING_NO_CATEGORY, 'categoryId');
    await assertUsableCategory(db, draft.categoryId, 'categoryId');
  }
  const { amountBase, fxRate } = bookedBase(target.currency, draft.amount, rates);
  assertRateUsed(rates);

  return {
    main: {
      accountId: draft.accountId,
      date: draft.date,
      payeeId: draft.payeeId,
      categoryId: draft.categoryId,
      memo: draft.memo,
      amount: draft.amount,
      amountBase,
      fxRate,
      fxRateManual: fxRate !== null,
      cleared: draft.cleared,
      approved: draft.approved,
      flag: draft.flag,
    },
    account: target,
    payee,
    payeeDefault:
      payee?.kind === 'user' && draft.categoryId !== null ? { payeeId: payee.id, categoryId: draft.categoryId } : null,
  };
}
