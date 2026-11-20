import { describe, expect, it } from 'vitest';
import { ACCOUNT_TYPES, accountClassOf, isLoanType } from './accounts';

describe('accountClassOf', () => {
  it('maps every account type to its class (spec §3)', () => {
    const classes = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t, accountClassOf(t)]));
    expect(classes).toEqual({
      checking: 'cash',
      savings: 'cash',
      cash: 'cash',
      credit_card: 'credit',
      line_of_credit: 'credit',
      mortgage: 'tracking',
      auto_loan: 'tracking',
      student_loan: 'tracking',
      personal_loan: 'tracking',
      medical_debt: 'tracking',
      other_debt: 'tracking',
      other_asset: 'tracking',
      other_liability: 'tracking',
    });
  });

  it('identifies loan types', () => {
    expect(ACCOUNT_TYPES.filter(isLoanType)).toEqual([
      'mortgage',
      'auto_loan',
      'student_loan',
      'personal_loan',
      'medical_debt',
      'other_debt',
    ]);
  });
});
