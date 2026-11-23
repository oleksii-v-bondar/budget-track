import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BankAccountDto, BankStatus } from '../../shared/api/bank';
import { fakeApi, writes } from '../test/fake-api';
import { account } from '../test/ledger-fixtures';
import { renderApp, SIGNED_IN } from '../test/render';

async function openSettings(routes: Parameters<typeof fakeApi>[0] = {}, path = '/settings') {
  const server = fakeApi({ ...SIGNED_IN, ...routes });
  const app = renderApp(path);
  await screen.findByRole('heading', { name: 'Settings' });
  return { ...server, ...app, user: userEvent.setup() };
}

describe('settings', () => {
  it('signs out this device', async () => {
    const { user, history, requests } = await openSettings({ 'POST /api/auth/logout': { body: { ok: true } } });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/auth/logout']);
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
  });

  it('cannot sign out while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openSettings();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
  });
});

describe('bank connections', () => {
  const pko = account({ name: 'PKO' });
  const savings = account({ name: 'Savings' });
  const euro = account({ name: 'Revolut EUR', currency: 'EUR' });
  const bankAccount = (fields: Partial<BankAccountDto> & Pick<BankAccountDto, 'id' | 'name'>): BankAccountDto => ({
    currency: 'PLN',
    providerName: 'PKO BP',
    accountId: null,
    lastSyncedAt: null,
    ...fields,
  });
  const connected: BankStatus = {
    configured: true,
    connected: true,
    status: 'active',
    accounts: [
      bankAccount({ id: 'pko-1', name: 'Konto', accountId: pko.id, lastSyncedAt: '2026-11-20T10:00:00.000Z' }),
      bankAccount({ id: 'rev-eur', name: 'EUR', currency: 'EUR', providerName: 'Revolut' }),
    ],
  };

  it('is hidden until the server is configured for it', async () => {
    await openSettings({ 'GET /api/bank/status': { body: { configured: false, connected: false, status: null, accounts: [] } } });
    expect(screen.queryByRole('heading', { name: 'Bank connections' })).not.toBeInTheDocument();
  });

  it('connects through a top-level navigation, and reports a failed connection', async () => {
    await openSettings(
      { 'GET /api/bank/status': { body: { configured: true, connected: false, status: null, accounts: [] } } },
      '/settings?bank=error',
    );
    expect(await screen.findByRole('link', { name: 'Connect bank' })).toHaveAttribute('href', '/api/bank/connect');
    expect(await screen.findByText("The bank wasn't connected. Try again.")).toBeInTheDocument();
  });

  it('links bank accounts to accounts in their currency, syncs with Undo and disconnects', async () => {
    const { user, requests } = await openSettings({
      'GET /api/bank/status': { body: connected },
      'GET /api/accounts': { body: { accounts: [pko, savings, euro] } },
      'PUT /api/bank/accounts/:id/link': { body: connected },
      'POST /api/bank/sync': { body: { imported: 2 } },
      'POST /api/undo': { body: { undone: { label: 'Bank sync' }, undo: null, redo: { label: 'Bank sync' } } },
      'DELETE /api/bank/connection': { body: { ...connected, connected: false, status: null, accounts: [] } },
    });

    const konto = await screen.findByLabelText('PKO BP · Konto (PLN)');
    await waitFor(() => expect(within(konto).getAllByRole('option')).toHaveLength(3));
    expect(within(konto).getAllByRole('option').map((o) => o.textContent)).toEqual(['Not linked', 'PKO', 'Savings']);
    expect(konto).toHaveValue(pko.id);
    expect(screen.getByText(/^Last synced 20\.11\.2026/)).toBeInTheDocument();
    const eur = screen.getByLabelText('Revolut · EUR (EUR)');
    expect(within(eur).getAllByRole('option').map((o) => o.textContent)).toEqual(['Not linked', 'Revolut EUR']);
    await user.selectOptions(eur, euro.id);

    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Imported 2 transactions');
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('link', { name: 'Connect bank' })).toBeInTheDocument();

    expect(writes(requests)).toEqual([
      { method: 'PUT', path: '/api/bank/accounts/rev-eur/link', body: { accountId: euro.id } },
      { method: 'POST', path: '/api/bank/sync', body: undefined },
      { method: 'POST', path: '/api/undo', body: undefined },
      { method: 'DELETE', path: '/api/bank/connection', body: undefined },
    ]);
  });
});
