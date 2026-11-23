import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { BankStatus } from '../../shared/api/bank';
import { MAX_AMOUNT } from '../../shared/api/common';
import { addDays, type IsoDate } from '../../engine';
import { todayIn } from '../clock';
import { runCommand } from '../commands/run-command';
import type { Executor } from '../db/client';
import { account, bankAccount, bankConnection, transaction } from '../db/schema';
import type { AppDeps } from '../http/app';
import { AppError, DomainError } from '../http/errors';
import { findUserPayeeByName } from '../payees/payee-commands';
import type { DefaultRates } from '../transactions/plan';
import { createTransaction } from '../transactions/transaction-commands';
import { type AiiaClient, AiiaError, aiiaClient, type AiiaTokens } from './aiia';

/** The first sync of an account looks back this far; later ones overlap the last by a few days for late bookings. */
const FIRST_SYNC_DAYS = 90;
const OVERLAP_DAYS = 5;
const AUTO_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const AUTO_SYNC_FIRST_MS = 60 * 1000;

const reconnectNeeded = () =>
  new AppError(409, 'bank_reconnect_needed', 'The bank connection has expired. Reconnect it in Settings.');

export function bankClient(deps: AppDeps): AiiaClient {
  if (!deps.config.aiia) throw new AppError(404, 'bank_not_configured', 'Bank connections are not configured.');
  return aiiaClient(deps.config.aiia, deps.logger);
}

async function findConnection(db: Executor) {
  const [row] = await db.select().from(bankConnection).limit(1);
  return row ?? null;
}

const tokenColumns = (tokens: AiiaTokens, now: Date) => ({
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  accessExpiresAt: new Date(now.getTime() + tokens.expiresIn * 1000),
  status: 'active' as const,
});

export async function bankStatus(deps: AppDeps): Promise<BankStatus> {
  const connection = await findConnection(deps.db);
  const accounts = await deps.db.select().from(bankAccount).orderBy(bankAccount.providerName, bankAccount.name);
  return {
    configured: deps.config.aiia !== null,
    connected: connection !== null,
    status: connection?.status ?? null,
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      providerName: a.providerName,
      accountId: a.accountId,
      lastSyncedAt: a.lastSyncedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * The end of the consent flow: stores the tokens (replacing the connection, if any) and the bank accounts they cover.
 * Accounts seen before keep their links; accounts the new consent no longer covers are forgotten.
 */
export async function connectBank(deps: AppDeps, code: string): Promise<void> {
  const aiia = bankClient(deps);
  const tokens = await aiia.exchangeCode(code);
  const accounts = await aiia.accounts(tokens.accessToken);
  const columns = tokenColumns(tokens, deps.clock.now());
  await deps.db.transaction(async (tx) => {
    const existing = await findConnection(tx);
    if (existing) await tx.update(bankConnection).set(columns).where(eq(bankConnection.id, existing.id));
    const connectionId = existing?.id ?? (await tx.insert(bankConnection).values(columns).returning())[0]!.id;
    const ids = accounts.map((a) => a.id);
    await tx.delete(bankAccount).where(ids.length > 0 ? notInArray(bankAccount.id, ids) : undefined);
    for (const a of accounts) {
      const values = { name: a.name, currency: a.currency, providerName: a.providerName, connectionId };
      await tx
        .insert(bankAccount)
        .values({ id: a.id, ...values })
        .onConflictDoUpdate({ target: bankAccount.id, set: values });
    }
  });
}

/** Forgets the connection and its bank accounts; imported transactions stay. */
export async function disconnectBank(deps: AppDeps): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await tx.delete(bankAccount);
    await tx.delete(bankConnection);
  });
}

/** Links a bank account to an account in the same currency (null unlinks). A new link starts with a first sync. */
export async function linkBankAccount(deps: AppDeps, id: string, accountId: string | null): Promise<void> {
  const [bank] = await deps.db.select().from(bankAccount).where(eq(bankAccount.id, id));
  if (!bank) throw new AppError(404, 'not_found', 'Bank account not found.');
  if (accountId !== null) {
    const [target] = await deps.db.select({ currency: account.currency }).from(account).where(eq(account.id, accountId));
    if (!target) throw new DomainError('invalid_account', 'Choose one of your accounts.', 'accountId');
    if (target.currency !== bank.currency) {
      throw new DomainError(
        'bank_currency_mismatch',
        `"${bank.name}" is in ${bank.currency ?? 'an unknown currency'}: link it to an account in the same currency.`,
        'accountId',
      );
    }
  }
  const lastSyncedAt = accountId === bank.accountId ? bank.lastSyncedAt : null;
  await deps.db.update(bankAccount).set({ accountId, lastSyncedAt }).where(eq(bankAccount.id, id));
}

/** Runs a call to Aiia. A refusal (`refused` statuses) means the consent is gone: the connection needs a reconnect. */
async function remote<T>(deps: AppDeps, connectionId: string, call: () => Promise<T>, refused = [401, 403]): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof AiiaError)) throw err;
    deps.logger.warn({ err }, 'Aiia call failed');
    if (refused.includes(err.status)) {
      await deps.db.update(bankConnection).set({ status: 'reconnect_needed' }).where(eq(bankConnection.id, connectionId));
      throw reconnectNeeded();
    }
    throw new AppError(502, 'bank_unavailable', "Can't reach the bank connection service. Try again later.");
  }
}

