import { describe, expect, it } from 'vitest';
import { amountToExpression, evaluateAmount, formatExpression } from './amount-expression';

const value = (expression: string) => {
  const result = evaluateAmount(expression);
  return result.ok ? result.value : result.error;
};

describe('evaluateAmount', () => {
  it('reads złoty amounts with a decimal comma or point into grosze', () => {
    expect(value('12')).toBe(1200);
    expect(value('12,5')).toBe(1250);
    expect(value('12.05')).toBe(1205);
    expect(value(',5')).toBe(50);
    expect(value('7,')).toBe(700);
    expect(value('1 234,56')).toBe(123456);
    expect(value('')).toBe(0);
  });

  it('adds, subtracts, multiplies and divides, × and ÷ before + and −', () => {
    expect(value('100+20,5')).toBe(12050);
    expect(value('100−20,5')).toBe(7950);
    expect(value('12,50×3')).toBe(3750);
    expect(value('90÷4')).toBe(2250);
    expect(value('10+2×3')).toBe(1600);
    expect(value('10−6÷3')).toBe(800);
    expect(value('2×3+4×5')).toBe(2600);
    expect(value('100−20−30')).toBe(5000);
    expect(value('100÷2÷5')).toBe(1000);
  });

  it('takes the ASCII operators too', () => {
    expect(value('10-2*3+8/4')).toBe(600);
    expect(value('3x4')).toBe(1200);
  });

  it('allows signs on numbers', () => {
    expect(value('−50')).toBe(-5000);
    expect(value('-50+20')).toBe(-3000);
    expect(value('100×−1')).toBe(-10000);
    expect(value('−−5')).toBe(500);
    expect(value('+5')).toBe(500);
  });

  it('computes exactly and rounds only the result, half away from zero', () => {
    expect(value('100÷3')).toBe(3333);
    expect(value('200÷3')).toBe(6667);
    expect(value('100÷3×3')).toBe(10000);
    expect(value('0,01÷2')).toBe(1);
    expect(value('−0,01÷2')).toBe(-1);
    expect(value('0,1+0,2')).toBe(30);
    expect(value('1,15×100')).toBe(11500);
  });

  it('explains what is wrong with an expression it cannot evaluate', () => {
    expect(value('12+')).toBe('Finish the calculation.');
    expect(value('×3')).toBe('Finish the calculation.');
    expect(value('5÷0')).toBe("Can't divide by 0.");
    expect(value('5÷(2)')).toBe('"(" can\'t be used in an amount.');
    expect(value('1,234')).toBe('Use at most 2 decimal places.');
    expect(value('1,2,3')).toBe('Check the amount.');
    expect(value(',')).toBe('Check the amount.');
    expect(value('99999999999999')).toBe('That amount is too large.');
    expect(value('90071992547409,91')).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('keypad helpers', () => {
  it('start the keypad from an amount', () => {
    expect(amountToExpression(123456)).toBe('1234,56');
    expect(amountToExpression(100000)).toBe('1000');
    expect(amountToExpression(5)).toBe('0,05');
    expect(amountToExpression(-2550)).toBe('−25,50');
    expect(amountToExpression(0)).toBe('0');
    for (const amount of [123456, 100000, 5, -2550, 0, Number.MAX_SAFE_INTEGER]) {
      expect(value(amountToExpression(amount))).toBe(amount);
    }
  });

  it('display an expression with grouped thousands and spaced operators', () => {
    expect(formatExpression('1234,5+20000')).toBe('1\u00a0234,5 + 20\u00a0000');
    expect(formatExpression('−1234,5678×3')).toBe('−1\u00a0234,5678 × 3');
    expect(formatExpression('12÷')).toBe('12 ÷ ');
    expect(formatExpression('100×−1')).toBe('100 × −1');
  });
});
