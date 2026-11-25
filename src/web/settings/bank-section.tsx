import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import type { BankAccountDto, BankConnectionDto, BankStatus, BankSyncResponse } from '../../shared/api/bank';
import { accountsQuery } from '../accounts/accounts-api';
import { api, unwrap } from '../lib/api';
import { COMMAND_TOAST, errorMessage, useUndoRedo } from '../lib/commands';
import { formatDate } from '../lib/format';
import { useOnline } from '../lib/online';
import { invalidateData } from '../lib/query';
import { todayIso } from '../lib/today';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { SelectField } from '../ui/field';
import { Loading, LoadError } from '../ui/load-state';
import { Pill } from '../ui/pill';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';

const bankStatusQuery = queryOptions({
  queryKey: ['bank', 'status'],
  queryFn: () => unwrap(api.api.bank.status.$get()),
});

const banksQuery = queryOptions({
  queryKey: ['bank', 'aspsps'],
  queryFn: () => unwrap(api.api.bank.aspsps.$get()),
  staleTime: 60 * 60 * 1000,
});

/** A top-level navigation: the server sends the browser on to the bank, which sends it back to /settings. */
const connectUrl = (bank: string) => `/api/bank/connect?bank=${encodeURIComponent(bank)}`;

/** Opens the bank's consent; like a mutating button, it is off while offline. */
function ConnectLink({ bank, className, children }: { bank: string; className: string; children: ReactNode }) {
  const online = useOnline();
  if (!online) {
    return (
      <span aria-disabled="true" title="You're offline" className={cx(className, 'cursor-not-allowed text-muted')}>
        {children}
      </span>
    );
  }
  return (
    <a href={connectUrl(bank)} className={className}>
      {children}
    </a>
  );
}

const dateOf = (iso: string) => formatDate(todayIso(new Date(iso)));

function lastSynced(iso: string | null): string {
  if (iso === null) return 'Not synced yet';
  return `Last synced ${dateOf(iso)} ${new Date(iso).toTimeString().slice(0, 5)}`;
}

function syncMessage({ imported, reconnectNeeded, failed }: BankSyncResponse): string {
  const parts = [imported === 0 ? 'No new transactions.' : `Imported ${imported} transaction${imported === 1 ? '' : 's'}.`];
  if (reconnectNeeded.length > 0) parts.push(`Reconnect ${reconnectNeeded.join(', ')} to sync it.`);
  if (failed.length > 0) parts.push(`Couldn't reach ${failed.join(', ')}.`);
  return parts.join(' ');
}

