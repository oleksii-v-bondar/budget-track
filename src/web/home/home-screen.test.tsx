import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { thisMonth } from '../lib/format';
import { budgetMonth, monthOfPath, rtaBreakdown, sampleBudget } from '../test/budget-fixtures';
import { fakeApi } from '../test/fake-api';
import { account, balances } from '../test/ledger-fixtures';
import { renderApp, SIGNED_IN } from '../test/render';

const checking = account({ name: 'Checking', balance: balances(250_000), unapprovedCount: 2 });
const card = account({ name: 'Visa', type: 'credit_card', balance: balances(-40_000) });

function openHome() {
  fakeApi({
    ...SIGNED_IN,
    'GET /api/accounts': { body: { accounts: [checking, card] } },
    // This month: Ready to Assign 100 zł, 3 overspent categories (Uncategorized included) and 1 underfunded.
    'GET /api/budget/:month': (request) => ({ body: sampleBudget({ month: monthOfPath(request.path) }) }),
  });
  const app = renderApp('/home');
  return { ...app, user: userEvent.setup() };
}

describe('the Home screen', () => {
  it('shows Ready to Assign, what needs attention, this month and the accounts', async () => {
    openHome();
    expect(await screen.findByTestId('home-rta')).toHaveTextContent('Ready to Assign100,00 zł');
    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(
      within(attention)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['22 transactions to review', '33 overspent categories', '11 underfunded category']);
    const main = within(screen.getByRole('main'));
    expect(main.getByRole('link', { name: /^This month/ })).toHaveTextContent('Spent so far635,00 złIncome5 000,00 zł');
    expect(main.getByRole('link', { name: /^Accounts/ })).toHaveTextContent(
      'Net worth2 100,00 złCash2 500,00 złCredit-400,00 zł',
    );
  });

  it('badges the Home tab with the transactions to review and the overspent categories', async () => {
    openHome();
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(await within(nav).findByTestId('home-badge')).toHaveTextContent('5');
    expect(within(nav).getByRole('link', { name: 'Home, 5 need attention' })).toBeInTheDocument();
  });

  it('links each item to where it is dealt with', async () => {
    const { user, history } = openHome();
    await user.click(await screen.findByRole('link', { name: /overspent categories/ }));
    expect(history.location.pathname).toBe('/budget');
    expect(history.location.search).toBe('?filter=overspent');
    expect(await screen.findByTestId('category-c-groceries')).toBeInTheDocument();
    expect(screen.queryByTestId('category-c-rent')).toBeNull();

    history.push('/home');
    await user.click(await screen.findByRole('link', { name: /transactions to review/ }));
    expect(history.location.pathname).toBe('/transactions');
    expect(history.location.search).toBe('?unapproved=true');
  });

  it('turns Ready to Assign red below zero', async () => {
    fakeApi({
      ...SIGNED_IN,
      'GET /api/accounts': { body: { accounts: [] } },
      'GET /api/budget/:month': { body: budgetMonth({ month: thisMonth(), rta: rtaBreakdown(-500) }) },
    });
    renderApp('/home');
    expect(await screen.findByTestId('home-rta')).toHaveClass('bg-red-500');
  });
});
