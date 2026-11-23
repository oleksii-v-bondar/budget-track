import { describe, expect, it } from 'vitest';
import { checkStep, createAccountRequest, initialWizard, stepOf, type WizardValues } from './wizard';

const TODAY = '2026-11-21';
const values = (fields: Partial<WizardValues>): WizardValues => ({ ...initialWizard(TODAY), ...fields });

describe('add-account wizard', () => {
  it("checks each step's fields", () => {
    expect(checkStep('type', values({}), TODAY)).toEqual({ type: 'Choose a type.' });
    expect(checkStep('name', values({ name: '  ' }), TODAY)).toEqual({ name: 'Enter a name.' });
    expect(checkStep('currency', values({ currency: 'EU' }), TODAY)).toEqual({
      currency: 'Use a 3-letter currency code, e.g. EUR.',
    });
    expect(checkStep('currency', values({ currency: 'eur' }), TODAY)).toEqual({});
    expect(
      checkStep('balance', values({ balance: '', date: '22.11.2026', fxRate: '4,3x' }), TODAY),
    ).toEqual({
      startingBalance: 'Enter an amount.',
      startingDate: "The starting balance can't be dated in the future.",
      fxRate: 'Enter the rate as a decimal number, e.g. 4.2512.',
    });
    expect(checkStep('balance', values({ balance: '100', date: '31.02.2026' }), TODAY)).toEqual({
      startingDate: 'Enter a date as dd.mm.yyyy.',
    });
  });

  it('builds the request: debts become negative, foreign rates as entered', () => {
    expect(createAccountRequest(values({ type: 'checking', name: ' Main ', balance: '1 234,56' }))).toEqual({
      name: 'Main',
      type: 'checking',
      currency: 'PLN',
      startingBalance: 123_456,
      startingDate: TODAY,
    });
    expect(
      createAccountRequest(
        values({ type: 'credit_card', name: 'Visa', currency: 'eur', balance: '1000', date: '01.11.2026', fxRate: '4,25' }),
      ),
    ).toEqual({
      name: 'Visa',
      type: 'credit_card',
      currency: 'EUR',
      startingBalance: -100_000,
      startingDate: '2026-11-01',
      fxRate: '4.25',
    });
    expect(createAccountRequest(values({ type: 'credit_card', name: 'Visa', balance: '0' })).startingBalance).toBe(0);
  });

  it('finds the step to go back to for a server error', () => {
    expect(stepOf(['startingDate', 'fxRate'])).toBe('balance');
    expect(stepOf(['name'])).toBe('name');
    expect(stepOf(['ids.0'])).toBeNull();
  });
});
