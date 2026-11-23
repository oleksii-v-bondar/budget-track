import { type ReactNode, useState } from 'react';
import type { BudgetMonthDto, PillColor } from '../../shared/api/budget';
import type { CategoryDto, CategoryGroupDto } from '../../shared/api/categories';
import { formatMoney } from '../lib/format';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { Pill } from '../ui/pill';
import { RTA_LABEL, systemCategory, usableGroups } from './lookups';

export interface CategoryPickerProps {
  /** GET /api/categories */
  groups: CategoryGroupDto[];
  /** The budget of the transaction's month, for each category's Available; undefined while (or if not) loaded. */
  month: BudgetMonthDto | undefined;
  value: string | null;
  /** Offer "No category" (a budget transaction without one counts as Uncategorized). */
  allowNone: boolean;
  onPick: (categoryId: string | null) => void;
  onCancel: () => void;
}

const rtaTone = (amount: number): PillColor => (amount > 0 ? 'green' : amount < 0 ? 'red' : 'grey');

/**
 * Spec §11 category picker: "Inflow: Ready to Assign", then the regular categories (and loans' paired ones) by group
 * with their Available in the transaction's month; hidden categories last. Credit card payment categories and
 * Uncategorized are never offered (spec §5.5).
 */
export function CategoryPicker({ groups, month, value, allowNone, onPick, onCancel }: CategoryPickerProps) {
  const [search, setSearch] = useState('');
  const available = new Map(month?.groups.flatMap((g) => g.categories.map((c) => [c.id, c] as const)) ?? []);
  const query = search.trim().toLowerCase();
  const rta = systemCategory(groups, 'rta');
  const visible = (category: CategoryDto) => category.name.toLowerCase().includes(query);
  const sections = usableGroups(groups)
    .map((group) => ({ ...group, categories: group.categories.filter((c) => !c.hidden && !group.hidden && visible(c)) }))
    .filter((group) => group.categories.length > 0);
  const hidden = usableGroups(groups).flatMap((group) => group.categories.filter((c) => (c.hidden || group.hidden) && visible(c)));

  const option = (id: string | null, name: string, amount: { available: number; pill: PillColor } | undefined) => (
    <li
      key={id ?? 'none'}
      role="option"
      aria-selected={id === value}
      tabIndex={0}
      onClick={() => onPick(id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onPick(id);
        }
      }}
      className={cx(
        'flex min-h-12 cursor-pointer items-center justify-between gap-3 px-4 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none',
        id === value && 'font-semibold text-brand',
      )}
    >
      <span className="min-w-0 truncate">{name}</span>
      {amount && <Pill tone={amount.pill}>{formatMoney(amount.available)}</Pill>}
    </li>
  );
  const group = (key: string, title: string, items: ReactNode[]) => (
    <li key={key} role="presentation">
      <p className="bg-gray-100 px-4 py-1 text-xs font-semibold tracking-wide text-gray-500 uppercase" aria-hidden="true">
        {title}
      </p>
      <ul role="group" aria-label={title}>
        {items}
      </ul>
    </li>
  );

  return (
    <div className="flex flex-col gap-3">
      <input
        type="search"
        aria-label="Search categories"
        placeholder="Search categories"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="min-h-11 rounded-xl border border-gray-300 bg-gray-50 px-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
      />
      <ul role="listbox" aria-label="Categories" className="-mx-4 divide-y divide-gray-100">
        {allowNone && value !== null && query === '' && option(null, 'No category', undefined)}
        {rta &&
          visible({ ...rta, name: RTA_LABEL }) &&
          option(rta.id, RTA_LABEL, month && { available: month.rta.readyToAssign, pill: rtaTone(month.rta.readyToAssign) })}
        {sections.map((section) =>
          group(
            section.id,
            section.name,
            section.categories.map((c) => option(c.id, c.name, available.get(c.id))),
          ),
        )}
        {hidden.length > 0 &&
          group(
            'hidden',
            'Hidden categories',
            hidden.map((c) => option(c.id, c.name, available.get(c.id))),
          )}
      </ul>
      <Button variant="secondary" block onClick={onCancel}>
        Back
      </Button>
    </div>
  );
}
