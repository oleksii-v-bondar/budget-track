import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { addMonths } from '../../engine/dates';
import { thisMonth } from '../lib/format';
import { budgetCategory, budgetGroup, budgetMonth, monthOfPath, rtaBreakdown } from '../test/budget-fixtures';
import { fakeApi } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';

const now = thisMonth();
const before = addMonths(now, -1);

/** Two months of budget: last month spent 300 zł on rent, this month 120 zł on food; income 1 000 zł each. */
function month(m: string) {
  const activity = (id: string) => (m === now ? { food: -12000, rent: 0 } : { food: 0, rent: -30000 })[id]!;
  return budgetMonth({
    month: m,
    firstMonth: before,
    currentMonth: now,
    rta: rtaBreakdown(0, { income: 100000 }),
    groups: [
      budgetGroup({
        id: 'g',
        name: 'Everyday',
        categories: [
          budgetCategory({ id: 'food', name: '🛒 Food', activity: activity('food') }),
          budgetCategory({ id: 'rent', name: 'Rent', activity: activity('rent') }),
        ],
      }),
    ],
  });
}

describe('the Reflect screen', () => {
  it("breaks down a month's spending, steps back a month, and compares income with spending", async () => {
    const { requests } = fakeApi({
      ...SIGNED_IN,
      'GET /api/budget/:month': (request) => ({ body: month(monthOfPath(request.path)) }),
    });
    renderApp('/reflect');
    expect(await screen.findByRole('heading', { name: 'Reflect' })).toBeInTheDocument();
    expect(await screen.findByTestId('spent-total')).toHaveTextContent('120,00 zł');
    expect(screen.getByRole('list', { name: 'Top categories' })).toHaveTextContent('🛒 Food120,00 zł');
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(await screen.findByText('Rent')).toBeInTheDocument();
    expect(screen.getByTestId('spent-total')).toHaveTextContent('300,00 zł');
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();

    const chart = screen.getByRole('region', { name: 'Income vs. Spending' });
    expect(within(chart).getByText('On average, you’re making more than you spend.')).toBeInTheDocument();
    expect(within(chart).getAllByRole('img')).toHaveLength(6);
    expect(within(chart).getAllByRole('img').at(-1)).toHaveAccessibleName(/income 1\s000,00\szł, spending 120,00\szł$/);
    // Months before the budget's first month are never asked for.
    const asked = new Set(requests.filter((r) => r.path.startsWith('/api/budget/')).map((r) => monthOfPath(r.path)));
    expect([...asked].sort()).toEqual([before, now]);
  });
});
