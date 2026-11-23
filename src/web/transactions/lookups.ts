import { queryOptions } from '@tanstack/react-query';
import type { CategoryDto, CategoryGroupDto } from '../../shared/api/categories';
import type { PayeeDto } from '../../shared/api/payees';
import { api, unwrap } from '../lib/api';

/** GET /api/payees: live payees (user, then transfer and system payees). */
export const payeesQuery = queryOptions({
  queryKey: ['payees'],
  queryFn: () => unwrap(api.api.payees.$get()),
});

/** GET /api/categories: every live group with its categories, the internal one (Ready to Assign) included. */
export const categoriesQuery = queryOptions({
  queryKey: ['categories'],
  queryFn: () => unwrap(api.api.categories.$get()),
});

/** GET /api/transactions/:id */
export const transactionQuery = (id: string) =>
  queryOptions({
    queryKey: ['transactions', 'one', id],
    queryFn: () => unwrap(api.api.transactions[':id'].$get({ param: { id } })),
  });

/** Spec §11: how the transaction sheet and the register name Ready to Assign. */
export const RTA_LABEL = 'Inflow: Ready to Assign';

export function systemCategory(groups: CategoryGroupDto[], kind: 'rta' | 'uncategorized'): CategoryDto | undefined {
  return groups.flatMap((group) => group.categories).find((category) => category.kind === kind);
}

/**
 * The groups whose categories a transaction line may use (spec §5.5): regular groups and Debt Payments (a loan's
 * paired category), hidden ones included; never the internal group or credit card payment categories.
 */
export function usableGroups(groups: CategoryGroupDto[]): CategoryGroupDto[] {
  return groups
    .filter((group) => group.kind === 'normal' || group.kind === 'debt_payments')
    .map((group) => ({ ...group, categories: group.categories.filter((c) => c.kind === 'normal' || c.kind === 'debt_payment') }))
    .filter((group) => group.categories.length > 0);
}

/** The payees a user can choose: their own and the transfer payees (system payees are the app's). */
export function choosablePayees(payees: PayeeDto[]): { user: PayeeDto[]; transfer: PayeeDto[] } {
  return { user: payees.filter((p) => p.kind === 'user'), transfer: payees.filter((p) => p.kind === 'transfer') };
}
