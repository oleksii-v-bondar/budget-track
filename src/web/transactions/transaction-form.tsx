import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { convertToBase, effectiveRate } from '../../engine/fx';
import { type AccountDto, BASE_CURRENCY, fxRateSchema } from '../../shared/api/accounts';
import type { CategoryGroupDto } from '../../shared/api/categories';
import {
  type CreateTransactionInput,
  FLAG_COLORS,
  type FlagColor,
  type TransactionDto,
  type UpdateTransactionRequest,
} from '../../shared/api/transactions';
import { isOnBudget } from '../accounts/account-groups';
import { accountsQuery } from '../accounts/accounts-api';
import { budgetMonthQuery } from '../budget/budget-api';
import { api, unwrap } from '../lib/api';
import { amountToExpression } from '../lib/amount-expression';
import { useCommand } from '../lib/commands';
import { formErrorsOf } from '../lib/form-errors';
import { formatDate, formatMoney, parseDate } from '../lib/format';
import { formatRate, fxRateQuery, rateInput } from '../lib/fx';
import { todayIso } from '../lib/today';
import { FLAG_CLASSES } from '../register/transaction-row';
import { AmountField, readAmount } from '../ui/amount-field';
import { AmountKeypad } from '../ui/amount-keypad';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { Checkbox, FormError, SegmentedControl, SelectField, TextField } from '../ui/field';
import { FlagIcon, LockIcon } from '../ui/icons';
import { LoadError, Loading } from '../ui/load-state';
import { useToast } from '../ui/toast';
import { CategoryPicker } from './category-picker';
import { ConfirmReconciled, needsConfirmation } from './confirm-reconciled';
import {
  categoryRule,
  checkForm,
  createTransactionBody,
  type Direction,
  editValues,
  type FormContext,
  FORM_FIELDS,
  type FormValues,
  lineFields,
  needsTransferAmount,
  newLine,
  newValues,
  type Prefill,
  rateCurrency,
  signedAmount,
  transferTarget,
  updateTransactionBody,
} from './form-model';
import { categoriesQuery, payeesQuery, RTA_LABEL, transactionQuery } from './lookups';
import { PayeeField } from './payee-field';
import { SplitEditor } from './split-editor';

/** The transaction sheet (spec §11): adds a transaction, or edits `transaction`. */
export interface TransactionFormProps {
  /** Editing a transaction. Without it the form adds a new one. */
  transaction?: TransactionDto;
  /** A new transaction's account. */
  prefill?: Prefill;
  /** After a save or delete, with the account it is in. */
  onDone: (accountId: string) => void;
}

/** One save: what the form sends. */
type SavePlan = { kind: 'create'; body: CreateTransactionInput } | { kind: 'update'; body: UpdateTransactionRequest };

/** "1 EUR = 4,30 zł" for a transfer between currencies. */
function rateLabel(from: { amount: number; currency: string }, to: { amount: number; currency: string }): string | null {
  const [foreign, other] = from.currency === BASE_CURRENCY ? [to, from] : [from, to];
  const rate = effectiveRate(foreign.amount, other.amount);
  if (rate === null || other.amount === 0) return null;
  return `1 ${foreign.currency} = ${formatRate(rate)} ${other.currency === BASE_CURRENCY ? 'zł' : other.currency}`;
}

const capitalized = (word: string) => `${word[0]!.toUpperCase()}${word.slice(1)}`;

function FlagPicker({ value, onChange }: { value: FlagColor | null; onChange: (flag: FlagColor | null) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-gray-700">Flag</span>
      <div role="radiogroup" aria-label="Flag" className="flex flex-wrap gap-2">
        {[null, ...FLAG_COLORS].map((flag) => (
          <button
            key={flag ?? 'none'}
            type="button"
            role="radio"
            aria-checked={value === flag}
            aria-label={flag ? `${capitalized(flag)} flag` : 'No flag'}
            onClick={() => onChange(flag)}
            className={cx(
              'flex size-10 items-center justify-center rounded-full ring-1 ring-gray-200',
              value === flag && 'ring-2 ring-gray-900',
              flag ? FLAG_CLASSES[flag] : 'text-gray-400',
            )}
          >
            <FlagIcon className="size-5" fill={flag ? 'currentColor' : 'none'} />
          </button>
        ))}
      </div>
    </div>
  );
}

