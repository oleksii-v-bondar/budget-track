import { z } from 'zod';
import { isoDateSchema, monthSchema, nonNegativeMoneySchema } from './common';

/** Spec §4.3 and §6: a category's target. */
export type TargetKind = 'spending' | 'balance' | 'debt';
export type TargetCadence = 'weekly' | 'monthly' | 'yearly' | 'custom' | 'none';
export type SpendingMode = 'set_aside' | 'refill';
export type DebtMode = 'min_payment' | 'fixed' | 'payoff_by_date';
export type RepeatUnit = 'month' | 'year';

/** A category's target; months are 'YYYY-MM', dates 'YYYY-MM-DD'. */
export interface TargetDto {
  categoryId: string;
  kind: TargetKind;
  /** Balance targets use `none`; debt targets `monthly`. */
  cadence: TargetCadence;
  /** Minor units, ≥ 0 (0 for minimum-payment and pay-off-by-date debt targets). */
  amount: number;
  /** Spending targets only. */
  mode: SpendingMode | null;
  /** Weekly targets: 0 = Sunday … 6 = Saturday. */
  dueWeekday: number | null;
  /** Monthly targets: the due day shown to the user; null = the last day of the month. */
  dueDayOfMonth: number | null;
  /** Yearly and custom spending targets, balance targets with a date, pay-off-by-date debt targets. */
  dueDate: string | null;
  /** Custom targets that repeat every `repeatEvery` months or years. */
  repeatUnit: RepeatUnit | null;
  repeatEvery: number | null;
  /** The first month the target applies to (and where the first set-aside cycle starts). */
  startMonth: string;
  debtMode: DebtMode | null;
  /** The month the target is snoozed in, if any. */
  snoozedMonth: string | null;
}

/** How a category's target stands in one month (spec §6). */
export interface TargetEvaluationDto {
  need: number;
  /** 0 while snoozed. */
  underfunded: number;
  /** 0..1; reflects the real funding even while snoozed. */
  progress: number;
  /** Assigned more than the need. */
  overfunded: boolean;
  snoozed: boolean;
  /**
   * A debt target whose account lacks a field it needs: the minimum payment (`min_payment`) or the APR
   * (`payoff_by_date`). The missing value counts as 0 until the user enters it on the account.
   */
  incomplete: boolean;
}

const intBetween = (min: number, max: number, message: string) => z.int(message).min(min, message).max(max, message);

/** Defaults to the replaced target's start month, or the current month for a new target. */
const startMonth = monthSchema.optional();

const spendingFields = {
  kind: z.literal('spending'),
  amount: nonNegativeMoneySchema,
  mode: z.enum(['set_aside', 'refill']).default('set_aside'),
  startMonth,
};

const spendingTargetSchema = z.discriminatedUnion('cadence', [
  z.object({
    ...spendingFields,
    cadence: z.literal('weekly'),
    dueWeekday: intBetween(0, 6, 'Pick a weekday.'),
  }),
  z.object({
    ...spendingFields,
    cadence: z.literal('monthly'),
    /** Null (the default) is the last day of the month. */
    dueDayOfMonth: intBetween(1, 31, 'Pick a day from 1 to 31.').nullable().default(null),
  }),
  z.object({ ...spendingFields, cadence: z.literal('yearly'), dueDate: isoDateSchema }),
  z
    .object({
      ...spendingFields,
      cadence: z.literal('custom'),
      dueDate: isoDateSchema,
      /** Null (the default) for a one-off target due on `dueDate`. */
      repeatUnit: z.enum(['month', 'year']).nullable().default(null),
      repeatEvery: intBetween(1, 120, 'Enter a whole number from 1 to 120.').nullable().default(null),
    })
    .refine((t) => (t.repeatUnit === null) === (t.repeatEvery === null), {
      path: ['repeatEvery'],
      message: 'Set how often it repeats together with the unit, or neither.',
    }),
]);

const balanceTargetSchema = z.object({
  kind: z.literal('balance'),
  amount: nonNegativeMoneySchema,
  /** "Have X by D"; null (the default) for "have X" with no date. */
  dueDate: isoDateSchema.nullable().default(null),
  startMonth,
});

/** Debt targets: credit card payment and paired loan categories only (spec §6). */
const debtTargetSchema = z.discriminatedUnion('debtMode', [
  z.object({ kind: z.literal('debt'), debtMode: z.literal('min_payment'), startMonth }),
  z.object({ kind: z.literal('debt'), debtMode: z.literal('fixed'), amount: nonNegativeMoneySchema, startMonth }),
  z.object({ kind: z.literal('debt'), debtMode: z.literal('payoff_by_date'), dueDate: isoDateSchema, startMonth }),
]);

/**
 * PUT /api/categories/:id/target: creates or replaces the category's target. Each kind and cadence (or debt mode)
 * takes only the fields it uses; a replaced target keeps its start month (unless given) and its snooze.
 */
export const setTargetRequestSchema = z.discriminatedUnion('kind', [
  spendingTargetSchema,
  balanceTargetSchema,
  debtTargetSchema,
]);

/** POST /api/categories/:id/target/snooze */
export const snoozeTargetRequestSchema = z.object({ month: monthSchema });

export type SetTargetRequest = z.infer<typeof setTargetRequestSchema>;
