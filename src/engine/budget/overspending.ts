import { allocate } from '../money';
import type { Money } from '../types';

export interface OverspendingSplit {
  cashOver: Money;
  creditOver: Money;
  /** Credit overspending per card, aligned with the `creditSpend` input. */
  creditOverByCard: Money[];
}

/**
 * Splits an overspent amount (≥ 0) into credit and cash parts (YNAB rule: available money covers cash spending
 * first, so overspending is attributed to card spending first). `creditSpend[i]` is the net spending (≥ 0) on card i.
 */
export function splitOverspending(overspent: Money, creditSpend: Money[]): OverspendingSplit {
  if (overspent < 0) throw new Error(`splitOverspending: overspent must be ≥ 0, got ${overspent}`);
  const totalCredit = creditSpend.reduce((s, x) => s + x, 0);
  const creditOver = Math.min(overspent, totalCredit);
  return {
    cashOver: overspent - creditOver,
    creditOver,
    creditOverByCard: allocate(creditOver, creditSpend),
  };
}
