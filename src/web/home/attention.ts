import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { accountsQuery } from '../accounts/accounts-api';
import { budgetMonthQuery } from '../budget/budget-api';
import { filterCounts } from '../budget/filters';
import { thisMonth } from '../lib/format';

/**
 * What needs the owner's attention this month: transactions to review (unapproved bank imports), overspent and
 * underfunded categories (the Plan's filters). Home lists them; the Home tab's badge counts the first two.
 */
export function useAttention() {
  const [month] = useState(thisMonth);
  const accounts = useQuery(accountsQuery);
  const budget = useQuery(budgetMonthQuery(month));
  const counts = budget.data ? filterCounts(budget.data) : null;
  return {
    month,
    accounts,
    budget,
    review: accounts.data?.accounts.reduce((sum, account) => sum + account.unapprovedCount, 0) ?? 0,
    overspent: counts?.overspent ?? 0,
    underfunded: counts?.underfunded ?? 0,
  };
}
