import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { account, balances } from '../test/ledger-fixtures';
import { renderApp, SIGNED_IN } from '../test/render';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 21, 12));
});
afterEach(() => vi.useRealTimers());

async function openWizard(routes: Parameters<typeof fakeApi>[0]) {
  const server = fakeApi({ ...SIGNED_IN, 'GET /api/accounts': { body: { accounts: [] } }, ...routes });
  const app = renderApp('/accounts');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add account' }));
  return { ...server, ...app, user, sheet: screen.getByRole('dialog', { name: 'Add account' }) };
}

const posts = (requests: { method: string; body: unknown }[]) => requests.filter((r) => r.method === 'POST').map((r) => r.body);

describe('add-account wizard', () => {
  it('adds a checking account and opens its register', async () => {
    const created = account({ name: 'Main', balance: balances(123_456) });
    const { user, sheet, requests, history } = await openWizard({ 'POST /api/accounts': json(created, 201) });
    await user.click(within(sheet).getByRole('button', { name: 'Checking' }));
    expect(within(sheet).getByText('Step 2 of 4 · Checking')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Continue' }));
    expect(within(sheet).getByLabelText('Account name')).toHaveAccessibleDescription('Enter a name.');
    await user.type(within(sheet).getByLabelText('Account name'), 'Main');
    await user.click(within(sheet).getByRole('button', { name: 'Continue' }));
    expect(within(sheet).getByLabelText('Currency')).toHaveValue('PLN');
    await user.click(within(sheet).getByRole('button', { name: 'Continue' }));
    await user.type(within(sheet).getByLabelText('Balance'), '1234,56');
    expect(within(sheet).getByLabelText('Date')).toHaveValue('21.11.2026');
    expect(within(sheet).queryByLabelText(/Exchange rate/)).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(history.location.pathname).toBe(`/accounts/${created.id}`));
    expect(posts(requests)).toEqual([
      { name: 'Main', type: 'checking', currency: 'PLN', startingBalance: 123_456, startingDate: '2026-11-21' },
    ]);
  });

  it('suggests the NBP rate for a foreign card, and goes back to the step of a refused field', async () => {
    let calls = 0;
    const refused = { code: 'fx_rate_required', message: 'Enter the exchange rate of EUR to PLN.', fieldErrors: { fxRate: ['Enter the exchange rate of EUR to PLN.'] } };
    const { user, sheet, requests } = await openWizard({
      'GET /api/fx/rates/EUR/2026-11-21': { body: { rate: '4.312300', effectiveDate: '2026-11-20' } },
      'POST /api/accounts': () => (++calls === 1 ? json(refused, 422) : json(account({ name: 'Revolut' }), 201)),
    });
    expect(within(sheet).queryByRole('button', { name: 'Mortgage' })).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: 'Credit card' }));
    await user.type(within(sheet).getByLabelText('Account name'), 'Revolut');
    await user.click(within(sheet).getByRole('button', { name: 'Continue' }));
    await user.click(within(sheet).getByRole('button', { name: 'EUR' }));
    await user.click(within(sheet).getByRole('button', { name: 'Continue' }));
    await user.type(within(sheet).getByLabelText('Amount owed'), '200');
    const rate = within(sheet).getByLabelText('Exchange rate (PLN per EUR)');
    await waitFor(() =>
      expect(rate).toHaveAccessibleDescription('Leave it empty for the NBP rate of 20.11.2026: 4,3123.'),
    );
    await user.click(within(sheet).getByRole('button', { name: 'Add account' }));
    expect(await within(sheet).findByLabelText('Exchange rate (PLN per EUR)')).toHaveAccessibleDescription(
      'Enter the exchange rate of EUR to PLN.',
    );
    await user.type(within(sheet).getByLabelText('Exchange rate (PLN per EUR)'), '4,30');
    await user.click(within(sheet).getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(requests)[1]).toEqual({
      name: 'Revolut',
      type: 'credit_card',
      currency: 'EUR',
      startingBalance: -20_000,
      startingDate: '2026-11-21',
      fxRate: '4.30',
    });
  });
});
