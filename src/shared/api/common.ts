import { z } from 'zod';

/** Integer minor units (grosze for PLN); `z.int()` also keeps it inside the safe integer range (spec §2). */
export const moneySchema = z.int('Enter a whole amount in minor units.');
export const nonNegativeMoneySchema = moneySchema.min(0, 'Enter 0 or more.');
export const positiveMoneySchema = moneySchema.min(1, 'Enter an amount greater than 0.');

export const isoDateSchema = z.iso.date('Use the format YYYY-MM-DD.');
/** A budget month in URLs and bodies; stored as its first day ('YYYY-MM-01'). */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM.');

/** Lowercased, so ids that differ only in letter case compare equal. */
export const idSchema = z.uuid('Invalid id.').transform((id) => id.toLowerCase());
export const idParamSchema = z.object({ id: idSchema });

export const nameSchema = z.string().trim().min(1, 'Enter a name.').max(100, 'Use at most 100 characters.');
/** Free text; an empty note clears it. */
export const noteSchema = z.string().trim().max(2000, 'Use at most 2000 characters.');

/** PUT …/order: the full new order of the affected rows. */
export const reorderRequestSchema = z.object({
  ids: z
    .array(idSchema)
    .min(1, 'List at least one id.')
    .max(1000, 'List at most 1000 ids.')
    .refine((ids) => new Set(ids).size === ids.length, 'List each id once.'),
});

export type ReorderRequest = z.infer<typeof reorderRequestSchema>;

/** Response of deletes: the id of the removed row. */
export interface IdResponse {
  id: string;
}

/** Response of reorders: the ids in their new order. */
export interface ReorderResponse {
  ids: string[];
}
