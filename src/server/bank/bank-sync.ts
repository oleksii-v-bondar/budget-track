import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { BankStatus, BankSyncResponse } from '../../shared/api/bank';
import { MAX_AMOUNT } from '../../shared/api/common';
import { addDays, type IsoDate } from '../../engine';
import { todayIn } from '../clock';
import { runCommand } from '../commands/run-command';
import type { EnableBankingConfig } from '../config';
import { account, bankAccount, bankConnection, transaction } from '../db/schema';
import type { AppDeps } from '../http/app';
import { AppError, DomainError } from '../http/errors';
import { findUserPayeeByName } from '../payees/payee-commands';
import type { DefaultRates } from '../transactions/plan';
import { createTransaction } from '../transactions/transaction-commands';
import {
  type BankTransaction,
  type EnableBankingClient,
  EnableBankingError,
  enableBankingClient,
} from './enable-banking';

/** The banks offered are Polish. */
const COUNTRY = 'PL';
const DAY_MS = 24 * 60 * 60 * 1000;
/** A consent lasts as long as the bank allows, at most 180 days, less a margin so clock skew can't overshoot it. */
const MAX_CONSENT_MS = 180 * DAY_MS;
const CONSENT_MARGIN_MS = 10 * 60 * 1000;
/** The first sync of an account looks back this far; later ones overlap the last by a few days for late bookings. */
const FIRST_SYNC_DAYS = 90;
const OVERLAP_DAYS = 5;
const AUTO_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const AUTO_SYNC_FIRST_MS = 60 * 1000;

const unavailable = () =>
  new AppError(502, 'bank_unavailable', "Can't reach the bank connection service. Try again later.");

// One client per configuration, so its JWT and bank list are cached across requests and the auto-sync.
const clients = new WeakMap<EnableBankingConfig, EnableBankingClient>();

export function bankClient(deps: AppDeps): EnableBankingClient {
  const config = deps.config.enableBanking;
  if (!config) throw new AppError(404, 'bank_not_configured', 'Bank connections are not configured.');
  let client = clients.get(config);
  if (!client) {
    client = enableBankingClient(config, deps.logger, deps.clock);
    clients.set(config, client);
  }
  return client;
}

export async function bankStatus(deps: AppDeps): Promise<BankStatus> {
  const now = deps.clock.now();
  const connections = await deps.db.select().from(bankConnection).orderBy(bankConnection.aspspName);
  const accounts = await deps.db.select().from(bankAccount).orderBy(bankAccount.name, bankAccount.uid);
  return {
    configured: deps.config.enableBanking !== null,
    connections: connections.map((c) => ({
      id: c.id,
      bank: c.aspspName,
      // A session past its end needs a reconnect, even before a sync has found out.
      status: c.validUntil <= now ? 'reconnect_needed' : c.status,
      validUntil: c.validUntil.toISOString(),
      accounts: accounts
        .filter((a) => a.connectionId === c.id)
        .map((a) => ({
          uid: a.uid,
          name: a.name,
          iban: a.iban,
          currency: a.currency,
          accountId: a.accountId,
          lastSyncedAt: a.lastSyncedAt?.toISOString() ?? null,
        })),
    })),
  };
}

/** The Polish banks for personal customers (cached by the client for 24 hours). */
export async function listBanks(deps: AppDeps): Promise<{ name: string }[]> {
  const client = bankClient(deps);
  try {
    return (await client.aspsps(COUNTRY)).map(({ name }) => ({ name }));
  } catch (err) {
    if (!(err instanceof EnableBankingError)) throw err;
    deps.logger.warn({ err }, 'Enable Banking bank list failed');
    throw unavailable();
  }
}

/** Starts the consent with a bank; returns where to send the browser. */
export async function startConnect(deps: AppDeps, bank: string, state: string): Promise<string> {
  const client = bankClient(deps);
  const aspsp = (await client.aspsps(COUNTRY)).find((a) => a.name === bank);
  if (!aspsp) throw new AppError(404, 'bank_not_found', 'Choose one of the listed banks.');
  const validity = Math.min((aspsp.maximumConsentValidity ?? Infinity) * 1000, MAX_CONSENT_MS);
  const validUntil = new Date(deps.clock.now().getTime() + validity - CONSENT_MARGIN_MS);
  return client.startAuthorization(aspsp, validUntil, state);
}

