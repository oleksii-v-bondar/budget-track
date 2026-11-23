import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi, type FakeRequest } from '../test/fake-api';
import { account, balances, category, categoryGroups, payee, registerPage, transaction } from '../test/ledger-fixtures';
import { renderApp, SIGNED_IN } from '../test/render';

const checking = account({ name: 'Checking', balance: balances(90_000, -2_500) });
const tracking = account({ name: 'House', type: 'other_asset', balance: balances(50_000_000) });

const lidl = transaction(checking, 'lidl', {
  date: '2026-11-20',
  payeeName: 'Lidl',
  categoryName: 'Groceries',
  memo: 'weekly',
  amount: -2_500,
  flag: 'red',
});
const salary = transaction(checking, 'salary', {
  date: '2026-11-20',
  payeeName: 'Employer',
  categoryName: 'Ready to Assign',
  amount: 500_000,
  cleared: 'reconciled',
});
const kiosk = transaction(checking, 'kiosk', { date: '2026-11-18', payeeName: 'Kiosk', cleared: 'cleared', approved: false });
const valuation = transaction(tracking, 'valuation', { date: '2026-11-01', payeeName: 'Valuation', amount: 100_000 });

function registerRoutes(pages: Record<string, ReturnType<typeof registerPage>>) {
  return {
    ...SIGNED_IN,
    'GET /api/accounts': { body: { accounts: [checking, tracking] } },
    'GET /api/transactions': (request: FakeRequest) => {
      const query = new URL(request.path, 'http://x').searchParams;
      return { body: pages[query.get('cursor') ?? 'first']! };
    },
  };
}

