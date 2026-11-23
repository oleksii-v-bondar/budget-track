import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { account, category, categoryGroups, payee, transferPayee } from '../test/ledger-fixtures';
import { type LineValues, newLine } from './form-model';
import { SplitEditor } from './split-editor';

const checking = account({ name: 'Checking' });
const savings = account({ name: 'Savings', type: 'savings' });
const house = account({ name: 'House', type: 'other_asset' });
const euro = account({ name: 'Euro', currency: 'EUR' });
const groceries = category({ name: 'Groceries' });
const context = {
  accounts: [checking, savings, house, euro],
  payees: [payee({ name: 'Lidl' }), ...[checking, savings, house, euro].map(transferPayee)],
};
const { groups } = categoryGroups([{ name: 'Everyday', categories: [groceries] }]);

function Harness({ errors = {}, start }: { errors?: Record<string, string>; start: LineValues[] }) {
  const [lines, setLines] = useState(start);
  return (
    <SplitEditor
      lines={lines}
      onChange={setLines}
      amount={10_000}
      account={checking}
      context={context}
      groups={groups}
      errors={errors}
      onPickCategory={() => {}}
      onUnsplit={() => {}}
    />
  );
}

const remaining = () => screen.getByRole('status', { name: 'Remaining to assign' });

describe('SplitEditor', () => {
  it('shows what remains to assign as the line amounts change', async () => {
    const user = userEvent.setup();
    render(<Harness start={[newLine({ amount: '60', categoryId: groceries.id }), newLine()]} />);
    expect(remaining()).toHaveTextContent('Remaining to assign: 40,00 zł');
    expect(screen.getByRole('button', { name: 'Line 1 category: Groceries' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Line 2 amount'), '30');
    expect(remaining()).toHaveTextContent('Remaining to assign: 10,00 zł');
    await user.type(screen.getByLabelText('Line 2 amount'), '0');
    expect(remaining()).toHaveTextContent('Assigned 260,00 zł too much');
    await user.clear(screen.getByLabelText('Line 2 amount'));
    await user.type(screen.getByLabelText('Line 2 amount'), '50 − 10');
    expect(remaining()).toHaveTextContent('Everything is assigned.');
  });

  it('adds a line with the remaining amount and removes lines down to two', async () => {
    const user = userEvent.setup();
    render(<Harness start={[newLine({ amount: '25' }), newLine({ amount: '25' })]} />);
    expect(screen.queryByRole('button', { name: /Remove line/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    expect(screen.getByLabelText('Line 3 amount')).toHaveValue('50');
    expect(remaining()).toHaveTextContent('Everything is assigned.');
    await user.click(screen.getByRole('button', { name: 'Remove line 1' }));
    expect(screen.getAllByRole('listitem').map((item) => within(item).getAllByRole('textbox')[0]!.getAttribute('value'))).toEqual(['25', '50']);
    expect(screen.queryByRole('button', { name: /Remove line/ })).toBeNull();
  });

  it('makes a line a transfer to an account in the same currency, with the category rules of a transfer', async () => {
    const user = userEvent.setup();
    render(<Harness start={[newLine({ amount: '50' }), newLine({ amount: '50' })]} errors={{ 'lines.1.memo': 'Use at most 500 characters.' }} />);
    await user.type(screen.getByRole('combobox', { name: 'Line 2 payee' }), 'Transfer');
    const suggestions = screen.getByRole('listbox', { name: 'Line 2 payee suggestions' });
    expect(within(suggestions).getAllByRole('option').map((o) => o.textContent)).toEqual(['Transfer : Savings', 'Transfer : House']);
    await user.click(within(suggestions).getByRole('option', { name: 'Transfer : Savings' }));
    expect(screen.queryByRole('button', { name: /Line 2 category/ })).toBeNull();
    await user.clear(screen.getByRole('combobox', { name: 'Line 2 payee' }));
    await user.type(screen.getByRole('combobox', { name: 'Line 2 payee' }), 'House');
    await user.click(screen.getByRole('option', { name: 'Transfer : House' }));
    expect(screen.getByRole('button', { name: 'Line 2 category: none' })).toHaveTextContent('Choose a category');
    expect(screen.getByLabelText('Line 2 memo')).toHaveAccessibleDescription('Use at most 500 characters.');
  });
});
