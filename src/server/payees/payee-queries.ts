import { and, asc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { PayeeDto, PayeeKind } from '../../shared/api/payees';
import type { Executor } from '../db/client';
import { payee, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
import { AppError } from '../http/errors';

type PayeeRow = typeof payee.$inferSelect;

export function payeeKindOf(row: Pick<PayeeRow, 'transferAccountId' | 'systemKind'>): PayeeKind {
  if (row.transferAccountId) return 'transfer';
  if (row.systemKind) return 'system';
  return 'user';
}

/** Live rows per payee: transactions, lines of live transactions, schedules and schedule lines. */
async function usageByPayee(db: Executor, id?: string): Promise<Map<string, number>> {
  const rows = await db.execute<{ payee_id: string; uses: number }>(sql`
    select u.payee_id, count(*)::int as uses from (
      select t.payee_id from ${transaction} t where t.deleted_at is null
      union all
      select s.payee_id from ${subtransaction} s join ${transaction} p on p.id = s.txn_id
        where s.deleted_at is null and p.deleted_at is null
      union all
      select st.payee_id from ${scheduledTransaction} st
      union all
      select ss.payee_id from ${scheduledSubtransaction} ss
    ) u
    where u.payee_id is not null ${id ? sql`and u.payee_id = ${id}` : sql``}
    group by u.payee_id`);
  return new Map(rows.map((row) => [row.payee_id, row.uses]));
}

const kindOrder = sql`case
  when ${payee.transferAccountId} is not null then 1
  when ${payee.systemKind} is not null then 2
  else 0
end`;

/** Live payees: user payees first, then transfer and system payees, each by name (ignoring case). */
export async function listPayees(db: Executor, where?: SQL): Promise<PayeeDto[]> {
  const rows = await db
    .select()
    .from(payee)
    .where(and(isNull(payee.deletedAt), where))
    .orderBy(kindOrder, sql`lower(${payee.name})`, asc(payee.id));
  const usage = await usageByPayee(db, rows.length === 1 ? rows[0]!.id : undefined);
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    kind: payeeKindOf(p),
    transferAccountId: p.transferAccountId,
    lastCategoryId: p.lastCategoryId,
    usageCount: usage.get(p.id) ?? 0,
  }));
}

export async function getPayee(db: Executor, id: string): Promise<PayeeDto> {
  const [found] = await listPayees(db, eq(payee.id, id));
  if (!found) throw new AppError(404, 'not_found', 'Payee not found.');
  return found;
}

/** How many live rows use the payee (see `PayeeDto.usageCount`). */
export async function payeeUsage(db: Executor, id: string): Promise<number> {
  return (await usageByPayee(db, id)).get(id) ?? 0;
}
