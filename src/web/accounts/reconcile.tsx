import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type AccountDto, BASE_CURRENCY, type ReconcileRequest } from '../../shared/api/accounts';
import { api, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { formErrorsOf } from '../lib/form-errors';
import { formatDate, formatMoney } from '../lib/format';
import { rateInput } from '../lib/fx';
import { AmountField, readAmount } from '../ui/amount-field';
import { Button } from '../ui/button';
import { FormError, TextField } from '../ui/field';
import { LoadError, Loading } from '../ui/load-state';
import { reconcileStatusQuery } from './accounts-api';

/**
 * Spec §10 "Reconcile flow", in the account's currency: "Is your cleared balance X?" Yes reconciles. No asks for the
 * statement balance and shows the difference; the owner can keep reviewing, or create an adjustment and finish.
 */
export function ReconcileForm({ account, onDone }: { account: AccountDto; onDone: () => void }) {
  const status = useQuery(reconcileStatusQuery(account.id));
  const [mismatch, setMismatch] = useState(false);
  const [statement, setStatement] = useState('');
  const [fxRate, setFxRate] = useState('');
  const reconcile = useCommand((json: ReconcileRequest) =>
    unwrap(api.api.accounts[':id'].reconcile.$post({ param: { id: account.id }, json })),
  );
  const errors = formErrorsOf(reconcile.error, ['statementBalance', 'fxRate']);

  if (status.isPending) return <Loading />;
  if (status.isError) return <LoadError error={status.error} onRetry={() => void status.refetch()} />;
  const { clearedBalance, currency, lastReconciledAt, lastReconciledBalance } = status.data;
  const money = (minor: number) => formatMoney(minor, currency);
  const amount = statement.trim() === '' ? null : readAmount(statement);
  const difference = amount?.ok ? amount.value - clearedBalance : null;

  const last =
    lastReconciledAt === null || lastReconciledBalance === null ? null : (
      <p className="text-sm text-gray-500">
        Last reconciled on {formatDate(lastReconciledAt.slice(0, 10))} at {money(lastReconciledBalance)}.
      </p>
    );

  if (!mismatch) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-lg">
          Is your cleared balance <strong className="whitespace-nowrap">{money(clearedBalance)}</strong>?
        </p>
        <p className="text-gray-600">Compare it with your bank. Yes marks every cleared transaction as reconciled.</p>
        {last}
        <FormError message={errors.form} />
        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={() => setMismatch(true)}>
            No
          </Button>
          <Button
            className="flex-1"
            mutating
            busy={reconcile.isPending}
            onClick={() => reconcile.mutate({ statementBalance: clearedBalance, createAdjustment: false }, { onSuccess: onDone })}
          >
            Yes
          </Button>
        </div>
      </div>
    );
  }

  const finish = () => {
    if (!amount?.ok) return;
    const adjust = difference !== 0;
    const rate = adjust && currency !== BASE_CURRENCY && fxRate.trim() !== '' ? { fxRate: rateInput(fxRate) } : {};
    reconcile.mutate({ statementBalance: amount.value, createAdjustment: adjust, ...rate }, { onSuccess: onDone });
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-gray-600">Your cleared balance is {money(clearedBalance)}.</p>
      <AmountField
        label="Statement balance"
        currency={currency}
        value={statement}
        onChange={setStatement}
        error={amount && !amount.ok ? amount.error : errors.fields.statementBalance}
      />
      {difference !== null && (
        <p className="text-lg" data-testid="reconcile-difference">
          Difference: <strong className="tabular-nums">{money(difference)}</strong>
        </p>
      )}
      {difference !== null && difference !== 0 && currency !== BASE_CURRENCY && (
        <TextField
          label={`Exchange rate (PLN per ${currency})`}
          value={fxRate}
          onChange={(e) => setFxRate(e.target.value)}
          hint="For the adjustment. Leave it empty for today's NBP rate."
          error={errors.fields.fxRate}
          inputMode="decimal"
        />
      )}
      <FormError message={errors.form} />
      <Button mutating busy={reconcile.isPending} block disabled={difference === null} onClick={finish}>
        {difference === 0 ? 'Finish' : 'Create adjustment & finish'}
      </Button>
      <Button variant="secondary" block onClick={onDone}>
        Keep reviewing
      </Button>
    </div>
  );
}
