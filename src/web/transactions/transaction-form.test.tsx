import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetMonthDto } from '../../shared/api/budget';
import { fakeApi, type FakeRequest, json } from '../test/fake-api';
import {
  account,
  balances,
  category,
  categoryGroups,
  idFor,
  payee,
  registerPage,
  splitLine,
  transaction,
  transferPayee,
} from '../test/ledger-fixtures';
import { renderApp, SIGNED_IN } from '../test/render';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 21, 12));
});
afterEach(() => vi.useRealTimers());

const checking = account({ name: 'Checking', balance: balances(100_000) });
const savings = account({ name: 'Savings', type: 'savings' });
const house = account({ name: 'House', type: 'other_asset' });
const euro = account({ name: 'Euro', currency: 'EUR' });
const groceries = category({ name: 'Groceries' });
const rent = category({ name: 'Rent' });
const lidl = payee({ name: 'Lidl', lastCategoryId: groceries.id });
const accounts = [checking, savings, house, euro];
const month = {
  month: '2026-11',
  rta: { readyToAssign: 30_000 },
  groups: [{ id: 'g', name: 'Everyday', kind: 'normal', hidden: false, categories: [{ id: groceries.id, available: 12_000, pill: 'green' }] }],
} as unknown as BudgetMonthDto;

function server(routes: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    ...SIGNED_IN,
    'GET /api/accounts': { body: { accounts } },
    'GET /api/payees': { body: { payees: [lidl, ...accounts.map(transferPayee)] } },
    'GET /api/categories': { body: categoryGroups([{ name: 'Everyday', categories: [groceries, rent] }]) },
    'GET /api/budget/2026-11': { body: month },
    'GET /api/transactions': { body: registerPage([]) },
    'POST /api/transactions': (request: FakeRequest) =>
      json({ kind: 'transaction', transaction: transaction(checking, 'new', request.body as object) }, 201),
    ...routes,
  });
}

const posted = (requests: FakeRequest[]) => requests.filter((r) => r.method !== 'GET').map(({ method, path, body }) => ({ method, path, body }));

async function typeAmount(user: ReturnType<typeof userEvent.setup>, digits: string) {
  for (const key of digits) await user.click(await screen.findByRole('button', { name: key === ',' ? 'Decimal comma' : key }));
  await user.click(screen.getByRole('button', { name: 'Done' }));
}

