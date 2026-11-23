import { useState } from 'react';
import type { BudgetCategoryDto, BudgetMonthDto, MoveMoneyRequest } from '../../shared/api/budget';
import { api, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { type FormErrors, formErrorsOf } from '../lib/form-errors';
import { AmountKeypad } from '../ui/amount-keypad';
import { FormError, SegmentedControl } from '../ui/field';
import { CategoryPicker, READY_TO_ASSIGN } from './category-picker';
import { splitHidden } from './view-model';

type Direction = 'out' | 'in';

const DIRECTIONS = [
  { value: 'out', label: 'Move out' },
  { value: 'in', label: 'Move in' },
] as const;

interface MoveMoneyFormProps {
  view: BudgetMonthDto;
  category: BudgetCategoryDto;
  onDone: () => void;
}

/**
 * Spec §11 Move money: to or from another category or Ready to Assign. An overspent category starts on "Move in"
 * with what covers it; any other starts on "Move out" with its Available (both editable on the keypad).
 */
export function MoveMoneyForm({ view, category, onDone }: MoveMoneyFormProps) {
  const [direction, setDirection] = useState<Direction>(category.available < 0 ? 'in' : 'out');
  const [other, setOther] = useState('');
  const [invalid, setInvalid] = useState<FormErrors | null>(null);
  const move = useCommand((body: MoveMoneyRequest) =>
    unwrap(api.api.budget[':month'].move.$post({ param: { month: view.month }, json: body })),
  );
  const errors = invalid ?? formErrorsOf(move.error, ['from', 'to']);
  const start = Math.max(0, direction === 'in' ? -category.available : category.available);

  const send = (amount: number) => {
    if (other === '') {
      setInvalid({ fields: { other: 'Choose where the money goes or comes from.' }, form: null });
      return;
    }
    if (amount <= 0) {
      setInvalid({ fields: {}, form: 'Enter an amount greater than 0.' });
      return;
    }
    setInvalid(null);
    const otherId = other === READY_TO_ASSIGN ? null : other;
    const body: MoveMoneyRequest =
      direction === 'out' ? { from: category.id, to: otherId, amount } : { from: otherId, to: category.id, amount };
    move.mutate(body, { onSuccess: onDone });
  };

  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        label="Direction"
        value={direction}
        options={DIRECTIONS}
        onChange={(value) => {
          setDirection(value);
          setInvalid(null);
        }}
      />
      <CategoryPicker
        label={direction === 'out' ? `From ${category.name} to` : `To ${category.name} from`}
        groups={splitHidden(view).groups}
        include={(c) => c.id !== category.id}
        readyToAssign={{ label: 'Ready to Assign', amount: view.rta.readyToAssign }}
        value={other}
        onChange={(value) => {
          setOther(value);
          setInvalid(null);
        }}
        placeholder="Choose a category"
        error={errors.fields.other ?? errors.fields.from ?? errors.fields.to}
      />
      <FormError message={errors.form} />
      {/* A new key restarts the keypad from the new direction's amount. */}
      <AmountKeypad key={direction} value={start} doneLabel="Move" mutating busy={move.isPending} onDone={send} />
    </div>
  );
}
