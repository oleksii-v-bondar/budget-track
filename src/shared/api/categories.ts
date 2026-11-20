import { z } from 'zod';
import { idSchema, nameSchema, noteSchema, reorderRequestSchema } from './common';

/** `internal` holds the system categories and is never shown; the others are rendered as groups. */
export type CategoryGroupKind = 'normal' | 'cc_payments' | 'debt_payments' | 'internal';

/**
 * - `rta`, `uncategorized`: system categories (internal group, never editable)
 * - `cc_payment`: a credit card's payment category, named after its account (spec §5.3)
 * - `debt_payment`: a loan's paired category, named after its account (spec §8)
 * - `normal`: everything the user created
 */
export type CategoryKind = 'normal' | 'rta' | 'uncategorized' | 'cc_payment' | 'debt_payment';

export interface CategoryDto {
  id: string;
  groupId: string;
  name: string;
  kind: CategoryKind;
  hidden: boolean;
  note: string | null;
  sortOrder: number;
  /** The credit or loan account of a `cc_payment` / `debt_payment` category. */
  linkedAccountId: string | null;
}

export interface CategoryGroupDto {
  id: string;
  name: string;
  kind: CategoryGroupKind;
  hidden: boolean;
  sortOrder: number;
  /** Live categories in display order. */
  categories: CategoryDto[];
}

/** GET /api/categories: every live group (internal included) with its live categories, in display order. */
export interface CategoryListResponse {
  groups: CategoryGroupDto[];
}

export const createGroupRequestSchema = z.object({ name: nameSchema });

/** Renaming is for normal groups only; any group but the internal one can be hidden. */
export const updateGroupRequestSchema = z.object({
  name: nameSchema.optional(),
  hidden: z.boolean().optional(),
});

export const createCategoryRequestSchema = z.object({
  groupId: idSchema,
  name: nameSchema,
  note: noteSchema.optional(),
});

/**
 * Normal categories take every field; credit card payment and paired loan categories take only `note` and `hidden`
 * (their name follows the account); system categories take none. Moving (`groupId`) appends to a normal group.
 */
export const updateCategoryRequestSchema = z.object({
  name: nameSchema.optional(),
  note: noteSchema.nullable().optional(),
  hidden: z.boolean().optional(),
  groupId: idSchema.optional(),
});

/** PUT /api/categories/order: every live category of one group, in the new order. */
export const reorderCategoriesRequestSchema = reorderRequestSchema.extend({ groupId: idSchema });

export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;
export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>;
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;
