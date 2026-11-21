import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { ClearedStatus, FlagColor } from '../../shared/api/transactions';
import { type IsoDate, type Money, splitLineBases, transferBases } from '../../engine';
import type { Executor } from '../db/client';
import { DomainError } from '../http/errors';
import {
  type AccountInfo,
  assertBaseAmount,
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
  type Rate,
  rateFor,
  type Rates,
  requireAccount,
  requirePayee,
  TRACKING_NO_CATEGORY,
  UNKNOWN_RATE,
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
  /** A split's lines (null = not a split). */
  lines: DraftLine[] | null;
}

export interface DraftLine {
  amount: Money;
  payeeId: string | null;
  /** For a transfer line between a budget and a tracking account: the budget side's category. */
  categoryId: string | null;
  memo: string | null;
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

/** One `subtransaction` row, with the counterpart transaction of a transfer line. */
export interface LinePlan {
  amount: Money;
  amountBase: Money;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  transferAccountId: string | null;
  sortOrder: number;
  counterpart: RowPlan | null;
}

export interface Plan {
  main: RowPlan & { cleared: ClearedStatus; approved: boolean; flag: FlagColor | null; isSplit: boolean };
  account: AccountInfo;
  payee: PayeeInfo | null;
  /** The other side of a transfer. */
  counterpart: RowPlan | null;
  /** The other account of a transfer. */
  transfer: AccountInfo | null;
  /** A split's lines in order (null = not a split). */
  lines: LinePlan[] | null;
  /** Spec §10: saving a categorized, non-transfer transaction makes its category the payee's default. */
  payeeDefault: { payeeId: string; categoryId: string } | null;
}

/** Spec §9: NBP rates by currency, quoted before the command for one date (see `default-rates.ts`). */
export interface DefaultRates {
  date: IsoDate;
  rates: Map<string, string>;
}

/** What an edited transaction already has; edits may keep values that new transactions can't use. */
export interface PlanContext {
  existing?: {
    payeeId: string | null;
    /** Stored rates by currency that still apply, used when the request sends none (see `storedRates`). */
    rates: Map<string, Rate>;
    /** A plain transfer's other side: its amount stays unless `transferAmount` is sent. */
    counterpart: { accountId: string; amount: Money } | null;
    /** Accounts that already hold the transaction's rows (they may be closed). */
    accountIds: Set<string>;
  };
  /**
   * Spec §9: NBP rates quoted before the command. They apply only to a draft of the date they were quoted for: if the
   * transaction's date changed in between, its currencies have no default (422 `fx_rate_required`).
   */
  defaults?: DefaultRates;
  /** Collects currencies that have no rate instead of refusing them (see `Rates.unknown`). */
  unknownRates?: Set<string>;
  /** Rows the app books (reconciliation adjustments) may use a system payee; users can't choose one. */
  systemPayee?: boolean;
}

/** PLN rows, rows whose base comes from the other side of a transfer, and rates nobody has yet store none. */
const rateColumns = (rate: Rate | null) =>
  rate === null || rate === UNKNOWN_RATE
    ? { fxRate: null, fxRateManual: false }
    : { fxRate: rate.rate, fxRateManual: rate.manual };

/**
 * Spec §9: both sides of a transfer net to zero in PLN. Same-currency transfers mirror the amount; transfers between
 * currencies take both native amounts. The sending side (the outflow; this side for 0) decides the base amounts:
 * a PLN side gives them directly, otherwise the sending currency's rate converts.
 */
function transferSides(main: AccountInfo, other: AccountInfo, draft: Draft, rates: Rates, context: PlanContext) {
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
    const kept = context.existing?.counterpart;
    const amount = draft.transferAmount ?? (kept?.accountId === other.id ? kept.amount : null);
    if (amount === null) {
      throw new DomainError(
        'transfer_amount_required',
        `Enter the amount in ${other.currency} that "${other.name}" receives or sends.`,
        'transferAmount',
      );
    }
    if (draft.amount === 0 || Math.sign(amount) !== -Math.sign(draft.amount)) {
      throw new DomainError(
        'transfer_amount_sign',
        'The two sides of a transfer need opposite, non-zero amounts.',
        'transferAmount',
      );
    }
    otherAmount = amount;
  }
  const here = { amount: draft.amount, currency: main.currency };
  const there = { amount: otherAmount, currency: other.currency };
  const mainSends = draft.amount <= 0;
  const from = mainSends ? here : there;
  const to = mainSends ? there : here;
  const rate = from.currency !== BASE_CURRENCY && to.currency !== BASE_CURRENCY ? rateFor(rates, from.currency) : null;
  const { fromBase, toBase } = transferBases(
    BASE_CURRENCY,
    { ...from, rate: rate?.rate ?? null },
    { ...to, rate: null },
  );
  assertBaseAmount(fromBase, mainSends || main.currency === other.currency ? 'amount' : 'transferAmount');
  return mainSends
    ? { mainBase: fromBase, mainRate: rate, otherAmount, otherBase: toBase, otherRate: null }
    : { mainBase: toBase, mainRate: null, otherAmount, otherBase: fromBase, otherRate: rate };
}

