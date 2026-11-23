import { useNavigate, useSearch } from '@tanstack/react-router';
import type { Prefill } from './form-model';
import { TransactionForm } from './transaction-form';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The router's `validateSearch` for `/transactions/new`: `?accountId=…` preselects the account. */
export function prefillFromSearch(search: Record<string, unknown>): Prefill {
  const { accountId } = search;
  return typeof accountId === 'string' && UUID.test(accountId) ? { accountId } : {};
}

/** ＋ in the bottom navigation: a new transaction; once saved, its account's register. */
export function NewTransactionScreen() {
  const prefill = prefillFromSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  return (
    <div className="px-4 py-4">
      <TransactionForm
        prefill={prefill}
        onDone={(accountId) => void navigate({ to: '/accounts/$accountId', params: { accountId } })}
      />
    </div>
  );
}
