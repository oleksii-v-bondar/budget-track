import { type KeyboardEvent, useState } from 'react';
import { amountToExpression, evaluateAmount, formatExpression, OPERATORS } from '../lib/amount-expression';
import { formatMoney } from '../lib/format';
import { useOnline } from '../lib/online';
import { Button } from './button';
import { cx } from './cx';
import { BackspaceIcon } from './icons';

export interface AmountKeypadProps {
  /** The amount (minor units) the keypad starts from; typing a digit first replaces it, an operator extends it. */
  value: number;
  currency?: string;
  /** Called with the result (minor units) when the user taps Done or presses Enter. */
  onDone: (value: number) => void;
  doneLabel?: string;
  /** Done sends a command: disabled while offline. */
  mutating?: boolean;
  busy?: boolean;
}

/** The keypad's buttons in reading order; `name` is the accessible name. */
const KEYS: { key: string; name: string }[] = [
  { key: '7', name: '7' },
  { key: '8', name: '8' },
  { key: '9', name: '9' },
  { key: OPERATORS.divide, name: 'Divide' },
  { key: '4', name: '4' },
  { key: '5', name: '5' },
  { key: '6', name: '6' },
  { key: OPERATORS.multiply, name: 'Multiply' },
  { key: '1', name: '1' },
  { key: '2', name: '2' },
  { key: '3', name: '3' },
  { key: OPERATORS.subtract, name: 'Minus' },
  { key: ',', name: 'Decimal comma' },
  { key: '0', name: '0' },
  { key: 'Backspace', name: 'Delete' },
  { key: OPERATORS.add, name: 'Plus' },
];

const KEYBOARD: Record<string, string> = { '.': ',', '-': OPERATORS.subtract, '*': OPERATORS.multiply, '/': OPERATORS.divide };

/**
 * A calculator keypad for amounts (spec §11): digits, a decimal comma and + − × ÷. It shows the expression and its
 * result, and also works with a hardware keyboard.
 */
export function AmountKeypad({ value, currency = 'PLN', onDone, doneLabel = 'Done', mutating, busy }: AmountKeypadProps) {
  const [expression, setExpression] = useState(() => amountToExpression(value));
  // The starting amount is replaced by the first digit typed, as in a calculator.
  const [fresh, setFresh] = useState(true);
  const result = evaluateAmount(expression);
  const online = useOnline();
  // Enter follows the same rules as the Done button.
  const canSubmit = result.ok && !busy && !(mutating && !online);

  const press = (key: string) => {
    setFresh(false);
    if (key === 'Backspace') setExpression((e) => (fresh ? '' : e.slice(0, -1)));
    else if (/^[0-9,]$/.test(key) && fresh) setExpression(key);
    else setExpression((e) => e + key);
  };
  const done = () => {
    if (canSubmit) onDone(result.value);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const key = KEYBOARD[event.key] ?? event.key;
    if (key === 'Enter') done();
    else if (key === 'Backspace' || /^[0-9,+−×÷]$/.test(key)) press(key);
    else return;
    event.preventDefault();
  };

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <div className="rounded-xl bg-raised px-4 py-3 text-right" aria-live="polite">
        <div className="min-h-8 text-2xl font-semibold tabular-nums break-all" data-testid="keypad-expression">
          {formatExpression(expression) || '0'}
        </div>
        <div className={cx('text-sm tabular-nums', result.ok ? 'text-muted' : 'text-red-400')} data-testid="keypad-result">
          {result.ok ? `= ${formatMoney(result.value, currency)}` : result.error}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {KEYS.map(({ key, name }) => (
          <button
            key={key}
            type="button"
            aria-label={name}
            onClick={() => press(key)}
            className={cx(
              'flex min-h-12 items-center justify-center rounded-xl text-xl font-semibold active:bg-white/15',
              /[+−×÷]/.test(key) ? 'bg-zero text-brand' : 'bg-raised text-white',
            )}
          >
            {key === 'Backspace' ? <BackspaceIcon /> : key}
          </button>
        ))}
      </div>
      <Button block mutating={mutating} busy={busy} disabled={!canSubmit} onClick={done}>
        {doneLabel}
      </Button>
    </div>
  );
}
