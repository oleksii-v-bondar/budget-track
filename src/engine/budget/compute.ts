import { monthRange } from '../dates';
import type { Money, Month } from '../types';
import { splitOverspending } from './overspending';
import type { BudgetInput, BudgetResult, CategoryMonth, MonthBudget } from './types';

const key = (month: Month, id: string) => `${month}|${id}`;

function addTo(map: Map<string, Money>, k: string, amount: Money): void {
  map.set(k, (map.get(k) ?? 0) + amount);
}

/** "Need X to pay in full": card debt not covered by its payment category's Available. */
export function cardPaymentShortfall(cardBalance: Money, paymentAvailable: Money): Money {
  return Math.max(0, -cardBalance - paymentAvailable);
}

/** Computes every budget month from the (widened) start month through the (widened) end month. */
export function computeBudget(input: BudgetInput): BudgetResult {
  const { rtaCategoryId } = input;
  const known = new Map(input.categories.map((c) => [c.id, c]));
  if (known.has(rtaCategoryId)) throw new Error('The RTA category must not be listed in categories');
  const regular = input.categories.filter((c) => c.kind !== 'cc_payment');
  const payment = input.categories.filter((c) => c.kind === 'cc_payment');
  const cardIds = new Set<string>();
  for (const p of payment) {
    if (!p.linkedAccountId) throw new Error(`Credit card payment category ${p.id} has no linkedAccountId`);
    cardIds.add(p.linkedAccountId);
  }

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
    const cat = known.get(row.categoryId);
    if (!cat) throw new Error(`Activity in unknown category ${row.categoryId}`);
    if (cat.kind === 'cc_payment') {
      throw new Error(`Transactions cannot be categorized to credit card payment category ${row.categoryId}`);
    }
    const k = key(row.month, row.categoryId);
    if (row.accountClass === 'cash') {
      addTo(cashLines, k, row.amount);
    } else {
      if (!cardIds.has(row.accountId)) throw new Error(`Credit account ${row.accountId} has no payment category`);
      let byCard = cardLines.get(k);
      if (!byCard) cardLines.set(k, (byCard = new Map()));
      addTo(byCard, row.accountId, row.amount);
    }
  }

  const cardTransfers = new Map<string, Money>();
  for (const t of input.cardTransfers ?? []) {
    if (!cardIds.has(t.cardAccountId)) throw new Error(`Credit account ${t.cardAccountId} has no payment category`);
    widen(t.month);
    addTo(cardTransfers, key(t.month, t.cardAccountId), t.amount);
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
    const fundedFlow = new Map<string, Money>();
    let cashOverspentTotal = 0;

    for (const c of regular) {
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
        // Funded spending (or a refund, when negative) moves into the card's payment category.
        addTo(fundedFlow, card, -(byCard.get(card) ?? 0) - over);
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

    for (const p of payment) {
      const card = p.linkedAccountId as string;
      const k = key(month, p.id);
      const activity = (fundedFlow.get(card) ?? 0) - (cardTransfers.get(key(month, card)) ?? 0);
      const carry = Math.max(0, prev?.categories[p.id]?.available ?? 0);
      const asg = assigned.get(k) ?? 0;
      const available = carry + asg + activity;
      const cashOverspent = Math.max(0, -available);
      cashOverspentTotal += cashOverspent;
      categories[p.id] = {
        categoryId: p.id,
        carry,
        assigned: asg,
        activity,
        available,
        cashOverspent,
        creditOverspent: 0,
        creditOverByCard: {},
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