function SplitButton({ onSplit }: { onSplit: () => void }) {
  return (
    <button type="button" onClick={onSplit} className="text-sm font-semibold text-brand">
      Split
    </button>
  );
}

interface BodyProps extends TransactionFormProps {
  initial: FormValues;
  context: FormContext;
  groups: CategoryGroupDto[];
}

function TransactionFormBody({ transaction, initial, context, groups, onDone }: BodyProps) {
  const [today] = useState(todayIso);
  const [values, setValues] = useState(initial);
  const [checked, setChecked] = useState<Record<string, string>>({});
  const [keypad, setKeypad] = useState(transaction === undefined);
  const toast = useToast();
  /** The category picker, for the transaction or one of its split lines. */
  const [picking, setPicking] = useState<'main' | number | null>(null);
  const set = (patch: Partial<FormValues>) => setValues((current) => ({ ...current, ...patch }));

  const account = context.accounts.find((a) => a.id === values.accountId);
  const target = transferTarget(values.payee, context);
  const rule = categoryRule(account, target);
  const rateCode = rateCurrency(account, target, values.direction);
  const isoDate = parseDate(values.date);
  const month = isoDate?.slice(0, 7);
  const budget = useQuery({ ...budgetMonthQuery(month ?? ''), enabled: month !== undefined && rule !== 'none', retry: false });
  const nbpEnabled = rateCode !== null && isoDate !== null && isoDate <= today;
  const nbp = useQuery({ ...fxRateQuery(rateCode ?? '', isoDate ?? ''), enabled: nbpEnabled });

  const id = transaction?.id ?? '';
  const save = useCommand(async (plan: SavePlan) => {
    if (plan.kind === 'update') {
      await unwrap(api.api.transactions[':id'].$patch({ param: { id }, json: plan.body }));
      return null;
    }
    const created = await unwrap(api.api.transactions.$post({ json: plan.body }));
    return created.kind === 'scheduled' ? created.date : null;
  });
  const remove = useCommand((confirmReconciled: boolean) =>
    unwrap(api.api.transactions[':id'].$delete({ param: { id }, json: { confirmReconciled } })),
  );
  const [pending, setPending] = useState<SavePlan | null>(null);
  const failure = save.error ?? remove.error;
  const server = formErrorsOf(needsConfirmation(failure) ? null : failure, [...FORM_FIELDS, ...lineFields(values.lines)]);
  const errors: Record<string, string | undefined> = { ...server.fields, ...checked };
  const done = () => onDone(values.accountId);
  // Spec §5.6: the server saves a transaction dated after today as a one-time scheduled transaction.
  const saved = (scheduledFor: string | null) => {
    if (scheduledFor !== null) toast.show({ message: `Scheduled for ${formatDate(scheduledFor)}` });
    done();
  };

  // The split line counterpart and FX revaluations keep their amounts: only memo, flag and cleared change here.
  const locked = Boolean(transaction && (transaction.transfer?.splitLineId || (transaction.amount === 0 && transaction.amountBase !== 0)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems = locked ? {} : checkForm(values, context);
    setChecked(problems);
    if (Object.keys(problems).length > 0) return;
    const plan: SavePlan = transaction
      ? { kind: 'update', body: { ...updateTransactionBody(values, initial, context), confirmReconciled: false } }
      : { kind: 'create', body: createTransactionBody(values, context) };
    if (plan.kind === 'update' && Object.keys(plan.body).length === 1) {
      done();
      return;
    }
    setPending(plan);
    save.mutate(plan, { onSuccess: saved });
  };
  const confirm = () => {
    if (needsConfirmation(remove.error)) remove.mutate(true, { onSuccess: done });
    else if (pending?.kind === 'update') {
      save.mutate({ ...pending, body: { ...pending.body, confirmReconciled: true } }, { onSuccess: saved });
    }
  };

  const onPayee = (payee: FormValues['payee']) =>
    setValues((current) => {
      const chosen = payee.kind === 'existing' ? context.payees.find((p) => p.id === payee.id) : undefined;
      const categoryId = current.categoryId ?? chosen?.lastCategoryId ?? null;
      return { ...current, payee, categoryId };
    });

  const categories = groups.flatMap((g) => g.categories);
  const category = categories.find((c) => c.id === values.categoryId);
  const categoryName = category?.kind === 'rta' ? RTA_LABEL : category?.name;
  const accountOptions = context.accounts.filter(
    (a) =>
      a.id === values.accountId ||
      (!a.closed && (!transaction || a.currency === context.accounts.find((o) => o.id === transaction.accountId)?.currency)),
  );
  const currency = account?.currency ?? BASE_CURRENCY;
  const signed = signedAmount(values);

  const typedRate = values.fxRate.trim() === '' ? null : fxRateSchema.safeParse(rateInput(values.fxRate));
  const shownRate = typedRate?.success ? typedRate.data : (nbp.data?.rate ?? null);
  let rateHint: string;
  if (transaction?.fxRate && values.fxRate === initial.fxRate && values.date === initial.date) {
    rateHint = transaction.fxRateManual ? 'The rate you entered.' : 'The NBP rate it was booked at.';
  } else if (isoDate !== null && isoDate > today) {
    rateHint = 'Left empty, it takes the NBP rate of the day it is entered.';
  } else if (nbp.data) {
    rateHint = `Left empty: the NBP rate of ${formatDate(nbp.data.effectiveDate)}, ${formatRate(nbp.data.rate)}.`;
  } else if (nbp.isError) {
    rateHint = `There's no NBP rate for this day: enter the rate.`;
  } else rateHint = 'Looking up the NBP rate…';
  const preview =
    rateCode !== null && !target && shownRate !== null && account?.currency === rateCode
      ? ` = ${formatMoney(convertToBase(signed, shownRate))}`
      : '';

  // Splitting starts from the current category with the whole amount, plus an empty line.
  const split = () => {
    const first = newLine({ amount: values.amount === 0 ? '' : amountToExpression(values.amount), categoryId: values.categoryId });
    set({ lines: [first, newLine()] });
  };
  const dateHint =
    !transaction && isoDate !== null && isoDate > today ? 'A future date saves it as a scheduled transaction.' : 'dd.mm.yyyy';

  const transferAmount = needsTransferAmount(account, target) ? readAmount(values.transferAmount) : null;
  const effective =
    target && transferAmount?.ok && transferAmount.value !== 0 && values.amount !== 0
      ? rateLabel({ amount: values.amount, currency }, { amount: Math.abs(transferAmount.value), currency: target.currency })
      : null;

  return (
    <>
      <form noValidate onSubmit={submit} hidden={picking !== null} className="flex flex-col gap-4">
        {locked ? (
          <p className="rounded-xl bg-gray-100 p-3 text-sm text-gray-700">
            {transaction?.transfer?.splitLineId
              ? `This is one line of a split in ${transaction.transfer.accountName}. Change its amount, date or category on the split.`
              : 'An FX revaluation keeps its amounts; you can change its memo, flag and cleared state.'}
          </p>
        ) : (
          <>
            <SegmentedControl<Direction>
              label="Direction"
              value={values.direction}
              options={[
                { value: 'outflow', label: 'Outflow' },
                { value: 'inflow', label: 'Inflow' },
              ]}
              onChange={(direction) => set({ direction })}
            />
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                aria-label="Amount"
                aria-expanded={keypad}
                onClick={() => setKeypad((open) => !open)}
                className={cx(
                  'rounded-xl px-3 py-1 text-3xl font-semibold tabular-nums',
                  values.direction === 'inflow' ? 'text-green-700' : 'text-gray-900',
                )}
              >
                {formatMoney(signed, currency)}
              </button>
              {errors.amount && <p className="text-sm text-red-600">{errors.amount}</p>}
            </div>
            {keypad && (
              <AmountKeypad
                value={values.amount}
                currency={currency}
                onDone={(amount) => {
                  set({ amount: Math.abs(amount), direction: amount < 0 ? 'outflow' : values.direction });
                  setKeypad(false);
                }}
              />
            )}
            <PayeeField
              label="Payee"
              value={values.payee}
              onChange={onPayee}
              payees={context.payees}
              accounts={context.accounts}
              accountId={values.accountId}
              error={errors.payeeId ?? errors.payeeName}
            />
            {values.lines && account ? (
              <SplitEditor
                lines={values.lines}
                onChange={(lines) => set({ lines })}
                amount={values.amount}
                account={account}
                context={context}
                groups={groups}
                errors={errors}
                onPickCategory={setPicking}
                onUnsplit={() => set({ lines: null, categoryId: null })}
              />
            ) : rule !== 'none' ? (
              <div className="flex flex-col gap-1">
                <span className="flex items-end justify-between">
                  <span className="text-sm font-medium text-gray-700">Category</span>
                  {!target && <SplitButton onSplit={split} />}
                </span>
                <button
                  type="button"
                  aria-label={`Category: ${categoryName ?? (rule === 'optional' ? 'Uncategorized' : 'none')}`}
                  aria-invalid={errors.categoryId ? true : undefined}
                  onClick={() => setPicking('main')}
                  className={cx(
                    'flex min-h-11 items-center rounded-xl border bg-white px-3 text-left text-base',
                    errors.categoryId ? 'border-red-500' : 'border-gray-300',
                    !categoryName && 'text-gray-500',
                  )}
                >
                  {categoryName ?? (rule === 'optional' ? 'Uncategorized' : 'Choose a category')}
                </button>
                {errors.categoryId && <p className="text-sm text-red-600">{errors.categoryId}</p>}
              </div>
            ) : target ? (
              <p className="text-sm text-gray-500">
                A transfer between two {isOnBudget(target) ? 'budget' : 'tracking'} accounts takes no category.
              </p>
            ) : (
              <div className="flex justify-end">
                <SplitButton onSplit={split} />
              </div>
            )}
            <SelectField
              label="Account"
              value={values.accountId}
              onChange={(event) => set({ accountId: event.target.value })}
              error={errors.accountId}
            >
              {accountOptions.map((option: AccountDto) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                  {option.currency !== BASE_CURRENCY && ` (${option.currency})`}
                </option>
              ))}
            </SelectField>
            {target && needsTransferAmount(account, target) && (
              <div className="flex flex-col gap-1">
                <AmountField
                  label={`Amount in ${target.currency} (${values.direction === 'outflow' ? 'received' : 'sent'})`}
                  currency={target.currency}
                  value={values.transferAmount}
                  onChange={(transferAmount) => set({ transferAmount })}
                  error={errors.transferAmount}
                  hint="What the other account receives or sends, in its currency."
                />
                {effective && (
                  <p className="text-sm text-gray-600" data-testid="effective-rate">
                    Effective rate: {effective}
                  </p>
                )}
              </div>
            )}
            <TextField
              label="Date"
              value={values.date}
              onChange={(event) => set({ date: event.target.value })}
              error={errors.date}
              hint={dateHint}
              inputMode="numeric"
              autoComplete="off"
            />
            {rateCode !== null && (
              <TextField
                label={`Exchange rate (PLN per ${rateCode})`}
                value={values.fxRate}
                onChange={(event) => set({ fxRate: event.target.value })}
                placeholder={nbp.data ? formatRate(nbp.data.rate) : undefined}
                error={errors.fxRate}
                hint={`${rateHint}${preview}`}
                inputMode="decimal"
                autoComplete="off"
              />
            )}
          </>
        )}
        <TextField label="Memo" value={values.memo} onChange={(event) => set({ memo: event.target.value })} error={errors.memo} />
        <FlagPicker value={values.flag} onChange={(flag) => set({ flag })} />
        <Checkbox
          label={
            transaction?.cleared === 'reconciled' && values.cleared ? (
              <span className="flex items-center gap-1">
                Cleared (reconciled) <LockIcon className="size-4 text-brand" />
              </span>
            ) : (
              'Cleared'
            )
          }
          checked={values.cleared}
          onChange={(event) => set({ cleared: event.target.checked })}
        />
        <FormError message={server.form} />
        {needsConfirmation(failure) && <ConfirmReconciled busy={save.isPending || remove.isPending} onConfirm={confirm} />}
        <Button type="submit" mutating busy={save.isPending} block>
          {transaction ? (transaction.approved ? 'Save' : 'Approve') : 'Add transaction'}
        </Button>
        {transaction && (
          <Button
            variant="ghost"
            mutating
            busy={remove.isPending}
            block
            className="text-red-600"
            onClick={() => {
              save.reset();
              remove.mutate(false, { onSuccess: done });
            }}
          >
            {transaction.transfer ? 'Delete both sides of the transfer' : 'Delete transaction'}
          </Button>
        )}
      </form>
      {picking !== null && (
        <CategoryPicker
          groups={groups}
          month={budget.data}
          value={picking === 'main' ? values.categoryId : (values.lines?.[picking]?.categoryId ?? null)}
          allowNone={picking === 'main' ? rule === 'optional' : true}
          onPick={(categoryId) => {
            if (picking === 'main') set({ categoryId });
            else set({ lines: values.lines!.map((line, i) => (i === picking ? { ...line, categoryId } : line)) });
            setPicking(null);
          }}
          onCancel={() => setPicking(null)}
        />
      )}
    </>
  );
}

