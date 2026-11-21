import { z } from 'zod';
import { type AccountBalances, fxRateSchema } from './accounts';
import { boundedMoneySchema, idSchema, isoDateSchema, moneySchema, nameSchema } from './common';

export const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type FlagColor = (typeof FLAG_COLORS)[number];

export const CLEARED_STATUSES = ['uncleared', 'cleared', 'reconciled'] as const;
/** `reconciled` is set by the reconcile flow (P2d); users switch between the other two. */
export type ClearedStatus = (typeof CLEARED_STATUSES)[number];

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
 * A split line (spec §10 "Splits"). Choosing a transfer payee makes the line a transfer to that account (same
 * currency only); the line's category follows the same rules as a transaction in the split's account.
 */
export const splitLineSchema = z.object({
  amount: boundedMoneySchema,
  payeeId: idSchema.nullable().default(null),
  categoryId: idSchema.nullable().default(null),
  memo: memoSchema.default(''),
});

export type SplitLineRequest = z.infer<typeof splitLineSchema>;

/** At least two lines; their amounts add up to the transaction's amount. */
export const splitLinesSchema = z
  .array(splitLineSchema)
  .min(2, 'A split needs at least two lines.')
  .max(100, 'Use at most 100 lines.');

/**
 * POST /api/transactions. `amount` is in the account's currency (minor units, signed: + inflow, − outflow).
 * Choose an existing payee by `payeeId` or name one with `payeeName` (reused if a payee with that name exists,
 * otherwise created). A `date` after today (in the budget's time zone) is saved as a one-time scheduled transaction.
 *
 * Choosing an account's "Transfer : <name>" payee makes a transfer (spec §10): the other side is created in that
 * account. A transfer between a budget and a tracking account needs `categoryId`, which is stored on the budget side;
 * other transfers take none (spec §5.5). `lines` makes a split, whose own category stays empty.
 */
export const createTransactionRequestSchema = z
  .object({
    accountId: idSchema,
    /** Defaults to today. */
    date: transactionDateSchema.optional(),
    /** null = no payee, like omitting it. */
    payeeId: idSchema.nullable().optional(),
    payeeName: nameSchema.optional(),
    /** null = Uncategorized on budget accounts; tracking accounts never take one. */
    categoryId: idSchema.nullable().default(null),
    memo: memoSchema.default(''),
    amount: boundedMoneySchema,
    /** Transfers between currencies: the other account's native amount (opposite sign). */
    transferAmount: boundedMoneySchema.optional(),
    /**
     * Rate to PLN; required for foreign-currency accounts until the NBP lookup exists (P2d). For a transfer between
     * two foreign-currency accounts it is the rate of the sending account's currency (spec §9).
     */
    fxRate: fxRateSchema.optional(),
    cleared: userClearedSchema.default('uncleared'),
    flag: flagSchema.nullable().default(null),
    lines: splitLinesSchema.optional(),
  })
  .refine((body) => body.payeeId == null || body.payeeName === undefined, {
    path: ['payeeName'],
    message: 'Choose a payee or type a new name, not both.',
  })
  .refine((body) => body.lines === undefined || body.categoryId === null, {
    path: ['categoryId'],
    message: "A split's categories go on its lines.",
  });

export type CreateTransactionRequest = z.infer<typeof createTransactionRequestSchema>;
/** The request body as sent (fields with defaults are optional). */
export type CreateTransactionInput = z.input<typeof createTransactionRequestSchema>;

/**
 * PATCH /api/transactions/:id: omitted fields stay as they are. On a transfer, date, amount and memo are mirrored to
 * the other side (between currencies, the other side's amount changes only with `transferAmount`); cleared, approved
 * and flag belong to each side. The counterpart of a split line takes only memo, cleared, approved and flag; the
 * rest is edited on the split.
 *
 * Changing the amount, account, date or transfer of a reconciled transaction (or un-reconciling it) needs
 * `confirmReconciled: true`; otherwise the answer is 409 `confirm_reconciled`.
 */
export const updateTransactionRequestSchema = z
  .object({
    /** Another account in the same currency. */
    accountId: idSchema.optional(),
    date: transactionDateSchema.optional(),
    /** null removes the payee; a transfer payee makes (or retargets) a transfer. */
    payeeId: idSchema.nullable().optional(),
    payeeName: nameSchema.optional(),
    categoryId: idSchema.nullable().optional(),
    memo: memoSchema.optional(),
    amount: boundedMoneySchema.optional(),
    transferAmount: boundedMoneySchema.optional(),
    fxRate: fxRateSchema.optional(),
    cleared: userClearedSchema.optional(),
    approved: z.boolean().optional(),
    flag: flagSchema.nullable().optional(),
    /** New lines replace the split's lines (unless they equal them); null turns a split into a plain transaction. */
    lines: splitLinesSchema.nullable().optional(),
    confirmReconciled: z.boolean().default(false),
  })
  .refine((body) => body.payeeId === undefined || body.payeeName === undefined, {
    path: ['payeeName'],
    message: 'Choose a payee or type a new name, not both.',
  })
  .refine((body) => !body.lines || !body.categoryId, {
    path: ['categoryId'],
    message: "A split's categories go on its lines.",
  });

