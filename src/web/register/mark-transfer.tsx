import { useId, useState } from 'react';
import { type AccountDto, BASE_CURRENCY } from '../../shared/api/accounts';
import type { TransactionDto, UpdateTransactionRequest } from '../../shared/api/transactions';
import { api, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { formErrorsOf } from '../lib/form-errors';
import { formatMoney } from '../lib/format';
import { useOnline } from '../lib/online';
import { ConfirmReconciled, needsConfirmation } from '../transactions/confirm-reconciled';
import { AmountField, readAmount } from '../ui/amount-field';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { FormError } from '../ui/field';
import { ChevronRightIcon } from '../ui/icons';
import { useToast } from '../ui/toast';
import { payeeLabel } from './register-days';

export interface MarkTransferProps {
  transaction: TransactionDto;
  accounts: AccountDto[];
  onDone: () => void;
}

/**
 * Review's "Transfer…": tapping the account an unapproved transaction's money went to (or came from) saves it as a
 * transfer and approves it; the server links it to the matching transaction already in that account, if any. Between
 * currencies, the other amount is asked for when there is no matching transaction to take it from.
 */
export function MarkTransfer({ transaction, accounts, onDone }: MarkTransferProps) {
  const toast = useToast();
  const online = useOnline();
  const headingId = useId();
  const [chosen, setChosen] = useState<AccountDto | null>(null);
  const [amount, setAmount] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const save = useCommand((body: UpdateTransactionRequest) =>
    unwrap(api.api.transactions[':id'].$patch({ param: { id: transaction.id }, json: body })),
  );
  const outflow = transaction.amount < 0;
  const options = accounts.filter((a) => !a.closed && a.id !== transaction.accountId);
  const errors = formErrorsOf(needsConfirmation(save.error) ? null : save.error, ['transferAmount']);
  const foreign = chosen !== null && chosen.currency !== transaction.currency;
  const askAmount = foreign && (amount !== '' || errors.fields.transferAmount !== undefined);

  const send = (target: AccountDto, confirmReconciled = false) => {
    // An amount typed for another account's currency doesn't carry over.
    const typedText = target.id === chosen?.id ? amount : '';
    setChosen(target);
    setAmount(typedText);
    const body: UpdateTransactionRequest = { payeeId: target.transferPayeeId, approved: true, confirmReconciled };
    if (target.currency !== transaction.currency && typedText.trim() !== '') {
      const typed = readAmount(typedText);
      if (!typed.ok) {
        setInvalid(typed.error);
        return;
      }
      body.transferAmount = outflow ? Math.abs(typed.value) : -Math.abs(typed.value);
    }
    setInvalid(null);
    save.mutate(body, {
      onSuccess: ({ linkedTo }) => {
        const created = `Transfer ${outflow ? 'to' : 'from'} ${target.name} created`;
        toast.show({ message: linkedTo ? `Linked with the matching transaction in ${target.name}` : created });
        onDone();
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted">
        {payeeLabel(transaction)} · {formatMoney(transaction.amount, transaction.currency)}
      </p>
      <section className="flex flex-col gap-1">
        <h3 id={headingId} className="text-sm font-medium text-gray-200">
          {outflow ? 'To account' : 'From account'}
        </h3>
        <ul aria-labelledby={headingId} className="divide-y divide-line overflow-hidden rounded-xl bg-raised">
          {options.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                disabled={save.isPending || !online}
                onClick={() => send(option)}
                className={cx(
                  'flex min-h-12 w-full items-center gap-2 px-4 text-left hover:bg-white/5 disabled:opacity-60',
                  chosen?.id === option.id && 'text-brand',
                )}
              >
                <span className="flex-1">{option.name}</span>
                {option.currency !== BASE_CURRENCY && <span className="text-sm text-muted">{option.currency}</span>}
                <ChevronRightIcon className="size-4 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      </section>
      {askAmount && (
        <>
          <AmountField
            label={`Amount in ${chosen.currency} (${outflow ? 'received' : 'sent'})`}
            currency={chosen.currency}
            value={amount}
            onChange={setAmount}
            error={invalid ?? errors.fields.transferAmount}
          />
          <Button mutating busy={save.isPending} block onClick={() => send(chosen)}>
            Transfer and approve
          </Button>
        </>
      )}
      <FormError message={errors.form} />
      {needsConfirmation(save.error) && chosen && (
        <ConfirmReconciled busy={save.isPending} onConfirm={() => send(chosen, true)} />
      )}
    </div>
  );
}
