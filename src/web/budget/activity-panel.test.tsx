import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { RegisterResponse } from '../../shared/api/transactions';
import { sampleBudget, transactionDto } from '../test/budget-fixtures';
import { type FakeRequest, fakeApi } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';

const page = (transactions: RegisterResponse['transactions'], nextCursor: string | null = null): RegisterResponse => ({
  transactions,
  nextCursor,
  balances: null,
});

const lidl = transactionDto({
  id: 't1',
  date: '2026-11-14',
  amount: -68000,
  payeeName: 'Lidl',
  categoryId: 'c-groceries',
  memo: 'Weekly shop',
});
const split = transactionDto({
  id: 't2',
  date: '2026-11-03',
  amount: -7000,
  payeeName: 'Auchan',
  accountName: 'Visa',
  isSplit: true,
  lines: [
    { id: 'l1', amount: -2000, amountBase: -2000, payeeId: null, payeeName: null, categoryId: 'c-groceries', categoryName: 'Groceries', memo: null, transfer: null },
    { id: 'l2', amount: -5000, amountBase: -5000, payeeId: null, payeeName: null, categoryId: 'c-fun', categoryName: 'Fun money', memo: null, transfer: null },
  ],
});

async function openActivity(id: string, register: (request: FakeRequest) => { body: RegisterResponse }) {
  const server = fakeApi({ ...SIGNED_IN, 'GET /api/budget/:month': { body: sampleBudget() }, 'GET /api/transactions': register });
  renderApp('/budget?month=2026-11');
  await userEvent.click(await screen.findByTestId(`category-${id}`));
  const sheet = screen.getByRole('dialog');
  await userEvent.click(within(sheet).getByRole('tab', { name: 'Activity' }));
  const query = () => {
    const request = server.requests.filter((r) => r.path.startsWith('/api/transactions')).at(-1)!;
    return Object.fromEntries(new URL(request.path, 'http://x').searchParams);
  };
  return { ...server, sheet, query };
}

const rows = (sheet: HTMLElement) =>
  within(within(sheet).getByRole('list', { name: 'Transactions' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent);

describe('the Activity tab', () => {
  it("lists the month's transactions in the category, counting only a split's lines in it", async () => {
    const { sheet, query } = await openActivity('c-groceries', () => ({ body: page([lidl, split]) }));
    expect(await within(sheet).findByRole('list', { name: 'Transactions' })).toBeInTheDocument();
    expect(query()).toEqual({ categoryId: 'c-groceries', from: '2026-11-01', to: '2026-11-30', limit: '100' });
    expect(rows(sheet)).toEqual([
      'Lidl14.11.2026 · Checking · Weekly shop-680,00\u00a0zł',
      'Auchan03.11.2026 · Visa · Split-20,00\u00a0zł',
    ]);
  });

  it("lists a card payment category's card transactions", async () => {
    const { sheet, query } = await openActivity('c-visa', () => ({ body: page([split]) }));
    await within(sheet).findByRole('list', { name: 'Transactions' });
    expect(query()).toEqual({ accountId: 'a-visa', from: '2026-11-01', to: '2026-11-30', limit: '100' });
    expect(sheet).toHaveTextContent('Spending and payments on this card in November 2026.');
    expect(rows(sheet)).toEqual(['Auchan03.11.2026 · Visa · Split-70,00\u00a0zł']);
  });

  it('shows more on request', async () => {
    const { sheet, query } = await openActivity('c-groceries', (request) => ({
      body: request.path.includes('cursor=') ? page([split]) : page([lidl], 'next-page'),
    }));
    await userEvent.click(await within(sheet).findByRole('button', { name: 'Show more' }));
    expect(await within(sheet).findByText('Auchan')).toBeInTheDocument();
    expect(query()).toMatchObject({ cursor: 'next-page' });
    expect(within(sheet).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('says when a month has no transactions', async () => {
    const { sheet } = await openActivity('c-fun', () => ({ body: page([]) }));
    expect(await within(sheet).findByText('No transactions in November 2026.')).toBeInTheDocument();
  });

  it("is all that Uncategorized's sheet has", async () => {
    const { sheet, query } = await openActivity('c-uncategorized', () => ({ body: page([]) }));
    expect(within(sheet).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Activity']);
    expect(within(sheet).queryByRole('button', { name: /Hide category/ })).toBeNull();
    await within(sheet).findByText('No transactions in November 2026.');
    expect(query()).toMatchObject({ categoryId: 'c-uncategorized' });
  });
});
