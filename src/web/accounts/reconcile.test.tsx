import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import { fakeApi } from '../test/fake-api';
import { account, balances, registerPage } from '../test/ledger-fixtures';
import { renderApp, SIGNED_IN } from '../test/render';

async function openRegister(owner: AccountDto, routes: Parameters<typeof fakeApi>[0] = {}) {
  const server = fakeApi({
    ...SIGNED_IN,
    'GET /api/accounts': { body: { accounts: [owner] } },
    'GET /api/transactions': { body: registerPage([], { owner }) },
    [`GET /api/accounts/${owner.id}/reconcile`]: {
      body: {
        accountId: owner.id,
        currency: owner.currency,
        clearedBalance: owner.balance.cleared,
        lastReconciledAt: '2026-10-31T18:00:00.000Z',
        lastReconciledBalance: 50_000,
      },
    },
    [`POST /api/accounts/${owner.id}/reconcile`]: { body: {} },
    [`POST /api/accounts/${owner.id}/revalue`]: { body: {} },
    ...routes,
  });
  const app = renderApp(`/accounts/${owner.id}`);
  return { ...server, ...app, user: userEvent.setup() };
}

const posts = (requests: { method: string; path: string; body: unknown }[]) =>
  requests.filter((r) => r.method === 'POST').map(({ path, body }) => ({ path, body }));

describe('reconcile', () => {
  const checking = account({ name: 'Checking', balance: balances(100_000, 20_000) });

  it('reconciles when the cleared balance matches the bank', async () => {
    const { user, requests } = await openRegister(checking);
    await user.click(await screen.findByRole('button', { name: 'Reconcile' }));
    const sheet = screen.getByRole('dialog', { name: 'Reconcile Checking' });
    expect(await within(sheet).findByText(/Is your cleared balance/)).toHaveTextContent('Is your cleared balance 800,00 zł?');
    expect(sheet).toHaveTextContent('Last reconciled on 31.10.2026 at 500,00 zł.');
    await user.click(within(sheet).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(requests)).toEqual([
      { path: `/api/accounts/${checking.id}/reconcile`, body: { statementBalance: 80_000, createAdjustment: false } },
    ]);
  });

  it('shows the difference to the statement and books an adjustment', async () => {
    const { user, requests } = await openRegister(checking);
    await user.click(await screen.findByRole('button', { name: 'Reconcile' }));
    const sheet = screen.getByRole('dialog', { name: 'Reconcile Checking' });
    await user.click(await within(sheet).findByRole('button', { name: 'No' }));
    expect(within(sheet).getByRole('button', { name: 'Create adjustment & finish' })).toBeDisabled();
    await user.type(within(sheet).getByLabelText('Statement balance'), '790');
    expect(within(sheet).getByTestId('reconcile-difference')).toHaveTextContent('Difference: -10,00 zł');
    expect(within(sheet).queryByLabelText(/Exchange rate/)).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: 'Create adjustment & finish' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(requests)).toEqual([
      { path: `/api/accounts/${checking.id}/reconcile`, body: { statementBalance: 79_000, createAdjustment: true } },
    ]);
  });

  it('can stop to keep reviewing', async () => {
    const { user, requests } = await openRegister(checking);
    await user.click(await screen.findByRole('button', { name: 'Reconcile' }));
    await user.click(await screen.findByRole('button', { name: 'No' }));
    await user.click(screen.getByRole('button', { name: 'Keep reviewing' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(requests)).toEqual([]);
  });
});

describe('revalue', () => {
  const euro = account({
    name: 'Euro',
    type: 'savings',
    currency: 'EUR',
    balance: balances(100_000),
    balanceBase: balances(420_000),
    latestRate: { rate: '4.300000', effectiveDate: '2026-11-20' },
    balanceAtLatestRate: 430_000,
  });

  it('books the difference at the NBP rate or a rate of your own', async () => {
    const { user, requests } = await openRegister(euro);
    await user.click(await screen.findByRole('button', { name: 'Revalue' }));
    const sheet = screen.getByRole('dialog', { name: 'Revalue Euro' });
    expect(sheet).toHaveTextContent('Booked in PLN4 200,00 zł');
    expect(sheet).toHaveTextContent('NBP rate of 20.11.20264,30');
    expect(sheet).toHaveTextContent('Worth at this rate4 300,00 zł');
    expect(within(sheet).getByTestId('revalue-difference')).toHaveTextContent('Difference: 100,00 zł');
    await user.type(within(sheet).getByLabelText('Exchange rate (PLN per EUR)'), '4,2');
    expect(within(sheet).getByRole('button', { name: 'Nothing to revalue' })).toBeDisabled();
    await user.type(within(sheet).getByLabelText('Exchange rate (PLN per EUR)'), '5');
    expect(within(sheet).getByTestId('revalue-difference')).toHaveTextContent('Difference: 50,00 zł');
    await user.click(within(sheet).getByRole('button', { name: 'Revalue' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(requests)).toEqual([{ path: `/api/accounts/${euro.id}/revalue`, body: { fxRate: '4.25' } }]);
  });

  it('is offered for foreign, open accounts only', async () => {
    await openRegister(account({ name: 'Checking' }));
    expect(await screen.findByRole('button', { name: 'Reconcile' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revalue' })).toBeNull();
  });
});
