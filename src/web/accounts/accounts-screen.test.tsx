import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi } from '../test/fake-api';
import { account, balances } from '../test/ledger-fixtures';
import { renderApp, SIGNED_IN } from '../test/render';

const checking = account({ name: 'Checking', balance: balances(123_456) });
const euro = account({
  name: 'Euro savings',
  type: 'savings',
  currency: 'EUR',
  balance: balances(10_000),
  balanceBase: balances(42_000),
  latestRate: { rate: '4.300000', effectiveDate: '2026-11-20' },
  balanceAtLatestRate: 43_000,
});
const card = account({ name: 'Visa', type: 'credit_card', balance: balances(-5_000), unapprovedCount: 2 });
const old = account({ name: 'Old savings', type: 'savings', closed: true });

async function openAccounts(accounts = [checking, euro, card, old]) {
  fakeApi({ ...SIGNED_IN, 'GET /api/accounts': { body: { accounts } } });
  const app = renderApp('/accounts');
  await screen.findByRole('heading', { name: 'Accounts' });
  return { ...app, user: userEvent.setup() };
}

describe('accounts screen', () => {
  it('groups the open accounts with their PLN totals; foreign ones show ≈ PLN', async () => {
    await openAccounts();
    const cash = await screen.findByRole('list', { name: 'Cash accounts' });
    const [first, second, ...rest] = within(cash).getAllByRole('link');
    expect(first).toHaveTextContent('CheckingChecking1 234,56 zł');
    expect(second).toHaveTextContent('Euro savingsSavings100,00 EUR≈ 430,00 zł');
    expect(rest).toEqual([]);
    expect(screen.getByTestId('total-cash')).toHaveTextContent('1 654,56 zł');
    expect(screen.getByTestId('total-credit')).toHaveTextContent('-50,00 zł');
    expect(screen.getByRole('link', { name: /Visa/ })).toHaveTextContent('VisaCredit card · 2 to approve');
    expect(screen.getByRole('link', { name: /All accounts/ })).toHaveTextContent('1 604,56 zł');
  });

  it('keeps closed accounts in a collapsed section', async () => {
    const { user } = await openAccounts();
    const toggle = await screen.findByRole('button', { name: 'Closed accounts (1)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Old savings')).toBeNull();
    await user.click(toggle);
    expect(within(screen.getByRole('list', { name: 'Closed accounts' })).getByText('Old savings')).toBeInTheDocument();
  });

  it("opens an account's register", async () => {
    const { user, history } = await openAccounts();
    await user.click(await screen.findByRole('link', { name: /Visa/ }));
    await waitFor(() => expect(history.location.pathname).toBe(`/accounts/${card.id}`));
  });

  it('invites to add the first account', async () => {
    await openAccounts([]);
    expect(await screen.findByText('Add your first account to start budgeting.')).toBeInTheDocument();
  });
});
