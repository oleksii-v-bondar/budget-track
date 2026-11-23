import { type AccountType, accountClassOf } from '../../shared/accounts';
import { BASE_CURRENCY, type createAccountRequestSchema, currencySchema, fxRateSchema } from '../../shared/api/accounts';
import { nameSchema } from '../../shared/api/common';
import type { z } from 'zod';
import { formatDate, parseDate } from '../lib/format';
import { rateInput } from '../lib/fx';
import { readAmount } from '../ui/amount-field';

/** Spec §11: type → name → currency → starting balance and date. */
export type WizardStep = 'type' | 'name' | 'currency' | 'balance';

export const WIZARD_STEPS: readonly WizardStep[] = ['type', 'name', 'currency', 'balance'];

export interface WizardValues {
  type: AccountType | null;
  name: string;
  currency: string;
  /** Amount text (keypad expressions work); for debts the amount owed. */
  balance: string;
  /** dd.MM.yyyy */
  date: string;
  /** Empty: the NBP rate of the date. */
  fxRate: string;
}

export type CreateAccountInput = z.input<typeof createAccountRequestSchema>;

export function initialWizard(today: string): WizardValues {
  return { type: null, name: '', currency: BASE_CURRENCY, balance: '', date: formatDate(today), fxRate: '' };
}

/** Credit accounts and other liabilities hold debt: the wizard asks for the amount owed. */
export function isDebt(type: AccountType): boolean {
  return accountClassOf(type) === 'credit' || type === 'other_liability';
}

/** Which step asks for each request field, so a server error can send the owner back to it. */
const FIELD_STEPS: Record<string, WizardStep> = {
  type: 'type',
  name: 'name',
  currency: 'currency',
  startingBalance: 'balance',
  startingDate: 'balance',
  fxRate: 'balance',
};

/** The earliest step with one of `fields` (request paths) on it, if any. */
export function stepOf(fields: readonly string[]): WizardStep | null {
  return WIZARD_STEPS.find((step) => fields.some((field) => FIELD_STEPS[field] === step)) ?? null;
}

const message = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? null : (result.error?.issues[0]?.message ?? 'Check this field.');

/** The step's own checks, keyed by request field (the server checks everything again). */
export function checkStep(step: WizardStep, values: WizardValues, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const put = (field: string, problem: string | null) => {
    if (problem) errors[field] = problem;
  };
  if (step === 'type' && values.type === null) put('type', 'Choose a type.');
  if (step === 'name') put('name', message(nameSchema.safeParse(values.name)));
  if (step === 'currency') put('currency', message(currencySchema.safeParse(values.currency.trim().toUpperCase())));
  if (step === 'balance') {
    const amount = readAmount(values.balance);
    put('startingBalance', amount.ok ? null : amount.error);
    const date = parseDate(values.date);
    if (date === null) put('startingDate', 'Enter a date as dd.mm.yyyy.');
    else if (date > today) put('startingDate', "The starting balance can't be dated in the future.");
    else if (date < '1970-01-01') put('startingDate', 'Use a date from 1970-01-01 on.');
    if (values.fxRate.trim() !== '') put('fxRate', message(fxRateSchema.safeParse(rateInput(values.fxRate))));
  }
  return errors;
}

/** POST /api/accounts for checked values; a debt's amount owed becomes a negative balance. */
export function createAccountRequest(values: WizardValues): CreateAccountInput {
  const type = values.type!;
  const amount = readAmount(values.balance);
  const owed = amount.ok ? amount.value : 0;
  const currency = values.currency.trim().toUpperCase();
  const request: CreateAccountInput = {
    name: values.name.trim(),
    type,
    currency,
    startingBalance: isDebt(type) && owed !== 0 ? -owed : owed,
    startingDate: parseDate(values.date) ?? undefined,
  };
  if (currency !== BASE_CURRENCY && values.fxRate.trim() !== '') request.fxRate = rateInput(values.fxRate);
  return request;
}
