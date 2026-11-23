import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { sampleBudget } from '../test/budget-fixtures';
import { fakeApi, json, undoStack, writes } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';
import { CategoryPicker, type CategoryPickerProps, READY_TO_ASSIGN } from './category-picker';

describe('CategoryPicker', () => {
  function Picker(props: Partial<CategoryPickerProps>) {
    const [value, setValue] = useState('');
    return (
      <>
        <CategoryPicker label="Category" groups={sampleBudget().groups} value={value} onChange={setValue} {...props} />
        <output>{value}</output>
      </>
    );
  }

  it("lists categories by group with each one's Available, and Ready to Assign first when asked", async () => {
    render(<Picker readyToAssign={{ label: 'Inflow: Ready to Assign', amount: 10000 }} />);
    const select = screen.getByRole('combobox', { name: 'Category' });
    expect(within(select).getAllByRole('group').map((group) => group.getAttribute('label'))).toEqual([
      'Bills',
      'Everyday',
      'Credit Card Payments',
      'Old stuff',
    ]);
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose a category',
      'Inflow: Ready to Assign (100,00\u00a0zł)',
      'Rent (2\u00a0000,00\u00a0zł)',
      'Electricity (100,00\u00a0zł)',
      'Groceries (-80,00\u00a0zł)',
      'Eating out (-30,00\u00a0zł)',
      'Fun money (0,00\u00a0zł)',
      'Gifts (50,00\u00a0zł)',
      'Visa (30,00\u00a0zł)',
      'Old hobby (0,00\u00a0zł)',
    ]);
    await userEvent.selectOptions(select, READY_TO_ASSIGN);
    expect(screen.getByRole('status')).toHaveTextContent(READY_TO_ASSIGN);
    await userEvent.selectOptions(select, 'c-groceries');
    expect(screen.getByRole('status')).toHaveTextContent('c-groceries');
  });

  it('leaves out what the caller excludes, and groups left empty (e.g. card payments for a transaction)', () => {
    render(<Picker include={(c) => c.kind === 'normal' && !c.hidden} />);
    const select = screen.getByRole('combobox', { name: 'Category' });
    expect(within(select).getAllByRole('group').map((group) => group.getAttribute('label'))).toEqual([
      'Bills',
      'Everyday',
      'Old stuff',
    ]);
    expect(within(select).queryByRole('option', { name: /Visa|Gifts|Ready to Assign/ })).toBeNull();
  });
});

describe('Move money', () => {
  async function openMove(id: string, routes: Parameters<typeof fakeApi>[0] = {}) {
    const stack = undoStack();
    const server = fakeApi({
      ...SIGNED_IN,
      ...stack.route,
      'GET /api/budget/:month': { body: sampleBudget() },
      'POST /api/budget/:month/move': () => {
        stack.push('Move money');
        return { body: { assignments: [] } };
      },
      ...routes,
    });
    renderApp('/budget?month=2026-11');
    await userEvent.click(await screen.findByTestId(`category-${id}`));
    const sheet = screen.getByRole('dialog');
    await userEvent.click(within(sheet).getByRole('tab', { name: 'Move' }));
    return { ...server, sheet };
  }

  it('covers an overspent category from Ready to Assign, starting from what covers it', async () => {
    const { sheet, requests } = await openMove('c-groceries');
    expect(within(sheet).getByRole('radio', { name: 'Move in' })).toHaveAttribute('aria-checked', 'true');
    expect(within(sheet).getByTestId('keypad-expression')).toHaveTextContent('80');
    await userEvent.selectOptions(within(sheet).getByRole('combobox', { name: 'To Groceries from' }), READY_TO_ASSIGN);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Move' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Move money');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(requests)).toEqual([
      { method: 'POST', path: '/api/budget/2026-11/move', body: { from: null, to: 'c-groceries', amount: 8000 } },
    ]);
  });

  it("moves part of a category's money to another category", async () => {
    const { sheet, requests } = await openMove('c-rent');
    expect(within(sheet).getByRole('radio', { name: 'Move out' })).toHaveAttribute('aria-checked', 'true');
    expect(within(sheet).getByTestId('keypad-expression')).toHaveTextContent('2 000');
    const picker = within(sheet).getByRole('combobox', { name: 'From Rent to' });
    expect(within(picker).queryByRole('option', { name: /^Rent/ })).toBeNull();
    expect(within(picker).queryByRole('option', { name: /Gifts|Old hobby/ })).toBeNull();
    await userEvent.selectOptions(picker, 'c-fun');
    for (const key of ['5', '0', '0']) await userEvent.click(within(sheet).getByRole('button', { name: key }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Move' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Move money');
    expect(writes(requests)).toEqual([
      { method: 'POST', path: '/api/budget/2026-11/move', body: { from: 'c-rent', to: 'c-fun', amount: 50000 } },
    ]);
  });

  it('starts over from the other amount when the direction changes', async () => {
    const { sheet } = await openMove('c-groceries');
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Move out' }));
    expect(within(sheet).getByTestId('keypad-expression')).toHaveTextContent('0');
    expect(within(sheet).getByRole('combobox', { name: 'From Groceries to' })).toBeInTheDocument();
  });

  it('checks the form before sending it', async () => {
    const { sheet, requests } = await openMove('c-rent');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Move' }));
    expect(within(sheet).getByRole('combobox', { name: 'From Rent to' })).toHaveAccessibleDescription(
      'Choose where the money goes or comes from.',
    );
    await userEvent.selectOptions(within(sheet).getByRole('combobox', { name: 'From Rent to' }), 'c-fun');
    await userEvent.click(within(sheet).getByRole('button', { name: '0' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Move' }));
    expect(within(sheet).getByRole('alert')).toHaveTextContent('Enter an amount greater than 0.');
    expect(writes(requests)).toEqual([]);
  });

  it("shows the server's reason when the move is refused", async () => {
    const { sheet } = await openMove('c-rent', {
      'POST /api/budget/:month/move': json({ code: 'category_not_assignable', message: "Money can't be assigned to this category." }, 422),
    });
    await userEvent.selectOptions(within(sheet).getByRole('combobox', { name: 'From Rent to' }), 'c-visa');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Move' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent("Money can't be assigned to this category.");
  });
});
