import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { BudgetCategoryDto, BudgetGroupDto, BudgetMonthDto } from '../../shared/api/budget';
import { api, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { formErrorsOf } from '../lib/form-errors';
import { formatMoney, formatMonth } from '../lib/format';
import { useOnline } from '../lib/online';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { FormError } from '../ui/field';
import {
  CheckIcon,
  FolderPlusIcon,
  GripIcon,
  MoreCircleIcon,
  PencilIcon,
  PlusCircleIcon,
  ReorderIcon,
} from '../ui/icons';
import { Sheet } from '../ui/sheet';
import { budgetSettingsQuery } from './budget-api';
import { AddCategoryForm, AddGroupForm, EditCategoryForm, IncomeForm, RenameGroupForm } from './edit-sheets';
import { costToBeMe, monthlyTargetAmount, targetCadenceLabel } from './plan-targets';
import { reorderOnDragEnd } from './reorder';
import { splitHidden } from './view-model';

/** Touch, mouse and keyboard (Space, arrows, Space). A drag starts only from a handle. */
function useReorderSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/**
 * The order shown while a reorder is on its way: the dropped order until the server has answered and the month view
 * is fresh (no optimistic cache update; on failure the old order comes back).
 */
function useReorder(send: (ids: string[]) => Promise<unknown>) {
  const [pending, setPending] = useState<string[] | null>(null);
  const reorder = useCommand(send);
  const errors = formErrorsOf(reorder.error, []);
  const run = (ids: string[]) => {
    setPending(ids);
    reorder.mutate(ids, { onSettled: () => setPending(null) });
  };
  const ordered = <T extends { id: string }>(items: T[]) =>
    pending ? pending.flatMap((id) => items.filter((item) => item.id === id)) : items;
  return { run, ordered, busy: reorder.isPending, error: errors.form };
}

interface SortableProps {
  id: string;
  label: string;
  className?: string;
  children: (handle: ReactNode) => ReactNode;
}

function Sortable({ id, label, className, children }: SortableProps) {
  const online = useOnline();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !online,
  });
  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      aria-label={`Reorder ${label}`}
      disabled={!online}
      className="flex size-11 shrink-0 cursor-grab touch-none items-center justify-center text-muted disabled:cursor-not-allowed"
    >
      <GripIcon className="size-5" />
    </button>
  );
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx('relative', className, isDragging && 'z-10 shadow-lg')}
    >
      {children(handle)}
    </li>
  );
}

interface ReorderListProps<T extends { id: string; name: string }> {
  label: string;
  /** The rows shown, in order. */
  items: T[];
  /** Every id the reorder API wants (hidden rows too), in order; a drop moves the dragged id among them. */
  allIds: string[];
  send: (ids: string[]) => Promise<unknown>;
  /** Drag handles are passed to `children` only in reorder mode (null otherwise). */
  reordering: boolean;
  className?: string;
  itemClassName?: string;
  children: (item: T, handle: ReactNode) => ReactNode;
}

/** A list whose rows can be dragged by their handles (dnd-kit) in reorder mode. */
function ReorderList<T extends { id: string; name: string }>(props: ReorderListProps<T>) {
  const { label, items, allIds, send, reordering, className, itemClassName, children } = props;
  const sensors = useReorderSensors();
  const reorder = useReorder(send);
  const shown = reorder.ordered(items);
  const list = (
    <ul aria-label={label} aria-busy={reorder.busy || undefined} className={className}>
      {shown.map((item) =>
        reordering ? (
          <Sortable key={item.id} id={item.id} label={item.name} className={itemClassName}>
            {(handle) => children(item, handle)}
          </Sortable>
        ) : (
          <li key={item.id} className={itemClassName}>
            {children(item, null)}
          </li>
        ),
      )}
    </ul>
  );
  return (
    <>
      <FormError message={reorder.error} />
      {reordering ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderOnDragEnd(allIds, reorder.run)}>
          <SortableContext items={shown.map((item) => item.id)} strategy={verticalListSortingStrategy}>
            {list}
          </SortableContext>
        </DndContext>
      ) : (
        list
      )}
    </>
  );
}

type Editing =
  | { type: 'add-group' }
  | { type: 'rename-group'; group: BudgetGroupDto }
  | { type: 'add-category'; group: BudgetGroupDto }
  | { type: 'category'; category: BudgetCategoryDto; group: BudgetGroupDto }
  | { type: 'income' }
  | null;

const ICON_BUTTON = 'flex size-11 shrink-0 items-center justify-center rounded-full text-gray-300 hover:bg-white/10';
const MENU_ITEM =
  'flex min-h-11 w-full items-center rounded-xl px-3 text-left text-base hover:bg-white/10 disabled:text-muted disabled:hover:bg-transparent';

