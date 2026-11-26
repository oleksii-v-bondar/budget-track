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
import { FlagIcon, LockIcon, TransferIcon } from '../ui/icons';
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
  NO_OTHER_ACCOUNT,
  type PayeeValue,
  type Prefill,
  rateCurrency,
  signedAmount,
  transferPayeeValue,
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

/** What a save did: scheduled a future transaction, or linked a new transfer to the row already in the other account. */
interface Saved {
  scheduledFor: string | null;
  linkedTo: string | null;
}

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
      <span className="text-sm font-medium text-gray-200">Flag</span>
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
              'flex size-10 items-center justify-center rounded-full ring-1 ring-line',
              value === flag && 'ring-2 ring-white',
              flag ? FLAG_CLASSES[flag] : 'text-muted',
            )}
          >
            <FlagIcon className="size-5" fill={flag ? 'currentColor' : 'none'} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** "This is a transfer": the payee gives way to the account the money goes to or comes from. */
function TransferSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="This is a transfer"
      onClick={onChange}
      className={cx(
        'flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 text-left ring-1',
        checked ? 'bg-brand-light ring-brand/40' : 'bg-raised ring-line',
      )}
    >
      <TransferIcon className={cx('size-5 shrink-0', checked ? 'text-brand' : 'text-muted')} />
      <span className="flex-1">
        <span className="block text-base font-medium">This is a transfer</span>
        <span className="block text-sm text-muted">Between two of your accounts</span>
      </span>
      <span aria-hidden="true" className={cx('relative h-6 w-10 shrink-0 rounded-full', checked ? 'bg-brand' : 'bg-zero')}>
        <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow', checked ? 'left-[18px]' : 'left-0.5')} />
      </span>
    </button>
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
  /** The payee to give back when "This is a transfer" is switched off. */
  const [plainPayee, setPlainPayee] = useState<PayeeValue>(initial.transfer ? { kind: 'none' } : initial.payee);

  const account = context.accounts.find((a) => a.id === values.accountId);
  const target = transferTarget(values.payee, context);
  const initialTarget = transferTarget(initial.payee, context);
  // Until the other account is chosen, a transfer shows no category.
  const rule = values.transfer && !target ? 'none' : categoryRule(account, target);
  // A saved plain transaction that becomes a transfer may link to its other side already in the other account.
  const linkable = Boolean(transaction && !transaction.transfer && !transaction.isSplit);
  const rateCode = rateCurrency(account, target, values.direction);
  const isoDate = parseDate(values.date);
  const month = isoDate?.slice(0, 7);
  const budget = useQuery({ ...budgetMonthQuery(month ?? ''), enabled: month !== undefined && rule !== 'none', retry: false });
  const nbpEnabled = rateCode !== null && isoDate !== null && isoDate <= today;
  const nbp = useQuery({ ...fxRateQuery(rateCode ?? '', isoDate ?? ''), enabled: nbpEnabled });

  const id = transaction?.id ?? '';
  const save = useCommand(async (plan: SavePlan): Promise<Saved> => {
    if (plan.kind === 'update') {
      const updated = await unwrap(api.api.transactions[':id'].$patch({ param: { id }, json: plan.body }));
      return { scheduledFor: null, linkedTo: updated.linkedTo ?? null };
    }
    const created = await unwrap(api.api.transactions.$post({ json: plan.body }));
    return { scheduledFor: created.kind === 'scheduled' ? created.date : null, linkedTo: null };
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
  const saved = ({ scheduledFor, linkedTo }: Saved) => {
    if (scheduledFor !== null) toast.show({ message: `Scheduled for ${formatDate(scheduledFor)}` });
    if (linkable && target) {
      const created = `Transfer ${values.direction === 'outflow' ? 'to' : 'from'} ${target.name} created`;
      toast.show({ message: linkedTo ? `Linked with the matching transaction in ${target.name}` : created });
    }
    done();
  };

  // The split line counterpart and FX revaluations keep their amounts: only memo, flag and cleared change here.
  const locked = Boolean(transaction && (transaction.transfer?.splitLineId || (transaction.amount === 0 && transaction.amountBase !== 0)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems = locked ? {} : checkForm(values, context, linkable);
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
      if (chosen?.kind === 'transfer') return { ...current, payee, transfer: true };
      const categoryId = current.categoryId ?? chosen?.lastCategoryId ?? null;
      return { ...current, payee, categoryId };
    });

  // The other open accounts (and a closed one the transfer already goes to).
  const transferAccounts = context.accounts.filter(
    (a) => a.id !== values.accountId && (!a.closed || a.id === initialTarget?.id),
  );
  const canTransfer = !values.lines && !transaction?.isStartingBalance;
  const toggleTransfer = () => {
    if (values.transfer) {
      set({ transfer: false, payee: plainPayee, transferAmount: '' });
      return;
    }
    setPlainPayee(values.payee);
    set({ transfer: true, payee: initialTarget ? initial.payee : { kind: 'none' }, transferAmount: initial.transferAmount });
  };
  const pickTarget = (accountId: string) => {
    const chosen = transferAccounts.find((a) => a.id === accountId);
    if (!chosen) return;
    const transferAmount = chosen.id === initialTarget?.id ? initial.transferAmount : '';
    set({ payee: transferPayeeValue(chosen, context), transferAmount });
  };

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
        {transaction?.bankPending && (
          <p className="rounded-xl bg-raised p-3 text-sm text-muted">
            <span className="font-semibold text-gray-200 italic">Pending at the bank</span>. It clears when the bank
            books it.
          </p>
        )}
        {locked ? (
          <p className="rounded-xl bg-raised p-3 text-sm text-gray-200">
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
                  values.direction === 'inflow' ? 'text-lime' : 'text-white',
                )}
              >
                {formatMoney(signed, currency)}
              </button>
              {errors.amount && <p className="text-sm text-red-400">{errors.amount}</p>}
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
            {canTransfer && <TransferSwitch checked={values.transfer} onChange={toggleTransfer} />}
            {values.transfer ? (
              <SelectField
                label={values.direction === 'outflow' ? 'To account' : 'From account'}
                value={target?.id ?? ''}
                onChange={(event) => pickTarget(event.target.value)}
                error={errors.payeeId}
                disabled={transferAccounts.length === 0}
                hint={transferAccounts.length === 0 ? NO_OTHER_ACCOUNT : undefined}
              >
                <option value="" disabled>
                  {transferAccounts.length === 0 ? 'No other account' : 'Choose an account'}
                </option>
                {transferAccounts.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                    {option.currency !== BASE_CURRENCY && ` (${option.currency})`}
                  </option>
                ))}
              </SelectField>
            ) : (
              <PayeeField
                label="Payee"
                value={values.payee}
                onChange={onPayee}
                payees={context.payees}
                accounts={context.accounts}
                accountId={values.accountId}
                error={errors.payeeId ?? errors.payeeName}
              />
            )}
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
                  <span className="text-sm font-medium text-gray-200">Category</span>
                  {!target && <SplitButton onSplit={split} />}
                </span>
                <button
                  type="button"
                  aria-label={`Category: ${categoryName ?? (rule === 'optional' ? 'Uncategorized' : 'none')}`}
                  aria-invalid={errors.categoryId ? true : undefined}
                  onClick={() => setPicking('main')}
                  className={cx(
                    'flex min-h-11 items-center rounded-xl border bg-surface px-3 text-left text-base',
                    errors.categoryId ? 'border-red-500' : 'border-line',
                    !categoryName && 'text-muted',
                  )}
                >
                  {categoryName ?? (rule === 'optional' ? 'Uncategorized' : 'Choose a category')}
                </button>
                {errors.categoryId && <p className="text-sm text-red-400">{errors.categoryId}</p>}
              </div>
            ) : target ? (
              <p className="text-sm text-muted">
                A transfer between two {isOnBudget(target) ? 'budget' : 'tracking'} accounts takes no category.
              </p>
            ) : (
              !values.transfer && (
                <div className="flex justify-end">
                  <SplitButton onSplit={split} />
                </div>
              )
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
                  hint={
                    linkable
                      ? 'Leave it empty to take the amount of the matching transaction there.'
                      : 'What the other account receives or sends, in its currency.'
                  }
                />
                {effective && (
                  <p className="text-sm text-muted" data-testid="effective-rate">
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
            className="text-red-400"
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
 * amount keypad, payee (new names and "Transfer : <Account>" payees) or, as "This is a transfer", the account the money
 * goes to or comes from, category with its Available, account, date,
 * FX rate for foreign accounts (NBP's by default), the other amount of a transfer between currencies, memo, flag,
 * cleared; Delete removes a transfer's both sides. Changes to reconciled transactions ask first. A saved transaction
 * that becomes a transfer toasts whether it was linked to the matching transaction in the other account.
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
    return <p className="py-8 text-center text-muted">Add an account first: every transaction belongs to one.</p>;
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
