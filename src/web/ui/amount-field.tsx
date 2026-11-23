import { type AmountResult, evaluateAmount } from '../lib/amount-expression';
import { formatMoney } from '../lib/format';
import { TextField, type TextFieldProps } from './field';

export interface AmountFieldProps extends Omit<TextFieldProps, 'value' | 'onChange'> {
  /** What the user typed: an amount in złoty ("1 234,56") or a keypad expression ("400+120"). */
  value: string;
  onChange: (value: string) => void;
  currency?: string;
}

/**
 * A text input for an amount in a form (the keypad is for single amounts in a sheet). It takes the keypad's
 * expressions and shows what the text comes to under it; read the result with `readAmount` when the form is sent.
 */
export function AmountField({ value, onChange, currency = 'PLN', hint, error, ...props }: AmountFieldProps) {
  const result = value.trim() === '' ? null : evaluateAmount(value);
  const live = result?.ok ? `= ${formatMoney(result.value, currency)}` : undefined;
  return (
    <TextField
      inputMode="decimal"
      autoComplete="off"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={error}
      hint={live ?? hint}
      {...props}
    />
  );
}

/** The amount of an AmountField's text, in minor units, or the message to show under it (empty isn't 0 here). */
export function readAmount(text: string): AmountResult {
  if (text.trim() === '') return { ok: false, error: 'Enter an amount.' };
  return evaluateAmount(text);
}
