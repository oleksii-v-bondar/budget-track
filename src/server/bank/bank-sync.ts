import { createHash } from 'node:crypto';
import { and, asc, eq, exists, gt, inArray, isNull, lt, ne, notExists, or, sql } from 'drizzle-orm';
import type { AccountType } from '../../shared/accounts';
import { BASE_CURRENCY, createAccountRequestSchema } from '../../shared/api/accounts';
import type { BankStatus, BankSyncResponse } from '../../shared/api/bank';
import { MAX_AMOUNT } from '../../shared/api/common';
import { addDays, diffDays, type IsoDate, monthOf } from '../../engine';
import { createAccount } from '../accounts/account-commands';
import { todayIn } from '../clock';
import type { ChangeRecorder } from '../commands/recorder';
import { runCommand } from '../commands/run-command';
import type { EnableBankingConfig } from '../config';
import { account, bankAccount, bankConnection, bankImport, payee, payeeAlias, transaction } from '../db/schema';
import type { AppDeps } from '../http/app';
import { AppError, DomainError } from '../http/errors';
import { createPayee, findUserPayeeByName, isUserPayee } from '../payees/payee-commands';
import { draftOf, loadAggregate } from '../transactions/aggregate';
import { type DefaultRates, planTransaction } from '../transactions/plan';
import { findAccount, onBudget } from '../transactions/rules';
import { createTransaction, updateTransaction } from '../transactions/transaction-commands';
import { syncPlan } from '../transactions/write';
import {
  type BankTransaction,
  type EnableBankingClient,
  EnableBankingError,
  enableBankingClient,
} from './enable-banking';
import { bestMatch, payeeDisplayName, payeeKey } from './payee-match';

/** The banks offered are Polish. */
const COUNTRY = 'PL';
const DAY_MS = 24 * 60 * 60 * 1000;
/** A consent lasts as long as the bank allows, at most 180 days, less a margin so clock skew can't overshoot it. */
const MAX_CONSENT_MS = 180 * DAY_MS;
const CONSENT_MARGIN_MS = 10 * 60 * 1000;
/** The first sync of an account looks back this far; later ones overlap the last by a few days for late bookings. */
const FIRST_SYNC_DAYS = 90;
const OVERLAP_DAYS = 5;
/** An import matches a row already there in its account with the same amount, dated this many days apart at most. */
const MATCH_DAYS = 4;
/** The two sides of a transfer: same currency, the opposite amount this many days apart at most… */
const PAIR_DAYS = 3;
/** …between currencies, PLN amounts within this many percent, this many days apart at most. */
const PAIR_FX_PERCENT = 2;
const PAIR_FX_DAYS = 1;
/** A pending transaction's booked copy (under a new id) is dated from this many days before it… */
const BOOKED_BEFORE_DAYS = 2;
/** …to this many days after it, with its amount or, at the same payee, one this many percent off (a tip, FX). */
const BOOKED_AFTER_DAYS = 7;
const BOOKED_AMOUNT_PERCENT = 10;
const AUTO_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const AUTO_SYNC_FIRST_MS = 60 * 1000;
/** The balance "Add to budget" starts from: booked, else expected, else available, else whichever the bank sends. */
const BALANCE_TYPES = ['ITBD', 'CLBD', 'XPCD', 'ITAV'];
/** The balances that count pending transactions already. */
const PENDING_BALANCES = new Set(['XPCD', 'ITAV']);

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
 * session is deleted), and its accounts keep their links where the IBAN and currency match. The others are added to
 * the budget; one that can't be stays unlinked, for Settings.
 */