export type UpdateTransactionRequest = z.infer<typeof updateTransactionRequestSchema>;

/**
 * DELETE /api/transactions/:id (body optional): deletes the transaction with its transfer side or the counterparts of
 * its split lines. Deleting reconciled rows needs `confirmReconciled: true` (409 `confirm_reconciled` otherwise).
 */
export const deleteTransactionRequestSchema = z.object({ confirmReconciled: z.boolean().default(false) });

/** One edit for every selected transaction (spec §10 "Search and bulk operations"). */
export const bulkActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('categorize'), categoryId: idSchema.nullable() }),
  z.object({ type: z.literal('setPayee'), payeeId: idSchema.nullable() }),
  z.object({ type: z.literal('setFlag'), flag: flagSchema.nullable() }),
  z.object({ type: z.literal('setCleared'), cleared: userClearedSchema }),
  z.object({ type: z.literal('approve') }),
  /** Another account in the same currency. */
  z.object({ type: z.literal('moveAccount'), accountId: idSchema }),
  z.object({ type: z.literal('delete') }),
]);

export type BulkAction = z.infer<typeof bulkActionSchema>;

/**
 * POST /api/transactions/bulk: one undoable command. Each row gets exactly the checks of a single edit or delete;
 * if any row fails, nothing changes and the error's `fieldErrors` names it (`ids.<index>`). A row that an earlier
 * row already deleted (the other side of a transfer it deleted or ended) is skipped.
 */
export const bulkRequestSchema = z.object({
  ids: z
    .array(idSchema)
    .min(1, 'Select at least one transaction.')
    .max(500, 'Select at most 500 transactions.')
    .refine((ids) => new Set(ids).size === ids.length, 'List each id once.'),
  action: bulkActionSchema,
  confirmReconciled: z.boolean().default(false),
});

export type BulkRequest = z.infer<typeof bulkRequestSchema>;

/** The selected ids. */
export interface BulkResponse {
  ids: string[];
}

/** Money in a query string: a whole number of minor units. */
const queryMoneySchema = z
  .string()
  .regex(/^-?\d{1,16}$/, 'Enter a whole amount in minor units.')
  .transform(Number)
  .pipe(moneySchema);

/** An opaque page position: the (date, id) of the last row of the previous page, as `YYYY-MM-DD_<id>`. */
export const registerCursorSchema = z.string().transform((cursor, ctx) => {
  const date = transactionDateSchema.safeParse(cursor.slice(0, 10));
  const id = idSchema.safeParse(cursor.slice(11));
  if (cursor[10] !== '_' || !date.success || !id.success) {
    ctx.addIssue({ code: 'custom', message: 'Invalid cursor.' });
    return z.NEVER;
  }
  return { date: date.data, id: id.data };
});

/**
 * GET /api/transactions (spec §10 "Search and bulk operations", §11 Register): newest first by (date desc, id desc),
 * cursor-paginated. Every filter is optional and they combine with AND.
 */
export const registerQuerySchema = z
  .object({
    /** One account's register (with its balances); all accounts when omitted. */
    accountId: idSchema.optional(),
    /** Case-insensitive text in the payee, memo or category name, including split lines. */
    q: z.string().trim().min(1).max(100).optional(),
    /** Inclusive date range. */
    from: transactionDateSchema.optional(),
    to: transactionDateSchema.optional(),
    /** Inclusive range of the signed native amount. */
    minAmount: queryMoneySchema.optional(),
    maxAmount: queryMoneySchema.optional(),
    /**
     * The transaction's category or one of its split lines'. The Uncategorized category lists what the budget counts
     * as its activity: lines in budget accounts without a category that are neither transfers nor starting balances
     * (split lines included). Card payment categories hold no transactions; the client lists their activity with
     * `accountId=<linkedAccountId>`.
     */
    categoryId: idSchema.optional(),
    /** The transaction's payee or one of its split lines'. */
    payeeId: idSchema.optional(),
    flag: flagSchema.optional(),
    cleared: z.enum(CLEARED_STATUSES).optional(),
    /** `true`: only transactions waiting for approval. */
    unapproved: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    cursor: registerCursorSchema.optional(),
    /** Page size, 1–200 (default 50). */
    limit: z
      .string()
      .regex(/^\d{1,3}$/, 'Use 1 to 200.')
      .transform(Number)
      .pipe(z.int().min(1, 'Use 1 to 200.').max(200, 'Use 1 to 200.'))
      .optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ['to'],
    message: 'The end date must not be before the start date.',
  })
  .refine(({ minAmount: min, maxAmount: max }) => min === undefined || max === undefined || min <= max, {
    path: ['maxAmount'],
    message: 'The largest amount must not be below the smallest.',
  });

export type RegisterQuery = z.infer<typeof registerQuerySchema>;

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

/** GET /api/transactions */
export interface RegisterResponse {
  transactions: TransactionDto[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
  /** With `accountId`: the register header's cleared, uncleared and working balances (natively and in PLN). */
  balances: { balance: AccountBalances; balanceBase: AccountBalances } | null;
}
