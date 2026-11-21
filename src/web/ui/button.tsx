import type { ButtonHTMLAttributes } from 'react';
import { useOnline } from '../lib/online';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** It sends a request that changes data: disabled while offline (spec §11 "Offline"). */
  mutating?: boolean;
  /** A request is running: disabled, with a spinner. */
  busy?: boolean;
  /** Full width. */
  block?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-dark disabled:bg-gray-300',
  secondary: 'bg-white text-gray-900 ring-1 ring-gray-300 hover:bg-gray-50 disabled:text-gray-400',
  ghost: 'text-brand hover:bg-brand-light disabled:text-gray-400 disabled:hover:bg-transparent',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-gray-300',
};

/** The kit's button. It is `type="button"` unless told otherwise, so only an explicit submit button submits a form. */
export function Button({
  variant = 'primary',
  mutating = false,
  busy = false,
  block = false,
  disabled,
  className,
  type = 'button',
  title,
  children,
  ...props
}: ButtonProps) {
  const online = useOnline();
  const offline = mutating && !online;
  return (
    <button
      type={type}
      disabled={disabled || busy || offline}
      aria-busy={busy || undefined}
      title={offline ? "You're offline" : title}
      className={cx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed',
        VARIANTS[variant],
        block && 'w-full',
        className,
      )}
      {...props}
    >
      {busy && (
        <span
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
}
