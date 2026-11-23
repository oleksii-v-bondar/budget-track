import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { sampleBudget } from '../test/budget-fixtures';
import { fakeApi, json, undoStack, writes } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';

async function openCategory(id: string, routes: Parameters<typeof fakeApi>[0] = {}) {
  const stack = undoStack();
  const server = fakeApi({ ...SIGNED_IN, ...stack.route, 'GET /api/budget/:month': { body: sampleBudget() }, ...routes });
  renderApp('/budget?month=2026-11');
  await userEvent.click(await screen.findByTestId(`category-${id}`));
  return { ...server, stack, sheet: screen.getByRole('dialog') };
}

describe('the category sheet', () => {
  it('shows what makes up Available, what needs attention, and the tabs', async () => {
    const { sheet } = await openCategory('c-power');
    expect(sheet).toHaveAccessibleName('Electricity');
    expect(within(sheet).getByText('Available in November 2026').nextElementSibling).toHaveTextContent('100,00 zł');
    const cells = within(sheet)
      .getAllByRole('term')
      .map((term) => `${term.textContent}: ${term.nextElementSibling?.textContent}`);
    expect(cells).toEqual(['Carried over: 0,00\u00a0zł', 'Assigned: 100,00\u00a0zł', 'Activity: 0,00\u00a0zł']);
    expect(sheet).toHaveTextContent('150,00 zł more needed this month');
    expect(within(sheet).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Assign', 'Move', 'Target', 'Activity', 'Note']);
    expect(within(sheet).getByRole('tab', { name: 'Assign' })).toHaveAttribute('aria-selected', 'true');
  });

  it('assigns with a keypad expression, then closes with Undo in the toast', async () => {
    const { sheet, stack, requests } = await openCategory('c-power', {
      'PUT /api/budget/:month/assignments/:categoryId': () => {
        stack.push('Assign money to "Electricity"');
        return { body: { month: '2026-11', categoryId: 'c-power', amount: 25000 } };
      },
    });
    expect(within(sheet).getByTestId('keypad-expression')).toHaveTextContent('100');
    for (const key of ['Plus', '1', '5', '0']) await userEvent.click(within(sheet).getByRole('button', { name: key }));
    expect(within(sheet).getByTestId('keypad-result')).toHaveTextContent('= 250,00 zł');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Assign' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Assign money to "Electricity"');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(requests)).toEqual([
      { method: 'PUT', path: '/api/budget/2026-11/assignments/c-power', body: { amount: 25000 } },
    ]);
  });

  it('sends nothing when the amount is unchanged', async () => {
    const { sheet, requests } = await openCategory('c-power');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Assign' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(requests)).toEqual([]);
  });

  it('shows why an assignment was refused and stays open', async () => {
    const { sheet } = await openCategory('c-power', {
      'PUT /api/budget/:month/assignments/:categoryId': json(
        { code: 'month_out_of_range', message: 'Pick a month from 2026-09 to 2028-11.' },
        422,
      ),
    });
    await userEvent.click(within(sheet).getByRole('button', { name: '5' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Assign' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Pick a month from 2026-09 to 2028-11.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows what a card payment category needs to pay the card in full', async () => {
    const { sheet } = await openCategory('c-visa');
    expect(sheet).toHaveTextContent('Need 1 200,00 zł to pay in full');
  });

  it("edits the category's note", async () => {
    const { sheet, stack, requests } = await openCategory('c-power', {
      'PATCH /api/categories/:id': () => {
        stack.push('Edit category "Electricity"');
        return { body: {} };
      },
    });
    await userEvent.click(within(sheet).getByRole('tab', { name: 'Note' }));
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Note' }), 'Tariff G11');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save note' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Edit category "Electricity"');
    expect(writes(requests)).toEqual([{ method: 'PATCH', path: '/api/categories/c-power', body: { note: 'Tariff G11' } }]);
  });

  it('hides a category, and unhides a hidden one', async () => {
    const { sheet, requests } = await openCategory('c-power', { 'PATCH /api/categories/:id': { body: {} } });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Hide category' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Hidden categories (2)' }));
    await userEvent.click(screen.getByTestId('category-c-gifts'));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Gifts' })).getByRole('button', { name: 'Unhide category' }));
    expect(writes(requests)).toEqual([
      { method: 'PATCH', path: '/api/categories/c-power', body: { hidden: true } },
      { method: 'PATCH', path: '/api/categories/c-gifts', body: { hidden: false } },
    ]);
  });
});
