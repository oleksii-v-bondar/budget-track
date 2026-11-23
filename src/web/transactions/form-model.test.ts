import { describe, expect, it } from 'vitest';
import { account, payee, transaction, transferPayee } from '../test/ledger-fixtures';
import {
  categoryRule,
  checkForm,
  createTransactionBody,
  editValues,
  type FormValues,
  newValues,
  rateCurrency,
  updateTransactionBody,
} from './form-model';

const checking = account({ name: 'Checking' });
const card = account({ name: 'Visa', type: 'credit_card' });
const house = account({ name: 'House', type: 'other_asset' });
const euro = account({ name: 'Euro', currency: 'EUR' });
const dollars = account({ name: 'Dollars', type: 'savings', currency: 'USD' });
const lidl = payee({ name: 'Lidl' });
const context = {
  accounts: [checking, card, house, euro, dollars],
  payees: [lidl, ...[checking, card, house, euro, dollars].map(transferPayee)],
};
const to = (target: typeof checking) => ({ kind: 'existing' as const, id: target.transferPayeeId, name: '' });
const values = (fields: Partial<FormValues>): FormValues => ({ ...newValues('2026-11-21', context), ...fields });

describe('transaction form rules', () => {
  it('place the category by account class (spec §5.5)', () => {
    expect(categoryRule(checking, null)).toBe('optional');
    expect(categoryRule(house, null)).toBe('none');
    expect(categoryRule(checking, card)).toBe('none');
    expect(categoryRule(checking, house)).toBe('required');
    expect(categoryRule(house, checking)).toBe('required');
  });

  it('ask for the rate of the currency the base comes from (spec §9)', () => {
    expect(rateCurrency(checking, null, 'outflow')).toBeNull();
    expect(rateCurrency(euro, null, 'outflow')).toBe('EUR');
    expect(rateCurrency(euro, checking, 'outflow')).toBeNull();
    expect(rateCurrency(euro, dollars, 'outflow')).toBe('EUR');
    expect(rateCurrency(euro, dollars, 'inflow')).toBe('USD');
  });

  it('check what the server would refuse anyway', () => {
    expect(
      checkForm(values({ date: '30.02.2026', payee: { kind: 'new', name: ' ' } }), context),
    ).toEqual({ date: 'Enter a date as dd.mm.yyyy.', payeeName: 'Enter a name.' });
    expect(checkForm(values({ payee: to(house) }), context)).toEqual({
      categoryId: 'Choose a category for the budget side of a transfer to or from a tracking account.',
    });
    expect(checkForm(values({ payee: to(checking) }), context)).toEqual({ payeeId: 'A transfer needs two different accounts.' });
    expect(checkForm(values({ accountId: euro.id, payee: to(checking), amount: 1000 }), context)).toEqual({
      transferAmount: 'Enter an amount.',
    });
  });
});

describe('transaction requests', () => {
  it('create: a signed amount, the payee by id or name, no rate unless one is typed', () => {
    expect(createTransactionBody(values({ amount: 2_550, payee: { kind: 'new', name: ' Żabka ' }, memo: ' x ' }), context)).toEqual({
      accountId: checking.id,
      date: '2026-11-21',
      payeeName: 'Żabka',
      categoryId: null,
      memo: 'x',
      amount: -2_550,
      cleared: 'uncleared',
      flag: null,
    });
    const foreign = createTransactionBody(values({ accountId: euro.id, amount: 1_000, direction: 'inflow', fxRate: '4,3' }), context);
    expect(foreign).toMatchObject({ amount: 1_000, fxRate: '4.3' });
  });

  it('create: a transfer between currencies sends the other amount with the opposite sign', () => {
    const body = createTransactionBody(
      values({ accountId: euro.id, payee: to(dollars), amount: 10_000, transferAmount: '108,50', fxRate: '4,30', categoryId: 'x' }),
      context,
    );
    expect(body).toMatchObject({ payeeId: dollars.transferPayeeId, amount: -10_000, transferAmount: 10_850, fxRate: '4.30', categoryId: null });
    const fromPln = createTransactionBody(values({ payee: to(euro), amount: 43_000, transferAmount: '100', fxRate: '9' }), context);
    expect(fromPln).toMatchObject({ amount: -43_000, transferAmount: 10_000 });
    expect(fromPln).not.toHaveProperty('fxRate');
  });

  it('update: only what changed; a new transfer payee drops the category', () => {
    const saved = transaction(checking, 'saved', {
      payeeId: lidl.id,
      payeeName: 'Lidl',
      categoryId: 'c1',
      categoryName: 'Groceries',
      amount: -2_000,
      cleared: 'reconciled',
    });
    const original = editValues(saved);
    expect(updateTransactionBody(original, original, context)).toEqual({});
    expect(updateTransactionBody({ ...original, payee: to(card) }, original, context)).toEqual({
      payeeId: card.transferPayeeId,
      categoryId: null,
    });
    expect(
      updateTransactionBody({ ...original, amount: 2_500, cleared: false, payee: { kind: 'none' }, date: '19.11.2026' }, original, context),
    ).toEqual({ amount: -2_500, cleared: 'uncleared', payeeId: null, date: '2026-11-19' });
  });
});
