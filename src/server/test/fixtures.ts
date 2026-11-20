import type { AccountDto, CreateAccountRequest } from '../../shared/api/accounts';
import type { CategoryDto, CategoryGroupDto } from '../../shared/api/categories';
import type { PayeeDto } from '../../shared/api/payees';
import type { Db } from '../db/client';
import { transaction } from '../db/schema';
import type { TestClient } from './http-client';

async function created<T>(res: Response, what: string): Promise<T> {
  if (res.status !== 201) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Creates an account through the API (defaults: checking, PLN, starting balance 0). */
export async function createAccount(
  client: TestClient,
  body: Partial<CreateAccountRequest> & { name: string },
): Promise<AccountDto> {
  const res = await client.post('/api/accounts', { type: 'checking', startingBalance: 0, ...body });
  return created(res, 'createAccount');
}

export async function createGroup(client: TestClient, name: string): Promise<CategoryGroupDto> {
  return created(await client.post('/api/category-groups', { name }), 'createGroup');
}

export async function createCategory(client: TestClient, groupId: string, name: string): Promise<CategoryDto> {
  return created(await client.post('/api/categories', { groupId, name }), 'createCategory');
}

export async function createPayee(client: TestClient, name: string): Promise<PayeeDto> {
  return created(await client.post('/api/payees', { name }), 'createPayee');
}

export type NewTransaction = Partial<typeof transaction.$inferInsert> &
  Pick<typeof transaction.$inferInsert, 'accountId' | 'date' | 'amount'>;

/** Inserts a transaction straight into the database (the transactions API is P2c); `amountBase` defaults to `amount`. */
export async function insertTransaction(db: Db, values: NewTransaction): Promise<typeof transaction.$inferSelect> {
  const [row] = await db
    .insert(transaction)
    .values({ amountBase: values.amount, ...values })
    .returning();
  return row!;
}
