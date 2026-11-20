import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addMonths, monthRange } from '../dates';
import { computeBudget } from './compute';
import type { ActivityRow, AssignmentRow, BudgetInput, CardTransferRow } from './types';

const START = '2026-01';
const MONTHS = monthRange(START, addMonths(START, 5));
const CASH_ACCOUNTS = ['checking', 'savings'] as const;
const CARDS = ['visa', 'amex'] as const;
const ACCOUNTS = [...CASH_ACCOUNTS, ...CARDS];
const SPENDING = ['groceries', 'rent', 'uncat'] as const;
const isCard = (a: string) => (CARDS as readonly string[]).includes(a);

const lineArb = fc.record({
  month: fc.integer({ min: 0, max: 5 }),
  account: fc.constantFrom(...ACCOUNTS),
  category: fc.constantFrom('rta', ...SPENDING),
  amount: fc.integer({ min: -50_000, max: 50_000 }),
});
const transferArb = fc.record({
  month: fc.integer({ min: 0, max: 5 }),
  from: fc.constantFrom(...ACCOUNTS),
  to: fc.constantFrom(...ACCOUNTS),
  amount: fc.integer({ min: 1, max: 50_000 }),
});
const assignmentArb = fc.record({
  month: fc.integer({ min: 0, max: 5 }),
  category: fc.constantFrom('groceries', 'rent', 'pay-visa', 'pay-amex'),
  amount: fc.integer({ min: -30_000, max: 30_000 }),
});
const ledgerArb = fc.record({
  lines: fc.array(lineArb, { maxLength: 40 }),
  transfers: fc.array(transferArb, { maxLength: 15 }),
  assignments: fc.array(assignmentArb, { maxLength: 20 }),
});

type Ledger = typeof ledgerArb extends fc.Arbitrary<infer T> ? T : never;

function toInput(ledger: Ledger): BudgetInput {
  const activity: ActivityRow[] = ledger.lines.map((l) => ({
    month: MONTHS[l.month]!,
    categoryId: l.category,
    accountId: l.account,
    accountClass: isCard(l.account) ? 'credit' : 'cash',
    amount: l.amount,
  }));
  const cardTransfers: CardTransferRow[] = [];
  for (const t of ledger.transfers) {
    if (t.from === t.to) continue;
    if (isCard(t.from)) cardTransfers.push({ month: MONTHS[t.month]!, cardAccountId: t.from, amount: -t.amount });
    if (isCard(t.to)) cardTransfers.push({ month: MONTHS[t.month]!, cardAccountId: t.to, amount: t.amount });
  }
  const assignments: AssignmentRow[] = ledger.assignments.map((a) => ({
    month: MONTHS[a.month]!,
    categoryId: a.category,
    amount: a.amount,
  }));
  return {
    startMonth: START,
    throughMonth: MONTHS[5]!,
    rtaCategoryId: 'rta',
    categories: [
      { id: 'groceries', kind: 'normal' },
      { id: 'rent', kind: 'normal' },
      { id: 'uncat', kind: 'uncategorized' },
      { id: 'pay-visa', kind: 'cc_payment', linkedAccountId: 'visa' },
      { id: 'pay-amex', kind: 'cc_payment', linkedAccountId: 'amex' },
    ],
    assignments,
    activity,
    cardTransfers,
  };
}

/** Σ balances of cash-class accounts at the end of month index `mi`. */
function cashBalance(ledger: Ledger, mi: number): number {
  let total = 0;
  for (const l of ledger.lines) if (l.month <= mi && !isCard(l.account)) total += l.amount;
  for (const t of ledger.transfers) {
    if (t.month > mi || t.from === t.to) continue;
    if (!isCard(t.from)) total -= t.amount;
    if (!isCard(t.to)) total += t.amount;
  }
  return total;
}

/** Σ RTA-categorized amounts on credit accounts through month index `mi` (K in spec §5.7). */
function cardIncome(ledger: Ledger, mi: number): number {
  return ledger.lines
    .filter((l) => l.month <= mi && isCard(l.account) && l.category === 'rta')
    .reduce((s, l) => s + l.amount, 0);
}

describe('budget invariants (spec §5.7)', () => {
  it('cash balances = Σ Available + leftover + credit overspending − card income', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const result = computeBudget(toInput(ledger));
        MONTHS.forEach((month, mi) => {
          const mb = result.byMonth[month]!;
          const cats = Object.values(mb.categories);
          const available = cats.reduce((s, c) => s + c.available, 0);
          const creditOver = cats.reduce((s, c) => s + c.creditOverspent, 0);
          expect(available + mb.rta.leftover + creditOver - cardIncome(ledger, mi)).toBe(cashBalance(ledger, mi));
        });
      }),
      { numRuns: 500 },
    );
  });

  it('never carries a negative balance', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const result = computeBudget(toInput(ledger));
        for (const month of result.months) {
          for (const c of Object.values(result.byMonth[month]!.categories)) expect(c.carry).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it('shows RTA as leftover minus everything assigned in later months', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const result = computeBudget(toInput(ledger));
        MONTHS.forEach((month, mi) => {
          const later = ledger.assignments.filter((a) => a.month > mi).reduce((s, a) => s + a.amount, 0);
          const rta = result.byMonth[month]!.rta;
          expect(rta.readyToAssign).toBe(rta.leftover - later);
        });
      }),
    );
  });

  it('splits overspending exactly into cash and credit parts', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const result = computeBudget(toInput(ledger));
        for (const month of result.months) {
          for (const c of Object.values(result.byMonth[month]!.categories)) {
            expect(c.cashOverspent + c.creditOverspent).toBe(Math.max(0, -c.available));
            const byCard = Object.values(c.creditOverByCard).reduce((s, x) => s + x, 0);
            expect(byCard).toBe(c.creditOverspent);
          }
        }
      }),
    );
  });
});