interface MenuAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** The ⋯ button and its menu (Escape or a tap outside closes it). Every action sends a command: off while offline. */
function ActionMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const online = useOnline();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={ICON_BUTTON}
      >
        <MoreCircleIcon className="size-7" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            ref={menu}
            role="menu"
            aria-label={label}
            className="absolute top-full right-0 z-50 mt-1 flex w-48 flex-col rounded-2xl bg-raised p-1.5 shadow-2xl ring-1 ring-line"
          >
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                disabled={!online}
                title={online ? undefined : "You're offline"}
                className={cx(MENU_ITEM, action.danger && 'text-red-400')}
                onClick={() => {
                  setOpen(false);
                  action.onSelect();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface CategoryRowProps {
  category: BudgetCategoryDto;
  month: string;
  /** In reorder mode: the drag handle; the row then opens nothing. */
  handle: ReactNode;
  onOpen: () => void;
}

/** A category and what its target costs a month ("No target" without one), with the target's cadence under it. */
function CategoryRow({ category, month, handle, onOpen }: CategoryRowProps) {
  const amount = monthlyTargetAmount(category, month);
  const cadence = category.target && targetCadenceLabel(category.target);
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate text-[17px]">{category.name}</span>
      <span className="flex shrink-0 flex-col items-end text-right tabular-nums">
        {amount === null ? (
          <span className="text-muted">No target</span>
        ) : (
          <span className="text-[17px] text-gray-300">{formatMoney(amount)}</span>
        )}
        {cadence && <span className="text-sm text-muted">{cadence}</span>}
      </span>
    </>
  );
  if (handle) return <div className="flex min-h-16 items-center gap-3 py-2 pr-2 pl-5">{content}{handle}</div>;
  return (
    <button
      type="button"
      data-testid={`plan-row-${category.id}`}
      aria-haspopup="dialog"
      onClick={onOpen}
      className="flex min-h-16 w-full items-center gap-3 px-5 py-2 text-left hover:bg-white/5"
    >
      {content}
    </button>
  );
}

interface GroupSectionProps {
  /** The group as shown: its visible categories. */
  group: BudgetGroupDto;
  /** Every live category of the group (hidden ones too), for the reorder API. */
  allCategoryIds: string[];
  month: string;
  reordering: boolean;
  handle: ReactNode;
  onEdit: (editing: Editing) => void;
}

/**
 * A group: its name with ⊕ (add a category, your own groups only) and ⋯ (rename and delete your own groups, hide
 * any), then its categories in a card. The server's refusal (e.g. deleting a group that isn't empty) shows under it.
 */
function GroupSection({ group, allCategoryIds, month, reordering, handle, onEdit }: GroupSectionProps) {
  const own = group.kind === 'normal';
  const id = { param: { id: group.id } };
  const hide = useCommand(() => unwrap(api.api['category-groups'][':id'].$patch({ ...id, json: { hidden: true } })));
  const remove = useCommand(() => unwrap(api.api['category-groups'][':id'].$delete(id)));
  const failed = remove.error ?? hide.error;
  const actions: MenuAction[] = [
    ...(own ? [{ label: 'Rename', onSelect: () => onEdit({ type: 'rename-group', group }) }] : []),
    { label: 'Hide', onSelect: () => hide.mutate() },
    ...(own ? [{ label: 'Delete', danger: true, onSelect: () => remove.mutate() }] : []),
  ];
  return (
    <section aria-label={group.name} className="px-4 pt-6">
      <div className="flex min-h-11 items-center gap-1 pl-1">
        <h2 className="min-w-0 flex-1 truncate text-lg font-bold">{group.name}</h2>
        {reordering ? (
          handle
        ) : (
          <>
            {own && (
              <button
                type="button"
                aria-label={`Add a category to ${group.name}`}
                aria-haspopup="dialog"
                onClick={() => onEdit({ type: 'add-category', group })}
                className={ICON_BUTTON}
              >
                <PlusCircleIcon className="size-7" />
              </button>
            )}
            <ActionMenu label={`Actions for ${group.name}`} actions={actions} />
          </>
        )}
      </div>
      {failed && (
        <div className="mt-2">
          <FormError message={formErrorsOf(failed, []).form} />
        </div>
      )}
      <div className="mt-2 overflow-hidden rounded-3xl bg-raised">
        <ReorderList
          label={`Categories in ${group.name}`}
          items={group.categories}
          allIds={allCategoryIds}
          send={(ids) => unwrap(api.api.categories.order.$put({ json: { groupId: group.id, ids } }))}
          reordering={reordering}
          className="divide-y divide-line"
          itemClassName="bg-raised"
        >
          {(category, categoryHandle) => (
            <CategoryRow
              category={category}
              month={month}
              handle={categoryHandle}
              onOpen={() => onEdit({ type: 'category', category, group })}
            />
          )}
        </ReorderList>
        {group.categories.length === 0 && <p className="px-5 py-4 text-muted">No categories yet.</p>}
      </div>
    </section>
  );
}

function UnhideButton({ name, send }: { name: string; send: () => Promise<unknown> }) {
  const unhide = useCommand(send);
  return (
    <Button
      variant="secondary"
      mutating
      busy={unhide.isPending}
      aria-label={`Unhide ${name}`}
      onClick={() => unhide.mutate()}
      className="min-h-9 shrink-0 px-4 text-sm"
    >
      Unhide
    </Button>
  );
}

/** Spec §11: hidden groups and the hidden categories of shown groups, at the bottom, each with Unhide. */
function HiddenSection({ view, onEdit }: { view: BudgetMonthDto; onEdit: (editing: Editing) => void }) {
  const rows: ReactNode[] = [];
  for (const group of view.groups) {
    if (group.hidden) {
      const count = group.categories.length;
      rows.push(
        <li key={group.id} className="flex min-h-16 items-center gap-3 px-5 py-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[17px]">{group.name}</span>
            <span className="block text-sm text-muted">
              Group · {count} {count === 1 ? 'category' : 'categories'}
            </span>
          </span>
          <UnhideButton
            name={group.name}
            send={() => unwrap(api.api['category-groups'][':id'].$patch({ param: { id: group.id }, json: { hidden: false } }))}
          />
        </li>,
      );
      continue;
    }
    for (const category of group.categories.filter((c) => c.hidden)) {
      rows.push(
        <li key={category.id} className="flex min-h-16 items-center gap-3 px-5 py-2">
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => onEdit({ type: 'category', category, group })}
            className="min-w-0 flex-1 text-left"
          >
            <span className="block truncate text-[17px]">{category.name}</span>
            <span className="block truncate text-sm text-muted">{group.name}</span>
          </button>
          <UnhideButton
            name={category.name}
            send={() => unwrap(api.api.categories[':id'].$patch({ param: { id: category.id }, json: { hidden: false } }))}
          />
        </li>,
      );
    }
  }
  if (rows.length === 0) return null;
  return (
    <section aria-label="Hidden" className="px-4 pt-6">
      <h2 className="pl-1 text-lg font-bold text-muted">Hidden</h2>
      <ul className="mt-2 divide-y divide-line overflow-hidden rounded-3xl bg-raised">{rows}</ul>
    </section>
  );
}