/**
 * Spec §11 Transaction sheet, for a new transaction (from ＋ or a register) or a saved one: outflow/inflow, the
 * amount keypad, payee (new names and "Transfer : <Account>" payees), category with its Available, account, date,
 * FX rate for foreign accounts (NBP's by default), the other amount of a transfer between currencies, memo, flag,
 * cleared; Delete removes a transfer's both sides. Changes to reconciled transactions ask first.
 */
export function TransactionForm({ transaction, prefill, onDone }: TransactionFormProps) {
  const [today] = useState(todayIso);
  const accounts = useQuery(accountsQuery);
  const payees = useQuery(payeesQuery);
  const categories = useQuery(categoriesQuery);
  // A budget↔tracking transfer keeps its category on the budget side: seen from the tracking side, read it there.
  const other = accounts.data?.accounts.find((a) => a.id === transaction?.transfer?.accountId);
  const own = accounts.data?.accounts.find((a) => a.id === transaction?.accountId);
  const counterpartId =
    transaction?.transfer && transaction.categoryId === null && own && other && !isOnBudget(own) && isOnBudget(other)
      ? transaction.transfer.transactionId
      : null;
  const counterpart = useQuery({ ...transactionQuery(counterpartId ?? ''), enabled: counterpartId !== null });

  for (const query of [accounts, payees, categories, ...(counterpartId ? [counterpart] : [])]) {
    if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (!accounts.data || !payees.data || !categories.data || (counterpartId !== null && !counterpart.data)) {
    return <Loading />;
  }
  const context = { accounts: accounts.data.accounts, payees: payees.data.payees };
  if (!transaction && !context.accounts.some((a) => !a.closed)) {
    return <p className="py-8 text-center text-gray-600">Add an account first: every transaction belongs to one.</p>;
  }
  const initial = transaction
    ? editValues(transaction, counterpart.data?.categoryId ?? transaction.categoryId)
    : newValues(today, context, prefill);
  return (
    <TransactionFormBody
      transaction={transaction}
      initial={initial}
      context={context}
      groups={categories.data.groups}
      onDone={onDone}
    />
  );
}
