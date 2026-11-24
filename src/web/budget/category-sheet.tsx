import { useState } from 'react';
import type { BudgetCategoryDto, BudgetMonthDto } from '../../shared/api/budget';
import { api, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { formErrorsOf } from '../lib/form-errors';
import { formatMoney, formatMonth } from '../lib/format';
import { AmountKeypad } from '../ui/amount-keypad';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { FormError } from '../ui/field';
import { Pill } from '../ui/pill';
import { Tabs } from '../ui/tabs';
import { ActivityPanel } from './activity-panel';
import { MoveMoneyForm } from './move-money-form';
import { NoteForm } from './note-form';
import { TargetPanel } from './target-panel';
import { categoryHint, HINT_TONES } from './view-model';

type Tab = 'assign' | 'move' | 'target' | 'activity' | 'note';

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'assign', label: 'Assign' },
  { value: 'move', label: 'Move' },
  { value: 'target', label: 'Target' },
  { value: 'activity', label: 'Activity' },
  { value: 'note', label: 'Note' },
];

/** Uncategorized takes no money, target or note (spec §3): its sheet only lists its transactions. */
const UNCATEGORIZED_TABS: readonly { value: Tab; label: string }[] = [{ value: 'activity', label: 'Activity' }];

interface PanelProps {
  month: string;
  category: BudgetCategoryDto;
  /** After a command succeeded: the sheet closes and the toast offers Undo. */
  onDone: () => void;
}

/** What makes up Available this month (Carry + Assigned + Activity, spec §5.1) and what needs attention. */
function Summary({ month, category }: { month: string; category: BudgetCategoryDto }) {
  const hint = categoryHint(category, { cardNeed: false });
  const need = category.needToPayInFull;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">Available in {formatMonth(month)}</span>
        <Pill tone={category.pill} className="text-base">
          {formatMoney(category.available)}
        </Pill>
      </div>
      <dl className="grid grid-cols-3 gap-2 rounded-xl bg-raised px-3 py-2 text-center text-sm">
        {[
          ['Carried over', category.carry],
          ['Assigned', category.assigned],
          ['Activity', category.activity],
        ].map(([label, amount]) => (
          <div key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="font-semibold tabular-nums">{formatMoney(amount as number)}</dd>
          </div>
        ))}
      </dl>
      {hint && <p className={cx('text-sm', HINT_TONES[hint.tone])}>{hint.text}</p>}
      {need !== null && (
        <p className="text-sm font-medium text-gray-200">
          {need > 0 ? `Need ${formatMoney(need)} to pay in full` : 'Enough to pay the card in full'}
        </p>
      )}
    </div>
  );
}

/** Spec §11 Assign: the keypad sets the category's Assigned for the month (+ − × ÷ allowed). */
function AssignPanel({ month, category, onDone }: PanelProps) {
  const assign = useCommand((amount: number) =>
    unwrap(
      api.api.budget[':month'].assignments[':categoryId'].$put({
        param: { month, categoryId: category.id },
        json: { amount },
      }),
    ),
  );
  const errors = formErrorsOf(assign.error, []);
  return (
    <div className="flex flex-col gap-3">
      <FormError message={errors.form} />
      <AmountKeypad
        value={category.assigned}
        doneLabel="Assign"
        mutating
        busy={assign.isPending}
        // Unchanged: nothing to send (and nothing to undo).
        onDone={(amount) => (amount === category.assigned ? onDone() : assign.mutate(amount, { onSuccess: onDone }))}
      />
    </div>
  );
}

function HideButton({ category, onDone }: Omit<PanelProps, 'month'>) {
  const hide = useCommand((hidden: boolean) =>
    unwrap(api.api.categories[':id'].$patch({ param: { id: category.id }, json: { hidden } })),
  );
  const errors = formErrorsOf(hide.error, []);
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <FormError message={errors.form} />
      <Button variant="ghost" block mutating busy={hide.isPending} onClick={() => hide.mutate(!category.hidden, { onSuccess: onDone })}>
        {category.hidden ? 'Unhide category' : 'Hide category'}
      </Button>
    </div>
  );
}

interface CategorySheetContentProps {
  view: BudgetMonthDto;
  category: BudgetCategoryDto;
  onDone: () => void;
}

/** Spec §11: a category's sheet. It opens on Assign; every command closes it, and its toast offers Undo. */
export function CategorySheetContent({ view, category, onDone }: CategorySheetContentProps) {
  const uncategorized = category.kind === 'uncategorized';
  const [tab, setTab] = useState<Tab>(uncategorized ? 'activity' : 'assign');
  const panel = { month: view.month, category, onDone };
  return (
    <div className="flex flex-col gap-4">
      <Summary month={view.month} category={category} />
      <Tabs label={category.name} value={tab} tabs={uncategorized ? UNCATEGORIZED_TABS : TABS} onChange={setTab}>
        {tab === 'assign' && <AssignPanel {...panel} />}
        {tab === 'move' && <MoveMoneyForm view={view} category={category} onDone={onDone} />}
        {tab === 'target' && <TargetPanel view={view} category={category} onDone={onDone} />}
        {tab === 'activity' && <ActivityPanel month={view.month} category={category} />}
        {tab === 'note' && (
          <NoteForm
            label="Note"
            initial={category.note}
            send={(note) => unwrap(api.api.categories[':id'].$patch({ param: { id: category.id }, json: { note } }))}
            onDone={onDone}
          />
        )}
      </Tabs>
      {!uncategorized && <HideButton category={category} onDone={onDone} />}
    </div>
  );
}
