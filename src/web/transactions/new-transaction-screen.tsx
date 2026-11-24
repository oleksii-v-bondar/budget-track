import { useNavigate, useSearch } from '@tanstack/react-router';
import { BackLink, ScreenHeader } from '../shell/screen-header';
import type { Prefill } from './form-model';
import { TransactionForm } from './transaction-form';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The router's `validateSearch` for `/transactions/new`: `?accountId=…` preselects the account. */
export function prefillFromSearch(search: Record<string, unknown>): Prefill {
  const { accountId } = search;
  return typeof accountId === 'string' && UUID.test(accountId) ? { accountId } : {};
}

/** A new transaction on a page of its own (`/transactions/new`); once saved, its account's register. */
export function NewTransactionScreen() {
  const prefill = prefillFromSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  return (
    <>
      <ScreenHeader title="New transaction" left={<BackLink to="/home" label="Home" />} />
      <div className="px-4 py-2">
        <TransactionForm
          prefill={prefill}
          onDone={(accountId) => void navigate({ to: '/accounts/$accountId', params: { accountId } })}
        />
      </div>
    </>
  );
}
