import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import { fakeApi, json } from '../test/fake-api';
import { account, balances, registerPage } from '../test/ledger-fixtures';
import { renderApp, SIGNED_IN } from '../test/render';

async function openSettings(owner: AccountDto, routes: Parameters<typeof fakeApi>[0] = {}) {
  const server = fakeApi({
    ...SIGNED_IN,
    'GET /api/accounts': { body: { accounts: [owner] } },
    'GET /api/transactions': { body: registerPage([], { owner }) },
    ...routes,
  });
  const app = renderApp(`/accounts/${owner.id}`);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Edit account' }));
  return { ...server, ...app, user, sheet: screen.getByRole('dialog', { name: 'Edit account' }) };
}

const sent = (requests: { method: string; path: string; body: unknown }[]) =>
  requests.filter((r) => r.method !== 'GET').map(({ method, path, body }) => ({ method, path, body }));

describe('account settings', () => {
  it('saves what changed; an emptied field is cleared', async () => {
    const visa = account({ name: 'Visa', type: 'credit_card', minPayment: 15_000 });
    const { user, sheet, requests } = await openSettings(visa, { [`PATCH /api/accounts/${visa.id}`]: { body: visa } });
    expect(within(sheet).getByLabelText('Minimum payment')).toHaveValue('150');
    expect(within(sheet).queryByLabelText(/Interest rate/)).toBeNull();
    await user.type(within(sheet).getByLabelText('Note'), 'Due on the 25th');
    await user.clear(within(sheet).getByLabelText('Minimum payment'));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(requests)).toEqual([
      { method: 'PATCH', path: `/api/accounts/${visa.id}`, body: { note: 'Due on the 25th', minPayment: null } },
    ]);
  });

  it('closes an account at a zero balance', async () => {
    const savings = account({ name: 'Savings', type: 'savings' });
    const { user, sheet, requests } = await openSettings(savings, {
      [`POST /api/accounts/${savings.id}/close`]: { body: { ...savings, closed: true } },
    });
    expect(within(sheet).queryByLabelText('Minimum payment')).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: 'Close account' }));
    expect(sent(requests)).toEqual([]);
    await user.click(within(sheet).getByRole('button', { name: 'Close account' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(requests)).toEqual([{ method: 'POST', path: `/api/accounts/${savings.id}/close`, body: undefined }]);
  });

  it('offers an adjustment to 0 before closing an account with money in it', async () => {
    const checking = account({ name: 'Checking', balance: balances(12_000, -2_000) });
    const { user, sheet, requests } = await openSettings(checking, {
      [`POST /api/accounts/${checking.id}/reconcile`]: { body: {} },
      [`POST /api/accounts/${checking.id}/close`]: { body: { ...checking, closed: true } },
    });
    await user.click(within(sheet).getByRole('button', { name: 'Close account' }));
    expect(sheet).toHaveTextContent('The balance is 120,00 zł.');
    expect(sheet).toHaveTextContent('a reconciliation adjustment of -120,00 zł');
    await user.click(within(sheet).getByRole('button', { name: 'Adjust to 0 and close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(requests)).toEqual([
      {
        method: 'POST',
        path: `/api/accounts/${checking.id}/reconcile`,
        body: { statementBalance: 2_000, createAdjustment: true },
      },
      { method: 'POST', path: `/api/accounts/${checking.id}/close`, body: undefined },
    ]);
  });

  it('reopens a closed account', async () => {
    const old = account({ name: 'Old', closed: true });
    const { user, sheet, requests } = await openSettings(old, {
      [`POST /api/accounts/${old.id}/reopen`]: { body: { ...old, closed: false } },
    });
    await user.click(within(sheet).getByRole('button', { name: 'Reopen account' }));
    await waitFor(() => expect(sent(requests).map((r) => r.path)).toEqual([`/api/accounts/${old.id}/reopen`]));
  });

  it('deletes an unused account, and explains a refusal', async () => {
    const spare = account({ name: 'Spare' });
    let calls = 0;
    const refused = { code: 'account_in_use', message: 'This account has transactions. Close it instead.' };
    const { user, sheet, history } = await openSettings(spare, {
      [`DELETE /api/accounts/${spare.id}`]: () => (++calls === 1 ? json(refused, 422) : { body: { id: spare.id } }),
    });
    await user.click(within(sheet).getByRole('button', { name: 'Delete account' }));
    await user.click(within(sheet).getByRole('button', { name: 'Delete account' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('This account has transactions. Close it instead.');
    await user.click(within(sheet).getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(history.location.pathname).toBe('/accounts'));
  });
});