interface SummaryCardProps {
  month: string;
  /** The month's targets (Cost to Be Me). */
  total: number;
  /** The expected monthly income; null while unset. */
  income: number | null;
  /** False while the income is loading. */
  ready: boolean;
  onEditIncome: () => void;
}

/** The month's targets against the expected income: the bar fills with targets ÷ income (at most 100%). */
function SummaryCard({ month, total, income, ready, onEditIncome }: SummaryCardProps) {
  const share = income === null ? 0 : income > 0 ? Math.min(1, total / income) : total > 0 ? 1 : 0;
  const percent = Math.round(share * 100);
  const monthName = formatMonth(month).split(' ')[0];
  return (
    <div className="relative mx-4 -mt-20 flex flex-col gap-3 rounded-3xl bg-[#161a2e] p-5 shadow-2xl ring-1 ring-white/5">
      <div className="flex items-center justify-between gap-3 text-[17px]">
        <span>{monthName}’s Targets</span>
        <span data-testid="targets-total" className="font-semibold text-lime tabular-nums">
          {formatMoney(total)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Targets as a share of income"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-4 overflow-hidden rounded-full bg-zero/40"
      >
        <div className="h-full rounded-full bg-linear-to-r from-income to-[#b5e27a]" style={{ width: `${percent}%` }} />
      </div>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`Monthly Income: ${income === null ? 'Set income' : formatMoney(income)}`}
        disabled={!ready}
        onClick={onEditIncome}
        className="mt-2 flex min-h-11 items-center justify-between gap-3 text-left text-[17px]"
      >
        <span>Monthly Income</span>
        <span className="flex items-center gap-2 font-semibold tabular-nums">
          <PencilIcon className="size-4 text-muted" />
          {income === null ? <span className="text-brand">Set income</span> : formatMoney(income)}
        </span>
      </button>
      <div aria-hidden="true" className="h-4 rounded-full bg-zero" />
    </div>
  );
}

const PILL =
  'flex h-14 items-center justify-center gap-3 rounded-full bg-raised text-lg font-semibold text-white ring-1 ring-white/5 hover:bg-white/10 aria-pressed:bg-brand-light aria-pressed:ring-brand';

