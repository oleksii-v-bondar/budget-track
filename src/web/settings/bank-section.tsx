import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import type { BankAccountDto, BankStatus } from '../../shared/api/bank';
import { accountsQuery } from '../accounts/accounts-api';
import { api, unwrap } from '../lib/api';
import { COMMAND_TOAST, errorMessage, useUndoRedo } from '../lib/commands';
import { formatDate } from '../lib/format';
import { invalidateData } from '../lib/query';
import { todayIso } from '../lib/today';
import { Button } from '../ui/button';
import { SelectField } from '../ui/field';
import { useToast } from '../ui/toast';

const bankStatusQuery = queryOptions({
  queryKey: ['bank'],
  queryFn: () => unwrap(api.api.bank.status.$get()),
});

/** Top-level navigations: the server sends the browser on to Aiia and back to /settings. */
const CONNECT_URL = '/api/bank/connect';
const LINK_CLASS =
  'inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-base font-semibold';

function lastSynced(iso: string | null): string {
  if (iso === null) return 'Not synced yet';
  const at = new Date(iso);
  return `Last synced ${formatDate(todayIso(at))} ${at.toTimeString().slice(0, 5)}`;
}

/**
 * Settings → Bank connections (Mastercard Open Banking): connect, link each bank account to an account in its
 * currency, sync (one undoable "Bank sync") and disconnect. Hidden unless the server has Aiia credentials.
 */
export function BankSection() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { undo } = useUndoRedo();
  const navigate = useNavigate();
  const { bank: outcome } = useSearch({ strict: false });
  const status = useQuery(bankStatusQuery);
  const accounts = useQuery({ ...accountsQuery, enabled: status.data?.connected === true });

  useEffect(() => {
    if (outcome !== 'error') return;
    toast.show({ key: 'bank', tone: 'error', message: "The bank wasn't connected. Try again." });
    void navigate({ to: '/settings', replace: true });
  }, [outcome, toast, navigate]);

  const saved = (next: BankStatus) => queryClient.setQueryData(bankStatusQuery.queryKey, next);
  const failed = (error: Error) => {
    toast.show({ tone: 'error', message: errorMessage(error) });
    void queryClient.invalidateQueries({ queryKey: bankStatusQuery.queryKey });
  };
  const link = useMutation({
    mutationFn: ({ id, accountId }: { id: string; accountId: string | null }) =>
      unwrap(api.api.bank.accounts[':id'].link.$put({ param: { id }, json: { accountId } })),
    onSuccess: saved,
    onError: failed,
  });
  const disconnect = useMutation({
    mutationFn: () => unwrap(api.api.bank.connection.$delete()),
    onSuccess: saved,
    onError: failed,
  });
  const sync = useMutation({
    mutationFn: () => unwrap(api.api.bank.sync.$post()),
    onSuccess: async ({ imported }) => {
      await invalidateData(queryClient);
      toast.show(
        imported === 0
          ? { key: COMMAND_TOAST, message: 'No new transactions' }
          : {
              key: COMMAND_TOAST,
              message: `Imported ${imported} transaction${imported === 1 ? '' : 's'}`,
              action: { label: 'Undo', onClick: undo },
            },
      );
    },
    onError: failed,
  });

  if (!status.data?.configured) return null;
  const { connected, status: state } = status.data;
  const options = (bank: BankAccountDto) =>
    (accounts.data?.accounts ?? []).filter(
      (a) => a.id === bank.accountId || (!a.closed && a.currency === bank.currency),
    );

  return (
    <section aria-labelledby="bank-heading" className="mt-6">
      <h2 id="bank-heading" className="px-4 pb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase">
        Bank connections
      </h2>
      <div className="flex flex-col gap-4 border-y border-gray-200 bg-white p-4">
        {!connected ? (
          <>
            <p className="text-sm text-gray-600">
              Import transactions from your banks (e.g. Revolut, PKO BP) through Mastercard Open Banking.
            </p>
            <a href={CONNECT_URL} className={`${LINK_CLASS} bg-brand text-white hover:bg-brand-dark`}>
              Connect bank
            </a>
          </>
        ) : (
          <>
            {state === 'reconnect_needed' ? (
              <>
                <p className="text-sm text-red-700">The bank connection has expired. Reconnect to keep syncing.</p>
                <a href={CONNECT_URL} className={`${LINK_CLASS} bg-brand text-white hover:bg-brand-dark`}>
                  Reconnect
                </a>
              </>
            ) : (
              <p className="text-sm text-gray-600">Connected. New transactions sync every 6 hours.</p>
            )}
            {status.data.accounts.map((bank) => (
              <SelectField
                key={bank.id}
                label={`${bank.providerName ? `${bank.providerName} · ` : ''}${bank.name}${bank.currency ? ` (${bank.currency})` : ''}`}
                value={bank.accountId ?? ''}
                hint={lastSynced(bank.lastSyncedAt)}
                disabled={link.isPending}
                onChange={(event) => link.mutate({ id: bank.id, accountId: event.target.value || null })}
              >
                <option value="">Not linked</option>
                {options(bank).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </SelectField>
            ))}
            <Button mutating busy={sync.isPending} disabled={state !== 'active'} onClick={() => sync.mutate()}>
              Sync now
            </Button>
            <Button variant="ghost" mutating busy={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Disconnect
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
