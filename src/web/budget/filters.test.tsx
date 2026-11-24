import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BudgetMonthDto } from '../../shared/api/budget';
import {
  budgetCategory,
  budgetGroup,
  budgetMonth,
  evaluation,
  monthlyTarget,
  sampleBudget,
} from '../test/budget-fixtures';
import { fakeApi } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';
import { filterBudget, filterCounts } from './filters';

const target = monthlyTarget('x', 10000);
const view = budgetMonth({
  groups: [
    budgetGroup({
      id: 'g-bills',
      name: 'Bills',
      categories: [
        budgetCategory({
          id: 'rent',
          name: 'Rent',
          available: 250000,
          target,
          targetEvaluation: evaluation(200000, 0, { overfunded: true }),
        }),
        budgetCategory({
          id: 'power',
          name: 'Electricity',
          available: 10000,
          target,
          targetEvaluation: evaluation(25000, 15000),
        }),
      ],
    }),
    budgetGroup({
      id: 'g-everyday',
      name: 'Everyday',
      categories: [
        budgetCategory({
          id: 'gym',
          name: 'Gym',
          target,
          targetEvaluation: evaluation(10000, 0, { snoozed: true, progress: 0 }),
        }),
        budgetCategory({
          id: 'gifts',
          name: 'Gifts',
          hidden: true,
          available: 5000,
          target,
          targetEvaluation: evaluation(9000, 4000),
        }),
      ],
    }),
    budgetGroup({ id: 'g-empty', name: 'Empty' }),
  ],
  uncategorized: budgetCategory({
    id: 'u',
    name: 'Uncategorized',
    kind: 'uncategorized',
    activity: 700,
    available: 700,
  }),
});

const shown = (budget: BudgetMonthDto, filter: Parameters<typeof filterBudget>[1]) => {
  const { uncategorized, groups, hidden } = filterBudget(budget, filter);
  return {
    uncategorized: uncategorized?.name ?? null,
    groups: groups.map((g) => [g.name, g.categories.map((c) => c.name)]),
    hidden: hidden.map((h) => h.category.name),
  };
};

describe('filterBudget', () => {
  it('lists everything visible under All, empty groups and the hidden section included', () => {
    expect(shown(view, 'all')).toEqual({
      uncategorized: 'Uncategorized',
      groups: [
        ['Bills', ['Rent', 'Electricity']],
        ['Everyday', ['Gym']],
        ['Empty', []],
      ],
      hidden: ['Gifts'],
    });
  });

  it('lists only matching visible categories, in the groups that have one, under the other filters', () => {
    expect(shown(view, 'underfunded')).toEqual({
      uncategorized: null,
      groups: [['Bills', ['Electricity']]],
      hidden: [],
    });
    expect(shown(view, 'overfunded')).toEqual({ uncategorized: null, groups: [['Bills', ['Rent']]], hidden: [] });
    expect(shown(view, 'available')).toEqual({
      uncategorized: 'Uncategorized',
      groups: [['Bills', ['Rent', 'Electricity']]],
      hidden: [],
    });
    expect(shown(view, 'snoozed')).toEqual({ uncategorized: null, groups: [['Everyday', ['Gym']]], hidden: [] });
  });

  it('lists categories with less than nothing available under Overspent', () => {
    const { uncategorized, groups } = filterBudget(sampleBudget(), 'overspent');
    expect([uncategorized?.name, groups.map((g) => [g.name, g.categories.map((c) => c.name)])]).toEqual([
      'Uncategorized',
      [['Everyday', ['Groceries', 'Eating out']]],
    ]);
  });

  it('counts what each chip shows', () => {
    expect(filterCounts(view)).toEqual({
      all: 4,
      overspent: 0,
      underfunded: 1,
      overfunded: 1,
      available: 3,
      snoozed: 1,
    });
  });
});

describe('the filter menu', () => {
  it('filters the budget from a sheet and says when nothing matches', async () => {
    fakeApi({ ...SIGNED_IN, 'GET /api/budget/:month': { body: sampleBudget() } });
    renderApp('/budget?month=2026-11');
    const openMenu = async () => {
      await userEvent.click(await screen.findByRole('button', { name: 'Filter categories' }));
      return within(screen.getByRole('dialog', { name: 'Show' })).getByRole('group', { name: 'Show' });
    };
    let menu = await openMenu();
    expect(
      within(menu)
        .getAllByRole('button')
        .map((option) => option.textContent),
    ).toEqual(['All', 'Overspent3', 'Underfunded1', 'Overfunded0', 'Money available3', 'Snoozed0']);
    expect(within(menu).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(within(menu).getByRole('button', { name: /^Underfunded/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual(['Bills']);
    expect(screen.getByTestId('category-c-power')).toBeInTheDocument();
    expect(screen.queryByTestId('category-c-rent')).toBeNull();

    menu = await openMenu();
    expect(within(menu).getByRole('button', { name: /^Underfunded/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(menu).getByRole('button', { name: /^Snoozed/ }));
    expect(screen.getByText('No target is snoozed this month.')).toBeInTheDocument();
    expect(screen.queryAllByRole('region')).toEqual([]);

    await userEvent.click(within(await openMenu()).getByRole('button', { name: 'All' }));
    expect(screen.getByRole('button', { name: 'Hidden categories (2)' })).toBeInTheDocument();
  });
});
