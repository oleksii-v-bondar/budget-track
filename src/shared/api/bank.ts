import { z } from 'zod';
import { idSchema } from './common';

/** A bank account of a connection (Enable Banking). */
export interface BankAccountDto {
  /** Enable Banking's account uid (valid for its connection's session only). */
  uid: string;
  name: string;
  iban: string | null;
  currency: string;
  /** The account it syncs into; null = not linked. */
  accountId: string | null;
  lastSyncedAt: string | null;
}

/** One bank's session: it lasts until `validUntil`, then the bank has to be reconnected. */
export interface BankConnectionDto {
  id: string;
  /** The bank (Enable Banking's ASPSP name), e.g. "PKO BP". */
  bank: string;
  status: 'active' | 'reconnect_needed';
  validUntil: string;
  accounts: BankAccountDto[];
}

/** GET /api/bank/status (and the answer of the link and disconnect routes). */
export interface BankStatus {
  /** ENABLE_BANKING_APP_ID and its key file are set; without them the app hides bank connections. */
  configured: boolean;
  connections: BankConnectionDto[];
}

/** GET /api/bank/aspsps: the Polish banks a connection can be made to. */
export interface BankListResponse {
  aspsps: { name: string }[];
}

export const bankAccountParamSchema = z.object({ uid: z.string().min(1).max(500) });

/** PUT /api/bank/accounts/:uid/link: an account in the bank account's currency, or null to unlink. */
export const linkBankAccountRequestSchema = z.object({ accountId: idSchema.nullable() });

/** POST /api/bank/sync: how many transactions were imported (one undo entry, "Bank sync") and which banks were skipped. */
export interface BankSyncResponse {
  imported: number;
  /** Banks whose session has expired: reconnect them in Settings. */
  reconnectNeeded: string[];
  /** Banks that couldn't be reached this time. */
  failed: string[];
}
