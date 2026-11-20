import type { AccountDto, CreateAccountRequest } from '../../shared/api/accounts';
import type { TestClient } from './http-client';

/** Creates an account through the API (defaults: checking, PLN, starting balance 0). */
export async function createAccount(
  client: TestClient,
  body: Partial<CreateAccountRequest> & { name: string },
): Promise<AccountDto> {
  const res = await client.post('/api/accounts', { type: 'checking', startingBalance: 0, ...body });
  if (res.status !== 201) throw new Error(`createAccount failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as AccountDto;
}
