import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AmountKeypad } from './amount-keypad';

// toHaveTextContent collapses whitespace, so the no-break spaces of formatted amounts compare equal to spaces.

function setup(value = 0) {
  const onDone = vi.fn();
  render(<AmountKeypad value={value} onDone={onDone} />);
  const tap = async (...names: string[]) => {
    for (const name of names) await userEvent.click(screen.getByRole('button', { name }));
  };
  return { onDone, tap };
}

describe('AmountKeypad', () => {
  it('starts from the amount, which the first digit replaces', async () => {
    const { onDone, tap } = setup(123456);
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('1 234,56');
    await tap('4', '2', 'Decimal comma', '5');
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('42,5');
    expect(screen.getByTestId('keypad-result')).toHaveTextContent('= 42,50 zł');
    await tap('Done');
    expect(onDone).toHaveBeenCalledWith(4250);
  });

  it('calculates with + − × ÷ on top of the starting amount', async () => {
    const { onDone, tap } = setup(10000);
    await tap('Plus', '2', '0', 'Multiply', '3');
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('100 + 20 × 3');
    expect(screen.getByTestId('keypad-result')).toHaveTextContent('= 160,00 zł');
    await tap('Minus', '1', '0', 'Divide', '4', 'Done');
    expect(onDone).toHaveBeenCalledWith(15750);
  });

  it('deletes the last character, or the whole starting amount', async () => {
    const { tap } = setup(5000);
    await tap('Delete');
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('0');
    await tap('7', '5', 'Delete');
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('7');
  });

  it('explains an unfinished calculation and keeps Done disabled', async () => {
    const { onDone, tap } = setup(0);
    await tap('5', 'Divide');
    expect(screen.getByTestId('keypad-result')).toHaveTextContent('Finish the calculation.');
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    await tap('0');
    expect(screen.getByTestId('keypad-result')).toHaveTextContent("Can't divide by 0.");
    expect(onDone).not.toHaveBeenCalled();
  });

  it('works with a hardware keyboard', async () => {
    const { onDone } = setup(0);
    await userEvent.click(screen.getByRole('button', { name: '1' }));
    await userEvent.keyboard('2*3.5-1{Backspace}2{Enter}');
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('12 × 3,5 − 2');
    expect(onDone).toHaveBeenCalledWith(4000);
  });

  it('ignores Enter while busy, like Done', async () => {
    const onDone = vi.fn();
    render(<AmountKeypad value={500} onDone={onDone} mutating busy />);
    await userEvent.click(screen.getByRole('button', { name: '1' }));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('ignores Enter while offline when Done sends a command', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const onDone = vi.fn();
    render(<AmountKeypad value={500} onDone={onDone} mutating />);
    await userEvent.click(screen.getByRole('button', { name: '1' }));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows foreign currencies by their code', () => {
    render(<AmountKeypad value={250} currency="EUR" onDone={() => {}} />);
    expect(screen.getByTestId('keypad-result')).toHaveTextContent('= 2,50 EUR');
  });
});
