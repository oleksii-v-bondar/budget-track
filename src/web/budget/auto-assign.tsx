import { AUTO_ASSIGN_STRATEGIES } from '../../shared/api/budget';
import { api, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { formErrorsOf } from '../lib/form-errors';
import { useOnline } from '../lib/online';
import { FormError } from '../ui/field';

type Strategy = (typeof AUTO_ASSIGN_STRATEGIES)[number];

/** Spec §7, in the API's order; the labels match the server's undo labels ("Auto-assign: Underfunded"). */
const STRATEGIES: Record<Strategy, { label: string; description: string }> = {
  underfunded: { label: 'Underfunded', description: 'What targets still need this month, while Ready to Assign lasts.' },
  assigned_last_month: { label: 'Assigned last month', description: 'The same as last month.' },
  spent_last_month: { label: 'Spent last month', description: 'What was spent last month.' },
  average_assigned: { label: 'Average assigned', description: 'The monthly average of the last 12 months.' },
  average_spent: { label: 'Average spent', description: 'What was spent on average in the last 12 months.' },
  reset_available: { label: 'Reset available', description: 'Changes Assigned so that Available is 0.' },
  reset_assigned: { label: 'Reset assigned', description: 'Sets Assigned to 0.' },
};

interface AutoAssignListProps {
  month: string;
  /** After the server has assigned (the toast offers Undo). */
  onDone: () => void;
}

/** Spec §7: one button per strategy for every visible category; each run is one undoable command. */
export function AutoAssignList({ month, onDone }: AutoAssignListProps) {
  const online = useOnline();
  const run = useCommand((strategy: Strategy) =>
    unwrap(api.api.budget[':month']['auto-assign'].$post({ param: { month }, json: { strategy, scope: { type: 'all' } } })),
  );
  const errors = formErrorsOf(run.error, []);
  return (
    <div className="flex flex-col gap-2">
      <FormError message={errors.form} />
      <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200">
        {AUTO_ASSIGN_STRATEGIES.map((strategy) => (
          <li key={strategy}>
            <button
              type="button"
              disabled={!online || run.isPending}
              aria-busy={(run.isPending && run.variables === strategy) || undefined}
              onClick={() => run.mutate(strategy, { onSuccess: onDone })}
              className="flex min-h-14 w-full flex-col justify-center px-4 py-2 text-left hover:bg-gray-50 disabled:text-gray-400"
            >
              <span className="font-semibold">{STRATEGIES[strategy].label}</span>
              <span className="text-sm text-gray-500">{STRATEGIES[strategy].description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