/**
 * The end of the consent flow: stores the session and its accounts. A bank connected before is replaced (its old
 * session is deleted), and its accounts keep their links where the IBAN and currency match.
 */
export async function completeConnect(deps: AppDeps, code: string): Promise<void> {
  const client = bankClient(deps);
  const session = await client.createSession(code);
  const replaced = await deps.db.transaction(async (tx) => {
    const old = await tx
      .select()
      .from(bankConnection)
      .where(and(eq(bankConnection.aspspName, session.aspsp.name), eq(bankConnection.aspspCountry, session.aspsp.country)));
    const oldIds = old.map((c) => c.id);
    const links = new Map<string, typeof bankAccount.$inferSelect>();
    if (oldIds.length > 0) {
      const oldAccounts = await tx.select().from(bankAccount).where(inArray(bankAccount.connectionId, oldIds));
      for (const a of oldAccounts) if (a.iban && a.accountId) links.set(`${a.iban}|${a.currency}`, a);
      await tx.delete(bankAccount).where(inArray(bankAccount.connectionId, oldIds));
      await tx.delete(bankConnection).where(inArray(bankConnection.id, oldIds));
    }
    const [connection] = await tx
      .insert(bankConnection)
      .values({
        sessionId: session.sessionId,
        aspspName: session.aspsp.name,
        aspspCountry: session.aspsp.country,
        validUntil: session.validUntil,
      })
      .returning();
    if (session.accounts.length > 0) {
      await tx.insert(bankAccount).values(
        session.accounts.map((a) => {
          const link = a.iban ? links.get(`${a.iban}|${a.currency}`) : undefined;
          return {
            uid: a.uid,
            connectionId: connection!.id,
            name: a.name,
            iban: a.iban,
            currency: a.currency,
            accountId: link?.accountId ?? null,
            lastSyncedAt: link?.lastSyncedAt ?? null,
          };
        }),
      );
    }
    return old;
  });
  for (const { sessionId } of replaced) {
    if (sessionId !== session.sessionId) await closeSession(deps, client, sessionId);
  }
}

/** Ends a session at Enable Banking; it may be gone already, so failures are only logged. */
async function closeSession(deps: AppDeps, client: EnableBankingClient, sessionId: string): Promise<void> {
  await client.deleteSession(sessionId).catch((err: unknown) => {
    deps.logger.warn({ err }, 'deleting an Enable Banking session failed');
  });
}

/** Forgets a connection and its bank accounts, and ends its session; imported transactions stay. */
export async function disconnectBank(deps: AppDeps, id: string): Promise<void> {
  const [connection] = await deps.db.select().from(bankConnection).where(eq(bankConnection.id, id));
  if (!connection) throw new AppError(404, 'not_found', 'Bank connection not found.');
  if (deps.config.enableBanking) await closeSession(deps, bankClient(deps), connection.sessionId);
  await deps.db.transaction(async (tx) => {
    await tx.delete(bankAccount).where(eq(bankAccount.connectionId, id));
    await tx.delete(bankConnection).where(eq(bankConnection.id, id));
  });
}

/** Links a bank account to an account in the same currency (null unlinks). A new link starts with a first sync. */
export async function linkBankAccount(deps: AppDeps, uid: string, accountId: string | null): Promise<void> {
  const [bank] = await deps.db.select().from(bankAccount).where(eq(bankAccount.uid, uid));
  if (!bank) throw new AppError(404, 'not_found', 'Bank account not found.');
  if (accountId !== null) {
    const [target] = await deps.db.select({ currency: account.currency }).from(account).where(eq(account.id, accountId));
    if (!target) throw new DomainError('invalid_account', 'Choose one of your accounts.', 'accountId');
    if (target.currency !== bank.currency) {
      throw new DomainError(
        'bank_currency_mismatch',
        `"${bank.name}" is in ${bank.currency}: link it to an account in the same currency.`,
        'accountId',
      );
    }
  }
  const lastSyncedAt = accountId === bank.accountId ? bank.lastSyncedAt : null;
  await deps.db.update(bankAccount).set({ accountId, lastSyncedAt }).where(eq(bankAccount.uid, uid));
}

interface Import {
  importId: string;
  date: IsoDate;
  payeeName: string;
  amount: number;
  defaults: DefaultRates;
}

