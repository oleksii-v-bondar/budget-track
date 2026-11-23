import { type FormEvent, useState } from 'react';
import type { CategoryGroupDto } from '../../shared/api/categories';
import type { PayeeDto } from '../../shared/api/payees';
import { CLEARED_STATUSES, FLAG_COLORS } from '../../shared/api/transactions';
import { amountToExpression } from '../lib/amount-expression';
import { formatDate, parseDate } from '../lib/format';
import { choosablePayees, RTA_LABEL, systemCategory, usableGroups } from '../transactions/lookups';
import { AmountField, readAmount } from '../ui/amount-field';
import { Button } from '../ui/button';
import { Checkbox, SelectField, TextField } from '../ui/field';
import type { RegisterFilters } from './filters';

interface Values {
  from: string;
  to: string;
  minAmount: string;
  maxAmount: string;
  categoryId: string;
  payeeId: string;
  flag: string;
  cleared: string;
  unapproved: boolean;
}

const valuesOf = (filters: RegisterFilters): Values => ({
  from: filters.from ? formatDate(filters.from) : '',
  to: filters.to ? formatDate(filters.to) : '',
  minAmount: filters.minAmount === undefined ? '' : amountToExpression(filters.minAmount),
  maxAmount: filters.maxAmount === undefined ? '' : amountToExpression(filters.maxAmount),
  categoryId: filters.categoryId ?? '',
  payeeId: filters.payeeId ?? '',
  flag: filters.flag ?? '',
  cleared: filters.cleared ?? '',
  unapproved: filters.unapproved ?? false,
});

const label = (word: string) => `${word[0]!.toUpperCase()}${word.slice(1)}`;

/** Spec §10 register filters: date range, amount range, category, payee, flag, cleared state, unapproved. */
export function FilterForm({
  filters,
  groups,
  payees,
  onApply,
}: {
  filters: RegisterFilters;
  groups: CategoryGroupDto[];
  payees: PayeeDto[];
  onApply: (filters: RegisterFilters) => void;
}) {
  const [values, setValues] = useState(() => valuesOf(filters));
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({});
  const set = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));
  const rta = systemCategory(groups, 'rta');
  const uncategorized = systemCategory(groups, 'uncategorized');
  const { user, transfer } = choosablePayees(payees);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: RegisterFilters = { q: filters.q };
    const problems: typeof errors = {};
    for (const key of ['from', 'to'] as const) {
      if (values[key].trim() === '') continue;
      const date = parseDate(values[key]);
      if (date === null) problems[key] = 'Enter a date as dd.mm.yyyy.';
      else next[key] = date;
    }
    if (next.from && next.to && next.from > next.to) problems.to = 'The end date must not be before the start date.';
    for (const key of ['minAmount', 'maxAmount'] as const) {
      if (values[key].trim() === '') continue;
      const amount = readAmount(values[key]);
      if (amount.ok) next[key] = amount.value;
      else problems[key] = amount.error;
    }
    if (next.minAmount !== undefined && next.maxAmount !== undefined && next.minAmount > next.maxAmount) {
      problems.maxAmount = 'The largest amount must not be below the smallest.';
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    if (values.categoryId) next.categoryId = values.categoryId;
    if (values.payeeId) next.payeeId = values.payeeId;
    if (values.flag) next.flag = values.flag as RegisterFilters['flag'];
    if (values.cleared) next.cleared = values.cleared as RegisterFilters['cleared'];
    if (values.unapproved) next.unapproved = true;
    onApply(next);
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <TextField label="From" value={values.from} onChange={(e) => set({ from: e.target.value })} error={errors.from} hint="dd.mm.yyyy" inputMode="numeric" />
        <TextField label="To" value={values.to} onChange={(e) => set({ to: e.target.value })} error={errors.to} hint="dd.mm.yyyy" inputMode="numeric" />
        <AmountField label="Amount from" value={values.minAmount} onChange={(minAmount) => set({ minAmount })} error={errors.minAmount} />
        <AmountField label="Amount to" value={values.maxAmount} onChange={(maxAmount) => set({ maxAmount })} error={errors.maxAmount} />
      </div>
      <p className="-mt-2 text-sm text-gray-500">Amounts are in each account's currency; outflows are negative.</p>
      <SelectField label="Category" value={values.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
        <option value="">Any category</option>
        {rta && <option value={rta.id}>{RTA_LABEL}</option>}
        {uncategorized && <option value={uncategorized.id}>Uncategorized</option>}
        {usableGroups(groups).map((group) => (
          <optgroup key={group.id} label={group.name}>
            {group.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </optgroup>
        ))}
      </SelectField>
      <SelectField label="Payee" value={values.payeeId} onChange={(e) => set({ payeeId: e.target.value })}>
        <option value="">Any payee</option>
        {user.map((payee) => (
          <option key={payee.id} value={payee.id}>
            {payee.name}
          </option>
        ))}
        {transfer.length > 0 && (
          <optgroup label="Transfers">
            {transfer.map((payee) => (
              <option key={payee.id} value={payee.id}>
                {payee.name}
              </option>
            ))}
          </optgroup>
        )}
      </SelectField>
      <div className="grid grid-cols-2 gap-3">
        <SelectField label="Flag" value={values.flag} onChange={(e) => set({ flag: e.target.value })}>
          <option value="">Any flag</option>
          {FLAG_COLORS.map((flag) => (
            <option key={flag} value={flag}>
              {label(flag)}
            </option>
          ))}
        </SelectField>
        <SelectField label="Status" value={values.cleared} onChange={(e) => set({ cleared: e.target.value })}>
          <option value="">Any status</option>
          {CLEARED_STATUSES.map((status) => (
            <option key={status} value={status}>
              {label(status)}
            </option>
          ))}
        </SelectField>
      </div>
      <Checkbox label="Only unapproved" checked={values.unapproved} onChange={(e) => set({ unapproved: e.target.checked })} />
      <div className="flex gap-3">
        <Button variant="secondary" className="flex-1" onClick={() => onApply({ q: filters.q })}>
          Clear filters
        </Button>
        <Button type="submit" className="flex-1">
          Show transactions
        </Button>
      </div>
    </form>
  );
}
