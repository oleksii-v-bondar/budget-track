import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BudgetMonthDto } from '../../shared/api/budget';
import { category, categoryGroups, RTA } from '../test/ledger-fixtures';
import { CategoryPicker } from './category-picker';

const groceries = category({ name: 'Groceries' });
const rent = category({ name: 'Rent' });
const gifts = category({ name: 'Gifts', hidden: true });
const visa = category({ name: 'Visa', kind: 'cc_payment' });
const mortgage = category({ name: 'Mortgage', kind: 'debt_payment' });
const { groups } = categoryGroups([
  { name: 'Everyday', categories: [groceries, rent, gifts] },
  { name: 'Credit Card Payments', kind: 'cc_payments', categories: [visa] },
  { name: 'Debt Payments', kind: 'debt_payments', categories: [mortgage] },
]);

const budgetCategory = (id: string, available: number, pill: 'green' | 'red' | 'yellow' | 'grey') => ({
  id,
  name: '',
  kind: 'normal' as const,
  hidden: false,
  note: null,
  linkedAccountId: null,
  carry: 0,
  assigned: 0,
  activity: 0,
  available,
  cashOverspent: 0,
  creditOverspent: 0,
  pill,
  target: null,
  targetEvaluation: null,
  needToPayInFull: null,
  loan: null,
});

const texts = (elements: HTMLElement[]) => elements.map((element) => element.textContent!.replace(/\s/g, ' '));

const month = {
  month: '2026-11',
  rta: { readyToAssign: 50_000 },
  groups: [
    { id: 'g', name: 'Everyday', kind: 'normal', hidden: false, categories: [budgetCategory(groceries.id, 12_000, 'green'), budgetCategory(rent.id, -500, 'red')] },
  ],
} as unknown as BudgetMonthDto;

function pick(props: Partial<Parameters<typeof CategoryPicker>[0]> = {}) {
  const onPick = vi.fn();
  render(<CategoryPicker groups={groups} month={month} value={null} allowNone={false} onPick={onPick} onCancel={vi.fn()} {...props} />);
  return { onPick, list: screen.getByRole('listbox', { name: 'Categories' }) };
}

describe('CategoryPicker', () => {
  it('offers Ready to Assign, the regular and loan categories with their Available; never card payments or Uncategorized', () => {
    const { list } = pick();
    const options = within(list).getAllByRole('option');
    expect(texts(options)).toEqual([
      'Inflow: Ready to Assign500,00 zł',
      'Groceries120,00 zł',
      'Rent-5,00 zł',
      'Mortgage',
      'Gifts',
    ]);
    expect(within(options[1]!).getByText('120,00 zł')).toHaveAttribute('data-tone', 'green');
    expect(within(options[2]!).getByText('-5,00 zł')).toHaveAttribute('data-tone', 'red');
    expect(within(list).getByRole('group', { name: 'Hidden categories' })).toHaveTextContent('Gifts');
    expect(within(list).queryByText('Visa')).toBeNull();
    expect(within(list).queryByText('Uncategorized')).toBeNull();
    expect(within(list).queryByText('Ready to Assign')).toBeNull();
  });

  it('picks by tap or keyboard, searches, and can clear the category', async () => {
    const { onPick, list } = pick({ value: groceries.id, allowNone: true });
    expect(within(list).getByRole('option', { name: /Groceries/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(within(list).getByRole('option', { name: 'No category' }));
    expect(onPick).toHaveBeenLastCalledWith(null);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search categories' }), 'ren');
    expect(texts(within(list).getAllByRole('option'))).toEqual(['Rent-5,00 zł']);
    within(list).getByRole('option').focus();
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenLastCalledWith(rent.id);
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search categories' }));
    await userEvent.click(within(list).getByRole('option', { name: /Ready to Assign/ }));
    expect(onPick).toHaveBeenLastCalledWith(RTA.id);
  });

  it('shows no amounts without the month', () => {
    const { list } = pick({ month: undefined });
    expect(within(list).getByRole('option', { name: 'Groceries' })).toBeInTheDocument();
  });
});
