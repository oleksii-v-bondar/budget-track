import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Checkbox, FormError, SegmentedControl, TextField } from './field';
import { Pill } from './pill';

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

describe('Pill', () => {
  it('colours an amount by its tone', () => {
    render(<Pill tone="red">-30,00 zł</Pill>);
    expect(screen.getByText('-30,00 zł')).toHaveAttribute('data-tone', 'red');
  });
});
