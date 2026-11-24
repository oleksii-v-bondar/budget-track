import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { AccountType } from '../../shared/accounts';
import type { AccountDto } from '../../shared/api/accounts';
import { api, ApiError, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { formErrorsOf } from '../lib/form-errors';
import { formatDate, parseDate } from '../lib/format';
import { formatRate, fxRateQuery } from '../lib/fx';
import { todayIso } from '../lib/today';
import { AmountField } from '../ui/amount-field';
import { Button } from '../ui/button';
import { FormError, TextField } from '../ui/field';
import { ChevronRightIcon } from '../ui/icons';
import { ACCOUNT_TYPE_LABELS, isForeign } from './account-groups';
import {
  checkStep,
  type CreateAccountInput,
  createAccountRequest,
  initialWizard,
  isDebt,
  stepOf,
  WIZARD_STEPS,
  type WizardStep,
  type WizardValues,
} from './wizard';

const TYPE_SECTIONS: { title: string; types: AccountType[] }[] = [
  { title: 'Cash', types: ['checking', 'savings', 'cash'] },
  { title: 'Credit', types: ['credit_card', 'line_of_credit'] },
  { title: 'Tracking', types: ['other_asset', 'other_liability'] },
];

const STEP_TITLES: Record<WizardStep, string> = {
  type: 'What kind of account is it?',
  name: 'What do you call it?',
  currency: 'Which currency does it use?',
  balance: 'What is its balance?',
};

const FIELDS = ['type', 'name', 'currency', 'startingBalance', 'startingDate', 'fxRate'];

const COMMON_CURRENCIES = ['PLN', 'EUR', 'USD', 'GBP', 'CHF'];

/** The NBP rate the server will use when the rate field stays empty (spec §9). */
function NbpHint({ currency, date, today }: { currency: string; date: string | null; today: string }) {
  const enabled = date !== null && date <= today;
  const rate = useQuery({ ...fxRateQuery(currency, date ?? today), enabled });
  if (!enabled) return 'Enter the date first.';
  if (rate.isPending) return 'Looking up the NBP rate…';
  if (rate.isError) return `There's no NBP rate for ${currency} on ${formatDate(date)}: enter the rate.`;
  return `Leave it empty for the NBP rate of ${formatDate(rate.data.effectiveDate)}: ${formatRate(rate.data.rate)}.`;
}

/**
 * Spec §11 Add-account wizard: type → name → currency → starting balance and date (and, for a foreign currency, an
 * optional rate: NBP's by default). Server errors send the owner back to their step.
 */
export function AddAccountForm({ onDone }: { onDone: (account: AccountDto) => void }) {
  const [today] = useState(todayIso);
  const [values, setValues] = useState<WizardValues>(() => initialWizard(today));
  const [step, setStep] = useState<WizardStep>('type');
  const [checked, setChecked] = useState<Record<string, string>>({});
  const create = useCommand((body: CreateAccountInput) => unwrap(api.api.accounts.$post({ json: body })));
  const steps = WIZARD_STEPS;
  const index = steps.indexOf(step);
  const server = formErrorsOf(create.error, FIELDS);
  const errors: Record<string, string | undefined> = { ...server.fields, ...checked };
  const set = (patch: Partial<WizardValues>) => setValues((current) => ({ ...current, ...patch }));

  const goTo = (next: WizardStep) => {
    setChecked({});
    setStep(next);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems = checkStep(step, values, today);
    setChecked(problems);
    if (Object.keys(problems).length > 0) return;
    const next = steps[index + 1];
    if (next) {
      setStep(next);
      return;
    }
    create.mutate(createAccountRequest(values), {
      onSuccess: onDone,
      onError: (error) => {
        const back = error instanceof ApiError ? stepOf(Object.keys(error.fieldErrors)) : null;
        if (back) setStep(back);
      },
    });
  };

  if (step === 'type') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">Step 1 of {steps.length}</p>
        <h3 className="text-lg font-semibold">{STEP_TITLES.type}</h3>
        {TYPE_SECTIONS.map((section) => (
          <section key={section.title} aria-label={section.title}>
            <h4 className="pb-1 text-xs font-semibold tracking-wide text-muted uppercase">{section.title}</h4>
            <div className="divide-y divide-line rounded-xl ring-1 ring-line">
              {section.types.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    set({ type });
                    goTo('name');
                  }}
                  className="flex min-h-12 w-full items-center justify-between px-4 text-left hover:bg-white/5"
                >
                  {ACCOUNT_TYPE_LABELS[type]}
                  <ChevronRightIcon className="text-muted" />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  }

  const type = values.type!;
  const foreign = isForeign({ currency: values.currency.trim().toUpperCase() || 'PLN' });
  const last = index === steps.length - 1;
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Step {index + 1} of {steps.length} · {ACCOUNT_TYPE_LABELS[type]}
      </p>
      <h3 className="text-lg font-semibold">{STEP_TITLES[step]}</h3>

      {step === 'name' && (
        <TextField
          label="Account name"
          value={values.name}
          onChange={(e) => set({ name: e.target.value })}
          error={errors.name}
          autoComplete="off"
        />
      )}

      {step === 'currency' && (
        <>
          <TextField
            label="Currency"
            value={values.currency}
            onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
            error={errors.currency}
            hint="A 3-letter code. Amounts in another currency are converted to PLN when you enter them."
            maxLength={3}
            autoComplete="off"
          />
          <div className="flex flex-wrap gap-2" aria-label="Common currencies" role="group">
            {COMMON_CURRENCIES.map((code) => (
              <Button key={code} variant="secondary" className="min-h-9 px-3 text-sm" onClick={() => set({ currency: code })}>
                {code}
              </Button>
            ))}
          </div>
        </>
      )}

      {step === 'balance' && (
        <>
          <AmountField
            label={isDebt(type) ? 'Amount owed' : 'Balance'}
            currency={values.currency.trim().toUpperCase()}
            value={values.balance}
            onChange={(balance) => set({ balance })}
            error={errors.startingBalance}
            hint={isDebt(type) ? 'What you owe today, as a positive amount.' : 'What the account holds today.'}
          />
          <TextField
            label="Date"
            value={values.date}
            onChange={(e) => set({ date: e.target.value })}
            error={errors.startingDate}
            hint="dd.mm.yyyy"
            inputMode="numeric"
            autoComplete="off"
          />
          {foreign && (
            <TextField
              label={`Exchange rate (PLN per ${values.currency.trim().toUpperCase()})`}
              value={values.fxRate}
              onChange={(e) => set({ fxRate: e.target.value })}
              error={errors.fxRate}
              hint={<NbpHint currency={values.currency.trim().toUpperCase()} date={parseDate(values.date)} today={today} />}
              inputMode="decimal"
              autoComplete="off"
            />
          )}
        </>
      )}

      <FormError message={server.form} />
      <div className="flex gap-3">
        <Button variant="secondary" className="flex-1" onClick={() => goTo(steps[index - 1]!)}>
          Back
        </Button>
        <Button type="submit" className="flex-1" mutating={last} busy={create.isPending}>
          {last ? 'Add account' : 'Continue'}
        </Button>
      </div>
    </form>
  );
}
