import type { CreateTransactionRequest, UpdateTransactionRequest } from '../../shared/api/transactions';
import type { IsoDate } from '../../engine';
import type { Db } from '../db/client';
import type { FxRates } from '../fx/fx-rates';
import { AppError } from '../http/errors';
import { findUserPayeeByName } from '../payees/payee-commands';
import { loadAggregate } from './aggregate';
import { type Draft, type PlanContext, planTransaction } from './plan';
import { createDraft, editDraft, type PayeeByName } from './transaction-commands';

interface Deps {
  db: Db;
  fx: FxRates;
}

/** A dry run only looks payees up: a name nobody has yet is a new user payee, never a transfer. */
const lookUpPayee =
  (db: Db): PayeeByName =>
  async (name) =>
    (await findUserPayeeByName(db, name))?.id ?? null;

/**
 * Spec §9 default rates, resolved before the command: plans the write without writing (outside any transaction and
 * the command lock) to learn which currencies still need a rate, i.e. none was sent or stored, and quotes them from
 * NBP for the draft's date. The command then plans again with these defaults; a currency NBP has no rate for stays
 * missing, so the command answers 422 `fx_rate_required`. Errors of the dry run are left to the command to report.
 */
async function quoteMissingRates(
  deps: Deps,
  prepare: () => Promise<{ draft: Draft; context: PlanContext } | null>,
): Promise<Map<string, string>> {
  const unknownRates = new Set<string>();
  let date: IsoDate | null = null;
  try {
    const prepared = await prepare();
    if (!prepared) return new Map();
    date = prepared.draft.date;
    await planTransaction(deps.db, prepared.draft, { ...prepared.context, unknownRates });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  const defaults = new Map<string, string>();
  for (const currency of unknownRates) {
    const quote = await deps.fx.quote(currency, date!);
    if (quote) defaults.set(currency, quote.rate);
  }
  return defaults;
}

/** NBP rates a new transaction needs. A future-dated one becomes a schedule, which takes no NBP rate. */
export function createDefaultRates(
  deps: Deps,
  input: CreateTransactionRequest,
  today: IsoDate,
): Promise<Map<string, string>> {
  return quoteMissingRates(deps, async () => {
    const draft = await createDraft(input, today, lookUpPayee(deps.db));
    return draft.date > today ? null : { draft, context: {} };
  });
}

/** NBP rates an edit needs: rates the transaction doesn't have, or NBP rates of a date that changed. */
export function editDefaultRates(
  deps: Deps,
  id: string,
  patch: UpdateTransactionRequest,
  today: IsoDate,
): Promise<Map<string, string>> {
  return quoteMissingRates(deps, async () => {
    const agg = await loadAggregate(deps.db, id);
    // A split line's counterpart takes no rate, and no edit moves a transaction past today.
    if (agg.owner || (patch.date !== undefined && patch.date > today)) return null;
    return editDraft(deps.db, agg, patch, lookUpPayee(deps.db));
  });
}