export async function completeConnect(deps: AppDeps, code: string): Promise<void> {
  const client = bankClient(deps);
  const session = await client.createSession(code);
  const { replaced, connectionId } = await deps.db.transaction(async (tx) => {
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
            cashAccountType: a.cashAccountType,
            accountId: link?.accountId ?? null,
            lastSyncedAt: link?.lastSyncedAt ?? null,
          };
        }),
      );
    }
    return { replaced: old, connectionId: connection!.id };
  });
  for (const { sessionId } of replaced) {
    if (sessionId !== session.sessionId) await closeSession(deps, client, sessionId);
  }
  const unlinked = await deps.db
    .select({ uid: bankAccount.uid })
    .from(bankAccount)
    .where(and(eq(bankAccount.connectionId, connectionId), isNull(bankAccount.accountId)));
  for (const { uid } of unlinked) {
    await addToBudget(deps, uid).catch((err: unknown) => {
      deps.logger.warn({ err, uid }, 'adding a bank account to the budget failed');
    });
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
  /** Still pending at the bank (PDNG). */
  pending: boolean;
  defaults: DefaultRates;
}

/** What an import id says after `<uid>:`: the same for a transaction in every session of its account. */
const refOf = (importId: string) => importId.slice(importId.indexOf(':') + 1);

/**
 * A booked or pending transaction's import: amount in minor units, negative for a debit; the counterparty (or the
 * first line of the payment details) as the payee. Null for one without a date. `hashes` numbers transactions that
 * have no id from the bank and look the same.
 */
function importOf(uid: string, t: BankTransaction, hashes: Map<string, number>) {
  const pending = t.status === 'PDNG';
  // A pending card payment is dated the day it was made; the bank books it a few days later.
  const date = pending
    ? (t.transaction_date ?? t.booking_date ?? t.value_date)
    : (t.booking_date ?? t.value_date ?? t.transaction_date);
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
    const counted = `${t.status}|${ref}`;
    const seen = (hashes.get(counted) ?? 0) + 1;
    hashes.set(counted, seen);
    if (seen > 1) ref = `${ref}#${seen}`;
  }
  return { importId: `${uid}:${ref}`, date, amount, payeeName, pending };
}

/**
 * The booked and pending transactions of a list the sync imports into an account in `currency` opened on `start`, and
 * the refs of every pending one the bank lists, whatever its date.
 */
function bankImports(
  deps: AppDeps,
  uid: string,
  list: BankTransaction[],
  { start, today, currency }: { start: IsoDate; today: IsoDate; currency: string },
) {
  const hashes = new Map<string, number>();
  const pendingRefs: string[] = [];
  const items = list.flatMap((t) => {
    if (t.status !== 'BOOK' && t.status !== 'PDNG') return [];
    const item = importOf(uid, t, hashes);
    if (!item) return [];
    if (item.pending) pendingRefs.push(refOf(item.importId));
    if (item.date < start || item.date > today) return [];
    if (t.transaction_amount.currency.toUpperCase() !== currency || !(Math.abs(item.amount) <= MAX_AMOUNT)) {
      deps.logger.warn({ uid, importId: item.importId }, 'skipped a bank transaction');
      return [];
    }
    return [item];
  });
  return { items, pendingRefs };
}

/** By Enable Banking's cash account type: a card account is a credit card, a savings account savings, else checking. */
const accountTypeOf = (cashAccountType: string | null): AccountType =>
  cashAccountType === 'CARD' ? 'credit_card' : cashAccountType === 'SVGS' ? 'savings' : 'checking';

/**
 * The name "Add to budget" gives a bank account's account: the bank's (not the account's `name`, which may be its
 * holder's), with the currency when the connection has other accounts, and the IBAN's last 4 digits when one of them
 * is in the same currency; " 2", " 3"… keeps it unique.
 */