/** The "Connect bank" sheet: the Polish banks Enable Banking offers, with a search box. */
function BankPicker({ connected }: { connected: Set<string> }) {
  const [search, setSearch] = useState('');
  const banks = useQuery(banksQuery);
  const query = search.trim().toLocaleLowerCase('pl');
  const matches = (banks.data?.aspsps ?? []).filter((b) => b.name.toLocaleLowerCase('pl').includes(query));

  return (
    <div className="flex flex-col gap-3">
      <input
        type="search"
        aria-label="Search banks"
        placeholder="Search banks"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="min-h-11 rounded-xl border border-line bg-raised px-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
      />
      {banks.isPending ? (
        <Loading label="Loading banks…" />
      ) : banks.isError ? (
        <LoadError error={banks.error} onRetry={() => void banks.refetch()} />
      ) : matches.length === 0 ? (
        <p className="py-6 text-center text-muted">No bank matches “{search.trim()}”.</p>
      ) : (
        <ul aria-label="Banks" className="-mx-4 divide-y divide-line">
          {matches.map((bank) => (
            <li key={bank.name}>
              <ConnectLink
                bank={bank.name}
                className="flex min-h-12 items-center justify-between gap-3 px-4 hover:bg-white/5 focus:bg-white/5 focus:outline-none"
              >
                <span className="min-w-0 truncate">{bank.name}</span>
                {connected.has(bank.name) && <span className="text-sm text-muted">Connected</span>}
              </ConnectLink>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted">You sign in at your bank; Budget Track only reads your transactions.</p>
    </div>
  );
}

/**
 * Settings → Bank connections (Enable Banking): connect banks (which adds their accounts to the budget), add a bank
 * account the connection couldn't add or link it to an account in its currency, sync (one undoable "Bank sync"),
 * reconnect when a bank's consent ends and disconnect. Hidden unless the server is configured for it.
 */
export function BankSection() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { undo } = useUndoRedo();
  const navigate = useNavigate();
  const { bank: outcome } = useSearch({ strict: false });
  const [picking, setPicking] = useState(false);
  const status = useQuery(bankStatusQuery);
  const hasBankAccounts = status.data?.connections.some((c) => c.accounts.length > 0) === true;
  const accounts = useQuery({ ...accountsQuery, enabled: hasBankAccounts });

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
    mutationFn: ({ uid, accountId }: { uid: string; accountId: string | null }) =>
      unwrap(api.api.bank.accounts[':uid'].link.$put({ param: { uid }, json: { accountId } })),
    onSuccess: saved,
    onError: failed,
  });
  const add = useMutation({
    mutationFn: (uid: string) => unwrap(api.api.bank.accounts[':uid']['create-account'].$post({ param: { uid } })),
    onSuccess: async ({ name, status: next }) => {
      saved(next);
      await invalidateData(queryClient);
      toast.show({ key: COMMAND_TOAST, message: `Added ${name} to Accounts` });
    },
    onError: failed,
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => unwrap(api.api.bank.connections[':id'].$delete({ param: { id } })),
    onSuccess: saved,
    onError: failed,
  });
  const sync = useMutation({
    mutationFn: () => unwrap(api.api.bank.sync.$post()),
    onSuccess: async (result) => {
      await invalidateData(queryClient);
      // Only a sync that imported nothing because of a bank is an error; otherwise its cards show what needs doing.
      const problems = result.reconnectNeeded.length + result.failed.length > 0;
      toast.show({
        key: COMMAND_TOAST,
        tone: problems && result.imported === 0 ? 'error' : 'info',
        message: syncMessage(result),
        ...(result.imported > 0 && { action: { label: 'Undo', onClick: undo } }),
      });
    },
    onError: failed,
  });

  if (!status.data?.configured) return null;
  const { connections } = status.data;
  const options = (bank: BankAccountDto) =>
    (accounts.data?.accounts ?? []).filter((a) => a.id === bank.accountId || (!a.closed && a.currency === bank.currency));
  const accountHint = (bank: BankAccountDto) =>
    [bank.iban && `…${bank.iban.slice(-4)}`, lastSynced(bank.lastSyncedAt)].filter(Boolean).join(' · ');

  const connection = (c: BankConnectionDto) => (
    <article
      key={c.id}
      aria-labelledby={`bank-${c.id}`}
      className="flex flex-col gap-3 rounded-xl bg-raised p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={`bank-${c.id}`} className="min-w-0 truncate font-semibold">
          {c.bank}
        </h3>
        <Pill tone={c.status === 'active' ? 'green' : 'red'}>
          {c.status === 'active' ? 'Active' : 'Reconnect needed'}
        </Pill>
      </div>
      <p className="text-sm text-muted">
        {c.status === 'active' ? `Valid until ${dateOf(c.validUntil)}` : 'The consent has ended: reconnect to keep syncing.'}
      </p>
      {c.accounts.length === 0 && <p className="text-sm text-muted">The bank shared no accounts.</p>}
      {c.accounts.map((bank) => (
        <div key={bank.uid} className="flex items-start gap-2">
          <SelectField
            className="min-w-0 flex-1"
            label={`${bank.name} (${bank.currency})`}
            value={bank.accountId ?? ''}
            hint={accountHint(bank)}
            disabled={link.isPending || add.isPending}
            onChange={(event) => link.mutate({ uid: bank.uid, accountId: event.target.value || null })}
          >
            <option value="">{bank.accountId ? 'Not linked' : 'Link to existing account…'}</option>
            {options(bank).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </SelectField>
          {bank.accountId === null && (
            // Level with the select, under its label.
            <Button
              variant="secondary"
              className="mt-6"
              mutating
              busy={add.isPending && add.variables === bank.uid}
              disabled={add.isPending || link.isPending}
              onClick={() => add.mutate(bank.uid)}
            >
              Add to budget
            </Button>
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <ConnectLink
          bank={c.bank}
          className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-base font-semibold text-brand ring-1 ring-line hover:bg-white/5"
        >
          Reconnect
        </ConnectLink>
        <Button
          variant="ghost"
          mutating
          busy={disconnect.isPending && disconnect.variables === c.id}
          onClick={() => disconnect.mutate(c.id)}
        >
          Disconnect
        </Button>
      </div>
    </article>
  );

  return (
    <section aria-labelledby="bank-heading" className="mt-6">
      <h2 id="bank-heading" className="px-8 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">
        Bank connections
      </h2>
      <div className="mx-4 flex flex-col gap-4 rounded-2xl bg-surface p-4">
        {connections.length === 0 ? (
          <p className="text-sm text-muted">
            Import transactions from PKO BP, Revolut and other Polish banks through Enable Banking.
          </p>
        ) : (
          <>
            {connections.map(connection)}
            <p className="text-sm text-muted">New transactions sync every 6 hours.</p>
            <Button
              mutating
              busy={sync.isPending}
              disabled={!connections.some((c) => c.status === 'active')}
              onClick={() => sync.mutate()}
            >
              Sync now
            </Button>
          </>
        )}
        <Button variant={connections.length === 0 ? 'primary' : 'secondary'} mutating onClick={() => setPicking(true)}>
          Connect bank
        </Button>
      </div>
      <Sheet open={picking} onClose={() => setPicking(false)} title="Connect bank">
        <BankPicker connected={new Set(connections.map((c) => c.bank))} />
      </Sheet>
    </section>
  );
}
