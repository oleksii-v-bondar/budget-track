import { type ReactNode, useState } from 'react';
import type { BudgetCategoryDto, BudgetGroupDto, BudgetMonthDto } from '../../shared/api/budget';
import { formatMoney } from '../lib/format';
import { cx } from '../ui/cx';
import { ChevronDownIcon } from '../ui/icons';
import { Pill } from '../ui/pill';
import { useCollapsedGroups } from './collapsed-groups';
import { type BudgetFilter, EMPTY_FILTER_MESSAGES, filterBudget } from './filters';
import { type CategoryStatus, categoryStatus, HINT_TONES, type HiddenCategory } from './view-model';

const BAR_TONES: Record<CategoryStatus['bar'], string> = {
  lime: 'bg-lime',
  yellow: 'bg-yellow-400',
  red: 'bg-red-500',
  empty: '',
};

/** The bar under a category's name: how far it is funded, with the part already spent darker. */
function StatusBar({ status }: { status: CategoryStatus }) {
  const filled = status.filled * 100;
  const spent = filled * status.spent;
  return (
    <div aria-hidden="true" className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-zero/70">
      {spent > 0 && <div className="h-full bg-lime-dark" style={{ width: `${spent}%` }} />}
      <div className={cx('h-full', BAR_TONES[status.bar])} style={{ width: `${filled - spent}%` }} />
    </div>
  );
}

/** Opens a category's sheet. */
type OnOpen = (categoryId: string) => void;

interface CategoryRowProps {
  category: BudgetCategoryDto;
  /** Shown in the hidden section. */
  groupName?: string;
  onOpen: OnOpen;
}

/** One budget row: the name and the Available pill (spec §6 colours), the bar and the status line. */
function CategoryRow({ category, groupName, onOpen }: CategoryRowProps) {
  const status = categoryStatus(category);
  return (
    <button
      type="button"
      data-testid={`category-${category.id}`}
      aria-haspopup="dialog"
      onClick={() => onOpen(category.id)}
      className="block w-full py-3 text-left"
    >
      <span className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-[17px]">{category.name}</span>
        <Pill tone={category.pill}>{formatMoney(category.available)}</Pill>
      </span>
      {groupName && <span className="block truncate text-xs text-muted">{groupName}</span>}
      <StatusBar status={status} />
      {status.text && (
        <span className={cx('mt-1.5 block truncate text-[15px]', HINT_TONES[status.tone])}>{status.text}</span>
      )}
    </button>
  );
}

function CategoryRows({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-line bg-surface px-4">{children}</ul>;
}

const HEADER_BUTTON = 'flex min-h-16 w-full items-center gap-3 border-y border-line bg-header px-4 text-left';

interface GroupSectionProps {
  group: BudgetGroupDto;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: OnOpen;
}

function GroupSection({ group, collapsed, onToggle, onOpen }: GroupSectionProps) {
  return (
    <section aria-label={group.name}>
      <h3>
        <button type="button" aria-expanded={!collapsed} onClick={onToggle} className={HEADER_BUTTON}>
          <ChevronDownIcon className={cx('size-5 shrink-0 transition-transform', collapsed && '-rotate-90')} />
          <span className="flex-1 truncate text-lg font-bold">{group.name}</span>
          <span aria-hidden="true" className="text-right text-sm leading-tight font-medium">
            Available
            <br />
            to Spend
          </span>
        </button>
      </h3>
      {!collapsed && (
        <CategoryRows>
          {group.categories.map((category) => (
            <li key={category.id}>
              <CategoryRow category={category} onOpen={onOpen} />
            </li>
          ))}
          {group.categories.length === 0 && <li className="py-3 text-sm text-muted">No categories yet.</li>}
        </CategoryRows>
      )}
    </section>
  );
}

/** Spec §11: hidden categories sit in their own section at the bottom, closed until opened. */
function HiddenSection({ hidden, onOpen }: { hidden: HiddenCategory[]; onOpen: OnOpen }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Hidden categories">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={cx(HEADER_BUTTON, 'text-muted')}
        >
          <ChevronDownIcon className={cx('size-5 shrink-0 transition-transform', !open && '-rotate-90')} />
          <span className="flex-1 font-semibold">Hidden categories ({hidden.length})</span>
        </button>
      </h3>
      {open && (
        <CategoryRows>
          {hidden.map(({ category, groupName }) => (
            <li key={category.id}>
              <CategoryRow category={category} groupName={groupName} onOpen={onOpen} />
            </li>
          ))}
        </CategoryRows>
      )}
    </section>
  );
}

/** The month's categories by group (spec §11), Uncategorized first while it has activity or money. */
export function CategoryList({ view, filter, onOpen }: { view: BudgetMonthDto; filter: BudgetFilter; onOpen: OnOpen }) {
  const { uncategorized, groups, hidden } = filterBudget(view, filter);
  const collapsed = useCollapsedGroups();
  return (
    <div>
      {uncategorized && (
        <section aria-label="Uncategorized" className="border-t border-line">
          <CategoryRows>
            <li>
              <CategoryRow category={uncategorized} onOpen={onOpen} />
            </li>
          </CategoryRows>
        </section>
      )}
      {groups.map((group) => (
        <GroupSection
          key={group.id}
          group={group}
          collapsed={collapsed.isCollapsed(group.id)}
          onToggle={() => collapsed.toggle(group.id)}
          onOpen={onOpen}
        />
      ))}
      {groups.length === 0 && !uncategorized && (
        <p className="px-4 py-8 text-center text-muted">{EMPTY_FILTER_MESSAGES[filter]}</p>
      )}
      {hidden.length > 0 && <HiddenSection hidden={hidden} onOpen={onOpen} />}
    </div>
  );
}
