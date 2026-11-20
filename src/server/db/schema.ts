import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  pgView,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ACCOUNT_CLASS_SQL, ACCOUNT_TYPES } from '../../shared/accounts';

// Money is integer minor units (grosze); `mode: 'number'` maps int8 to a JS number (safe below 2^53).
const money = (name: string) => bigint(name, { mode: 'number' });
const day = (name: string) => date(name, { mode: 'string' });
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const timestamps = {
  createdAt: instant('created_at').defaultNow().notNull(),
  updatedAt: instant('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

export const accountType = pgEnum('account_type', ACCOUNT_TYPES);
export const categoryGroupKind = pgEnum('category_group_kind', ['normal', 'cc_payments', 'debt_payments', 'internal']);
export const categorySystemKind = pgEnum('category_system_kind', ['rta', 'uncategorized']);
export const payeeSystemKind = pgEnum('payee_system_kind', [
  'starting_balance',
  'reconciliation_adjustment',
  'fx_revaluation',
]);
export const clearedStatus = pgEnum('cleared_status', ['uncleared', 'cleared', 'reconciled']);
export const flagColor = pgEnum('flag_color', ['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
export const targetKind = pgEnum('target_kind', ['spending', 'balance', 'debt']);
export const targetCadence = pgEnum('target_cadence', ['weekly', 'monthly', 'yearly', 'custom', 'none']);
export const targetMode = pgEnum('target_mode', ['set_aside', 'refill']);
export const targetDebtMode = pgEnum('target_debt_mode', ['min_payment', 'fixed', 'payoff_by_date']);
export const repeatUnit = pgEnum('repeat_unit', ['month', 'year']);
export const frequency = pgEnum('frequency', [
  'once',
  'daily',
  'weekly',
  'every_other_week',
  'twice_a_month',
  'every_4_weeks',
  'monthly',
  'every_other_month',
  'every_3_months',
  'every_4_months',
  'twice_a_year',
  'yearly',
  'every_other_year',
]);
export const undoState = pgEnum('undo_state', ['done', 'undone']);

// ---------------------------------------------------------------- settings and auth (spec §4.1)

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    passwordHash: text('password_hash').notNull(),
    totpSecretEnc: text('totp_secret_enc').notNull(),
    recoveryCodeHashes: text('recovery_code_hashes').array().notNull().default(sql`'{}'::text[]`),
    baseCurrency: text('base_currency').notNull().default('PLN'),
    budgetStartMonth: day('budget_start_month').notNull(),
    ...timestamps,
  },
  (t) => [
    // At most one row: every row has the same value for the indexed constant expression.
    uniqueIndex('app_user_singleton').on(sql`(true)`),
    check('app_user_budget_start_first_of_month', sql`extract(day from ${t.budgetStartMonth}) = 1`),
  ],
);

export const session = pgTable('session', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: instant('created_at').defaultNow().notNull(),
  expiresAt: instant('expires_at').notNull(),
  lastSeenAt: instant('last_seen_at').notNull(),
  userAgent: text('user_agent'),
});

export const loginAttempt = pgTable(
  'login_attempt',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: instant('at').notNull(),
    success: boolean('success').notNull(),
    ip: text('ip').notNull(),
  },
  (t) => [index('login_attempt_ip_at').on(t.ip, t.at), index('login_attempt_at').on(t.at)],
);

// ---------------------------------------------------------------- accounts (spec §4.2)

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    type: accountType('type').notNull(),
    accountClass: text('account_class')
      .notNull()
      .generatedAlwaysAs(sql.raw(ACCOUNT_CLASS_SQL)),
    currency: text('currency').notNull().default('PLN'),
    closed: boolean('closed').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    note: text('note'),
    lastReconciledAt: instant('last_reconciled_at'),
    lastReconciledBalance: money('last_reconciled_balance'),
    interestRate: numeric('interest_rate', { precision: 7, scale: 4 }),
    minPayment: money('min_payment'),
    escrowAmount: money('escrow_amount'),
    pairedCategoryId: uuid('paired_category_id').references((): AnyPgColumn => category.id),
    ...timestamps,
  },
  (t) => [
    check('account_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('account_interest_rate_non_negative', sql`${t.interestRate} IS NULL OR ${t.interestRate} >= 0`),
  ],
);

export const loanInterestOverride = pgTable(
  'loan_interest_override',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    month: day('month').notNull(),
    amount: money('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.month] }),
    check('loan_interest_override_first_of_month', sql`extract(day from ${t.month}) = 1`),
  ],
);

