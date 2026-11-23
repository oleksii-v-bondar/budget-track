import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi, type FakeRequest, json } from '../test/fake-api';
import { account, category, categoryGroups, registerPage, transaction } from '../test/ledger-fixtures';
import { renderApp, SIGNED_IN } from '../test/render';

const checking = account({ name: 'Checking' });
const savings = account({ name: 'Savings', type: 'savings' });
const euro = account({ name: 'Euro', currency: 'EUR' });
const closed = account({ name: 'Old', closed: true });
const groceries = category({ name: 'Groceries' });
const lidl = transaction(checking, 'lidl', { payeeName: 'Lidl', amount: -2_500 });
const kiosk = transaction(checking, 'kiosk', { payeeName: 'Kiosk', amount: -500, date: '2026-11-19' });
const paris = transaction(euro, 'paris', { payeeName: 'Café', amount: -900, date: '2026-11-18' });

function openRegister(bulk: (request: FakeRequest) => Response | { body: unknown }) {
  const server = fakeApi({
    ...SIGNED_IN,
    'GET /api/accounts': { body: { accounts: [checking, savings, euro, closed] } },
    'GET /api/transactions': { body: registerPage([lidl, kiosk, paris]) },
    'GET /api/categories': { body: categoryGroups([{ name: 'Everyday', categories: [groceries] }]) },
    'GET /api/payees': { body: { payees: [] } },
    'POST /api/transactions/bulk': bulk,
  });
  renderApp('/transactions');
  return { ...server, user: userEvent.setup() };
}

async function select(user: ReturnType<typeof userEvent.setup>, ...names: string[]) {
  await user.click(await screen.findByRole('button', { name: 'Select' }));
  for (const name of names) await user.click(screen.getByRole('checkbox', { name: new RegExp(`^Select ${name}`) }));
  await user.click(within(screen.getByRole('toolbar', { name: 'Selected transactions' })).getByRole('button', { name: 'Actions' }));
}

const bulkBodies = (requests: FakeRequest[]) => requests.filter((r) => r.path === '/api/transactions/bulk').map((r) => r.body);

describe('bulk actions', () => {
  it('categorize the selected transactions in one command', async () => {
    const { user, requests } = openRegister(() => ({ body: { ids: [lidl.id, kiosk.id] } }));
    await select(user, 'Lidl', 'Kiosk');
    const sheet = screen.getByRole('dialog', { name: 'Change 2 transactions' });
    await user.click(within(sheet).getByRole('button', { name: 'Categorize' }));
    await user.selectOptions(within(sheet).getByLabelText('Category'), 'Groceries');
    await user.click(within(sheet).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Selected transactions' })).toBeNull());
    expect(bulkBodies(requests)).toEqual([
      { ids: [lidl.id, kiosk.id], action: { type: 'categorize', categoryId: groceries.id }, confirmReconciled: false },
    ]);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('ask before changing reconciled transactions, then send the confirmation', async () => {
    let calls = 0;
    const refused = { code: 'confirm_reconciled', message: 'This changes a reconciled transaction. Confirm to go ahead.' };
    const { user, requests } = openRegister(() => (++calls === 1 ? json(refused, 409) : { body: { ids: [lidl.id] } }));
    await select(user, 'Lidl');
    const sheet = screen.getByRole('dialog', { name: 'Change 1 transaction' });
    await user.click(within(sheet).getByRole('button', { name: 'Mark uncleared' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Change them anyway?');
    await user.click(within(sheet).getByRole('button', { name: 'Change anyway' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bulkBodies(requests)).toEqual([
      { ids: [lidl.id], action: { type: 'setCleared', cleared: 'uncleared' }, confirmReconciled: false },
      { ids: [lidl.id], action: { type: 'setCleared', cleared: 'uncleared' }, confirmReconciled: true },
    ]);
  });

  it('move only to open accounts in the same currency', async () => {
    const { user, requests } = openRegister(() => ({ body: { ids: [] } }));
    await select(user, 'Lidl', 'Café');
    let sheet = screen.getByRole('dialog', { name: 'Change 2 transactions' });
    await user.click(within(sheet).getByRole('button', { name: 'Move to account' }));
    expect(sheet).toHaveTextContent('Select transactions in one currency to move them.');
    await user.click(within(sheet).getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('checkbox', { name: /^Select Café/ }));
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    sheet = screen.getByRole('dialog', { name: 'Change 1 transaction' });
    await user.click(within(sheet).getByRole('button', { name: 'Move to account' }));
    const options = within(within(sheet).getByLabelText('Account')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Choose an account', 'Checking', 'Savings']);
    await user.selectOptions(within(sheet).getByLabelText('Account'), 'Savings');
    await user.click(within(sheet).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(bulkBodies(requests)).toHaveLength(1));
    expect(bulkBodies(requests)[0]).toMatchObject({ action: { type: 'moveAccount', accountId: savings.id } });
  });

  it('name the transaction a refusal is about, and delete after asking', async () => {
    let calls = 0;
    const refused = {
      code: 'category_required',
      message: 'Choose a category.',
      fieldErrors: { 'ids.1': ['Choose a category for the budget side of a transfer to or from a tracking account.'] },
    };
    const { user, requests } = openRegister(() => (++calls === 1 ? json(refused, 422) : { body: { ids: [] } }));
    await user.click(await screen.findByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const sheet = screen.getByRole('dialog', { name: 'Change 3 transactions' });
    await user.click(within(sheet).getByRole('button', { name: 'Set flag' }));
    await user.selectOptions(within(sheet).getByLabelText('Flag'), 'Purple');
    await user.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'Kiosk on 19.11.2026: Choose a category for the budget side of a transfer to or from a tracking account.',
    );
    await user.click(within(sheet).getByRole('button', { name: 'Back' }));
    await user.click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(sheet).toHaveTextContent('Delete 3 transactions? A transfer goes from both accounts.');
    await user.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bulkBodies(requests).map((body) => (body as { action: unknown }).action)).toEqual([
      { type: 'setFlag', flag: 'purple' },
      { type: 'delete' },
    ]);
  });
});
