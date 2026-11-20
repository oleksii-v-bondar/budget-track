import { monthRange } from '../dates';
import type { Money, Month } from '../types';
import { splitOverspending } from './overspending';
import type { BudgetInput, BudgetResult, CategoryMonth, MonthBudget } from './types';

const key = (month: Month, id: string) => `${month}|${id}`;

function addTo(map: Map<string, Money>, k: string, amount: Money): void {
  map.set(k, (map.get(k) ?? 0) + amount);
}

/** Computes every budget month from the (widened) start month through the (widened) end month. */
export function computeBudget(input: BudgetInput): BudgetResult {
  const { rtaCategoryId } = input;
  const known = new Map(input.categories.map((c) => [c.id, c]));
  if (known.has(rtaCategoryId)) throw new Error('The RTA category must not be listed in categories');

  let first = input.startMonth;
  let last = input.throughMonth;
  const widen = (m: Month) => {
    if (m < first) first = m;
    if (m > last) last = m;
  };

  const assigned = new Map<string, Money>();
  const assignedTotal = new Map<Month, Money>();
  for (const a of input.assignments) {
    if (!known.has(a.categoryId)) throw new Error(`Assignment to unknown category ${a.categoryId}`);
    widen(a.month);
    addTo(assigned, key(a.month, a.categoryId), a.amount);
    addTo(assignedTotal, a.month, a.amount);
  }

  const income = new Map<Month, Money>();
  const cashLines = new Map<string, Money>();
  const cardLines = new Map<string, Map<string, Money>>();
  for (const row of input.activity) {
    widen(row.month);
    if (row.categoryId === rtaCategoryId) {
      addTo(income, row.month, row.amount);
      continue;
    }
    if (!known.has(row.categoryId)) throw new Error(`Activity in unknown category ${row.categoryId}`);
    const k = key(row.month, row.categoryId);
    if (row.accountClass === 'cash') {
      addTo(cashLines, k, row.amount);
    } else {
      let byCard = cardLines.get(k);
      if (!byCard) cardLines.set(k, (byCard = new Map()));
      addTo(byCard, row.accountId, row.amount);
    }
  }

  const months = monthRange(first, last);
  const assignedAfter = new Map<Month, Money>();
  let running = 0;
  for (const m of [...months].reverse()) {
    assignedAfter.set(m, running);
    running += assignedTotal.get(m) ?? 0;
  }

  const byMonth: Record<Month, MonthBudget> = {};
  let prev: MonthBudget | undefined;
  for (const month of months) {
    const categories: Record<string, CategoryMonth> = {};
    let cashOverspentTotal = 0;

    for (const c of input.categories) {
      const k = key(month, c.id);
      const byCard = cardLines.get(k) ?? new Map<string, Money>();
      const cards = [...byCard.keys()];
      let activity = cashLines.get(k) ?? 0;
      for (const amount of byCard.values()) activity += amount;
      const carry = Math.max(0, prev?.categories[c.id]?.available ?? 0);
      const asg = assigned.get(k) ?? 0;
      const available = carry + asg + activity;
      const split = splitOverspending(
        Math.max(0, -available),
        cards.map((card) => Math.max(0, -(byCard.get(card) ?? 0))),
      );
      const creditOverByCard: Record<string, Money> = {};
      cards.forEach((card, i) => {
        const over = split.creditOverByCard[i] ?? 0;
        if (over > 0) creditOverByCard[card] = over;
      });
      cashOverspentTotal += split.cashOver;
      categories[c.id] = {
        categoryId: c.id,
        carry,
        assigned: asg,
        activity,
        available,
        cashOverspent: split.cashOver,
        creditOverspent: split.creditOver,
        creditOverByCard,
      };
    }

    const leftoverPrev = prev?.rta.leftover ?? 0;
    const cashOverspentPrev = prev?.cashOverspentTotal ?? 0;
    const monthIncome = income.get(month) ?? 0;
    const assignedThisMonth = assignedTotal.get(month) ?? 0;
    const assignedFuture = assignedAfter.get(month) ?? 0;
    const leftover = leftoverPrev + monthIncome - assignedThisMonth - cashOverspentPrev;
    const budget: MonthBudget = {
      month,
      cashOverspentTotal,
      categories,
      rta: {
        leftoverPrev,
        income: monthIncome,
        assignedThisMonth,
        assignedFuture,
        cashOverspentPrev,
        leftover,
        readyToAssign: leftover - assignedFuture,
      },
    };
    byMonth[month] = budget;
    prev = budget;
  }

  return { months, byMonth };
}