/** Spec §10 "Splits" and §9: lines add up to the amount; foreign lines get their base from the split's rate. */
async function planLines(
  db: Executor,
  main: AccountInfo,
  draft: Draft & { lines: DraftLine[] },
  rates: Rates,
  open: (target: AccountInfo, field: string) => void,
): Promise<{ amountBase: Money; rate: Rate | null; lines: LinePlan[] }> {
  const total = draft.lines.reduce((sum, line) => sum + BigInt(line.amount), 0n);
  if (total !== BigInt(draft.amount)) {
    throw new DomainError('split_sum', 'The lines must add up to the transaction amount.', 'lines');
  }
  const { amountBase, rate } = bookedBase(main.currency, draft.amount, rates);
  const amounts = draft.lines.map((line) => line.amount);
  const bases = rate === null ? amounts : splitLineBases(amountBase, amounts, rate.rate);

  const lines: LinePlan[] = [];
  for (const [index, line] of draft.lines.entries()) {
    const field = (name: string) => `lines.${index}.${name}`;
    const linePayee = line.payeeId === null ? null : await requirePayee(db, line.payeeId, field('payeeId'));
    if (linePayee) assertNotSystemPayee(linePayee, field('payeeId'));
    const lineBase = assertBaseAmount(bases[index]!, field('amount'));
    const base = {
      amount: line.amount,
      amountBase: lineBase,
      payeeId: line.payeeId,
      memo: line.memo,
      sortOrder: index,
    };
    if (!linePayee?.transferAccountId) {
      if (line.categoryId !== null) {
        if (!onBudget(main)) throw categoryNotAllowed(TRACKING_NO_CATEGORY, field('categoryId'));
        await assertUsableCategory(db, line.categoryId, field('categoryId'));
      }
      lines.push({ ...base, categoryId: line.categoryId, transferAccountId: null, counterpart: null });
      continue;
    }
    const other = await requireAccount(db, linePayee.transferAccountId, field('payeeId'));
    assertNotSelf(main, other, field('payeeId'));
    if (other.currency !== main.currency) {
      throw new DomainError(
        'split_transfer_currency',
        'A split line can only transfer to an account in the same currency.',
        field('payeeId'),
      );
    }
    open(other, field('payeeId'));
    const category = await placeTransferCategory(db, main, other, line.categoryId, field('categoryId'));
    lines.push({
      ...base,
      categoryId: category.here,
      transferAccountId: other.id,
      counterpart: {
        accountId: other.id,
        date: draft.date,
        payeeId: main.transferPayeeId,
        categoryId: category.there,
        memo: line.memo,
        amount: -line.amount,
        amountBase: -lineBase,
        ...rateColumns(null),
        transferAccountId: main.id,
      },
    });
  }
  return { amountBase, rate, lines };
}

/** Validates a draft against spec §5.5 and §9 and computes the rows to write. */
export async function planTransaction(db: Executor, draft: Draft, context: PlanContext = {}): Promise<Plan> {
  const existing = context.existing;
  const open = (target: AccountInfo, field: string) => {
    if (!existing?.accountIds.has(target.id)) assertOpen(target, field);
  };
  const main = await requireAccount(db, draft.accountId, 'accountId');
  open(main, 'accountId');
  const payee = draft.payeeId === null ? null : await requirePayee(db, draft.payeeId, 'payeeId');
  if (payee && !context.systemPayee && draft.payeeId !== existing?.payeeId) assertNotSystemPayee(payee, 'payeeId');
  const rates: Rates = {
    input: draft.fxRate,
    stored: existing?.rates ?? new Map(),
    defaults: context.defaults?.date === draft.date ? context.defaults.rates : new Map(),
    unknown: context.unknownRates ?? null,
    used: false,
  };
  const row = {
    accountId: draft.accountId,
    date: draft.date,
    payeeId: draft.payeeId,
    memo: draft.memo,
    amount: draft.amount,
  };
  const status = { cleared: draft.cleared, approved: draft.approved, flag: draft.flag };

  if (draft.lines !== null) {
    if (payee?.transferAccountId) {
      throw new DomainError(
        'split_transfer',
        "A split itself can't be a transfer: make one of its lines a transfer instead.",
        'payeeId',
      );
    }
    if (draft.categoryId !== null) throw categoryNotAllowed("A split's categories go on its lines.", 'categoryId');
    if (draft.transferAmount !== null) {
      throw new DomainError('transfer_amount_not_allowed', 'Only transfers take a second amount.', 'transferAmount');
    }
    const split = await planLines(db, main, { ...draft, lines: draft.lines }, rates, open);
    assertRateUsed(rates);
    return {
      main: {
        ...row,
        ...status,
        categoryId: null,
        amountBase: split.amountBase,
        ...rateColumns(split.rate),
        transferAccountId: null,
        isSplit: true,
      },
      account: main,
      payee,
      counterpart: null,
      transfer: null,
      lines: split.lines,
      payeeDefault: null,
    };
  }

  if (payee?.transferAccountId) {
    const other = await requireAccount(db, payee.transferAccountId, 'payeeId');
    assertNotSelf(main, other, 'payeeId');
    open(other, 'payeeId');
    const category = await placeTransferCategory(db, main, other, draft.categoryId, 'categoryId');
    const sides = transferSides(main, other, draft, rates, context);
    assertRateUsed(rates);
    return {
      main: {
        ...row,
        ...status,
        categoryId: category.here,
        amountBase: sides.mainBase,
        ...rateColumns(sides.mainRate),
        transferAccountId: other.id,
        isSplit: false,
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
      lines: null,
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
  const { amountBase, rate } = bookedBase(main.currency, draft.amount, rates);
  assertRateUsed(rates);
  return {
    main: {
      ...row,
      ...status,
      categoryId: draft.categoryId,
      amountBase,
      ...rateColumns(rate),
      transferAccountId: null,
      isSplit: false,
    },
    account: main,
    payee,
    counterpart: null,
    transfer: null,
    lines: null,
    payeeDefault:
      payee?.kind === 'user' && draft.categoryId !== null ? { payeeId: payee.id, categoryId: draft.categoryId } : null,
  };
}
