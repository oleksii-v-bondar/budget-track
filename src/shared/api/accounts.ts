import { z } from 'zod';
import { ACCOUNT_TYPES, type AccountClass, type AccountType, accountClassOf, isLoanType } from '../accounts';
import { boundedMoneySchema, isoDateSchema, nameSchema, noteSchema } from './common';
import type { FxRateDto } from './fx';
import type { TransactionDto } from './transactions';

/** Spec §1: the budget currency. */
export const BASE_CURRENCY = 'PLN';

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { error: 'Use a 3-letter currency code, e.g. EUR.', abort: true })
  .refine((code) => Intl.supportedValuesOf('currency').includes(code), 'Unknown currency code.');

/** Rate to PLN, numeric(14,6). */
export const fxRateSchema = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,6})?$/, { error: 'Enter the rate as a decimal number, e.g. 4.2512.', abort: true })
  .refine((rate) => Number(rate) > 0, 'The rate must be greater than 0.');

/** APR in percent, numeric(7,4). */
export const interestRateSchema = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter the APR in percent, e.g. 6.5.');

/** Minimum payments and escrow: 0 … MAX_AMOUNT, so the loan math and debt targets built on them stay exact. */
const cappedMoneySchema = boundedMoneySchema.min(0, 'Enter 0 or more.');

/** Starting balances can't be dated before 1970 (checked only once the format is valid). */
const startingDateSchema = isoDateSchema.refine((date) => date >= '1970-01-01', {
  error: 'Use a date from 1970-01-01 on.',
  when: (payload) => payload.issues.length === 0,
});

/** Spec §4.2: which optional fields an account type takes. */
export function accountFieldsAllowed(type: AccountType) {
  const loan = isLoanType(type);
  const credit = accountClassOf(type) === 'credit';
  return { interestRate: loan || credit, minPayment: loan || credit, escrowAmount: loan, pairedCategory: loan };
}

export const createAccountRequestSchema = z
  .object({
    name: nameSchema,
    type: z.enum(ACCOUNT_TYPES),
    currency: currencySchema.default(BASE_CURRENCY),
    /** Native minor units; negative for debt. */
    startingBalance: boundedMoneySchema,
    /** Defaults to today in the budget's time zone; may not be in the future. */
    startingDate: startingDateSchema.optional(),
    /**
     * Foreign currencies: the starting balance's rate to PLN. Without it the server uses the NBP rate of the starting
     * date (spec §9) and answers 422 `fx_rate_required` when NBP has none.
     */
    fxRate: fxRateSchema.optional(),
    note: noteSchema.optional(),
    interestRate: interestRateSchema.optional(),
    minPayment: cappedMoneySchema.optional(),
    escrowAmount: cappedMoneySchema.optional(),
    /** Loans only: a Debt Payments category linked to the loan, with a minimum-payment target (spec §8). */
    createPairedCategory: z.boolean().default(false),
  })
  .superRefine((body, ctx) => {
    const allowed = accountFieldsAllowed(body.type);
    const reject = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (body.interestRate !== undefined && !allowed.interestRate) {
      reject('interestRate', 'Only loans and credit accounts have an interest rate.');
    }
    if (body.minPayment !== undefined && !allowed.minPayment) {
      reject('minPayment', 'Only loans and credit accounts have a minimum payment.');
    }
    if (body.escrowAmount !== undefined && !allowed.escrowAmount) reject('escrowAmount', 'Only loans have escrow.');
    if (body.createPairedCategory && !allowed.pairedCategory) {
      reject('createPairedCategory', 'Only loans can have a paired category.');
    } else if (body.createPairedCategory && body.minPayment === undefined) {
      reject('minPayment', "Enter the minimum payment: it becomes the paired category's target.");
    }
    if (body.currency === BASE_CURRENCY && body.fxRate !== undefined) {
      reject('fxRate', `${BASE_CURRENCY} accounts don't need an exchange rate.`);
    }
  });

export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;

