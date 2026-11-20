import { z } from 'zod';
import { ACCOUNT_TYPES, type AccountClass, type AccountType, accountClassOf, isLoanType } from '../accounts';
import { isoDateSchema, moneySchema, nameSchema, nonNegativeMoneySchema, noteSchema } from './common';

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
    startingBalance: moneySchema,
    /** Defaults to today in the budget's time zone; may not be in the future. */
    startingDate: startingDateSchema.optional(),
    /** Required for foreign currencies until the NBP lookup exists (P2d). */
    fxRate: fxRateSchema.optional(),
    note: noteSchema.optional(),
    interestRate: interestRateSchema.optional(),
    minPayment: nonNegativeMoneySchema.optional(),
    escrowAmount: nonNegativeMoneySchema.optional(),
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
    if (body.currency !== BASE_CURRENCY && body.fxRate === undefined) {
      reject('fxRate', `Enter the exchange rate to ${BASE_CURRENCY} for the starting balance.`);
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
  minPayment: nonNegativeMoneySchema.nullable().optional(),
  escrowAmount: nonNegativeMoneySchema.nullable().optional(),
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
}

export interface AccountListResponse {
  accounts: AccountDto[];
}
