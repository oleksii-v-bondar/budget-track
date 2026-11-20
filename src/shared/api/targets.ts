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
