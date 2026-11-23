import type { CategoryGroupDto } from '../../shared/api/categories';
import type { PayeeDto } from '../../shared/api/payees';
import { CLEARED_STATUSES, type ClearedStatus, FLAG_COLORS, type FlagColor } from '../../shared/api/transactions';
import { formatAmount, formatDate } from '../lib/format';
import { RTA_LABEL } from '../transactions/lookups';
import type { RegisterParams } from './register-api';

/**
 * The register's search and filters (spec §10), kept in the URL's search params so a link can open a filtered
 * register, e.g. `/transactions?categoryId=…&from=2026-11-01&to=2026-11-30` for a category's month.
 */
export interface RegisterFilters {
  q?: string;
  from?: string;
  to?: string;
  /** Signed native minor units. */
  minAmount?: number;
  maxAmount?: number;
  categoryId?: string;
  payeeId?: string;
  flag?: FlagColor;
  cleared?: ClearedStatus;
  unapproved?: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** The router's `validateSearch`: keeps the filters it understands (the router parses numbers and booleans). */
export function filtersFromSearch(search: Record<string, unknown>): RegisterFilters {
  const filters: RegisterFilters = {};
  const q = typeof search.q === 'number' ? String(search.q) : search.q;
  if (typeof q === 'string' && q.trim() !== '') filters.q = q.trim();
  for (const key of ['from', 'to'] as const) {
    const value = search[key];
    if (typeof value === 'string' && ISO_DATE.test(value)) filters[key] = value;
  }
  for (const key of ['minAmount', 'maxAmount'] as const) {
    const value = search[key];
    if (typeof value === 'number' && Number.isSafeInteger(value)) filters[key] = value;
  }
  for (const key of ['categoryId', 'payeeId'] as const) {
    const value = search[key];
    if (typeof value === 'string' && UUID.test(value)) filters[key] = value;
  }
  if (isOneOf(FLAG_COLORS, search.flag)) filters.flag = search.flag;
  if (isOneOf(CLEARED_STATUSES, search.cleared)) filters.cleared = search.cleared;
  if (search.unapproved === true) filters.unapproved = true;
  return filters;
}

/** GET /api/transactions parameters for a register, in a stable order (they are part of the query key). */
export function registerParams(accountId: string | undefined, filters: RegisterFilters): RegisterParams {
  const { q, from, to, minAmount, maxAmount, categoryId, payeeId, flag, cleared, unapproved } = filters;
  const params: RegisterParams = { accountId, q, from, to, categoryId, payeeId, flag, cleared };
  if (minAmount !== undefined) params.minAmount = String(minAmount);
  if (maxAmount !== undefined) params.maxAmount = String(maxAmount);
  if (unapproved) params.unapproved = 'true';
  for (const key of Object.keys(params) as (keyof RegisterParams)[]) if (params[key] === undefined) delete params[key];
  return params;
}

const capitalized = (word: string) => `${word[0]!.toUpperCase()}${word.slice(1)}`;

/** The active filters (all but the search text) as chips, in a stable order. */
export function filterChips(
  filters: RegisterFilters,
  lookups: { groups: CategoryGroupDto[]; payees: PayeeDto[] },
): { key: keyof RegisterFilters; label: string }[] {
  const chips: { key: keyof RegisterFilters; label: string }[] = [];
  if (filters.from) chips.push({ key: 'from', label: `From ${formatDate(filters.from)}` });
  if (filters.to) chips.push({ key: 'to', label: `To ${formatDate(filters.to)}` });
  if (filters.minAmount !== undefined) chips.push({ key: 'minAmount', label: `At least ${formatAmount(filters.minAmount)}` });
  if (filters.maxAmount !== undefined) chips.push({ key: 'maxAmount', label: `At most ${formatAmount(filters.maxAmount)}` });
  if (filters.categoryId) {
    const category = lookups.groups.flatMap((g) => g.categories).find((c) => c.id === filters.categoryId);
    const name = category?.kind === 'rta' ? RTA_LABEL : (category?.name ?? 'a deleted category');
    chips.push({ key: 'categoryId', label: `Category: ${name}` });
  }
  if (filters.payeeId) {
    const payee = lookups.payees.find((p) => p.id === filters.payeeId);
    chips.push({ key: 'payeeId', label: `Payee: ${payee?.name ?? 'a deleted payee'}` });
  }
  if (filters.flag) chips.push({ key: 'flag', label: `${capitalized(filters.flag)} flag` });
  if (filters.cleared) chips.push({ key: 'cleared', label: capitalized(filters.cleared) });
  if (filters.unapproved) chips.push({ key: 'unapproved', label: 'Unapproved' });
  return chips;
}