describe('new transaction', () => {
  it('records an outflow with a new payee and a category showing its Available, then opens the register', async () => {
    const { requests } = server();
    const { history } = renderApp(`/transactions/new?accountId=${checking.id}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'New transaction' });
    await typeAmount(user, '25,5');
    expect(screen.getByRole('button', { name: 'Amount' })).toHaveTextContent('-25,50 zł');
    await user.type(screen.getByRole('combobox', { name: 'Payee' }), 'Żabka');
    await user.click(screen.getByRole('option', { name: 'Create "Żabka"' }));
    await user.click(screen.getByRole('button', { name: 'Category: Uncategorized' }));
    const option = screen.getByRole('option', { name: /Groceries/ });
    expect(option).toHaveTextContent('120,00 zł');
    await user.click(option);
    await user.type(screen.getByLabelText('Memo'), 'snacks');
    await user.click(screen.getByRole('radio', { name: 'Blue flag' }));
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    await waitFor(() => expect(history.location.pathname).toBe(`/accounts/${checking.id}`));
    expect(posted(requests)).toEqual([
      {
        method: 'POST',
        path: '/api/transactions',
        body: {
          accountId: checking.id,
          date: '2026-11-21',
          payeeName: 'Żabka',
          categoryId: groceries.id,
          memo: 'snacks',
          amount: -2_550,
          cleared: 'uncleared',
          flag: 'blue',
        },
      },
    ]);
  });

  it("pre-fills the category from the payee, and shows the server's field errors", async () => {
    const refused = { code: 'validation', message: 'Invalid', fieldErrors: { memo: ['Use at most 500 characters.'] } };
    server({ 'POST /api/transactions': json(refused, 400) });
    renderApp('/transactions/new');
    const user = userEvent.setup();
    await typeAmount(user, '10');
    await user.type(await screen.findByRole('combobox', { name: 'Payee' }), 'li');
    await user.click(screen.getByRole('option', { name: 'Lidl' }));
    expect(screen.getByRole('button', { name: 'Category: Groceries' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    expect(await screen.findByLabelText('Memo')).toHaveAccessibleDescription('Use at most 500 characters.');
  });

  it('places the category by account class for transfers', async () => {
    const { requests } = server();
    renderApp(`/transactions/new?accountId=${checking.id}`);
    const user = userEvent.setup();
    await typeAmount(user, '500');
    await user.type(await screen.findByRole('combobox', { name: 'Payee' }), 'Transfer');
    const suggestions = screen.getByRole('listbox', { name: 'Payee suggestions' });
    const options = within(suggestions).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Transfer : Savings', 'Transfer : House', 'Transfer : Euro', 'Create "Transfer"']);
    await user.click(screen.getByRole('option', { name: 'Transfer : Savings' }));
    // Choosing a transfer payee switches the sheet to "This is a transfer".
    expect(screen.getByRole('switch', { name: 'This is a transfer' })).toBeChecked();
    expect(screen.getByLabelText('To account')).toHaveValue(savings.id);
    expect(screen.getByText('A transfer between two budget accounts takes no category.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('To account'), 'House');
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    expect(screen.getByText('Choose a category for the budget side of a transfer to or from a tracking account.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Category: none' }));
    expect(screen.queryByRole('option', { name: 'No category' })).toBeNull();
    await user.click(screen.getByRole('option', { name: /Rent/ }));
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    await waitFor(() => expect(posted(requests)).toHaveLength(1));
    expect(posted(requests)[0]!.body).toMatchObject({ payeeId: house.transferPayeeId, categoryId: rent.id, amount: -50_000 });
  });

  it('lists the transfers as soon as the payee field has the focus, before anything is typed', async () => {
    server();
    renderApp(`/transactions/new?accountId=${checking.id}`);
    const user = userEvent.setup();
    await typeAmount(user, '10');
    const field = screen.getByRole('combobox', { name: 'Payee' });
    act(() => field.focus());
    const suggestions = screen.getByRole('listbox', { name: 'Payee suggestions' });
    const groups = within(suggestions).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Transfers', 'Payees']);
    expect(within(groups[0]!).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Transfer : Savings',
      'Transfer : House',
      'Transfer : Euro',
    ]);
    expect(within(groups[1]!).getByRole('option')).toHaveTextContent('Lidl');
  });

  it('suggests the NBP rate for a foreign account and books at a typed rate', async () => {
    const { requests } = server({ 'GET /api/fx/rates/EUR/2026-11-21': { body: { rate: '4.300000', effectiveDate: '2026-11-21' } } });
    renderApp(`/transactions/new?accountId=${euro.id}`);
    const user = userEvent.setup();
    await typeAmount(user, '10');
    expect(screen.getByRole('button', { name: 'Amount' })).toHaveTextContent('-10,00 EUR');
    const rate = screen.getByLabelText('Exchange rate (PLN per EUR)');
    await waitFor(() => expect(rate).toHaveAttribute('placeholder', '4,30'));
    expect(rate).toHaveAccessibleDescription('Left empty: the NBP rate of 21.11.2026, 4,30. = -43,00\u00a0zł');
    await user.type(rate, '4,5');
    expect(rate).toHaveAccessibleDescription(/= -45,00\u00a0zł$/);
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    await waitFor(() => expect(posted(requests)).toHaveLength(1));
    expect(posted(requests)[0]!.body).toMatchObject({ accountId: euro.id, amount: -1_000, fxRate: '4.5' });
  });

  it('takes both amounts of a transfer between currencies and shows the effective rate', async () => {
    const { requests } = server();
    renderApp(`/transactions/new?accountId=${checking.id}`);
    const user = userEvent.setup();
    await typeAmount(user, '430');
    await user.type(await screen.findByRole('combobox', { name: 'Payee' }), 'Euro');
    await user.click(screen.getByRole('option', { name: 'Transfer : Euro' }));
    expect(screen.queryByLabelText(/Exchange rate/)).toBeNull();
    const other = screen.getByLabelText('Amount in EUR (received)');
    await user.type(other, '100');
    expect(screen.getByTestId('effective-rate')).toHaveTextContent('Effective rate: 1 EUR = 4,30 zł');
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    await waitFor(() => expect(posted(requests)).toHaveLength(1));
    expect(posted(requests)[0]!.body).toMatchObject({ amount: -43_000, transferAmount: 10_000, payeeId: euro.transferPayeeId });
  });
});

describe('editing from the register', () => {
  const saved = transaction(checking, 'saved', {
    payeeId: lidl.id,
    payeeName: 'Lidl',
    categoryId: groceries.id,
    categoryName: 'Groceries',
    amount: -2_000,
    cleared: 'reconciled',
    transfer: null,
  });

  async function openSaved(routes: Parameters<typeof fakeApi>[0], shown = saved) {
    const api = server({ 'GET /api/transactions': { body: registerPage([shown], { owner: checking }) }, ...routes });
    renderApp(`/accounts/${checking.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Lidl/ }));
    return { ...api, user, sheet: screen.getByRole('dialog', { name: 'Edit transaction' }) };
  }

  it('sends what changed, asking before it changes a reconciled transaction', async () => {
    let calls = 0;
    const refused = { code: 'confirm_reconciled', message: 'This changes a reconciled transaction. Confirm to go ahead.' };
    const { user, sheet, requests } = await openSaved({
      [`PATCH /api/transactions/${saved.id}`]: () => (++calls === 1 ? json(refused, 409) : { body: saved }),
    });
    expect(within(sheet).getByRole('button', { name: 'Amount' })).toHaveTextContent('-20,00 zł');
    expect(within(sheet).getByRole('checkbox', { name: /Cleared \(reconciled\)/ })).toBeChecked();
    await user.click(within(sheet).getByRole('button', { name: 'Amount' }));
    await typeAmount(user, '21');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Change them anyway?');
    await user.click(within(sheet).getByRole('button', { name: 'Change anyway' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posted(requests).map((r) => r.body)).toEqual([
      { amount: -2_100, confirmReconciled: false },
      { amount: -2_100, confirmReconciled: true },
    ]);
  });

  it('approves an imported transaction together with its edits', async () => {
    const imported = { ...saved, cleared: 'cleared' as const, approved: false };
    const { user, sheet, requests } = await openSaved({ [`PATCH /api/transactions/${saved.id}`]: { body: imported } }, imported);
    await user.click(within(sheet).getByRole('button', { name: 'Category: Groceries' }));
    await user.click(screen.getByRole('option', { name: /Rent/ }));
    await user.click(within(sheet).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posted(requests).map((r) => r.body)).toEqual([{ categoryId: rent.id, approved: true, confirmReconciled: false }]);
  });

  it('marks an imported transaction as a transfer to the account chosen, and says it was linked', async () => {
    const imported = { ...saved, cleared: 'cleared' as const, approved: false };
    const { user, sheet, requests } = await openSaved(
      { [`PATCH /api/transactions/${saved.id}`]: { body: { ...imported, linkedTo: idFor('txn:savings-side') } } },
      imported,
    );
    const toggle = within(sheet).getByRole('switch', { name: 'This is a transfer' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(within(sheet).queryByRole('combobox', { name: 'Payee' })).toBeNull();
    const picker = within(sheet).getByLabelText('To account');
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose an account',
      'Savings',
      'House',
      'Euro (EUR)',
    ]);
    await user.click(within(sheet).getByRole('button', { name: 'Approve' }));
    expect(picker).toHaveAccessibleDescription('Choose the account the money goes to.');

    // A transfer to a tracking account keeps the category on the budget side; between budget accounts there is none.
    await user.selectOptions(picker, 'House');
    expect(within(sheet).getByRole('button', { name: 'Category: Groceries' })).toBeInTheDocument();
    await user.selectOptions(picker, 'Euro (EUR)');
    expect(within(sheet).getByLabelText('Amount in EUR (received)')).toHaveAccessibleDescription(
      'Leave it empty to take the amount of the matching transaction there.',
    );
    // Switched off, it is the transaction it was, with its payee.
    await user.click(toggle);
    expect(within(sheet).getByRole('combobox', { name: 'Payee' })).toHaveValue('Lidl');
    await user.click(toggle);
    await user.selectOptions(within(sheet).getByLabelText('To account'), 'Savings');
    expect(within(sheet).queryByRole('button', { name: /^Category/ })).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Linked with the matching transaction in Savings')).toBeInTheDocument();
    expect(posted(requests).map((r) => r.body)).toEqual([
      { payeeId: savings.transferPayeeId, categoryId: null, approved: true, confirmReconciled: false },
    ]);
  });

  it('deletes it (confirming, as it is reconciled)', async () => {
    let calls = 0;
    const refused = { code: 'confirm_reconciled', message: 'Confirm.' };
    const { user, sheet, requests } = await openSaved({
      [`DELETE /api/transactions/${saved.id}`]: () => (++calls === 1 ? json(refused, 409) : { body: { id: saved.id } }),
    });
    await user.click(within(sheet).getByRole('button', { name: 'Delete transaction' }));
    await user.click(await within(sheet).findByRole('button', { name: 'Change anyway' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posted(requests)).toEqual([
      { method: 'DELETE', path: `/api/transactions/${saved.id}`, body: { confirmReconciled: false } },
      { method: 'DELETE', path: `/api/transactions/${saved.id}`, body: { confirmReconciled: true } },
    ]);
  });
});

describe('splits', () => {
  it('splits a new transaction into a category line and a transfer line', async () => {
    let calls = 0;
    const refused = {
      code: 'invalid_category',
      message: 'Choose one of your categories.',
      fieldErrors: { 'lines.0.categoryId': ['Choose one of your categories.'] },
    };
    const { requests } = server({
      'POST /api/transactions': () =>
        ++calls === 1 ? json(refused, 422) : json({ kind: 'transaction', transaction: transaction(checking, 'split') }, 201),
    });
    renderApp(`/transactions/new?accountId=${checking.id}`);
    const user = userEvent.setup();
    await typeAmount(user, '100');
    await user.click(screen.getByRole('button', { name: 'Split' }));
    expect(screen.getByLabelText('Line 1 amount')).toHaveValue('100');
    await user.clear(screen.getByLabelText('Line 1 amount'));
    await user.type(screen.getByLabelText('Line 1 amount'), '70');
    await user.click(screen.getByRole('button', { name: 'Line 1 category: Uncategorized' }));
    await user.click(screen.getByRole('option', { name: /Groceries/ }));
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    expect(screen.getByText('The lines must add up to the transaction amount.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Line 2 amount'), '30');
    await user.type(screen.getByRole('combobox', { name: 'Line 2 payee' }), 'Sav');
    await user.click(screen.getByRole('option', { name: 'Transfer : Savings' }));
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    expect(await screen.findByText('Choose one of your categories.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    await waitFor(() => expect(posted(requests)).toHaveLength(2));
    expect(posted(requests)[1]!.body).toMatchObject({
      amount: -10_000,
      categoryId: null,
      lines: [
        { amount: -7_000, payeeId: null, categoryId: groceries.id, memo: '' },
        { amount: -3_000, payeeId: savings.transferPayeeId, categoryId: null, memo: '' },
      ],
    });
  });

  it('edits a saved split, sending its lines only when they change', async () => {
    const saved = transaction(checking, 'saved-split', {
      payeeName: 'Market',
      amount: -10_000,
      isSplit: true,
      lines: [
        splitLine('a', -6_000, { categoryId: groceries.id, categoryName: 'Groceries' }),
        splitLine('b', -4_000, { categoryId: rent.id, categoryName: 'Rent' }),
      ],
    });
    const { requests } = server({
      'GET /api/transactions': { body: registerPage([saved], { owner: checking }) },
      [`PATCH /api/transactions/${saved.id}`]: { body: saved },
    });
    renderApp(`/accounts/${checking.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Market/ }));
    const sheet = screen.getByRole('dialog', { name: 'Edit transaction' });
    expect(within(sheet).getByLabelText('Line 2 amount')).toHaveValue('40');
    await user.type(within(sheet).getByRole('textbox', { name: 'Memo' }), 'weekend');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted(requests)).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: /Market/ }));
    await user.clear(screen.getByLabelText('Line 2 amount'));
    await user.type(screen.getByLabelText('Line 2 amount'), '35');
    await user.type(screen.getByLabelText('Line 1 amount'), '+5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted(requests)).toHaveLength(2));
    expect(posted(requests).map((r) => r.body)).toEqual([
      { memo: 'weekend', confirmReconciled: false },
      {
        lines: [
          { amount: -6_500, payeeId: null, categoryId: groceries.id, memo: '' },
          { amount: -3_500, payeeId: null, categoryId: rent.id, memo: '' },
        ],
        confirmReconciled: false,
      },
    ]);
  });
});

describe('a future date', () => {
  it('becomes a scheduled transaction, and the toast says when', async () => {
    const { requests } = server({
      'POST /api/transactions': json({ kind: 'scheduled', scheduledId: '00000000-0000-4000-8000-0000000000aa', date: '2026-12-01' }, 201),
    });
    const { history } = renderApp(`/transactions/new?accountId=${checking.id}`);
    const user = userEvent.setup();
    await typeAmount(user, '20');
    await user.clear(screen.getByLabelText('Date'));
    await user.type(screen.getByLabelText('Date'), '01.12.2026');
    expect(screen.getByLabelText('Date')).toHaveAccessibleDescription('A future date saves it as a scheduled transaction.');
    expect(screen.queryByLabelText('Repeat')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    expect(await screen.findByText('Scheduled for 01.12.2026')).toBeInTheDocument();
    await waitFor(() => expect(history.location.pathname).toBe(`/accounts/${checking.id}`));
    expect(posted(requests)).toEqual([
      { method: 'POST', path: '/api/transactions', body: expect.objectContaining({ date: '2026-12-01', amount: -2_000 }) as unknown },
    ]);
  });
});
