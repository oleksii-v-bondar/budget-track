import { type FormEvent, useState } from 'react';
import { monthRange } from '../../engine/dates';
import type { BudgetCategoryDto, BudgetMonthDto } from '../../shared/api/budget';
import { api, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { type FormErrors, formErrorsOf } from '../lib/form-errors';
import { formatMoney, formatMonth } from '../lib/format';
import { AmountField } from '../ui/amount-field';
import { Button } from '../ui/button';
import { FormError, SegmentedControl, SelectField, TextField } from '../ui/field';
import {
  type CustomRepeat,
  describeTarget,
  type SetTargetInput,
  type SpendingCadence,
  TARGET_FIELDS,
  type TargetForm,
  targetForm,
  targetRequestOf,
  takesDebtTargets,
  WEEKDAY_OPTIONS,
} from './target-form';

interface TargetPanelProps {
  view: BudgetMonthDto;
  category: BudgetCategoryDto;
  onDone: () => void;
}

const KINDS = [
  { value: 'spending', label: 'Spending' },
  { value: 'balance', label: 'Balance' },
] as const;
const KINDS_WITH_DEBT = [...KINDS, { value: 'debt', label: 'Debt' }] as const;

const MODES = [
  { value: 'set_aside', label: 'Set aside' },
  { value: 'refill', label: 'Refill' },
] as const;

const MODE_HINTS = {
  set_aside: 'Assign the full amount every time, whatever is left over.',
  refill: 'Top the category up to the amount.',
};

const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));

