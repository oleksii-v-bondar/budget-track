import { useId } from 'react';
import type { BudgetMonthDto } from '../../shared/api/budget';
import { formatMoney } from '../lib/format';
import { cx } from '../ui/cx';
import { AutoAssignList } from './auto-assign';

function Line({ label, amount, total }: { label: string; amount: number; total?: boolean }) {
  return (
    <div className={cx('flex justify-between gap-4 py-1.5', total && 'border-t border-gray-200 pt-2 font-semibold')}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{formatMoney(amount)}</dd>
    </div>
  );
}

/** Spec §5.4 and §11: how Ready to Assign comes about this month, and auto-assign for every visible category. */
export function RtaSheetContent({ view, onDone }: { view: BudgetMonthDto; onDone: () => void }) {
  const { rta } = view;
  const headingId = useId();
  return (
    <div className="flex flex-col gap-6">
      <dl className="text-gray-700">
        <Line label="Left over from last month" amount={rta.leftoverPrev} />
        <Line label="Income this month" amount={rta.income} />
        <Line label="Assigned this month" amount={-rta.assignedThisMonth} />
        <Line label="Assigned in future months" amount={-rta.assignedFuture} />
        <Line label="Cash overspent last month" amount={-rta.cashOverspentPrev} />
        <Line label="Ready to Assign" amount={rta.readyToAssign} total />
      </dl>
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <h3 id={headingId} className="font-semibold">
          Auto-assign all
        </h3>
        <AutoAssignList month={view.month} onDone={onDone} />
      </section>
    </div>
  );
}