/**
 * YNAB's Edit Plan, full screen over the Plan: what the targets cost a month against the expected income, then every
 * group and category to add, rename, move, hide, delete, give a target and (in reorder mode) drag. ✓ leaves reorder
 * mode, then the view.
 */
export function EditPlan({ view, onClose }: { view: BudgetMonthDto; onClose: () => void }) {
  const [editing, setEditing] = useState<Editing>(null);
  const [reordering, setReordering] = useState(false);
  const settings = useQuery(budgetSettingsQuery);
  const income = settings.data?.expectedMonthlyIncome ?? null;
  const total = costToBeMe(view);
  const { groups } = splitHidden(view);
  const close = () => setEditing(null);
  const categoryIds = (groupId: string) =>
    view.groups.find((group) => group.id === groupId)?.categories.map((category) => category.id) ?? [];

  return (
    <section aria-label="Edit Plan" className="fixed inset-0 z-35 overflow-y-auto bg-page">
      <div className="mx-auto max-w-[480px] pb-[max(2rem,env(safe-area-inset-bottom))]">
        <header className="rounded-b-[2.5rem] bg-linear-to-b from-[#17184a] to-[#262a78] px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-28 text-center">
          <div className="grid grid-cols-[3.5rem_1fr_3.5rem] items-center">
            <span />
            <h1 className="text-xl font-bold">
              Edit Plan
            </h1>
            <button
              type="button"
              aria-label={reordering ? 'Done reordering' : 'Done'}
              onClick={reordering ? () => setReordering(false) : onClose}
              className="flex size-14 items-center justify-center rounded-full bg-brand text-white shadow-lg ring-1 ring-white/25 hover:bg-brand-dark"
            >
              <CheckIcon className="size-8" />
            </button>
          </div>
          <p data-testid="cost-to-be-me" className="mt-4 text-5xl font-bold tracking-tight text-gray-300 tabular-nums">
            {formatMoney(total)}
          </p>
          <p className="mt-1 text-lg font-medium text-gray-300">Cost to Be Me</p>
        </header>
        <SummaryCard
          month={view.month}
          total={total}
          income={income}
          ready={!settings.isPending}
          onEditIncome={() => setEditing({ type: 'income' })}
        />
        <div className="mt-5 grid grid-cols-2 gap-3 px-4">
          <button type="button" aria-haspopup="dialog" className={PILL} onClick={() => setEditing({ type: 'add-group' })}>
            <FolderPlusIcon className="size-6" />
            New Group
          </button>
          <button type="button" aria-pressed={reordering} className={PILL} onClick={() => setReordering(!reordering)}>
            <ReorderIcon className="size-6" />
            Reorder
          </button>
        </div>
        <ReorderList
          label="Groups"
          items={groups}
          allIds={view.groups.map((group) => group.id)}
          send={(ids) => unwrap(api.api['category-groups'].order.$put({ json: { ids } }))}
          reordering={reordering}
          itemClassName="bg-page"
        >
          {(group, handle) => (
            <GroupSection
              group={group}
              allCategoryIds={categoryIds(group.id)}
              month={view.month}
              reordering={reordering}
              handle={handle}
              onEdit={setEditing}
            />
          )}
        </ReorderList>
        {groups.length === 0 && <p className="px-4 py-8 text-center text-muted">No groups yet. Tap New Group to add one.</p>}
        <HiddenSection view={view} onEdit={setEditing} />
      </div>

      <Sheet open={editing?.type === 'add-group'} onClose={close} title="New Group">
        <AddGroupForm onDone={close} />
      </Sheet>
      <Sheet
        open={editing?.type === 'add-category'}
        onClose={close}
        title={editing?.type === 'add-category' ? `New category in ${editing.group.name}` : ''}
      >
        {editing?.type === 'add-category' && <AddCategoryForm group={editing.group} onDone={close} />}
      </Sheet>
      <Sheet
        open={editing?.type === 'rename-group'}
        onClose={close}
        title={editing?.type === 'rename-group' ? `Rename ${editing.group.name}` : ''}
      >
        {editing?.type === 'rename-group' && <RenameGroupForm group={editing.group} onDone={close} />}
      </Sheet>
      <Sheet open={editing?.type === 'category'} onClose={close} title={editing?.type === 'category' ? editing.category.name : ''}>
        {editing?.type === 'category' && (
          <EditCategoryForm view={view} category={editing.category} group={editing.group} onDone={close} />
        )}
      </Sheet>
      <Sheet open={editing?.type === 'income'} onClose={close} title="Monthly Income">
        <IncomeForm income={income} onDone={close} />
      </Sheet>
    </section>
  );
}