// ---------------------------------------------------------------- categories and budget (spec §4.3)

export const categoryGroup = pgTable('category_group', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  hidden: boolean('hidden').notNull().default(false),
  kind: categoryGroupKind('kind').notNull().default('normal'),
  ...timestamps,
});

export const category = pgTable(
  'category',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => categoryGroup.id),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    hidden: boolean('hidden').notNull().default(false),
    note: text('note'),
    systemKind: categorySystemKind('system_kind'),
    linkedAccountId: uuid('linked_account_id').references((): AnyPgColumn => account.id),
    deletedAt: instant('deleted_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('category_one_per_system_kind').on(t.systemKind).where(sql`${t.systemKind} IS NOT NULL`),
    index('category_group_id').on(t.groupId),
  ],
);

export const assignment = pgTable(
  'assignment',
  {
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    month: day('month').notNull(),
    amount: money('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.categoryId, t.month] }),
    check('assignment_first_of_month', sql`extract(day from ${t.month}) = 1`),
    check('assignment_non_zero', sql`${t.amount} <> 0`),
  ],
);

export const target = pgTable(
  'target',
  {
    categoryId: uuid('category_id')
      .primaryKey()
      .references(() => category.id),
    kind: targetKind('kind').notNull(),
    cadence: targetCadence('cadence').notNull(),
    amount: money('amount').notNull().default(0),
    mode: targetMode('mode'),
    dueWeekday: smallint('due_weekday'),
    dueDayOfMonth: smallint('due_day_of_month'),
    dueDate: day('due_date'),
    repeatUnit: repeatUnit('repeat_unit'),
    repeatEvery: integer('repeat_every'),
    startMonth: day('start_month').notNull(),
    debtMode: targetDebtMode('debt_mode'),
    snoozedMonth: day('snoozed_month'),
    ...timestamps,
  },
  (t) => [
    check('target_amount_non_negative', sql`${t.amount} >= 0`),
    check('target_due_weekday_range', sql`${t.dueWeekday} IS NULL OR ${t.dueWeekday} BETWEEN 0 AND 6`),
    check('target_due_day_range', sql`${t.dueDayOfMonth} IS NULL OR ${t.dueDayOfMonth} BETWEEN 1 AND 31`),
    check('target_repeat_every_positive', sql`${t.repeatEvery} IS NULL OR ${t.repeatEvery} >= 1`),
    check('target_start_month_first_of_month', sql`extract(day from ${t.startMonth}) = 1`),
    check(
      'target_snoozed_month_first_of_month',
      sql`${t.snoozedMonth} IS NULL OR extract(day from ${t.snoozedMonth}) = 1`,
    ),
  ],
);

export const monthNote = pgTable(
  'month_note',
  {
    month: day('month').primaryKey(),
    note: text('note').notNull(),
    ...timestamps,
  },
  (t) => [check('month_note_first_of_month', sql`extract(day from ${t.month}) = 1`)],
);

// ---------------------------------------------------------------- payees and transactions (spec §4.4)

export const payee = pgTable(
  'payee',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    transferAccountId: uuid('transfer_account_id')
      .unique()
      .references(() => account.id),
    systemKind: payeeSystemKind('system_kind'),
    lastCategoryId: uuid('last_category_id').references(() => category.id),
    deletedAt: instant('deleted_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('payee_name_live').on(sql`lower(${t.name})`).where(sql`${t.deletedAt} IS NULL`)],
);

export const scheduledTransaction = pgTable('scheduled_transaction', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => account.id),
  payeeId: uuid('payee_id').references(() => payee.id),
  categoryId: uuid('category_id').references(() => category.id),
  memo: text('memo'),
  amount: money('amount').notNull(),
  fxRate: numeric('fx_rate', { precision: 14, scale: 6 }),
  fxRateManual: boolean('fx_rate_manual').notNull().default(false),
  flag: flagColor('flag'),
  transferAccountId: uuid('transfer_account_id').references(() => account.id),
  isSplit: boolean('is_split').notNull().default(false),
  frequency: frequency('frequency').notNull(),
  anchorDate: day('anchor_date').notNull(),
  nextDate: day('next_date').notNull(),
  ...timestamps,
});

