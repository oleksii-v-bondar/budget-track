import { useState } from 'react';
import type { AccountDto } from '../../shared/api/accounts';
import type { CategoryGroupDto } from '../../shared/api/categories';
import type { PayeeDto } from '../../shared/api/payees';
import { type BulkAction, FLAG_COLORS, type FlagColor, type TransactionDto } from '../../shared/api/transactions';
import { api, ApiError, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { formErrorsOf } from '../lib/form-errors';
import { formatDate } from '../lib/format';
import { ConfirmReconciled, needsConfirmation } from '../transactions/confirm-reconciled';
import { choosablePayees, RTA_LABEL, systemCategory, usableGroups } from '../transactions/lookups';
import { Button } from '../ui/button';
import { FormError, SelectField } from '../ui/field';
import { payeeLabel } from './register-days';

type Step = 'menu' | 'categorize' | 'setPayee' | 'setFlag' | 'moveAccount' | 'delete';

const plural = (n: number) => `${n} transaction${n === 1 ? '' : 's'}`;

/** A bulk error names the row it is about (`ids.<index>`, spec §13); say which transaction that is. */
export function bulkErrorMessage(error: unknown, transactions: TransactionDto[]): string | null {
  if (!(error instanceof ApiError)) return formErrorsOf(error, []).form;
  const rows = Object.entries(error.fieldErrors).flatMap(([path, messages]) => {
    const row = /^ids\.(\d+)$/.exec(path) && transactions[Number(path.slice(4))];
    return row ? [`${payeeLabel(row)} on ${formatDate(row.date)}: ${messages[0]}`] : [];
  });
  return rows.length > 0 ? rows.join(' ') : formErrorsOf(error, []).form;
}

export interface BulkActionsProps {
  /** The selected transactions, in register order. */
  transactions: TransactionDto[];
  accounts: AccountDto[];
  groups: CategoryGroupDto[];
  payees: PayeeDto[];
  onDone: () => void;
}

/**
 * Spec §10 bulk operations on the selected transactions, each one undoable command: categorize, set payee, set
 * flag, clear/unclear, approve, move to an account in the same currency, delete. Reconciled rows need a confirmation.
 */
export function BulkActions({ transactions, accounts, groups, payees, onDone }: BulkActionsProps) {
  const [step, setStep] = useState<Step>('menu');
  const [value, setValue] = useState('');
  const [sent, setSent] = useState<BulkAction | null>(null);
  const ids = transactions.map((t) => t.id);
  const run = useCommand((body: { action: BulkAction; confirmReconciled: boolean }) =>
    unwrap(api.api.transactions.bulk.$post({ json: { ids, ...body } })),
  );
  const send = (action: BulkAction, confirmReconciled = false) => {
    setSent(action);
    run.mutate({ action, confirmReconciled }, { onSuccess: onDone });
  };
  const choose = (next: Step) => {
    setValue('');
    run.reset();
    setStep(next);
  };
  const currencies = new Set(transactions.map((t) => t.currency));
  const targets = accounts.filter((a) => !a.closed && currencies.size === 1 && currencies.has(a.currency));
  const rta = systemCategory(groups, 'rta');
  const { user, transfer } = choosablePayees(payees);

  const apply = () => {
    if (step === 'categorize') send({ type: 'categorize', categoryId: value || null });
    if (step === 'setPayee') send({ type: 'setPayee', payeeId: value || null });
    if (step === 'setFlag') send({ type: 'setFlag', flag: value === '' ? null : (value as FlagColor) });
    if (step === 'moveAccount' && value) send({ type: 'moveAccount', accountId: value });
    if (step === 'delete') send({ type: 'delete' });
  };

  const outcome = needsConfirmation(run.error) ? (
    <ConfirmReconciled busy={run.isPending} onConfirm={() => sent && send(sent, true)} />
  ) : (
    <FormError message={bulkErrorMessage(run.error, transactions)} />
  );

  if (step === 'menu') {
    const item = 'flex min-h-12 w-full items-center px-4 text-left hover:bg-gray-50 disabled:text-gray-400';
    return (
      <div className="flex flex-col gap-3">
        <ul className="divide-y divide-gray-200 rounded-xl ring-1 ring-gray-200">
          {(
            [
              ['Categorize', () => choose('categorize')],
              ['Set payee', () => choose('setPayee')],
              ['Set flag', () => choose('setFlag')],
              ['Mark cleared', () => send({ type: 'setCleared', cleared: 'cleared' })],
              ['Mark uncleared', () => send({ type: 'setCleared', cleared: 'uncleared' })],
              ['Approve', () => send({ type: 'approve' })],
              ['Move to account', () => choose('moveAccount')],
              ['Delete', () => choose('delete')],
            ] as const
          ).map(([label, onClick]) => (
            <li key={label}>
              <button type="button" className={item} disabled={run.isPending} onClick={onClick}>
                {label}
              </button>
            </li>
          ))}
        </ul>
        {outcome}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {step === 'categorize' && (
        <SelectField label="Category" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">No category</option>
          {rta && <option value={rta.id}>{RTA_LABEL}</option>}
          {usableGroups(groups).map((group) => (
            <optgroup key={group.id} label={group.name}>
              {group.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </optgroup>
          ))}
        </SelectField>
      )}
      {step === 'setPayee' && (
        <SelectField label="Payee" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">No payee</option>
          {user.map((payee) => (
            <option key={payee.id} value={payee.id}>
              {payee.name}
            </option>
          ))}
          {transfer.length > 0 && (
            <optgroup label="Transfers">
              {transfer.map((payee) => (
                <option key={payee.id} value={payee.id}>
                  {payee.name}
                </option>
              ))}
            </optgroup>
          )}
        </SelectField>
      )}
      {step === 'setFlag' && (
        <SelectField label="Flag" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">No flag</option>
          {FLAG_COLORS.map((flag) => (
            <option key={flag} value={flag}>
              {flag[0]!.toUpperCase() + flag.slice(1)}
            </option>
          ))}
        </SelectField>
      )}
      {step === 'moveAccount' &&
        (targets.length === 0 ? (
          <p className="text-gray-600">
            {currencies.size > 1
              ? 'Select transactions in one currency to move them.'
              : 'There is no open account in this currency to move them to.'}
          </p>
        ) : (
          <SelectField label="Account" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="" disabled>
              Choose an account
            </option>
            {targets.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </SelectField>
        ))}
      {step === 'delete' && (
        <p className="text-gray-600">
          Delete {plural(transactions.length)}? A transfer goes from both accounts. You can undo it.
        </p>
      )}
      {outcome}
      <div className="flex gap-3">
        <Button variant="secondary" className="flex-1" onClick={() => choose('menu')}>
          Back
        </Button>
        <Button
          variant={step === 'delete' ? 'danger' : 'primary'}
          className="flex-1"
          mutating
          busy={run.isPending}
          disabled={step === 'moveAccount' && !value}
          onClick={apply}
        >
          {step === 'delete' ? 'Delete' : 'Apply'}
        </Button>
      </div>
    </div>
  );
}
