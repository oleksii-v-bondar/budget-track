import { type KeyboardEvent, useId, useState } from 'react';
import type { AccountDto } from '../../shared/api/accounts';
import type { PayeeDto } from '../../shared/api/payees';
import { cx } from '../ui/cx';
import type { PayeeValue } from './form-model';

type Option = { kind: 'create'; name: string } | { kind: 'payee'; payee: PayeeDto };

export interface PayeeFieldProps {
  label: string;
  /** The accessible name when it says more than the label (e.g. "Line 2 payee"). */
  name?: string;
  value: PayeeValue;
  onChange: (value: PayeeValue) => void;
  payees: PayeeDto[];
  accounts: AccountDto[];
  /** The transaction's account: its own transfer payee isn't offered. */
  accountId: string;
  /** Offer "Create …" for a new name (split lines take existing payees only). */
  allowNew?: boolean;
  /** Which transfer payees to offer (e.g. split lines: same-currency accounts only). */
  transferFilter?: (account: AccountDto) => boolean;
  error?: string;
}

const MAX_MATCHES = 8;

/**
 * Spec §11 payee autocomplete: matching payees, "Transfer : <Account>" payees of the other open accounts, and
 * "Create …" for a name that doesn't exist yet (the server creates it with the transaction).
 */
export function PayeeField({
  label,
  name = label,
  value,
  onChange,
  payees,
  accounts,
  accountId,
  allowNew = true,
  transferFilter = () => true,
  error,
}: PayeeFieldProps) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState(value.kind === 'none' ? '' : value.name);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const query = text.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(query);
  const openAccounts = new Map(accounts.filter((a) => !a.closed && a.id !== accountId && transferFilter(a)).map((a) => [a.id, a]));
  const user = payees.filter((p) => p.kind === 'user' && matches(p.name)).slice(0, MAX_MATCHES);
  const transfers = payees.filter((p) => p.kind === 'transfer' && openAccounts.has(p.transferAccountId ?? '') && matches(p.name));
  const exact = payees.some((p) => p.kind === 'user' && p.name.toLowerCase() === query);
  const options: Option[] = [
    ...[...user, ...transfers].map((payee) => ({ kind: 'payee' as const, payee })),
    ...(allowNew && query !== '' && !exact ? [{ kind: 'create' as const, name: text.trim() }] : []),
  ];

  const choose = (option: Option) => {
    if (option.kind === 'create') {
      onChange({ kind: 'new', name: option.name });
      setText(option.name);
    } else {
      onChange({ kind: 'existing', id: option.payee.id, name: option.payee.name });
      setText(option.payee.name);
    }
    setOpen(false);
  };
  const type = (next: string) => {
    setText(next);
    setOpen(true);
    setActive(0);
    const trimmed = next.trim();
    const same = payees.find((p) => p.kind === 'user' && p.name.toLowerCase() === trimmed.toLowerCase());
    if (trimmed === '') onChange({ kind: 'none' });
    else if (same) onChange({ kind: 'existing', id: same.id, name: same.name });
    else onChange(allowNew ? { kind: 'new', name: trimmed } : { kind: 'none' });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open || options.length === 0) return;
    if (event.key === 'ArrowDown') setActive((i) => (i + 1) % options.length);
    else if (event.key === 'ArrowUp') setActive((i) => (i - 1 + options.length) % options.length);
    else if (event.key === 'Enter') choose(options[active] ?? options[0]!);
    else if (event.key === 'Escape') setOpen(false);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="relative flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-gray-200">
        {label}
      </label>
      <input
        id={id}
        role="combobox"
        aria-label={name === label ? undefined : name}
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${id}-option-${active}` : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        autoComplete="off"
        value={text}
        placeholder="Who did you pay, or who paid you?"
        onChange={(event) => type(event.target.value)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className={cx(
          'min-h-11 rounded-xl border bg-surface px-3 text-base text-white outline-none',
          'focus:border-brand focus:ring-2 focus:ring-brand/30',
          error ? 'border-red-500' : 'border-line',
        )}
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-red-400">
          {error}
        </p>
      )}
      {open && options.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${name} suggestions`}
          className="absolute top-full z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-xl bg-surface py-1 shadow-lg ring-1 ring-line"
        >
          {options.map((option, index) => (
            <li
              key={option.kind === 'create' ? 'create' : option.payee.id}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === active}
              // Keep the focus in the input, so choosing doesn't blur (and close) the list first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
              className={cx('cursor-pointer px-3 py-2', index === active && 'bg-brand-light')}
            >
              {option.kind === 'create' ? `Create "${option.name}"` : option.payee.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
