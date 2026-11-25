import { isNotNull } from 'drizzle-orm';
import type { BudgetSettingsDto } from '../../shared/api/budget';
import type { Money } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { appUser } from '../db/schema';

/** The budget's settings the owner edits in the app (null until the budget exists). */
export async function budgetSettings(db: Executor): Promise<BudgetSettingsDto> {
  const [user] = await db.select({ expectedMonthlyIncome: appUser.expectedMonthlyIncome }).from(appUser);
  return { expectedMonthlyIncome: user?.expectedMonthlyIncome ?? null };
}

/** Sets (or, with null, unsets) the expected monthly income of the one budget. */
export async function setExpectedMonthlyIncome(rec: ChangeRecorder, amount: Money | null): Promise<void> {
  await rec.update(appUser, isNotNull(appUser.id), { expectedMonthlyIncome: amount });
}
