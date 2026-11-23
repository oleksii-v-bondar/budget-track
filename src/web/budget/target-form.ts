import type { z } from 'zod';
import type { CategoryKind } from '../../shared/api/categories';
import { setTargetRequestSchema, type TargetDto } from '../../shared/api/targets';
import { amountToExpression } from '../lib/amount-expression';
import { type FormErrors, zodFormErrors } from '../lib/form-errors';
import { formatDate, formatMoney, formatMonth, parseDate } from '../lib/format';
import { readAmount } from '../ui/amount-field';

/** The body of PUT /api/categories/:id/target, before the server fills in its defaults. */
export type SetTargetInput = z.input<typeof setTargetRequestSchema>;

export type TargetFormKind = 'spending' | 'balance' | 'debt';
export type SpendingCadence = 'weekly' | 'monthly' | 'yearly' | 'custom';
export type CustomRepeat = 'none' | 'month' | 'year';

/** What the target form edits: text as typed, so a half-typed amount or date stays as it is. */
export interface TargetForm {
  kind: TargetFormKind;
  cadence: SpendingCadence;
  /** An amount or keypad expression in złoty. */
  amount: string;
  mode: 'set_aside' | 'refill';
  /** '0' (Sunday) … '6'. */
  dueWeekday: string;
  /** '1' … '31', or '' for the last day of the month. */
  dueDayOfMonth: string;
  /** dd.mm.yyyy; optional ('') only for balance targets. */
  dueDate: string;
  repeat: CustomRepeat;
  repeatEvery: string;
  debtMode: 'min_payment' | 'fixed' | 'payoff_by_date';
  /** 'YYYY-MM'. */
  startMonth: string;
}

/** The fields every form field's errors are keyed by (the request's dotted paths, plus `repeat`). */
export const TARGET_FIELDS = [
  'kind',
  'cadence',
  'amount',
  'mode',
  'dueWeekday',
  'dueDayOfMonth',
  'dueDate',
  'repeatUnit',
  'repeatEvery',
  'debtMode',
  'startMonth',
] as const;

/** Spec §6: debt targets are for credit card payment and loan-paired categories only. */
export function takesDebtTargets(kind: CategoryKind): boolean {
  return kind === 'cc_payment' || kind === 'debt_payment';
}

/** The form for a category's target, or for a new one starting in `month` (a debt target for payment categories). */
export function targetForm(target: TargetDto | null, categoryKind: CategoryKind, month: string): TargetForm {
  return {
    kind: target?.kind ?? (takesDebtTargets(categoryKind) ? 'debt' : 'spending'),
    cadence: target?.kind === 'spending' ? (target.cadence as SpendingCadence) : 'monthly',
    amount: target && target.amount > 0 ? amountToExpression(target.amount) : '',
    mode: target?.mode ?? 'set_aside',
    dueWeekday: String(target?.dueWeekday ?? 1),
    dueDayOfMonth: target?.dueDayOfMonth ? String(target.dueDayOfMonth) : '',
    dueDate: target?.dueDate ? formatDate(target.dueDate) : '',
    repeat: target?.repeatUnit ?? 'none',
    repeatEvery: String(target?.repeatEvery ?? 1),
    debtMode: target?.debtMode ?? 'min_payment',
    startMonth: target?.startMonth ?? month,
  };
}

const DATE_FORMAT = 'Use the format dd.mm.yyyy.';

/**
 * The request for a filled-in form, or what is wrong with it (amounts and dates first, then the shared schema).
 * `startMonth` is sent for a new target, and for an existing one only when it changed (the server keeps it otherwise).
 */