describe('register', () => {
  it("shows one account's balances and its transactions by date", async () => {
    const { requests } = fakeApi(registerRoutes({ first: registerPage([lidl, salary, kiosk], { owner: checking }) }));
    renderApp(`/accounts/${checking.id}`);
    const header = await screen.findByRole('region', { name: 'Balances' });
    expect(within(header).getByRole('heading', { name: 'Checking' })).toBeInTheDocument();
    expect(within(header).getByText('Cleared').nextSibling).toHaveTextContent('925,00 zł');
    expect(within(header).getByText('Uncleared').nextSibling).toHaveTextContent('-25,00 zł');
    expect(within(header).getByText('Working').nextSibling).toHaveTextContent('900,00 zł');
    expect(requests.find((r) => r.path.startsWith('/api/transactions'))!.path).toBe(
      `/api/transactions?accountId=${checking.id}`,
    );

    const day = screen.getByRole('region', { name: '20.11.2026' });
    const [first, second] = within(day).getAllByRole('listitem');
    expect(first).toHaveTextContent('LidlGroceries · weekly-25,00 zł');
    expect(within(first!).getByRole('img', { name: 'Red flag' })).toBeInTheDocument();
    expect(within(first!).getByRole('img', { name: 'Uncleared' })).toBeInTheDocument();
    expect(second).toHaveTextContent('EmployerReady to Assign5 000,00 zł');
    expect(within(second!).getByRole('img', { name: 'Reconciled' })).toBeInTheDocument();
    const earlier = screen.getByRole('region', { name: '18.11.2026' });
    expect(within(earlier).getByRole('listitem')).toHaveTextContent('KioskUncategorized');
    expect(within(earlier).getByRole('img', { name: 'Unapproved' })).toBeInTheDocument();
    expect(within(earlier).getByRole('img', { name: 'Cleared' })).toBeInTheDocument();
  });

  it('loads the next page from the cursor', async () => {
    const cursor = `2026-11-18_${kiosk.id}`;
    const { requests } = fakeApi(
      registerRoutes({
        first: registerPage([lidl, salary, kiosk], { nextCursor: cursor }),
        [cursor]: registerPage([valuation]),
      }),
    );
    renderApp('/transactions');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('region', { name: '01.11.2026' })).toHaveTextContent('ValuationHouse1 000,00 zł');
    expect(requests.filter((r) => r.path.startsWith('/api/transactions')).map((r) => r.path)).toEqual([
      '/api/transactions',
      `/api/transactions?cursor=${encodeURIComponent(cursor)}`,
    ]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  });

  it('names the account of each row in All accounts', async () => {
    fakeApi(registerRoutes({ first: registerPage([kiosk, valuation]) }));
    renderApp('/transactions');
    expect(await screen.findByRole('heading', { name: 'All accounts' })).toBeInTheDocument();
    expect(await screen.findByText('Checking · Uncategorized')).toBeInTheDocument();
    expect(screen.getByText('House')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Balances' })).toBeNull();
  });

  it('says when an account does not exist', async () => {
    fakeApi(registerRoutes({ first: registerPage([]) }));
    renderApp('/accounts/00000000-0000-4000-8000-000000000000');
    expect(await screen.findByText("This account doesn't exist.")).toBeInTheDocument();
  });
});

describe('register search and filters', () => {
  const groceries = category({ name: 'Groceries' });
  const lidlPayee = payee({ name: 'Lidl' });

  function openFiltered(path: string) {
    const server = fakeApi({
      ...registerRoutes({ first: registerPage([lidl], { owner: checking }) }),
      'GET /api/categories': { body: categoryGroups([{ name: 'Everyday', categories: [groceries] }]) },
      'GET /api/payees': { body: { payees: [lidlPayee] } },
    });
    const app = renderApp(path);
    return { ...server, ...app, user: userEvent.setup() };
  }
  const registerPaths = (requests: FakeRequest[]) =>
    requests.filter((r) => r.path.startsWith('/api/transactions')).map((r) => decodeURIComponent(r.path));

  it('searches the text and keeps it in the URL', async () => {
    const { user, requests, history } = openFiltered(`/accounts/${checking.id}`);
    await user.type(await screen.findByRole('searchbox', { name: 'Search transactions' }), 'lidl{Enter}');
    await waitFor(() => expect(history.location.search).toBe('?q=lidl'));
    await waitFor(() => expect(registerPaths(requests).at(-1)).toBe(`/api/transactions?accountId=${checking.id}&q=lidl`));
    await user.clear(screen.getByRole('searchbox', { name: 'Search transactions' }));
    await waitFor(() => expect(history.location.search).toBe(''));
  });

  it('applies the filter sheet and removes a filter by its chip', async () => {
    const { user, requests, history } = openFiltered('/transactions?flag=red');
    expect(await screen.findByRole('button', { name: 'Remove the filter Red flag' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Filters (1)' }));
    const sheet = screen.getByRole('dialog', { name: 'Filters' });
    expect(within(sheet).getByLabelText('Flag')).toHaveValue('red');
    await user.type(within(sheet).getByLabelText('From'), '01.11.2026');
    await user.type(within(sheet).getByLabelText('To'), '31.10.2026');
    await user.type(within(sheet).getByLabelText('Amount from'), '-100');
    await user.selectOptions(within(sheet).getByLabelText('Category'), 'Groceries');
    await user.selectOptions(within(sheet).getByLabelText('Payee'), 'Lidl');
    await user.click(within(sheet).getByLabelText('Only unapproved'));
    await user.click(within(sheet).getByRole('button', { name: 'Show transactions' }));
    expect(within(sheet).getByLabelText('To')).toHaveAccessibleDescription('The end date must not be before the start date.');
    await user.clear(within(sheet).getByLabelText('To'));
    await user.click(within(sheet).getByRole('button', { name: 'Show transactions' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const chips = screen.getByRole('list', { name: 'Active filters' });
    expect(within(chips).getAllByRole('button').map((chip) => chip.textContent)).toEqual([
      'From 01.11.2026',
      'At least -100,00',
      'Category: Groceries',
      'Payee: Lidl',
      'Red flag',
      'Unapproved',
    ]);
    await waitFor(() =>
      expect(registerPaths(requests).at(-1)).toBe(
        `/api/transactions?from=2026-11-01&categoryId=${groceries.id}&payeeId=${lidlPayee.id}&flag=red&minAmount=-10000&unapproved=true`,
      ),
    );
    await user.click(within(chips).getByRole('button', { name: 'Remove the filter Red flag' }));
    await waitFor(() => expect(history.location.search).not.toContain('flag'));
    expect(screen.getByRole('button', { name: 'Filters (5)' })).toBeInTheDocument();
  });

  it('says when nothing matches', async () => {
    fakeApi({ ...SIGNED_IN, 'GET /api/accounts': { body: { accounts: [checking] } }, 'GET /api/transactions': { body: registerPage([]) } });
    renderApp('/transactions?q=nothing');
    expect(await screen.findByText('No transactions match.')).toBeInTheDocument();
  });
});
