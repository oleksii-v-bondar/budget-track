export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'cash',
  'credit_card',
  'line_of_credit',
  'mortgage',
  'auto_loan',
  'student_loan',
  'personal_loan',
  'medical_debt',
  'other_debt',
  'other_asset',
  'other_liability',
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type AccountClass = 'cash' | 'credit' | 'tracking';

const CASH_TYPES: readonly AccountType[] = ['checking', 'savings', 'cash'];
const CREDIT_TYPES: readonly AccountType[] = ['credit_card', 'line_of_credit'];
const LOAN_TYPES: readonly AccountType[] = [
  'mortgage',
  'auto_loan',
  'student_loan',
  'personal_loan',
  'medical_debt',
  'other_debt',
];

/** Spec §3: cash and credit accounts are on-budget; everything else is a tracking account. */
export function accountClassOf(type: AccountType): AccountClass {
  if (CASH_TYPES.includes(type)) return 'cash';
  if (CREDIT_TYPES.includes(type)) return 'credit';
  return 'tracking';
}

export function isLoanType(type: AccountType): boolean {
  return LOAN_TYPES.includes(type);
}

/** SQL CASE expression that mirrors accountClassOf; used by the generated `account.account_class` column. */
export const ACCOUNT_CLASS_SQL = `CASE
  WHEN type IN (${CASH_TYPES.map((t) => `'${t}'`).join(', ')}) THEN 'cash'
  WHEN type IN (${CREDIT_TYPES.map((t) => `'${t}'`).join(', ')}) THEN 'credit'
  ELSE 'tracking'
END`;
