import { describe, expect, it } from 'vitest';
import { account, category, categoryGroups, idFor, payee, RTA } from '../test/ledger-fixtures';
import { filterChips, filtersFromSearch, registerParams } from './filters';

describe('register filters', () => {
  it('keep only the search params they understand', () => {
    const categoryId = idFor('category:Groceries');
    expect(
      filtersFromSearch({
        q: 123,
        from: '2026-11-01',
        to: 'tomorrow',
        minAmount: -10_000,
        maxAmount: '5',
        categoryId,
        payeeId: 'not-an-id',
        flag: 'red',
        cleared: 'pending',
        unapproved: true,
        month: '2026-11',
      }),
    ).toEqual({ q: '123', from: '2026-11-01', minAmount: -10_000, categoryId, flag: 'red', unapproved: true });
    expect(filtersFromSearch({ q: '  ', unapproved: 'true' })).toEqual({});
  });

  it('become the register query, as strings', () => {
    const checking = account({ name: 'Checking' });
    expect(registerParams(checking.id, { q: 'lidl', minAmount: -500, maxAmount: 0, unapproved: true, cleared: 'cleared' })).toStrictEqual({
      accountId: checking.id,
      q: 'lidl',
      minAmount: '-500',
      maxAmount: '0',
      unapproved: 'true',
      cleared: 'cleared',
    });
    expect(registerParams(undefined, { unapproved: false })).toStrictEqual({});
  });

  it('name the active filters (not the search text)', () => {
    const groceries = category({ name: 'Groceries' });
    const lidl = payee({ name: 'Lidl' });
    const lookups = { ...categoryGroups([{ name: 'Everyday', categories: [groceries] }]), payees: [lidl] };
    expect(
      filterChips(
        {
          q: 'x',
          from: '2026-11-01',
          to: '2026-11-30',
          minAmount: -10_050,
          maxAmount: 0,
          categoryId: groceries.id,
          payeeId: lidl.id,
          flag: 'green',
          cleared: 'reconciled',
          unapproved: true,
        },
        lookups,
      ).map((chip) => chip.label),
    ).toEqual([
      'From 01.11.2026',
      'To 30.11.2026',
      'At least -100,50',
      'At most 0,00',
      'Category: Groceries',
      'Payee: Lidl',
      'Green flag',
      'Reconciled',
      'Unapproved',
    ]);
    expect(filterChips({ categoryId: RTA.id }, lookups).map((chip) => chip.label)).toEqual([
      'Category: Inflow: Ready to Assign',
    ]);
  });
});
