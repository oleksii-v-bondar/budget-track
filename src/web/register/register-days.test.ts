import { describe, expect, it } from 'vitest';
import { account, splitLine, transaction } from '../test/ledger-fixtures';
import { categoryLabel, groupByDate, payeeLabel } from './register-days';

const checking = account({ name: 'Checking' });

describe('register rows', () => {
  it('group by date in the order they come', () => {
    const rows = [
      { id: 'a', date: '2026-11-20' },
      { id: 'b', date: '2026-11-20' },
      { id: 'c', date: '2026-11-18' },
    ];
    expect(groupByDate(rows)).toEqual([
      { date: '2026-11-20', items: [rows[0], rows[1]] },
      { date: '2026-11-18', items: [rows[2]] },
    ]);
  });

  it('label splits, uncategorized budget rows and transfers', () => {
    const lines = [splitLine('a', -600), splitLine('b', -400)];
    expect(categoryLabel(transaction(checking, 'split', { isSplit: true, lines }), true)).toBe('Split (2)');
    expect(categoryLabel(transaction(checking, 'plain'), true)).toBe('Uncategorized');
    expect(categoryLabel(transaction(checking, 'plain'), false)).toBeNull();
    expect(categoryLabel(transaction(checking, 'start', { isStartingBalance: true }), true)).toBeNull();
    const transfer = transaction(checking, 'transfer', {
      transfer: {
        accountId: 'x',
        accountName: 'Savings',
        transactionId: 'y',
        splitLineId: null,
        amount: 1000,
        currency: 'PLN',
        effectiveRate: null,
      },
    });
    expect(categoryLabel(transfer, true)).toBeNull();
    expect(payeeLabel(transfer)).toBe('Transfer : Savings');
    expect(payeeLabel(transaction(checking, 'none'))).toBe('No payee');
  });
});
