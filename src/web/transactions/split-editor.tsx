import type { AccountDto } from '../../shared/api/accounts';
import type { CategoryGroupDto } from '../../shared/api/categories';
import { amountToExpression } from '../lib/amount-expression';
import { formatMoney } from '../lib/format';
import { AmountField } from '../ui/amount-field';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { TextField } from '../ui/field';
import { CloseIcon, PlusIcon } from '../ui/icons';
import { categoryRule, type FormContext, type LineValues, newLine, remainingToAssign, transferTarget } from './form-model';
import { RTA_LABEL } from './lookups';
import { PayeeField } from './payee-field';

export interface SplitEditorProps {
  lines: LineValues[];
  onChange: (lines: LineValues[]) => void;
  /** The transaction's amount (≥ 0, in its direction). */
  amount: number;
  account: AccountDto;
  context: FormContext;
  groups: CategoryGroupDto[];
  /** Messages by request path (`lines`, `lines.2.amount`, …). */
  errors: Record<string, string | undefined>;
  /** Opens the category picker for a line. */
  onPickCategory: (index: number) => void;
  /** Back to one category. */
  onUnsplit: () => void;
}

/**
 * Spec §10 "Splits" and §11: at least two lines whose amounts add up to the transaction's, with "Remaining to assign"
 * while they don't. A line may be a transfer to an account in the same currency; its category follows the same rules
 * as a transaction's (spec §5.5).
 */
export function SplitEditor({ lines, onChange, amount, account, context, groups, errors, onPickCategory, onUnsplit }: SplitEditorProps) {
  const remaining = remainingToAssign({ amount, lines });
  const categories = groups.flatMap((group) => group.categories);
  const update = (index: number, patch: Partial<LineValues>) =>
    onChange(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  return (
    <section aria-label="Split" className="flex flex-col gap-3 rounded-xl bg-raised p-3 ring-1 ring-line">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Split</h3>
        <Button variant="ghost" className="min-h-9 px-2 text-sm" onClick={onUnsplit}>
          Don't split
        </Button>
      </div>
      <p
        role="status"
        aria-label="Remaining to assign"
        className={cx('rounded-lg px-3 py-2 text-sm font-medium', remaining === 0 ? 'bg-lime/15 text-lime' : 'bg-yellow-400/15 text-yellow-200')}
      >
        {remaining === 0
          ? 'Everything is assigned.'
          : remaining > 0
            ? `Remaining to assign: ${formatMoney(remaining, account.currency)}`
            : `Assigned ${formatMoney(-remaining, account.currency)} too much`}
      </p>
      {errors.lines && <p className="text-sm text-red-400">{errors.lines}</p>}
      <ol className="flex flex-col gap-3">
        {lines.map((line, index) => {
          const n = index + 1;
          const field = (name: string) => errors[`lines.${index}.${name}`];
          const target = transferTarget(line.payeeId ? { kind: 'existing', id: line.payeeId, name: '' } : { kind: 'none' }, context);
          const rule = categoryRule(account, target);
          const category = categories.find((c) => c.id === line.categoryId);
          const categoryName = category?.kind === 'rta' ? RTA_LABEL : category?.name;
          const payee = context.payees.find((p) => p.id === line.payeeId);
          return (
            <li key={line.key} aria-label={`Line ${n}`} className="flex flex-col gap-2 rounded-lg bg-surface p-3 ring-1 ring-line">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-muted">Line {n}</span>
                {lines.length > 2 && (
                  <button
                    type="button"
                    aria-label={`Remove line ${n}`}
                    onClick={() => onChange(lines.filter((_, i) => i !== index))}
                    className="-mr-1 rounded-full p-1 text-muted hover:bg-white/10"
                  >
                    <CloseIcon className="size-4" />
                  </button>
                )}
              </div>
              <div className={cx('grid gap-2', rule !== 'none' && 'grid-cols-[2fr_3fr]')}>
                <AmountField
                  label="Amount"
                  aria-label={`Line ${n} amount`}
                  className="min-w-0"
                  currency={account.currency}
                  value={line.amount}
                  onChange={(value) => update(index, { amount: value })}
                  error={field('amount')}
                />
                {rule !== 'none' && (
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium text-gray-200">Category</span>
                    <button
                      type="button"
                      aria-label={`Line ${n} category: ${categoryName ?? (rule === 'optional' ? 'Uncategorized' : 'none')}`}
                      onClick={() => onPickCategory(index)}
                      className={cx(
                        'flex min-h-11 items-center truncate rounded-xl border bg-surface px-3 text-left',
                        field('categoryId') ? 'border-red-500' : 'border-line',
                        !categoryName && 'text-muted',
                      )}
                    >
                      {categoryName ?? (rule === 'optional' ? 'Uncategorized' : 'Choose a category')}
                    </button>
                    {field('categoryId') && <p className="text-sm text-red-400">{field('categoryId')}</p>}
                  </div>
                )}
              </div>
              <PayeeField
                label="Payee"
                name={`Line ${n} payee`}
                value={payee ? { kind: 'existing', id: payee.id, name: payee.name } : { kind: 'none' }}
                onChange={(value) => update(index, { payeeId: value.kind === 'existing' ? value.id : null })}
                payees={context.payees}
                accounts={context.accounts}
                accountId={account.id}
                allowNew={false}
                transferFilter={(other) => other.currency === account.currency}
                error={field('payeeId')}
              />
              <TextField
                label="Memo"
                aria-label={`Line ${n} memo`}
                value={line.memo}
                onChange={(event) => update(index, { memo: event.target.value })}
                error={field('memo')}
              />
            </li>
          );
        })}
      </ol>
      <Button variant="secondary" onClick={() => onChange([...lines, newLine({ amount: remaining > 0 ? amountToExpression(remaining) : '' })])}>
        <PlusIcon className="size-5" />
        Add line
      </Button>
    </section>
  );
}
