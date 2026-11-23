import { describe, expect, it } from 'vitest';
import { account, balances } from '../test/ledger-fixtures';
import { groupAccounts } from './account-groups';

describe('groupAccounts', () => {
  it('groups open accounts as Cash, Credit and Tracking with PLN totals, closed ones apart', () => {
    const checking = account({ name: 'Checking', balance: balances(150_000) });
    const euro = account({
      name: 'Euro',
      type: 'savings',
      currency: 'EUR',
      balance: balances(10_000),
      balanceBase: balances(43_000),
    });
    const card = account({ name: 'Visa', type: 'credit_card', balance: balances(-20_000) });
    const mortgage = account({ name: 'Mortgage', type: 'mortgage', balance: balances(-50_000_000) });
    const car = account({ name: 'Car', type: 'other_asset', balance: balances(3_000_000) });
    const old = account({ name: 'Old', type: 'savings', closed: true });

    const { groups, closed } = groupAccounts([card, checking, mortgage, old, euro, car]);
    expect(groups.map((g) => [g.label, g.accounts.map((a) => a.name), g.total])).toEqual([
      ['Cash', ['Checking', 'Euro'], 193_000],
      ['Credit', ['Visa'], -20_000],
      ['Tracking', ['Mortgage', 'Car'], -47_000_000],
    ]);
    expect(closed.map((a) => a.name)).toEqual(['Old']);
  });

  it('leaves out empty groups', () => {
    const { groups } = groupAccounts([account({ name: 'Visa', type: 'line_of_credit' })]);
    expect(groups.map((g) => g.key)).toEqual(['credit']);
  });
});
