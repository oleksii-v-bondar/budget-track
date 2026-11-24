import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BankAccountDto, BankConnectionDto, BankStatus } from '../../shared/api/bank';
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
  const bankAccount = (fields: Partial<BankAccountDto> & Pick<BankAccountDto, 'uid' | 'name'>): BankAccountDto => ({
    iban: null,
    currency: 'PLN',
    accountId: null,
    lastSyncedAt: null,
    ...fields,
  });
  const pkoBank: BankConnectionDto = {
    id: 'c0000000-0000-4000-8000-000000000001',
    bank: 'PKO BP',
    status: 'active',
    validUntil: '2027-05-19T12:00:00.000Z',
    accounts: [
      bankAccount({
        uid: 'pko-1',
        name: 'Konto Za Zero',
        iban: 'PL61109010140000071219812874',
        accountId: pko.id,
        lastSyncedAt: '2026-11-20T12:00:00.000Z',
      }),
    ],
  };
  const revolut: BankConnectionDto = {
    id: 'c0000000-0000-4000-8000-000000000002',
    bank: 'Revolut',
    status: 'reconnect_needed',
    validUntil: '2026-11-01T12:00:00.000Z',
    accounts: [bankAccount({ uid: 'rev-eur', name: 'EUR', currency: 'EUR' })],
  };
  const connected: BankStatus = { configured: true, connections: [pkoBank, revolut] };
  const banks = { aspsps: [{ name: 'Alior Bank' }, { name: 'PKO BP' }, { name: 'Revolut' }] };

  it('is hidden until the server is configured for it', async () => {
    await openSettings({ 'GET /api/bank/status': { body: { configured: false, connections: [] } } });
    expect(screen.queryByRole('heading', { name: 'Bank connections' })).not.toBeInTheDocument();
  });

  it('picks a bank to connect from a searchable sheet, and reports a failed connection', async () => {
    const { user, requests } = await openSettings(
      {
        'GET /api/bank/status': { body: { configured: true, connections: [pkoBank] } },
        'GET /api/accounts': { body: { accounts: [pko] } },
        'GET /api/bank/aspsps': { body: banks },
      },
      '/settings?bank=error',
    );
    expect(await screen.findByText("The bank wasn't connected. Try again.")).toBeInTheDocument();
    expect(requests.some((r) => r.path === '/api/bank/aspsps')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Connect bank' }));
    const sheet = await screen.findByRole('dialog', { name: 'Connect bank' });
    const list = await within(sheet).findByRole('list', { name: 'Banks' });
    expect(within(list).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Alior Bank', '/api/bank/connect?bank=Alior%20Bank'],
      ['PKO BPConnected', '/api/bank/connect?bank=PKO%20BP'],
      ['Revolut', '/api/bank/connect?bank=Revolut'],
    ]);
    const search = within(sheet).getByRole('searchbox', { name: 'Search banks' });
    expect(search).toHaveFocus();
    await user.type(search, 'rev');
    expect(within(list).getAllByRole('link').map((a) => a.textContent)).toEqual(['Revolut']);
    await user.clear(search);
    await user.type(search, 'mbank');
    expect(within(sheet).getByText('No bank matches “mbank”.')).toBeInTheDocument();
    expect(writes(requests)).toEqual([]);
  });

  it('shows each connection, links bank accounts in their currency, syncs with Undo, reconnects and disconnects', async () => {
    const { user, requests } = await openSettings({
      'GET /api/bank/status': { body: connected },
      'GET /api/accounts': { body: { accounts: [pko, savings, euro] } },
      'PUT /api/bank/accounts/:uid/link': { body: connected },
      'POST /api/bank/sync': { body: { imported: 2, reconnectNeeded: ['Revolut'], failed: [] } },
      'POST /api/undo': { body: { undone: { label: 'Bank sync' }, undo: null, redo: { label: 'Bank sync' } } },
      'DELETE /api/bank/connections/:id': { body: { configured: true, connections: [pkoBank] } },
    });

    const pkoCard = await screen.findByRole('article', { name: 'PKO BP' });
    expect(within(pkoCard).getByText('Active')).toBeInTheDocument();
    expect(within(pkoCard).getByText('Valid until 19.05.2027')).toBeInTheDocument();
    expect(within(pkoCard).getByRole('link', { name: 'Reconnect' })).toHaveAttribute('href', '/api/bank/connect?bank=PKO%20BP');
    const konto = within(pkoCard).getByLabelText('Konto Za Zero (PLN)');
    await waitFor(() => expect(within(konto).getAllByRole('option')).toHaveLength(3));
    expect(within(konto).getAllByRole('option').map((o) => o.textContent)).toEqual(['Not linked', 'PKO', 'Savings']);
    expect(konto).toHaveValue(pko.id);
    expect(within(pkoCard).getByText(/^…2874 · Last synced 20\.11\.2026/)).toBeInTheDocument();

    const revolutCard = screen.getByRole('article', { name: 'Revolut' });
    expect(within(revolutCard).getByText('Reconnect needed')).toBeInTheDocument();
    expect(within(revolutCard).getByText(/reconnect to keep syncing/)).toBeInTheDocument();
    expect(within(revolutCard).getByRole('link', { name: 'Reconnect' })).toHaveAttribute(
      'href',
      '/api/bank/connect?bank=Revolut',
    );
    const eur = within(revolutCard).getByLabelText('EUR (EUR)');
    expect(within(eur).getAllByRole('option').map((o) => o.textContent)).toEqual(['Not linked', 'Revolut EUR']);
    await user.selectOptions(eur, euro.id);

    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    const toast = await screen.findByRole('status');
    await waitFor(() => expect(toast).toHaveTextContent('Imported 2 transactions. Reconnect Revolut to sync it.'));
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await user.click(within(revolutCard).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Revolut' })).not.toBeInTheDocument());

    expect(writes(requests)).toEqual([
      { method: 'PUT', path: '/api/bank/accounts/rev-eur/link', body: { accountId: euro.id } },
      { method: 'POST', path: '/api/bank/sync', body: undefined },
      { method: 'POST', path: '/api/undo', body: undefined },
      { method: 'DELETE', path: `/api/bank/connections/${revolut.id}`, body: undefined },
    ]);
  });

  it('cannot connect or sync while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openSettings({
      'GET /api/bank/status': { body: connected },
      'GET /api/accounts': { body: { accounts: [pko, savings, euro] } },
    });
    await screen.findByRole('article', { name: 'PKO BP' });
    for (const name of ['Connect bank', 'Sync now', 'Disconnect']) {
      for (const button of screen.getAllByRole('button', { name })) expect(button).toBeDisabled();
    }
    expect(screen.queryByRole('link', { name: 'Reconnect' })).not.toBeInTheDocument();
  });
});