/** Spec §6: every kind, cadence and debt mode the targets API takes, each with only the fields it uses. */
function TargetEditor({ view, category, onDone }: TargetPanelProps) {
  const target = category.target;
  const [form, setForm] = useState<TargetForm>(() => targetForm(target, category.kind, view.month));
  const [invalid, setInvalid] = useState<FormErrors | null>(null);
  const save = useCommand((json: SetTargetInput) =>
    unwrap(api.api.categories[':id'].target.$put({ param: { id: category.id }, json })),
  );
  const errors = invalid ?? formErrorsOf(save.error, TARGET_FIELDS);
  const set = (changes: Partial<TargetForm>) => {
    setForm({ ...form, ...changes });
    setInvalid(null);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = targetRequestOf(form, target?.startMonth ?? null);
    setInvalid(result.ok ? null : result.errors);
    if (result.ok) save.mutate(result.request, { onSuccess: onDone });
  };
  // The months a target can start in; an older start month stays selectable.
  const months = monthRange(view.firstMonth, view.lastMonth);
  if (!months.includes(form.startMonth)) months.unshift(form.startMonth);
  const dateField = (label: string, hint?: string) => (
    <TextField
      label={label}
      placeholder="dd.mm.yyyy"
      autoComplete="off"
      value={form.dueDate}
      onChange={(event) => set({ dueDate: event.target.value })}
      hint={hint}
      error={errors.fields.dueDate}
    />
  );
  const amountField = (label: string) => (
    <AmountField label={label} value={form.amount} onChange={(amount) => set({ amount })} error={errors.fields.amount} />
  );

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <SegmentedControl
        label="Target type"
        value={form.kind}
        options={takesDebtTargets(category.kind) ? KINDS_WITH_DEBT : KINDS}
        onChange={(kind) => set({ kind })}
      />
      {form.kind === 'spending' && (
        <>
          <SelectField
            label="Repeats"
            value={form.cadence}
            onChange={(event) => set({ cadence: event.target.value as SpendingCadence })}
            error={errors.fields.cadence}
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
            <option value="custom">Custom</option>
          </SelectField>
          {amountField('Amount')}
          {form.cadence === 'weekly' && (
            <SelectField
              label="Due on"
              value={form.dueWeekday}
              onChange={(event) => set({ dueWeekday: event.target.value })}
              error={errors.fields.dueWeekday}
            >
              {WEEKDAY_OPTIONS.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </SelectField>
          )}
          {form.cadence === 'monthly' && (
            <SelectField
              label="Due on day"
              value={form.dueDayOfMonth}
              onChange={(event) => set({ dueDayOfMonth: event.target.value })}
              error={errors.fields.dueDayOfMonth}
            >
              {DAYS.map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
              <option value="">Last day of the month</option>
            </SelectField>
          )}
          {form.cadence === 'yearly' && dateField('Due date', 'The first due date; it repeats every year.')}
          {form.cadence === 'custom' && (
            <>
              {dateField('Due date')}
              <SelectField
                label="Then"
                value={form.repeat}
                onChange={(event) => set({ repeat: event.target.value as CustomRepeat })}
                error={errors.fields.repeatUnit}
              >
                <option value="none">Doesn't repeat</option>
                <option value="month">Repeats every few months</option>
                <option value="year">Repeats every few years</option>
              </SelectField>
              {form.repeat !== 'none' && (
                <TextField
                  label={form.repeat === 'month' ? 'Every how many months' : 'Every how many years'}
                  inputMode="numeric"
                  value={form.repeatEvery}
                  onChange={(event) => set({ repeatEvery: event.target.value })}
                  error={errors.fields.repeatEvery}
                />
              )}
            </>
          )}
          <div className="flex flex-col gap-1">
            <SegmentedControl label="Each time" value={form.mode} options={MODES} onChange={(mode) => set({ mode })} />
            <p className="text-sm text-muted">{MODE_HINTS[form.mode]}</p>
          </div>
        </>
      )}
      {form.kind === 'balance' && (
        <>
          {amountField('Balance to have')}
          {dateField('By date (optional)', 'Leave it empty to save up with no date.')}
        </>
      )}
      {form.kind === 'debt' && (
        <>
          <SelectField
            label="Pay"
            value={form.debtMode}
            onChange={(event) => set({ debtMode: event.target.value as TargetForm['debtMode'] })}
            error={errors.fields.debtMode}
          >
            <option value="min_payment">The minimum payment</option>
            <option value="fixed">A fixed amount each month</option>
            <option value="payoff_by_date">Enough to pay it off by a date</option>
          </SelectField>
          {form.debtMode === 'fixed' && amountField('Amount each month')}
          {form.debtMode === 'payoff_by_date' && dateField('Paid off by')}
        </>
      )}
      <SelectField
        label="Starts in"
        value={form.startMonth}
        onChange={(event) => set({ startMonth: event.target.value })}
        error={errors.fields.startMonth}
      >
        {months.map((month) => (
          <option key={month} value={month}>
            {formatMonth(month)}
          </option>
        ))}
      </SelectField>
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={save.isPending} block>
        Save target
      </Button>
    </form>
  );
}

/** Spec §11 Target: the category's target and how it stands; edit, snooze for this month, or delete it. */
export function TargetPanel({ view, category, onDone }: TargetPanelProps) {
  const [editing, setEditing] = useState(false);
  const target = category.target;
  const id = { param: { id: category.id } };
  const change = useCommand((action: 'snooze' | 'unsnooze' | 'delete'): Promise<unknown> => {
    if (action === 'snooze') return unwrap(api.api.categories[':id'].target.snooze.$post({ ...id, json: { month: view.month } }));
    if (action === 'unsnooze') return unwrap(api.api.categories[':id'].target.snooze.$delete(id));
    return unwrap(api.api.categories[':id'].target.$delete(id));
  });
  const errors = formErrorsOf(change.error, []);

  if (!target || editing) return <TargetEditor view={view} category={category} onDone={onDone} />;
  const evaluation = category.targetEvaluation;
  const snoozed = target.snoozedMonth === view.month;
  const busy = (action: string) => change.isPending && change.variables === action;
  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium">{describeTarget(target)}</p>
      {evaluation ? (
        <p className="text-sm text-muted">
          Needed in {formatMonth(view.month)}: {formatMoney(evaluation.need)}
          {snoozed && ' (snoozed)'}
        </p>
      ) : (
        <p className="text-sm text-muted">It starts in {formatMonth(target.startMonth)}.</p>
      )}
      <FormError message={errors.form} />
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={() => setEditing(true)}>
          Edit target
        </Button>
        <Button
          variant="secondary"
          mutating
          busy={busy('snooze') || busy('unsnooze')}
          onClick={() => change.mutate(snoozed ? 'unsnooze' : 'snooze', { onSuccess: onDone })}
        >
          {snoozed ? 'Unsnooze' : 'Snooze this month'}
        </Button>
      </div>
      <Button variant="ghost" className="text-red-400" mutating busy={busy('delete')} onClick={() => change.mutate('delete', { onSuccess: onDone })}>
        Delete target
      </Button>
    </div>
  );
}
