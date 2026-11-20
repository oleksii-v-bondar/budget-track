import type { Executor } from '../db/client';
import { appUser } from '../db/schema';

export type AppUser = typeof appUser.$inferSelect;

/** The single budget owner, or null before first-run setup. */
export async function findUser(db: Executor): Promise<AppUser | null> {
  const [user] = await db.select().from(appUser).limit(1);
  return user ?? null;
}