/** What an import id says after `<uid>:`: the same for a transaction in every session of its account. */
const refOf = (importId: string) => importId.slice(importId.indexOf(':') + 1);

/**
 * A booked transaction's import: amount in minor units, negative for a debit; the counterparty (or the first line of
 * the payment details) as the payee. Null for one without a date. `hashes` numbers transactions that have no id from
 * the bank and look the same.
 */
function importOf(uid: string, t: BankTransaction, hashes: Map<string, number>) {
  const date = t.booking_date ?? t.value_date ?? t.transaction_date;
  if (!date) return null;
  const minor = Math.round(Math.abs(Number(t.transaction_amount.amount)) * 100);
  const amount = t.credit_debit_indicator === 'DBIT' ? -minor : minor;
  const remittance = t.remittance_information ?? [];
  const counterparty = (t.credit_debit_indicator === 'DBIT' ? t.creditor : t.debtor)?.name?.trim();
  const details = remittance.map((line) => line.trim()).find((line) => line !== '');
  const payeeName = (counterparty || details || 'Unknown').slice(0, 100).trim();
  let ref = t.entry_reference || t.transaction_id;
  if (!ref) {
    ref = createHash('sha256').update(`${date}|${amount}|${remittance.join('\n')}`).digest('hex');
    const seen = (hashes.get(ref) ?? 0) + 1;
    hashes.set(ref, seen);
    if (seen > 1) ref = `${ref}#${seen}`;
  }
  return { importId: `${uid}:${ref}`, date, amount, payeeName };
}

/**
 * Imports the booked transactions of every linked bank account of the active connections as one undoable command
 * ("Bank sync"): unapproved and cleared, the counterparty as the payee with that payee's last category (YNAB-like).
 * The import id (`<uid>:<entry reference>`) skips what was imported before, deleted or not, also from an earlier
 * session of the same bank account. Transactions dated before the account's starting balance (already in it) or after
 * today are left out. A connection whose session has expired becomes `reconnect_needed` and is skipped; one that
 * fails otherwise is skipped this time.
 */
