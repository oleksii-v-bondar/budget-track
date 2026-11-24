import { type ReactNode, useState } from 'react';
import { revaluationDiff } from '../../engine/fx';
import { type AccountDto, fxRateSchema } from '../../shared/api/accounts';
import { api, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { formErrorsOf } from '../lib/form-errors';
import { formatDate, formatMoney } from '../lib/format';
import { formatRate, rateInput } from '../lib/fx';
import { Button } from '../ui/button';
import { FormError, TextField } from '../ui/field';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * Spec §9 Revalue: books the unrealized difference between the native balance at the latest NBP rate (or a rate the
 * owner enters) and the PLN amounts booked so far, as an "FX revaluation" transaction.
 */
export function RevalueForm({ account, onDone }: { account: AccountDto; onDone: () => void }) {
  const [fxRate, setFxRate] = useState('');
  const revalue = useCommand((rate: string | undefined) =>
    unwrap(api.api.accounts[':id'].revalue.$post({ param: { id: account.id }, json: rate === undefined ? {} : { fxRate: rate } })),
  );
  const errors = formErrorsOf(revalue.error, ['fxRate']);
  const typed = fxRate.trim() === '' ? null : fxRateSchema.safeParse(rateInput(fxRate));
  const rate = typed === null ? (account.latestRate?.rate ?? null) : typed.success ? typed.data : null;
  const booked = account.balanceBase.working;
  const difference = rate === null ? null : revaluationDiff(account.balance.working, rate, booked);

  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2">
        <Row label="Balance">{formatMoney(account.balance.working, account.currency)}</Row>
        <Row label="Booked in PLN">{formatMoney(booked)}</Row>
        {account.latestRate && (
          <Row label={`NBP rate of ${formatDate(account.latestRate.effectiveDate)}`}>
            {formatRate(account.latestRate.rate)}
          </Row>
        )}
        {rate !== null && <Row label="Worth at this rate">{formatMoney(booked + difference!)}</Row>}
      </dl>
      <TextField
        label={`Exchange rate (PLN per ${account.currency})`}
        value={fxRate}
        onChange={(e) => setFxRate(e.target.value)}
        hint={account.latestRate ? 'Leave it empty for the NBP rate.' : "There's no NBP rate: enter the rate."}
        error={typed && !typed.success ? typed.error.issues[0]?.message : errors.fields.fxRate}
        inputMode="decimal"
      />
      {difference !== null && (
        <p className="text-lg" data-testid="revalue-difference">
          Difference: <strong className="tabular-nums">{formatMoney(difference)}</strong>
        </p>
      )}
      <FormError message={errors.form} />
      <Button
        mutating
        busy={revalue.isPending}
        block
        disabled={difference === null || difference === 0}
        onClick={() => revalue.mutate(typed?.success ? typed.data : undefined, { onSuccess: onDone })}
      >
        {difference === 0 ? 'Nothing to revalue' : 'Revalue'}
      </Button>
    </div>
  );
}