/** PATCH /api/accounts/:id. Omitted fields stay as they are; null (or an empty note) clears a field. */
export const updateAccountRequestSchema = z.object({
  name: nameSchema.optional(),
  note: noteSchema.nullable().optional(),
  /** Only within the account's class, and loans only to other loan types. */
  type: z.enum(ACCOUNT_TYPES).optional(),
  interestRate: interestRateSchema.nullable().optional(),
  minPayment: cappedMoneySchema.nullable().optional(),
  escrowAmount: cappedMoneySchema.nullable().optional(),
});

export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;

export interface AccountBalances {
  /** Cleared and reconciled transactions. */
  cleared: number;
  uncleared: number;
  /** cleared + uncleared */
  working: number;
}

export interface AccountDto {
  id: string;
  name: string;
  type: AccountType;
  accountClass: AccountClass;
  currency: string;
  closed: boolean;
  sortOrder: number;
  note: string | null;
  /** APR in percent as a decimal string, e.g. "6.5000". */
  interestRate: string | null;
  minPayment: number | null;
  escrowAmount: number | null;
  lastReconciledAt: string | null;
  lastReconciledBalance: number | null;
  /** The "Transfer : <name>" payee that targets this account. */
  transferPayeeId: string;
  /** Credit accounts: their credit card payment category. */
  paymentCategoryId: string | null;
  /** Loans: the opt-in paired Debt Payments category. */
  pairedCategoryId: string | null;
  /** In the account's currency (minor units). */
  balance: AccountBalances;
  /** In PLN: the sum of the booked base amounts. */
  balanceBase: AccountBalances;
  /**
   * Foreign-currency accounts: the latest NBP rate (today's, or the last published day's; spec §9). Null for PLN
   * accounts, when NBP has none, and in responses built inside a command.
   */
  latestRate: FxRateDto | null;
  /**
   * "≈ X zł" (spec §9, §11): the working balance at `latestRate`, in PLN; null without a rate. Revalue books
   * `balanceAtLatestRate − balanceBase.working`.
   */
  balanceAtLatestRate: number | null;
}

export interface AccountListResponse {
  accounts: AccountDto[];
}

/** POST /api/accounts/:id/revalue (spec §9). Without `fxRate` the latest NBP rate applies. */
export const revalueRequestSchema = z.object({ fxRate: fxRateSchema.optional() });

export interface RevalueResponse {
  account: AccountDto;
  /** The FX revaluation transaction: amount 0, `amountBase` = the difference. */
  transaction: TransactionDto;
}

/** POST /api/accounts/:id/reconcile (spec §10 "Reconcile flow"). Amounts are in the account's currency. */
export const reconcileRequestSchema = z
  .object({
    /** The bank statement's balance. */
    statementBalance: boundedMoneySchema,
    /** When the statement differs: book the difference as a cleared adjustment, then reconcile. */
    createAdjustment: z.boolean().default(false),
    /** Foreign accounts: the adjustment's rate to PLN; without it, today's NBP rate. */
    fxRate: fxRateSchema.optional(),
  })
  .refine((body) => body.fxRate === undefined || body.createAdjustment, {
    path: ['fxRate'],
    message: 'Only an adjustment takes an exchange rate.',
  });

export type ReconcileRequest = z.infer<typeof reconcileRequestSchema>;

/** GET /api/accounts/:id/reconcile: "Is your cleared balance X?" */
export interface ReconcileStatusDto {
  accountId: string;
  currency: string;
  /**
   * Cleared and reconciled transactions (for loans with the interest and escrow of months with a cleared payment), in
   * the account's currency.
   */
  clearedBalance: number;
  lastReconciledAt: string | null;
  lastReconciledBalance: number | null;
}

export interface ReconcileResponse extends ReconcileStatusDto {
  /** The "Reconciliation Balance Adjustment" booked for the difference, if there was one. */
  adjustment: TransactionDto | null;
  /** How many cleared transactions became reconciled (the adjustment included). */
  reconciledCount: number;
}