async function runSync(deps: AppDeps): Promise<BankSyncResponse> {
  const client = bankClient(deps);
  const connections = await deps.db.select().from(bankConnection).orderBy(bankConnection.aspspName);
  if (connections.length === 0) throw new AppError(409, 'bank_not_connected', 'Connect a bank first.');
  const now = deps.clock.now();
  const today = todayIn(deps.config.timeZone, now);
  const linked = await deps.db
    .select({ bank: bankAccount, currency: account.currency, accountClass: account.accountClass, opened: transaction.date })
    .from(bankAccount)
    .innerJoin(account, eq(account.id, bankAccount.accountId))
    .leftJoin(
      transaction,
      and(eq(transaction.accountId, account.id), eq(transaction.isStartingBalance, true), isNull(transaction.deletedAt)),
    )
    .where(eq(account.closed, false));

  const reconnectNeeded: string[] = [];
  const failed: string[] = [];
  const needsReconnect = async (connection: typeof bankConnection.$inferSelect) => {
    reconnectNeeded.push(connection.aspspName);
    if (connection.status === 'reconnect_needed') return;
    await deps.db.update(bankConnection).set({ status: 'reconnect_needed' }).where(eq(bankConnection.id, connection.id));
  };

  const fetched: { uid: string; accountId: string; onBudget: boolean; imports: Import[]; complete: boolean }[] = [];
  for (const connection of connections) {
    if (connection.status !== 'active' || connection.validUntil <= now) {
      await needsReconnect(connection);
      continue;
    }
    const fromConnection: typeof fetched = [];
    try {
      for (const { bank, currency, accountClass, opened } of linked) {
        if (bank.connectionId !== connection.id) continue;
        const start = opened ?? '1970-01-01';
        const firstFrom = addDays(today, -FIRST_SYNC_DAYS);
        const from = bank.lastSyncedAt
          ? addDays(todayIn(deps.config.timeZone, bank.lastSyncedAt), -OVERLAP_DAYS)
          : firstFrom > start
            ? firstFrom
            : start;
        if (from > today) continue;
        const list = await client.transactions(bank.uid, from, today);
        const imports: Import[] = [];
        // A transaction without an NBP rate waits for the next sync, which starts from the last complete one.
        let complete = true;
        const rates = new Map<IsoDate, string | null>();
        const hashes = new Map<string, number>();
        for (const t of list) {
          if (t.status !== 'BOOK') continue;
          const item = importOf(bank.uid, t, hashes);
          if (!item || item.date < start || item.date > today) continue;
          if (t.transaction_amount.currency.toUpperCase() !== currency || !(Math.abs(item.amount) <= MAX_AMOUNT)) {
            deps.logger.warn({ uid: bank.uid, importId: item.importId }, 'skipped a bank transaction');
            continue;
          }
          const defaults: DefaultRates = { date: item.date, rates: new Map() };
          if (currency !== BASE_CURRENCY) {
            if (!rates.has(item.date)) rates.set(item.date, (await deps.fx.quote(currency, item.date))?.rate ?? null);
            const rate = rates.get(item.date);
            if (!rate) {
              complete = false;
              continue;
            }
            defaults.rates.set(currency, rate);
          }
          imports.push({ ...item, defaults });
        }
        fromConnection.push({ uid: bank.uid, accountId: bank.accountId!, onBudget: accountClass !== 'tracking', imports, complete });
      }
    } catch (err) {
      if (!(err instanceof EnableBankingError)) throw err;
      deps.logger.warn({ err, bank: connection.aspspName }, 'Enable Banking sync failed');
      if (err.sessionExpired) await needsReconnect(connection);
      else failed.push(connection.aspspName);
      continue;
    }
    fetched.push(...fromConnection);
  }

  const imported = await runCommand(deps, 'Bank sync', async (rec) => {
    let count = 0;
    for (const { accountId, onBudget, imports } of fetched) {
      const refs = imports.map((i) => refOf(i.importId));
      const known = refs.length
        ? await rec.tx
            .select({ importId: transaction.importId })
            .from(transaction)
            .where(
              and(
                eq(transaction.accountId, accountId),
                inArray(sql`substr(${transaction.importId}, strpos(${transaction.importId}, ':') + 1)`, refs),
              ),
            )
        : [];
      const seen = new Set(known.map((row) => refOf(row.importId!)));
      for (const i of imports) {
        const ref = refOf(i.importId);
        if (seen.has(ref)) continue;
        seen.add(ref);
        const payee = await findUserPayeeByName(rec.tx, i.payeeName);
        const input = {
          accountId,
          date: i.date,
          payeeName: i.payeeName,
          categoryId: onBudget ? (payee?.lastCategoryId ?? null) : null,
          memo: '',
          amount: i.amount,
          cleared: 'cleared' as const,
          flag: null,
        };
        const saved = await createTransaction(rec, input, today, i.defaults);
        await rec.update(transaction, eq(transaction.id, saved.id), { approved: false, importId: i.importId });
        count++;
      }
    }
    return count;
  });
  // Outside the command, so a sync that imports nothing adds no undo entry.
  const synced = fetched.filter((f) => f.complete).map((f) => f.uid);
  if (synced.length > 0) {
    await deps.db.update(bankAccount).set({ lastSyncedAt: now }).where(inArray(bankAccount.uid, synced));
  }
  return { imported, reconnectNeeded, failed };
}

let running: Promise<BankSyncResponse> | null = null;

/** POST /api/bank/sync and the auto-sync. One sync at a time: callers share it. */
export function syncBank(deps: AppDeps): Promise<BankSyncResponse> {
  running ??= runSync(deps).finally(() => {
    running = null;
  });
  return running;
}

/** Syncs a minute after start, then every 6 hours, while a connection is active. Errors are logged. Returns a stop. */
export function startAutoSync(deps: AppDeps): () => void {
  const run = () => {
    deps.db
      .select({ id: bankConnection.id })
      .from(bankConnection)
      .where(eq(bankConnection.status, 'active'))
      .limit(1)
      .then(async ([active]) => {
        if (!active) return;
        const result = await syncBank(deps);
        deps.logger.info(result, 'bank auto-sync');
      })
      .catch((err: unknown) => deps.logger.warn({ err }, 'bank auto-sync failed'));
  };
  const first = setTimeout(run, AUTO_SYNC_FIRST_MS);
  const every = setInterval(run, AUTO_SYNC_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
