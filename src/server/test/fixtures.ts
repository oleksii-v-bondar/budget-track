import type { AccountDto, CreateAccountRequest } from '../../shared/api/accounts';
import type { CategoryDto, CategoryGroupDto } from '../../shared/api/categories';
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
