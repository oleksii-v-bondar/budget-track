import { z } from 'zod';
import { idSchema } from './common';

/** A bank account of the connection (Mastercard Open Banking / Aiia). */
export interface BankAccountDto {
  /** Aiia's account id. */
  id: string;
  name: string;
  currency: string | null;
  /** The bank, e.g. "Revolut". */
  providerName: string | null;
  /** The account it syncs into; null = not linked. */
  accountId: string | null;
  lastSyncedAt: string | null;
}

/** GET /api/bank/status (and the answer of the other bank routes, except sync). */
export interface BankStatus {
  /** AIIA_CLIENT_ID and AIIA_CLIENT_SECRET are set; without them the app hides bank connections. */
  configured: boolean;
  connected: boolean;
  status: 'active' | 'reconnect_needed' | null;
  accounts: BankAccountDto[];
}

export const bankAccountParamSchema = z.object({ id: z.string().min(1).max(500) });

/** PUT /api/bank/accounts/:id/link: an account in the bank account's currency, or null to unlink. */
export const linkBankAccountRequestSchema = z.object({ accountId: idSchema.nullable() });

/** POST /api/bank/sync: how many transactions were imported (one undo entry, "Bank sync"). */
export interface BankSyncResponse {
  imported: number;
}
