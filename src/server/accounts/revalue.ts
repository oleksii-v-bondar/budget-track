import { BASE_CURRENCY } from '../../shared/api/accounts';
import { type IsoDate, revaluationDiff } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import { systemCategoryId, systemPayeeId } from '../db/lookups';
import { transaction } from '../db/schema';
import { DomainError } from '../http/errors';
import { assertBaseAmount, type Rate } from '../transactions/rules';
import { getAccount } from './account-queries';

/**
 * Spec §9 Revalue: books a foreign account's unrealized FX difference, round(native balance × latest rate) −
 * Σ amount_base, as a cleared transaction dated today with amount 0, `amount_base` = the difference and the FX
 * revaluation payee; on budget accounts it is Ready to Assign income, tracking accounts take no category. The row is
 * written directly: planning derives base amounts from amounts, and this amount is 0. `rate` is the one sent, else
 * the latest NBP rate the caller quoted (null when NBP has none). Like any computed PLN amount, the difference stays
 * within ±MAX_BASE_AMOUNT (spec §4.4).
 */
export async function revalueAccount(
  rec: ChangeRecorder,
  id: string,
  rate: Rate | null,
  today: IsoDate,
): Promise<{ name: string; transactionId: string }> {
  const current = await getAccount(rec.tx, id);
  if (current.currency === BASE_CURRENCY) {
    throw new DomainError('revalue_pln', `${BASE_CURRENCY} accounts have nothing to revalue.`);
  }
  if (current.closed) {
    throw new DomainError('account_closed', `"${current.name}" is closed. Reopen it to revalue it.`);
  }
  if (!rate) {
    throw new DomainError('fx_rate_required', `Enter the exchange rate of ${current.currency} to PLN.`, 'fxRate');
  }
  const diff = assertBaseAmount(
    revaluationDiff(current.balance.working, rate.rate, current.balanceBase.working),
    'fxRate',
  );
  if (diff === 0) {
    throw new DomainError('revalue_no_difference', 'The PLN balance already matches this rate.');
  }
  const [row] = await rec.insert(transaction, {
    accountId: id,
    date: today,
    payeeId: await systemPayeeId(rec.tx, 'fx_revaluation'),
    categoryId: current.accountClass === 'tracking' ? null : await systemCategoryId(rec.tx, 'rta'),
    amount: 0,
    amountBase: diff,
    fxRate: rate.rate,
    fxRateManual: rate.manual,
    cleared: 'cleared',
  });
  return { name: current.name, transactionId: row!.id };
}
