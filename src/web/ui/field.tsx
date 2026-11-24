import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';
import { cx } from './cx';

/** What every labelled control takes besides its own attributes. */
interface FieldProps {
  label: string;
  /** Shown under the control in red, and announced with it. */
  error?: string | null;
  hint?: ReactNode;
}

export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & FieldProps;
export type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & FieldProps;
export type TextAreaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps;

const controlClass = (error: string | null | undefined) =>
  cx(
    'min-h-11 rounded-xl border bg-raised px-3 text-base text-white outline-none placeholder:text-muted',
    'focus:border-brand focus:ring-2 focus:ring-brand/30 disabled:opacity-60',
    error ? 'border-red-500' : 'border-line',
  );

/** The label above a control, its hint or error underneath, and the ids that tie them together. */
function useField({ label, error, hint }: FieldProps, id: string | undefined, className: string | undefined) {
  const generated = useId();
  const controlId = id ?? generated;
  const noteId = `${controlId}-note`;
  const note = error ?? hint;
  const control = {
    id: controlId,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': note ? noteId : undefined,
    className: controlClass(error),
  };
  const frame = (child: ReactNode) => (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={controlId} className="text-sm font-medium text-gray-200">
        {label}
      </label>
      {child}
      {note && (
        <p id={noteId} className={cx('text-sm', error ? 'text-red-400' : 'text-muted')}>
          {note}
        </p>
      )}
    </div>
  );
  return { control, frame };
}

/** A labelled input with its hint or error underneath. */
export function TextField({ label, error, hint, className, id, ...props }: TextFieldProps) {
  const { control, frame } = useField({ label, error, hint }, id, className);
  return frame(<input {...control} {...props} />);
}

/** A labelled native select (the phone's own picker), with its hint or error underneath. */
export function SelectField({ label, error, hint, className, id, children, ...props }: SelectFieldProps) {
  const { control, frame } = useField({ label, error, hint }, id, className);
  return frame(
    <select {...control} {...props}>
      {children}
    </select>,
  );
}

/** A labelled multi-line text input, e.g. for notes. */
export function TextAreaField({ label, error, hint, className, id, rows = 4, ...props }: TextAreaFieldProps) {
  const { control, frame } = useField({ label, error, hint }, id, className);
  return frame(<textarea {...control} rows={rows} {...props} className={cx(control.className, 'py-2')} />);
}

/** The form-level message of a failed request (see formErrorsOf). */
export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl bg-red-500/15 px-3 py-2 text-sm text-red-300">
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
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-raised p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            'min-h-9 rounded-lg px-3 text-sm font-semibold',
            option.value === value ? 'bg-zero text-white' : 'text-muted',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
