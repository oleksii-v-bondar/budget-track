import { type FormEvent, useState } from 'react';
import { type AccountDto, BASE_CURRENCY, type UpdateAccountRequest } from '../../shared/api/accounts';
import { api, unwrap } from '../lib/api';
import { amountToExpression } from '../lib/amount-expression';
import { useCommand } from '../lib/commands';
import { formErrorsOf } from '../lib/form-errors';
import { formatMoney } from '../lib/format';
import { rateInput } from '../lib/fx';
import { AmountField, readAmount } from '../ui/amount-field';
import { Button } from '../ui/button';
import { FormError, TextField } from '../ui/field';

interface Values {
  name: string;
  note: string;
  minPayment: string;
}

const FIELDS = ['name', 'note', 'minPayment'];

const valuesOf = (account: AccountDto): Values => ({
  name: account.name,
  note: account.note ?? '',
  minPayment: account.minPayment === null ? '' : amountToExpression(account.minPayment),
});

/** Credit accounts have a minimum payment: a card payment category's "minimum payment" target uses it. */
const hasMinPayment = (account: AccountDto) => account.accountClass === 'credit';

/** PATCH /api/accounts/:id with what changed; an emptied optional field is cleared (null). */
export function accountChanges(account: AccountDto, values: Values): UpdateAccountRequest | { error: string; field: string } {
  const before = valuesOf(account);
  const changes: UpdateAccountRequest = {};
  if (values.name.trim() !== before.name) changes.name = values.name.trim();
  if (values.note.trim() !== before.note) changes.note = values.note.trim() === '' ? null : values.note.trim();
  if (hasMinPayment(account) && values.minPayment.trim() !== before.minPayment) {
    if (values.minPayment.trim() === '') changes.minPayment = null;
    else {
      const amount = readAmount(values.minPayment);
      if (!amount.ok) return { error: amount.error, field: 'minPayment' };
      changes.minPayment = amount.value;
    }
  }
  return changes;
}

type Confirm = 'close' | 'delete' | null;

/**
 * Spec §10 "Accounts": edit the name, note and a credit account's minimum payment; close (only at a zero balance, otherwise after
 * an adjustment), reopen, or delete (the server refuses an account with transactions: close it instead).
 */
export function AccountSettings({ account, onDone, onDeleted }: { account: AccountDto; onDone: () => void; onDeleted: () => void }) {
  const [values, setValues] = useState(() => valuesOf(account));
  const [checked, setChecked] = useState<{ field: string; error: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [fxRate, setFxRate] = useState('');
  const param = { id: account.id };
  const save = useCommand((json: UpdateAccountRequest) => unwrap(api.api.accounts[':id'].$patch({ param, json })));
  const close = useCommand(() => unwrap(api.api.accounts[':id'].close.$post({ param })));
  const reopen = useCommand(() => unwrap(api.api.accounts[':id'].reopen.$post({ param })));
  const remove = useCommand(() => unwrap(api.api.accounts[':id'].$delete({ param })));
  // Spec §10: a reconciliation adjustment brings the working balance to 0 (the statement is minus the uncleared
  // amount), then the account closes. Two commands, so two steps to undo.
  const adjustAndClose = useCommand(async (rate: string) => {
    const json = {
      statementBalance: -account.balance.uncleared,
      createAdjustment: true,
      ...(rate.trim() === '' ? {} : { fxRate: rateInput(rate) }),
    };
    await unwrap(api.api.accounts[':id'].reconcile.$post({ param, json }));
    return unwrap(api.api.accounts[':id'].close.$post({ param }));
  });
  const saveErrors = formErrorsOf(save.error, FIELDS);
  const fieldError = (field: string) => (checked?.field === field ? checked.error : saveErrors.fields[field]);
  const set = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));
  const actionError = close.error ?? reopen.error ?? remove.error ?? adjustAndClose.error;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const changes = accountChanges(account, values);
    if ('error' in changes) {
      setChecked(changes);
      return;
    }
    setChecked(null);
    if (Object.keys(changes).length === 0) onDone();
    else save.mutate(changes, { onSuccess: onDone });
  };

  return (
    <div className="flex flex-col gap-6">
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <TextField label="Name" value={values.name} onChange={(e) => set({ name: e.target.value })} error={fieldError('name')} />
        <TextField label="Note" value={values.note} onChange={(e) => set({ note: e.target.value })} error={fieldError('note')} />
        {hasMinPayment(account) && (
          <AmountField
            label="Minimum payment"
            currency={account.currency}
            value={values.minPayment}
            onChange={(minPayment) => set({ minPayment })}
            error={fieldError('minPayment')}
          />
        )}
        <FormError message={saveErrors.form} />
        <Button type="submit" mutating busy={save.isPending} block>
          Save
        </Button>
      </form>

      <section aria-label="Close or delete" className="flex flex-col gap-3 border-t border-line pt-4">
        <FormError message={formErrorsOf(actionError, ['fxRate']).form} />
        {account.closed ? (
          <Button variant="secondary" mutating busy={reopen.isPending} block onClick={() => reopen.mutate(undefined, { onSuccess: onDone })}>
            Reopen account
          </Button>
        ) : confirm === 'close' ? (
          account.balance.working === 0 ? (
            <>
              <p className="text-muted">It moves to Closed accounts and takes no new transactions. You can reopen it.</p>
              <Button variant="danger" mutating busy={close.isPending} block onClick={() => close.mutate(undefined, { onSuccess: onDone })}>
                Close account
              </Button>
            </>
          ) : (
            <>
              <p className="text-muted">
                The balance is {formatMoney(account.balance.working, account.currency)}. An account closes only at 0: a
                reconciliation adjustment of {formatMoney(-account.balance.working, account.currency)} can bring it
                there (the cleared transactions become reconciled).
              </p>
              {account.currency !== BASE_CURRENCY && (
                <TextField
                  label={`Exchange rate (PLN per ${account.currency})`}
                  value={fxRate}
                  onChange={(e) => setFxRate(e.target.value)}
                  hint="Leave it empty for today's NBP rate."
                  error={formErrorsOf(adjustAndClose.error, ['fxRate']).fields.fxRate}
                  inputMode="decimal"
                />
              )}
              <Button
                variant="danger"
                mutating
                busy={adjustAndClose.isPending}
                block
                onClick={() => adjustAndClose.mutate(fxRate, { onSuccess: onDone })}
              >
                Adjust to 0 and close
              </Button>
            </>
          )
        ) : (
          <Button variant="secondary" block onClick={() => setConfirm('close')}>
            Close account
          </Button>
        )}
        {confirm === 'delete' ? (
          <>
            <p className="text-muted">
              Only an account with nothing but its starting balance can be deleted; otherwise close it.
            </p>
            <Button variant="danger" mutating busy={remove.isPending} block onClick={() => remove.mutate(undefined, { onSuccess: onDeleted })}>
              Delete account
            </Button>
          </>
        ) : (
          <Button variant="ghost" block className="text-red-400" onClick={() => setConfirm('delete')}>
            Delete account
          </Button>
        )}
      </section>
    </div>
  );
}
