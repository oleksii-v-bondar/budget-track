import { useState } from 'react';
import type { BudgetCategoryDto, BudgetGroupDto, BudgetMonthDto } from '../../shared/api/budget';
import { formatMoney } from '../lib/format';
import { cx } from '../ui/cx';
import { ChevronDownIcon } from '../ui/icons';
import { Pill, type PillTone } from '../ui/pill';
import { useCollapsedGroups } from './collapsed-groups';
import { type BudgetFilter, EMPTY_FILTER_MESSAGES, filterBudget } from './filters';
import { categoryHint, HINT_TONES, type HiddenCategory, totalAvailable } from './view-model';

const BAR_TONES: Record<PillTone, string> = {
  green: 'bg-green-500',
  yellow: 'bg-yellow-400',
  red: 'bg-red-500',
  grey: 'bg-zero',
};

/** How far a target is funded (spec §6 progress), as a thin bar under the category's name. */
function TargetProgress({ progress, tone }: { progress: number; tone: PillTone }) {
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <div
      role="progressbar"
      aria-label="Target progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="mt-1 h-1 overflow-hidden rounded-full bg-zero"
    >
      <div className={cx('h-full rounded-full', BAR_TONES[tone])} style={{ width: `${percent}%` }} />
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

/** One budget row: the name, the target or overspending hint, and the Available pill (spec §6 colours). */
function CategoryRow({ category, groupName, onOpen }: CategoryRowProps) {
  const hint = categoryHint(category);
  return (
    <button
      type="button"
      data-testid={`category-${category.id}`}
      aria-haspopup="dialog"
      onClick={() => onOpen(category.id)}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-white/5"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{category.name}</p>
        {groupName && <p className="truncate text-xs text-muted">{groupName}</p>}
        {hint && <p className={cx('truncate text-xs', HINT_TONES[hint.tone])}>{hint.text}</p>}
        {category.targetEvaluation && <TargetProgress progress={category.targetEvaluation.progress} tone={category.pill} />}
      </div>
      <Pill tone={category.pill}>{formatMoney(category.available)}</Pill>
    </button>
  );
}

interface GroupSectionProps {
  group: BudgetGroupDto;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: OnOpen;
}

function GroupSection({ group, collapsed, onToggle, onOpen }: GroupSectionProps) {
  return (
    <section aria-label={group.name} className="border-b border-line">
      <h3>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="flex min-h-11 w-full items-center gap-2 bg-raised px-4 text-left text-sm font-semibold text-gray-200"
        >
          <ChevronDownIcon className={cx('size-4 shrink-0 transition-transform', collapsed && '-rotate-90')} />
          <span className="flex-1 truncate">{group.name}</span>
          <span className="font-normal text-muted tabular-nums">{formatMoney(totalAvailable(group.categories))}</span>
        </button>
      </h3>
      {!collapsed && (
        <ul className="divide-y divide-line">
          {group.categories.map((category) => (
            <li key={category.id}>
              <CategoryRow category={category} onOpen={onOpen} />
            </li>
          ))}
          {group.categories.length === 0 && <li className="px-4 py-2.5 text-sm text-muted">No categories yet.</li>}
        </ul>
      )}
    </section>
  );
}

/** Spec §11: hidden categories sit in their own section at the bottom, closed until opened. */
function HiddenSection({ hidden, onOpen }: { hidden: HiddenCategory[]; onOpen: OnOpen }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Hidden categories" className="border-b border-line">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-sm font-semibold text-muted"
        >
          <ChevronDownIcon className={cx('size-4 shrink-0 transition-transform', !open && '-rotate-90')} />
          <span className="flex-1">Hidden categories ({hidden.length})</span>
        </button>
      </h3>
      {open && (
        <ul className="divide-y divide-line">
          {hidden.map(({ category, groupName }) => (
            <li key={category.id}>
              <CategoryRow category={category} groupName={groupName} onOpen={onOpen} />
            </li>
          ))}
        </ul>
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
      <div className="flex justify-between border-b border-line px-4 py-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
        <span>Category</span>
        <span>Available</span>
      </div>
      {uncategorized && (
        <section aria-label="Uncategorized" className="border-b border-line">
          <CategoryRow category={uncategorized} onOpen={onOpen} />
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
