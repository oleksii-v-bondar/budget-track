import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AmountField, readAmount } from './amount-field';
import { Button } from './button';
import { Checkbox, FormError, SegmentedControl, SelectField, TextAreaField, TextField } from './field';
import { Pill } from './pill';
import { Tabs } from './tabs';

describe('Button', () => {
  it('is a plain button unless it submits, and is disabled while busy', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button busy onClick={onClick}>
        Save
      </Button>,
    );
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('disables a mutating button while offline (spec §11)', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(
      <>
        <Button mutating>Assign</Button>
        <Button>Cancel</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Assign' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Assign' })).toHaveAttribute('title', "You're offline");
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });
});

describe('form controls', () => {
  it('label inputs and tie their error to them', () => {
    render(<TextField label="Password" error="Use at least 12 characters." hint="12 or more characters" />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Use at least 12 characters.');
  });

  it('show a hint when there is no error, and a form error only when there is one', () => {
    const { rerender } = render(
      <>
        <TextField label="Code" hint="6 digits" />
        <FormError message={null} />
      </>,
    );
    expect(screen.getByLabelText('Code')).toHaveAccessibleDescription('6 digits');
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<FormError message="Wrong password or code." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong password or code.');
  });

  it('switch between options and tick boxes', async () => {
    const onChange = vi.fn();
    const options = [
      { value: 'outflow', label: 'Outflow' },
      { value: 'inflow', label: 'Inflow' },
    ] as const;
    render(
      <>
        <SegmentedControl label="Direction" value="outflow" options={options} onChange={onChange} />
        <Checkbox label="I saved my recovery codes" />
      </>,
    );
    expect(screen.getByRole('radio', { name: 'Outflow' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: 'Inflow' }));
    expect(onChange).toHaveBeenCalledWith('inflow');
    await userEvent.click(screen.getByLabelText('I saved my recovery codes'));
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});

describe('select, text area and amount fields', () => {
  it('label a select and a text area like a text field', async () => {
    const onChange = vi.fn();
    render(
      <>
        <SelectField label="Weekday" value="1" onChange={(e) => onChange(e.target.value)} error="Pick a weekday.">
          <option value="1">Monday</option>
          <option value="2">Tuesday</option>
        </SelectField>
        <TextAreaField label="Note" hint="Up to 2000 characters." />
      </>,
    );
    const select = screen.getByLabelText('Weekday');
    expect(select).toHaveAccessibleDescription('Pick a weekday.');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    await userEvent.selectOptions(select, 'Tuesday');
    expect(onChange).toHaveBeenCalledWith('2');
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveAccessibleDescription('Up to 2000 characters.');
  });

  it('show what an amount comes to as it is typed, and read it when sent', async () => {
    function Harness() {
      const [text, setText] = useState('');
      return <AmountField label="Amount" value={text} onChange={setText} hint="In złoty." />;
    }
    render(<Harness />);
    const input = screen.getByLabelText('Amount');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(input).toHaveAccessibleDescription('In złoty.');
    await userEvent.type(input, '400+120,5');
    expect(input).toHaveAccessibleDescription('= 520,50\u00a0zł');
    expect(readAmount('400+120,5')).toEqual({ ok: true, value: 52050 });
    expect(readAmount(' ')).toEqual({ ok: false, error: 'Enter an amount.' });
    expect(readAmount('200000000000')).toEqual({ ok: false, error: 'Amounts can be at most 100\u00a0000\u00a0000\u00a0000,00.' });
  });
});

describe('Tabs', () => {
  it('select a tab by tapping it or with the arrow keys, and label the panel with it', async () => {
    function Harness() {
      const [tab, setTab] = useState<'assign' | 'move' | 'target'>('assign');
      const tabs = [
        { value: 'assign', label: 'Assign' },
        { value: 'move', label: 'Move' },
        { value: 'target', label: 'Target' },
      ] as const;
      return (
        <Tabs label="Category" value={tab} tabs={tabs} onChange={setTab}>
          <p>{tab} panel</p>
        </Tabs>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'Assign' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Assign' })).toHaveTextContent('assign panel');
    await userEvent.click(screen.getByRole('tab', { name: 'Target' }));
    expect(screen.getByRole('tabpanel', { name: 'Target' })).toHaveTextContent('target panel');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Assign' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Assign' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Target' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tabpanel', { name: 'Move' })).toHaveTextContent('move panel');
    expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
  });
});

describe('Pill', () => {
  it('colours an amount by its tone', () => {
    render(<Pill tone="red">-30,00 zł</Pill>);
    expect(screen.getByText('-30,00 zł')).toHaveAttribute('data-tone', 'red');
  });
});
