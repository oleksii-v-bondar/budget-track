import { z } from 'zod';
import { idSchema, nameSchema } from './common';

/**
 * - `user`: created by the user (by name, or inline from the transaction sheet)
 * - `transfer`: the "Transfer : <account>" payee of an account; choosing it makes a transaction a transfer
 * - `system`: Starting Balance, Reconciliation Balance Adjustment and FX revaluation (used by the app)
 */
export type PayeeKind = 'user' | 'transfer' | 'system';

export interface PayeeDto {
  id: string;
  name: string;
  kind: PayeeKind;
  /** Transfer payees: the account a transaction with this payee transfers to. */
  transferAccountId: string | null;
  /** The category last saved with this payee on a categorized, non-transfer transaction (spec §10). */
  lastCategoryId: string | null;
  /** Live transactions, split lines and scheduled transactions (and their lines) that use the payee. */
  usageCount: number;
}

/** GET /api/payees: live payees; user payees first, then transfer and system payees, each by name. */
export interface PayeeListResponse {
  payees: PayeeDto[];
}

/** POST /api/payees and PATCH /api/payees/:id. Names are unique among live user payees, ignoring case. */
export const payeeNameRequestSchema = z.object({ name: nameSchema });

/** POST /api/payees/:id/merge: the payee that takes over every transaction, line and schedule. */
export const mergePayeeRequestSchema = z.object({ targetId: idSchema });