export const scheduledSubtransaction = pgTable('scheduled_subtransaction', {
  id: uuid('id').primaryKey().defaultRandom(),
  scheduledId: uuid('scheduled_id')
    .notNull()
    .references(() => scheduledTransaction.id, { onDelete: 'cascade' }),
  amount: money('amount').notNull(),
  categoryId: uuid('category_id').references(() => category.id),
  payeeId: uuid('payee_id').references(() => payee.id),
  memo: text('memo'),
  transferAccountId: uuid('transfer_account_id').references(() => account.id),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const transaction = pgTable(
  'transaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    date: day('date').notNull(),
    payeeId: uuid('payee_id').references(() => payee.id),
    categoryId: uuid('category_id').references(() => category.id),
    memo: text('memo'),
    amount: money('amount').notNull(),
    amountBase: money('amount_base').notNull(),
    fxRate: numeric('fx_rate', { precision: 14, scale: 6 }),
    fxRateManual: boolean('fx_rate_manual').notNull().default(false),
    cleared: clearedStatus('cleared').notNull().default('uncleared'),
    approved: boolean('approved').notNull().default(true),
    flag: flagColor('flag'),
    transferAccountId: uuid('transfer_account_id').references(() => account.id),
    transferTxnId: uuid('transfer_txn_id').references((): AnyPgColumn => transaction.id),
    transferSubtxnId: uuid('transfer_subtxn_id').references((): AnyPgColumn => subtransaction.id),
    isSplit: boolean('is_split').notNull().default(false),
    isStartingBalance: boolean('is_starting_balance').notNull().default(false),
    scheduledId: uuid('scheduled_id').references(() => scheduledTransaction.id, { onDelete: 'set null' }),
    importId: text('import_id'),
    externalId: text('external_id'),
    deletedAt: instant('deleted_at'),
    ...timestamps,
  },
  (t) => [
    index('transaction_account_date').on(t.accountId, t.date),
    index('transaction_date').on(t.date),
    uniqueIndex('transaction_import_id').on(t.accountId, t.importId).where(sql`${t.importId} IS NOT NULL`),
    uniqueIndex('transaction_external_id').on(t.accountId, t.externalId).where(sql`${t.externalId} IS NOT NULL`),
  ],
);

export const subtransaction = pgTable(
  'subtransaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    txnId: uuid('txn_id')
      .notNull()
      .references((): AnyPgColumn => transaction.id),
    amount: money('amount').notNull(),
    amountBase: money('amount_base').notNull(),
    categoryId: uuid('category_id').references(() => category.id),
    payeeId: uuid('payee_id').references(() => payee.id),
    memo: text('memo'),
    transferAccountId: uuid('transfer_account_id').references(() => account.id),
    transferTxnId: uuid('transfer_txn_id').references((): AnyPgColumn => transaction.id),
    sortOrder: integer('sort_order').notNull().default(0),
    deletedAt: instant('deleted_at'),
    ...timestamps,
  },
  (t) => [index('subtransaction_txn_id').on(t.txnId)],
);

// ---------------------------------------------------------------- support (spec §4.5)

export const fxRate = pgTable(
  'fx_rate',
  {
    currency: text('currency').notNull(),
    date: day('date').notNull(),
    rate: numeric('rate', { precision: 14, scale: 6 }).notNull(),
    source: text('source').notNull().default('nbp'),
    effectiveDate: day('effective_date').notNull(),
  },
  (t) => [primaryKey({ columns: [t.currency, t.date] })],
);

export const undoEntry = pgTable('undo_entry', {
  // Monotonic id orders the undo/redo stacks.
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  label: text('label').notNull(),
  changes: jsonb('changes').notNull(),
  state: undoState('state').notNull().default('done'),
  createdAt: instant('created_at').defaultNow().notNull(),
});

// ---------------------------------------------------------------- ledger view (spec §4.6)

/** Read-only view created by migration 0001_ledger_view.sql; `.existing()` keeps drizzle-kit from managing it. */
export const ledgerLine = pgView('v_ledger_line', {
  accountId: uuid('account_id').notNull(),
  accountClass: text('account_class').notNull(),
  date: day('date').notNull(),
  month: day('month').notNull(),
  categoryId: uuid('category_id'),
  amount: money('amount').notNull(),
  amountBase: money('amount_base').notNull(),
  isTransfer: boolean('is_transfer').notNull(),
  counterAccountClass: text('counter_account_class'),
  isStartingBalance: boolean('is_starting_balance').notNull(),
  txnId: uuid('txn_id').notNull(),
  subtxnId: uuid('subtxn_id'),
}).existing();
