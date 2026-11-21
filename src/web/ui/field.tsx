import { type InputHTMLAttributes, type ReactNode, useId } from 'react';
import { cx } from './cx';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Shown under the input in red, and announced with it. */
  error?: string | null;
  hint?: ReactNode;
}

/** A labelled input with its hint or error underneath. */
export function TextField({ label, error, hint, className, id, ...props }: TextFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const noteId = `${inputId}-note`;
  const note = error ?? hint;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
        className={cx(
          'min-h-11 rounded-xl border bg-white px-3 text-base text-gray-900 outline-none',
          'focus:border-brand focus:ring-2 focus:ring-brand/30 disabled:bg-gray-100',
          error ? 'border-red-500' : 'border-gray-300',
        )}
        {...props}
      />
      {note && (
        <p id={noteId} className={cx('text-sm', error ? 'text-red-600' : 'text-gray-500')}>
          {note}
        </p>
      )}
    </div>
  );
}

/** The form-level message of a failed request (see formErrorsOf). */
export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </p>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
}

export function Checkbox({ label, className, ...props }: CheckboxProps) {
  return (
    <label className={cx('flex min-h-11 items-center gap-3 text-base', className)}>
      <input type="checkbox" className="size-5 accent-brand" {...props} />
      <span>{label}</span>
    </label>
  );
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

/** Two or three mutually exclusive choices side by side (e.g. Outflow / Inflow). */
export function SegmentedControl<T extends string>({ label, value, options, onChange }: SegmentedControlProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-gray-200 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            'min-h-9 rounded-lg px-3 text-sm font-semibold',
            option.value === value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