async function accountNameOf(deps: AppDeps, bank: typeof bankAccount.$inferSelect, bankName: string): Promise<string> {
  const others = await deps.db
    .select({ currency: bankAccount.currency })
    .from(bankAccount)
    .where(and(eq(bankAccount.connectionId, bank.connectionId), ne(bankAccount.uid, bank.uid)));
  let name = others.length > 0 ? `${bankName} ${bank.currency}` : bankName;
  if (bank.iban && others.some((o) => o.currency === bank.currency)) name += ` ••${bank.iban.slice(-4)}`;
  const taken = new Set((await deps.db.select({ name: account.name }).from(account)).map((a) => a.name.toLowerCase()));
  let unique = name;
  for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${name} ${n}`;
  return unique;
}

/**
 * "Add to budget" (YNAB-like): creates the account an unlinked bank account syncs into, links it and syncs it. The
 * starting balance, dated the 1st of this month, is the bank's balance less this month's booked transactions (and
 * pending ones, when the balance counts them), which the sync then imports unapproved, for review. Two undo entries:
 * the account's creation and the sync.
 */
export async function addToBudget(deps: AppDeps, uid: string): Promise<{ name: string }> {
  const [found] = await deps.db
    .select({ bank: bankAccount, bankName: bankConnection.aspspName })
    .from(bankAccount)
    .innerJoin(bankConnection, eq(bankConnection.id, bankAccount.connectionId))
    .where(eq(bankAccount.uid, uid));
  if (!found) throw new AppError(404, 'not_found', 'Bank account not found.');
  const { bank, bankName } = found;
  const linked = () => new AppError(409, 'bank_account_linked', 'This bank account is already linked to an account.');
  if (bank.accountId) throw linked();
  const client = bankClient(deps);
  const today = todayIn(deps.config.timeZone, deps.clock.now());
  const start = `${monthOf(today)}-01`;
  let balance: number;
  let month: number;
  try {
    const balances = (await client.balances(uid)).filter((b) => b.currency === bank.currency);
    const picked = BALANCE_TYPES.map((type) => balances.find((b) => b.type === type)).find(Boolean) ?? balances[0];
    if (!picked) throw new EnableBankingError(0, null, `Enable Banking sent no ${bank.currency} balance`);
    balance = Math.round(Number(picked.amount) * 100);
    const list = await client.transactions(uid, start, today);
    const { items } = bankImports(deps, uid, list, { start, today, currency: bank.currency });
    const counted = items.filter((i) => !i.pending || PENDING_BALANCES.has(picked.type));
    // Each transaction once, as the sync imports it.
    month = [...new Map(counted.map((i) => [i.importId, i.amount])).values()].reduce((sum, amount) => sum + amount, 0);
  } catch (err) {
    if (!(err instanceof EnableBankingError)) throw err;
    deps.logger.warn({ err, bank: bankName }, 'Enable Banking failed to give a starting balance');
    throw unavailable();
  }
  const input = createAccountRequestSchema.parse({
    name: await accountNameOf(deps, bank, bankName),
    type: accountTypeOf(bank.cashAccountType),
    currency: bank.currency,
    startingBalance: balance - month,
    startingDate: start,
  });
  // Spec §9: the NBP rate is quoted before the command, outside its transaction.
  const nbp = input.currency === BASE_CURRENCY ? null : await deps.fx.quote(input.currency, start);
  await runCommand(deps, `Create account "${input.name}"`, async (rec) => {
    const [current] = await rec.tx
      .select({ accountId: bankAccount.accountId })
      .from(bankAccount)
      .where(eq(bankAccount.uid, uid));
    if (current?.accountId) throw linked();
    const { id } = await createAccount(rec, input, today, nbp);
    // eslint-disable-next-line no-restricted-syntax -- bank_account isn't recorded: undoing the account unlinks it.
    await rec.tx.update(bankAccount).set({ accountId: id, lastSyncedAt: null }).where(eq(bankAccount.uid, uid));
  });
  await runSync(deps, uid);
  return { name: input.name };
}

/**
 * The payee of an import (YNAB-like), by the `payeeKey` of its bank text: the payee a learned alias names, else a payee
 * whose name has the same key or a similar one (`bestMatch`), else a new payee named after the text. An alias to a
 * transfer payee makes the import a transfer, when the bank says all it needs (`learnedTransferFits`).
 */
async function payeeOfImport(
  rec: ChangeRecorder,
  text: string,
  accountId: string,
): Promise<{ id: string; lastCategoryId: string | null }> {
  const key = payeeKey(text);
  const [alias] = await rec.tx
    .select({ id: payee.id, lastCategoryId: payee.lastCategoryId, transferAccountId: payee.transferAccountId })
    .from(payeeAlias)
    .innerJoin(payee, eq(payee.id, payeeAlias.payeeId))
    .where(and(eq(payeeAlias.key, key), isNull(payee.deletedAt), isNull(payee.systemKind)));
  if (alias && (!alias.transferAccountId || (await learnedTransferFits(rec, accountId, alias.transferAccountId)))) {
    return alias;
  }
  // ponytail: reads every live payee per import; fine for one user's hundreds, cache per sync if it ever isn't.
  const payees = await rec.tx
    .select({
      id: payee.id,
      name: payee.name,
      lastCategoryId: payee.lastCategoryId,
      lastUsed: sql<string | null>`(select max(t.date)::text from ${transaction} t where t.payee_id = ${payee.id} and t.deleted_at is null)`,
    })
    .from(payee)
    .where(isUserPayee);
  const match = bestMatch(key, payees.map((p) => ({ ...p, key: payeeKey(p.name) })));
  if (match) return match;
  const name = payeeDisplayName(text);
  return (await findUserPayeeByName(rec.tx, name)) ?? { id: (await createPayee(rec, name)).id, lastCategoryId: null };
}

/**
 * A learned transfer is created only when the bank says everything it needs: another open account in the same currency
 * (no second amount) on the same side of the budget (no category).
 */
async function learnedTransferFits(rec: ChangeRecorder, accountId: string, otherId: string): Promise<boolean> {
  if (otherId === accountId) return false;
  const here = await findAccount(rec.tx, accountId);
  const there = await findAccount(rec.tx, otherId);
  return (
    !!here && !!there && !there.closed && here.currency === there.currency && onBudget(here) === onBudget(there)
  );
}

type TxnRow = typeof transaction.$inferSelect;

/** Days between a row's date and `date`, in SQL. */
const daysFrom = (date: IsoDate) => sql<number>`abs(${transaction.date} - ${date}::date)`;

/**
 * YNAB-like matching: the live transaction of the account with the import's amount, dated within 4 days, that no import
 * holds yet (an entry made by hand, a transfer's other side, an entered schedule), the closest date first. It takes
 * the bank's id and is cleared (a pending import's stays uncleared and becomes pending); its payee, category, date and
 * approval stay. Returns its id, null when there is none.
 */
async function matchExisting(rec: ChangeRecorder, accountId: string, i: Import): Promise<string | null> {
  const days = daysFrom(i.date);
  const held = rec.tx.select({ id: bankImport.importId }).from(bankImport).where(eq(bankImport.transactionId, transaction.id));
  const [found] = await rec.tx
    .select({ id: transaction.id, cleared: transaction.cleared })
    .from(transaction)
    .where(
      and(
        eq(transaction.accountId, accountId),
        eq(transaction.amount, i.amount),
        isNull(transaction.deletedAt),
        eq(transaction.isStartingBalance, false),
        eq(transaction.bankPending, false),
        sql`${days} <= ${MATCH_DAYS}`,
        notExists(held),
      ),
    )
    .orderBy(days, asc(transaction.createdAt))
    .limit(1);
  if (!found) return null;
  await rec.update(transaction, eq(transaction.id, found.id), {
    cleared: !i.pending && found.cleared === 'uncleared' ? 'cleared' : undefined,
    bankPending: i.pending || undefined,
    importId: i.importId,
    importedPayee: i.payeeName,
  });
  return found.id;
}

/**
 * A new row for an import: unapproved and cleared (uncleared and pending while the bank hasn't booked it), the
 * counterparty's payee (`payeeOfImport`) with its last category. A learned transfer's other side waits, unapproved, for
 * its own bank's copy to match it.
 */
async function importNew(
  rec: ChangeRecorder,
  { accountId, onBudget: budget }: { accountId: string; onBudget: boolean },
  i: Import,
  today: IsoDate,
): Promise<TxnRow> {
  const match = await payeeOfImport(rec, i.payeeName, accountId);
  const input = {
    accountId,
    date: i.date,
    payeeId: match.id,
    categoryId: budget ? match.lastCategoryId : null,
    memo: '',
    amount: i.amount,
    cleared: i.pending ? ('uncleared' as const) : ('cleared' as const),
    flag: null,
  };
  const saved = await createTransaction(rec, input, today, i.defaults);
  const [row] = await rec.update(transaction, eq(transaction.id, saved.id), {
    approved: false,
    bankPending: i.pending,
    importId: i.importId,
    importedPayee: i.payeeName,
  });
  if (row!.transferTxnId) await rec.update(transaction, eq(transaction.id, row!.transferTxnId), { approved: false });
  return row!;
}

/**
 * Pairs a new (or newly booked) import with the other side of a transfer between the owner's accounts, imported into
 * another account (a learned transfer's: into its account): a plain, unapproved, booked import, uncategorized or still
 * in the category its payee gave it, of the opposite sign (same currency: the opposite amount within 3 days; between
 * currencies: PLN amounts within 2% and 1 day). Only a single candidate pairs. A plain import becomes a transfer to
 * that account (both native amounts kept, no category between two budget accounts); the transfer's side there
 * replaces the candidate: the candidate is deleted and its bank imports move to that side, which stays unapproved.
 * Returns whether it paired.
 */
async function pairTransfer(rec: ChangeRecorder, x: TxnRow, now: Date): Promise<boolean> {
  if (x.amount === 0) return false;
  const days = daysFrom(x.date);
  const imported = rec.tx
    .select({ id: bankImport.importId })
    .from(bankImport)
    .where(
      and(
        eq(bankImport.transactionId, transaction.id),
        or(isNull(transaction.categoryId), eq(transaction.categoryId, bankImport.autoCategoryId)),
      ),
    );
  const found = await rec.tx
    .select({ y: transaction, currency: account.currency, days })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .where(
      and(
        x.transferAccountId ? eq(transaction.accountId, x.transferAccountId) : ne(transaction.accountId, x.accountId),
        eq(account.closed, false),
        isNull(transaction.deletedAt),
        isNull(transaction.transferTxnId),
        eq(transaction.isSplit, false),
        eq(transaction.approved, false),
        eq(transaction.bankPending, false),
        exists(imported),
        x.amount < 0 ? gt(transaction.amount, 0) : lt(transaction.amount, 0),
        sql`${days} <= ${PAIR_DAYS}`,
      ),
    );
  const here = (await findAccount(rec.tx, x.accountId))!;
  const base = (row: TxnRow) => Math.abs(row.amountBase);
  const candidates = found.filter(({ y, currency, days: apart }) =>
    currency === here.currency
      ? y.amount === -x.amount
      : apart <= PAIR_FX_DAYS && Math.abs(base(y) - base(x)) * 100 <= PAIR_FX_PERCENT * Math.max(base(y), base(x)),
  );
  if (candidates.length !== 1) return false;
  const { y } = candidates[0]!;
  const sideId = x.transferTxnId ?? (await makeTransfer(rec, x, y, now));
  if (sideId === null) return false;
  // The import id moves to the transfer's side (unique per account, deleted rows included).
  await rec.update(transaction, eq(transaction.id, y.id), { deletedAt: now, importId: null });
  await rec.update(transaction, eq(transaction.id, sideId), {
    cleared: y.cleared,
    approved: false,
    importId: y.importId,
    importedPayee: y.importedPayee,
  });
  await rec.update(bankImport, eq(bankImport.transactionId, y.id), { transactionId: sideId });
  return true;
}

/**
 * Makes import `x` a transfer to the account of `y` with the planner's rules, keeping both native amounts; returns its
 * new side there. Null when the transfer needs a category neither has (between a budget and a tracking account).
 */
async function makeTransfer(rec: ChangeRecorder, x: TxnRow, y: TxnRow, now: Date): Promise<string | null> {
  const here = (await findAccount(rec.tx, x.accountId))!;
  const there = (await findAccount(rec.tx, y.accountId))!;
  const mixed = onBudget(here) !== onBudget(there);
  const categoryId = mixed ? (onBudget(here) ? x.categoryId : y.categoryId) : null;
  if (mixed && categoryId === null) return null;
  const agg = await loadAggregate(rec.tx, x.id);
  const draft = {
    ...draftOf(agg),
    payeeId: there.transferPayeeId,
    categoryId,
    transferAmount: here.currency === there.currency ? null : y.amount,
  };
  // The rates both imports were booked at, should the sending side need one.
  const rates = new Map<string, string>();
  if (x.fxRate) rates.set(here.currency, x.fxRate);
  if (y.fxRate) rates.set(there.currency, y.fxRate);
  const plan = await planTransaction(rec.tx, draft, { defaults: { date: x.date, rates } });
  await syncPlan(rec, agg, plan, now, false);
  const [row] = await rec.tx
    .select({ sideId: transaction.transferTxnId })
    .from(transaction)
    .where(eq(transaction.id, x.id));
  return row!.sideId!;
}

/** A live row of an account still pending at the bank, with the bank ids it holds. */
interface PendingRow {
  row: TxnRow;
  keys: string[];
  autoCategoryId: string | null;
}

/** The account's rows still pending at the bank, the oldest first. */
async function pendingRows(rec: ChangeRecorder, accountId: string): Promise<PendingRow[]> {
  const found = await rec.tx
    .select({ row: transaction, key: bankImport.importId, autoCategoryId: bankImport.autoCategoryId })
    .from(transaction)
    .innerJoin(bankImport, eq(bankImport.transactionId, transaction.id))
    .where(and(eq(transaction.accountId, accountId), eq(transaction.bankPending, true), isNull(transaction.deletedAt)))
    .orderBy(asc(transaction.createdAt), asc(transaction.id));
  const rows = new Map<string, PendingRow>();
  for (const { row, key, autoCategoryId } of found) {
    const pending = rows.get(row.id) ?? { row, keys: [], autoCategoryId };
    pending.keys.push(key);
    rows.set(row.id, pending);
  }
  return [...rows.values()];
}

/** The owner left an import as the sync made it: unapproved, plain, no memo or flag, in the category its payee gave. */
const untouched = (row: TxnRow, autoCategoryId: string | null) =>
  !row.approved && !row.transferTxnId && !row.isSplit && !row.memo && !row.flag && row.categoryId === autoCategoryId;

/**
 * The pending row a booked import under a new id books: dated from 7 days before it to 2 days after it, with its
 * amount or (a plain row whose bank text has the same payee key) within 10% of it, the closest date first, then the
 * oldest. A row whose id the bank still lists, as pending or booked (`taken`), isn't the import's.
 */
function bookingOf(waiting: PendingRow[], i: Import, taken: Set<string>): PendingRow | undefined {
  const key = payeeKey(i.payeeName);
  const apart = (p: PendingRow) => diffDays(p.row.date, i.date);
  return waiting
    .filter((p) => {
      const { row } = p;
      if (p.keys.some((k) => taken.has(k))) return false;
      if (apart(p) < -BOOKED_BEFORE_DAYS || apart(p) > BOOKED_AFTER_DAYS) return false;
      if (row.amount === i.amount) return true;
      return (
        !row.transferTxnId &&
        !row.isSplit &&
        Math.sign(row.amount) === Math.sign(i.amount) &&
        Math.abs(i.amount - row.amount) * 100 <= BOOKED_AMOUNT_PERCENT * Math.abs(row.amount) &&
        row.importedPayee !== null &&
        payeeKey(row.importedPayee) === key
      );
    })
    .sort((a, b) => Math.abs(apart(a)) - Math.abs(apart(b)))[0];
}

/**
 * Books a pending row with its booked copy: it is cleared, no longer pending and takes the bank's id; a plain row also
 * takes the booking date and amount, through the planner so its PLN amount follows. Its payee, category, memo and
 * approval stay. Returns the row.
 */
async function bookPending(
  rec: ChangeRecorder,
  { row }: PendingRow,
  i: Import,
  { today, now }: { today: IsoDate; now: Date },
): Promise<TxnRow> {
  if (!row.transferTxnId && !row.isSplit && (row.date !== i.date || row.amount !== i.amount)) {
    const patch = { date: i.date, amount: i.amount, confirmReconciled: true };
    await updateTransaction(rec, row.id, patch, { today, now, defaults: i.defaults });
  }
  const [booked] = await rec.update(transaction, eq(transaction.id, row.id), {
    cleared: row.cleared === 'uncleared' ? 'cleared' : undefined,
    bankPending: false,
    importId: i.importId,
  });
  return booked!;
}

/**
 * A pending row the bank dropped (a cancelled or expired authorization) is deleted, unless the owner touched it: then
 * it stays, no longer pending, for the owner to decide. Its bank ids are forgotten, so whatever the bank lists under
 * them later is imported again, or matches the row kept.
 */
async function dropPending(rec: ChangeRecorder, { row, autoCategoryId }: PendingRow, now: Date): Promise<void> {
  const kept = row.cleared !== 'uncleared' || !untouched(row, autoCategoryId);
  // The import id goes too (unique per account, deleted rows included).
  const change = kept ? { bankPending: false, importId: null } : { deletedAt: now, importId: null };
  await rec.update(transaction, eq(transaction.id, row.id), change);
  await rec.delete(bankImport, eq(bankImport.transactionId, row.id));
}

/**
 * Imports the booked and pending transactions of every linked bank account of the active connections as one undoable
 * command ("Bank sync"). A bank transaction recorded in `bank_import` before is skipped, whatever became of its row,
 * also when it comes from an earlier session of the same bank account, unless it is the booked copy of a row still
 * pending under the same id. A booked one first books the account's pending row it belongs to (`bookingOf`,
 * `bookPending`); otherwise it matches a row already there (`matchExisting`), or becomes a new row (`importNew`) that
 * may pair with its other side into a transfer (`pairTransfer`). A pending one matches or becomes a row the same way,
 * uncleared and pending, and never pairs. A pending row whose id the bank no longer lists as pending, in a complete
 * list, was dropped (`dropPending`). Transactions dated before the account's starting balance (already in it) or after
 * today are left out. A connection whose session has expired becomes `reconnect_needed` and is skipped; one that fails
 * otherwise is skipped this time. With a `uid`, only that bank account is synced.
 */
async function runSync(deps: AppDeps, uid?: string): Promise<BankSyncResponse> {
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
    .where(and(eq(account.closed, false), uid === undefined ? undefined : eq(bankAccount.uid, uid)));

  const reconnectNeeded: string[] = [];
  const failed: string[] = [];
  const needsReconnect = async (connection: typeof bankConnection.$inferSelect) => {
    reconnectNeeded.push(connection.aspspName);
    if (connection.status === 'reconnect_needed') return;
    await deps.db.update(bankConnection).set({ status: 'reconnect_needed' }).where(eq(bankConnection.id, connection.id));
  };

  // Far enough back to see what became of every row still pending at the bank.
  const pendingSince = await deps.db
    .select({ accountId: transaction.accountId, date: sql<IsoDate>`min(${transaction.date})::text` })
    .from(transaction)
    .where(and(eq(transaction.bankPending, true), isNull(transaction.deletedAt)))
    .groupBy(transaction.accountId);

  const fetched: {
    uid: string;
    accountId: string;
    onBudget: boolean;
    imports: Import[];
    pendingRefs: string[];
    complete: boolean;
  }[] = [];
  for (const connection of connections) {
    if (uid !== undefined && !linked.some((l) => l.bank.connectionId === connection.id)) continue;
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
        const usual = bank.lastSyncedAt
          ? addDays(todayIn(deps.config.timeZone, bank.lastSyncedAt), -OVERLAP_DAYS)
          : firstFrom > start
            ? firstFrom
            : start;
        const oldest = pendingSince.find((p) => p.accountId === bank.accountId)?.date;
        const reach = oldest ? addDays(oldest, -BOOKED_BEFORE_DAYS) : usual;
        const from = reach < usual ? reach : usual;
        if (from > today) continue;
        const list = await client.transactions(bank.uid, from, today);
        const { items, pendingRefs } = bankImports(deps, bank.uid, list, { start, today, currency });
        const imports: Import[] = [];
        // A transaction without an NBP rate waits for the next sync, which starts from the last complete one.
        let complete = true;
        const rates = new Map<IsoDate, string | null>();
        for (const item of items) {
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
        fromConnection.push({
          uid: bank.uid,
          accountId: bank.accountId!,
          onBudget: accountClass !== 'tracking',
          imports,
          pendingRefs,
          complete,
        });
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

  // Every bank account linked to an account: only complete lists from all of them tell what the bank dropped.
  const links = await deps.db.select({ uid: bankAccount.uid, accountId: bankAccount.accountId }).from(bankAccount);
  const counts = await runCommand(deps, 'Bank sync', async (rec) => {
    const result = { imported: 0, pending: 0, matched: 0, paired: 0, dropped: 0 };
    // By account: the ids the bank lists as pending, and those it lists as pending or booked.
    const lists = new Map<string, { listed: Set<string>; taken: Set<string> }>();
    for (const { accountId, imports, pendingRefs } of fetched) {
      const list = lists.get(accountId) ?? { listed: new Set(), taken: new Set() };
      for (const ref of pendingRefs) {
        list.listed.add(`${accountId}:${ref}`);
        list.taken.add(`${accountId}:${ref}`);
      }
      for (const i of imports) if (!i.pending) list.taken.add(`${accountId}:${refOf(i.importId)}`);
      lists.set(accountId, list);
    }
    for (const target of fetched) {
      const keyOf = (ref: string) => `${target.accountId}:${ref}`;
      const { taken } = lists.get(target.accountId)!;
      // Booked first: an entry made by hand matches the bank's booked copy before a pending one.
      const imports = [...target.imports].sort((a, b) => Number(a.pending) - Number(b.pending));
      const keys = imports.map((i) => keyOf(refOf(i.importId)));
      const known = keys.length
        ? await rec.tx
            .select({ key: bankImport.importId, transactionId: bankImport.transactionId })
            .from(bankImport)
            .where(inArray(bankImport.importId, keys))
        : [];
      const holders = new Map(known.map((row) => [row.key, row.transactionId]));
      const waiting = await pendingRows(rec, target.accountId);
      const book = async (p: PendingRow, i: Import) => {
        waiting.splice(waiting.indexOf(p), 1);
        const row = await bookPending(rec, p, i, { today, now });
        result.matched++;
        if (untouched(row, p.autoCategoryId) && (await pairTransfer(rec, row, now))) result.paired++;
      };
      for (const i of imports) {
        const key = keyOf(refOf(i.importId));
        if (holders.has(key)) {
          // The bank booked a pending transaction under the same id.
          const kept = i.pending ? undefined : waiting.find((p) => p.row.id === holders.get(key));
          if (kept) await book(kept, i);
          continue;
        }
        holders.set(key, null);
        const booking = i.pending ? undefined : bookingOf(waiting, i, taken);
        if (booking) {
          const { row, autoCategoryId } = booking;
          await rec.insert(bankImport, { importId: key, transactionId: row.id, autoCategoryId });
          await book(booking, i);
          continue;
        }
        const matched = await matchExisting(rec, target.accountId, i);
        if (matched) {
          await rec.insert(bankImport, { importId: key, transactionId: matched });
          result.matched++;
          continue;
        }
        const row = await importNew(rec, target, i, today);
        await rec.insert(bankImport, { importId: key, transactionId: row.id, autoCategoryId: row.categoryId });
        result.imported++;
        if (i.pending) result.pending++;
        else if (await pairTransfer(rec, row, now)) result.paired++;
      }
    }
    for (const [accountId, { listed }] of lists) {
      const sources = links.filter((l) => l.accountId === accountId);
      if (!sources.every((l) => fetched.some((f) => f.uid === l.uid && f.complete))) continue;
      for (const p of await pendingRows(rec, accountId)) {
        if (p.keys.some((k) => listed.has(k))) continue;
        await dropPending(rec, p, now);
        result.dropped++;
      }
    }
    return result;
  });
  // Outside the command, so a sync that imports nothing adds no undo entry.
  const synced = fetched.filter((f) => f.complete).map((f) => f.uid);
  if (synced.length > 0) {
    await deps.db.update(bankAccount).set({ lastSyncedAt: now }).where(inArray(bankAccount.uid, synced));
  }
  return { ...counts, reconnectNeeded, failed };
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