/** A live access token: refreshed (and the new pair stored) when it expires within a minute. */
async function accessToken(
  deps: AppDeps,
  aiia: AiiaClient,
  connection: typeof bankConnection.$inferSelect,
  now: Date,
): Promise<string> {
  if (connection.accessExpiresAt.getTime() > now.getTime() + 60_000) return connection.accessToken;
  const tokens = await remote(deps, connection.id, () => aiia.refresh(connection.refreshToken), [400, 401, 403]);
  await deps.db.update(bankConnection).set(tokenColumns(tokens, now)).where(eq(bankConnection.id, connection.id));
  return tokens.accessToken;
}

interface Import {
  importId: string;
  date: IsoDate;
  payeeName: string | undefined;
  amount: number;
  defaults: DefaultRates;
}

/**
 * Imports the booked transactions of every linked bank account as one undoable command ("Bank sync"): unapproved and
 * cleared, the bank's text as the payee and that payee's last category (YNAB-like). `import_id` (`<bank account
 * id>:<transaction id>`) skips what was imported before, deleted or not. Transactions dated before the account's
 * starting balance (already in it) or after today are left out.
 */
async function runSync(deps: AppDeps): Promise<{ imported: number }> {
  const aiia = bankClient(deps);
  const connection = await findConnection(deps.db);
  if (!connection) throw new AppError(409, 'bank_not_connected', 'Connect a bank first.');
  if (connection.status === 'reconnect_needed') throw reconnectNeeded();
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
  if (linked.length === 0) return { imported: 0 };

  const token = await accessToken(deps, aiia, connection, now);
  const fetched: { bankId: string; accountId: string; onBudget: boolean; imports: Import[]; complete: boolean }[] = [];
  for (const { bank, currency, accountClass, opened } of linked) {
    const start = opened ?? '1970-01-01';
    const firstFrom = addDays(today, -FIRST_SYNC_DAYS);
    const from = bank.lastSyncedAt
      ? addDays(todayIn(deps.config.timeZone, bank.lastSyncedAt), -OVERLAP_DAYS)
      : firstFrom > start
        ? firstFrom
        : start;
    const found = await remote(deps, connection.id, () =>
      aiia.transactions(token, bank.id, `${from}T00:00:00Z`, now.toISOString()),
    );
    const imports: Import[] = [];
    // A transaction without an NBP rate waits for the next sync, which starts from the last complete one.
    let complete = true;
    const rates = new Map<IsoDate, string | null>();
    for (const t of found) {
      if (t.state.toLowerCase() !== 'booked' || t.date < start || t.date > today) continue;
      const amount = Math.round(t.amount * 100);
      if ((t.currency !== null && t.currency !== currency) || !(Math.abs(amount) <= MAX_AMOUNT)) {
        deps.logger.warn({ bankAccountId: bank.id, transactionId: t.id }, 'skipped a bank transaction');
        continue;
      }
      const defaults: DefaultRates = { date: t.date, rates: new Map() };
      if (currency !== BASE_CURRENCY) {
        if (!rates.has(t.date)) rates.set(t.date, (await deps.fx.quote(currency, t.date))?.rate ?? null);
        const rate = rates.get(t.date);
        if (!rate) {
          complete = false;
          continue;
        }
        defaults.rates.set(currency, rate);
      }
      const payeeName = t.text?.slice(0, 100).trim() || undefined;
      imports.push({ importId: `${bank.id}:${t.id}`, date: t.date, payeeName, amount, defaults });
    }
    fetched.push({ bankId: bank.id, accountId: bank.accountId!, onBudget: accountClass !== 'tracking', imports, complete });
  }

  const imported = await runCommand(deps, 'Bank sync', async (rec) => {
    let count = 0;
    for (const { accountId, onBudget, imports } of fetched) {
      const ids = imports.map((i) => i.importId);
      const known = ids.length
        ? await rec.tx
            .select({ importId: transaction.importId })
            .from(transaction)
            .where(and(eq(transaction.accountId, accountId), inArray(transaction.importId, ids)))
        : [];
      const seen = new Set(known.map((row) => row.importId));
      for (const i of imports) {
        if (seen.has(i.importId)) continue;
        seen.add(i.importId);
        const payee = i.payeeName === undefined ? null : await findUserPayeeByName(rec.tx, i.payeeName);
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
  const synced = fetched.filter((f) => f.complete).map((f) => f.bankId);
  if (synced.length > 0) {
    await deps.db.update(bankAccount).set({ lastSyncedAt: now }).where(inArray(bankAccount.id, synced));
  }
  return { imported };
}

let running: Promise<{ imported: number }> | null = null;

/** POST /api/bank/sync and the auto-sync. One sync at a time (a refresh token works once): callers share it. */
export function syncBank(deps: AppDeps): Promise<{ imported: number }> {
  running ??= runSync(deps).finally(() => {
    running = null;
  });
  return running;
}

/** Syncs a minute after start, then every 6 hours, while a bank is connected. Errors are logged. Returns a stop. */
export function startAutoSync(deps: AppDeps): () => void {
  const run = () => {
    findConnection(deps.db)
      .then(async (connection) => {
        if (connection?.status !== 'active') return;
        const { imported } = await syncBank(deps);
        deps.logger.info({ imported }, 'bank auto-sync');
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
