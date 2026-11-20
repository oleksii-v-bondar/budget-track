import { z } from 'zod';
import { fxRateSchema } from './accounts';
import { idSchema, isoDateSchema, moneySchema, nameSchema } from './common';

export const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type FlagColor = (typeof FLAG_COLORS)[number];

/** `reconciled` is set by the reconcile flow (P2d); users switch between the other two. */
export type ClearedStatus = 'uncleared' | 'cleared' | 'reconciled';

export const flagSchema = z.enum(FLAG_COLORS);
export const userClearedSchema = z.enum(['uncleared', 'cleared']);
/** Trimmed; an empty memo is stored as null. */
export const memoSchema = z.string().trim().max(500, 'Use at most 500 characters.');
/** Like starting balances, transactions start at 1970-01-01 (checked only once the format is valid). */
export const transactionDateSchema = isoDateSchema.refine((date) => date >= '1970-01-01', {
  error: 'Use a date from 1970-01-01 on.',
  when: (payload) => payload.issues.length === 0,
});

/**
 * POST /api/transactions. `amount` is in the account's currency (minor units, signed: + inflow, − outflow).
 * Choose an existing payee by `payeeId` or name one with `payeeName` (reused if a payee with that name exists,
 * otherwise created). A `date` after today (in the budget's time zone) is saved as a one-time scheduled transaction.
 */
export const createTransactionRequestSchema = z
  .object({
    accountId: idSchema,
    /** Defaults to today. */
    date: transactionDateSchema.optional(),
    payeeId: idSchema.optional(),
    payeeName: nameSchema.optional(),
    /** null = Uncategorized on budget accounts; tracking accounts never take one. */
    categoryId: idSchema.nullable().default(null),
    memo: memoSchema.default(''),
    amount: moneySchema,
    /** Rate to PLN; required for foreign-currency accounts until the NBP lookup exists (P2d). */
    fxRate: fxRateSchema.optional(),
    cleared: userClearedSchema.default('uncleared'),
    flag: flagSchema.nullable().default(null),
  })
  .refine((body) => body.payeeId === undefined || body.payeeName === undefined, {
    path: ['payeeName'],
    message: 'Choose a payee or type a new name, not both.',
  });

export type CreateTransactionRequest = z.infer<typeof createTransactionRequestSchema>;
/** The request body as sent (fields with defaults are optional). */
export type CreateTransactionInput = z.input<typeof createTransactionRequestSchema>;

/** The other side of a transfer. */
export interface TransferDto {
  accountId: string;
  accountName: string;
  /** The other side's transaction; for the counterpart of a split line, the split transaction. */
  transactionId: string;
  /** Set when this transaction is the counterpart of a split line: that line. */
  splitLineId: string | null;
  /** The other side's native amount, in its currency. */
  amount: number;
  currency: string;
  /** PLN per unit of the other side's currency (|base| / |amount|) when it isn't PLN. */
  effectiveRate: string | null;
}

export interface SplitLineTransferDto {
  accountId: string;
  accountName: string;
  /** The counterpart transaction in that account. */
  transactionId: string;
}

export interface SplitLineDto {
  id: string;
  amount: number;
  amountBase: number;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  memo: string | null;
  transfer: SplitLineTransferDto | null;
}

export interface TransactionDto {
  id: string;
  accountId: string;
  accountName: string;
  /** The account's currency; `amount` is in it. */
  currency: string;
  date: string;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  memo: string | null;
  amount: number;
  /** PLN (spec §9). */
  amountBase: number;
  /** The rate the user entered; null for PLN accounts and for amounts derived from the other side of a transfer. */
  fxRate: string | null;
  /** |amountBase| / |amount| for foreign-currency accounts (null for PLN accounts and zero amounts). */
  effectiveRate: string | null;
  cleared: ClearedStatus;
  approved: boolean;
  flag: FlagColor | null;
  isStartingBalance: boolean;
  isSplit: boolean;
  transfer: TransferDto | null;
  /** Live split lines in order; [] unless `isSplit`. */
  lines: SplitLineDto[];
}

/** POST /api/transactions: a booked transaction, or the one-time schedule a future date became (spec §5.6). */
export type CreateTransactionResponse =
  | { kind: 'transaction'; transaction: TransactionDto }
  | { kind: 'scheduled'; scheduledId: string; date: string };