export function targetRequestOf(
  form: TargetForm,
  existingStartMonth: string | null,
): { ok: true; request: SetTargetInput } | { ok: false; errors: FormErrors } {
  const fields: Record<string, string> = {};
  const amount = () => {
    const result = readAmount(form.amount);
    if (!result.ok) fields.amount = result.error;
    return result.ok ? result.value : 0;
  };
  const date = (): string => {
    const iso = parseDate(form.dueDate);
    if (iso === null) fields.dueDate = form.dueDate.trim() === '' ? 'Enter a date.' : DATE_FORMAT;
    return iso ?? '';
  };
  const startMonth = form.startMonth === existingStartMonth ? {} : { startMonth: form.startMonth };

  let request: SetTargetInput;
  if (form.kind === 'balance') {
    request = { kind: 'balance', amount: amount(), dueDate: form.dueDate.trim() === '' ? null : date(), ...startMonth };
  } else if (form.kind === 'debt') {
    if (form.debtMode === 'fixed') request = { kind: 'debt', debtMode: 'fixed', amount: amount(), ...startMonth };
    else if (form.debtMode === 'payoff_by_date') request = { kind: 'debt', debtMode: 'payoff_by_date', dueDate: date(), ...startMonth };
    else request = { kind: 'debt', debtMode: 'min_payment', ...startMonth };
  } else {
    const spending = { kind: 'spending', amount: amount(), mode: form.mode, ...startMonth } as const;
    if (form.cadence === 'weekly') request = { ...spending, cadence: 'weekly', dueWeekday: Number(form.dueWeekday) };
    else if (form.cadence === 'monthly') {
      request = { ...spending, cadence: 'monthly', dueDayOfMonth: form.dueDayOfMonth === '' ? null : Number(form.dueDayOfMonth) };
    } else if (form.cadence === 'yearly') request = { ...spending, cadence: 'yearly', dueDate: date() };
    else {
      const every = /^\d+$/.test(form.repeatEvery.trim()) ? Number(form.repeatEvery) : Number.NaN;
      request = {
        ...spending,
        cadence: 'custom',
        dueDate: date(),
        repeatUnit: form.repeat === 'none' ? null : form.repeat,
        repeatEvery: form.repeat === 'none' ? null : every,
      };
    }
  }

  const parsed = setTargetRequestSchema.safeParse(request);
  if (Object.keys(fields).length > 0 || !parsed.success) {
    const schema = parsed.success ? { fields: {}, form: null } : zodFormErrors(parsed.error, TARGET_FIELDS);
    return { ok: false, errors: { fields: { ...schema.fields, ...fields }, form: schema.form } };
  }
  return { ok: true, request };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Monday first, as Polish calendars are; values are the API's 0 (Sunday) … 6. */
export const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ value: String(day), label: WEEKDAYS[day]! }));

const ordinal = (day: number) => {
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix}`;
};

/** A target in one sentence, e.g. "250,00 zł every month by the 15th (set aside)". */
export function describeTarget(target: TargetDto): string {
  const money = formatMoney(target.amount);
  const due = target.dueDate && formatDate(target.dueDate);
  const starts = `, from ${formatMonth(target.startMonth)}`;
  if (target.kind === 'balance') return `Have ${money}${due ? ` by ${due}` : ''}${starts}`;
  if (target.kind === 'debt') {
    if (target.debtMode === 'fixed') return `Pay ${money} each month${starts}`;
    if (target.debtMode === 'payoff_by_date') return `Pay off the debt by ${due}${starts}`;
    return `Pay the minimum payment each month${starts}`;
  }
  const mode = target.mode === 'refill' ? 'refill' : 'set aside';
  let when: string;
  if (target.cadence === 'weekly') when = `every ${WEEKDAYS[target.dueWeekday ?? 0]}`;
  else if (target.cadence === 'monthly') {
    when = `every month by the ${target.dueDayOfMonth === null ? 'last day' : ordinal(target.dueDayOfMonth)}`;
  } else if (target.cadence === 'yearly') when = `every year by ${due}`;
  else if (target.repeatUnit && target.repeatEvery) {
    const unit = target.repeatUnit === 'month' ? 'month' : 'year';
    when = `by ${due}, then every ${target.repeatEvery === 1 ? unit : `${target.repeatEvery} ${unit}s`}`;
  } else when = `by ${due}`;
  return `${money} ${when} (${mode})${starts}`;
}
