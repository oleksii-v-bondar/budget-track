import { roundDiv } from '../../engine/money';
import { MAX_AMOUNT } from '../../shared/api/common';
import { formatAmount } from './format';

/**
 * The amount keypad's calculator (spec §11 "Assign: calculator keypad that accepts + − × ÷ expressions"). Numbers are
 * in major units (złoty) with a decimal comma or point and at most two decimals; × and ÷ bind tighter than + and −,
 * and a number may carry a sign. The arithmetic is exact (fractions of bigints); only the result is rounded to minor
 * units, half away from zero, like every other amount (spec §2). Spaces are ignored, so "1 234,56" works too.
 */
export type AmountResult = { ok: true; value: number } | { ok: false; error: string };

export const OPERATORS = { add: '+', subtract: '−', multiply: '×', divide: '÷' } as const;

const TOO_LARGE_MESSAGE = `Amounts can be at most ${formatAmount(MAX_AMOUNT)}.`;

const ALIASES: Record<string, string> = { '-': '−', '*': '×', x: '×', '/': '÷', '.': ',' };

interface Fraction {
  n: bigint;
  d: bigint;
}

type Token = { kind: 'number'; text: string } | { kind: 'op'; op: string };

class ExpressionError extends Error {}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  for (const raw of expression.replace(/[\s\u00a0\u202f]/g, '')) {
    const char = ALIASES[raw] ?? raw;
    const last = tokens.at(-1);
    if (/[0-9,]/.test(char)) {
      if (last?.kind === 'number') last.text += char;
      else tokens.push({ kind: 'number', text: char });
    } else if ('+−×÷'.includes(char)) {
      tokens.push({ kind: 'op', op: char });
    } else {
      throw new ExpressionError(`"${raw}" can't be used in an amount.`);
    }
  }
  return tokens;
}

function parseNumber(text: string): Fraction {
  const match = /^(\d*)(?:,(\d*))?$/.exec(text);
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) throw new ExpressionError('Check the amount.');
  const decimals = match[2] ?? '';
  if (decimals.length > 2) throw new ExpressionError('Use at most 2 decimal places.');
  return { n: BigInt((match[1] || '0') + decimals), d: 10n ** BigInt(decimals.length) };
}

/** Recursive descent over the tokens: sum := product (± product)*, product := signed (×÷ signed)*. */
function evaluate(tokens: Token[]): Fraction {
  let i = 0;
  const peekOp = () => {
    const token = tokens[i];
    return token?.kind === 'op' ? token.op : null;
  };
  const signed = (): Fraction => {
    const op = peekOp();
    if (op === '+' || op === '−') {
      i++;
      const value = signed();
      return op === '−' ? { n: -value.n, d: value.d } : value;
    }
    const token = tokens[i++];
    if (token?.kind !== 'number') throw new ExpressionError('Finish the calculation.');
    return parseNumber(token.text);
  };
  const product = (): Fraction => {
    let value = signed();
    for (let op = peekOp(); op === '×' || op === '÷'; op = peekOp()) {
      i++;
      const right = signed();
      if (op === '÷' && right.n === 0n) throw new ExpressionError("Can't divide by 0.");
      value =
        op === '×'
          ? { n: value.n * right.n, d: value.d * right.d }
          : { n: value.n * right.d * (right.n < 0n ? -1n : 1n), d: value.d * (right.n < 0n ? -right.n : right.n) };
    }
    return value;
  };
  let value = product();
  for (let op = peekOp(); op === '+' || op === '−'; op = peekOp()) {
    i++;
    const right = product();
    const n = value.n * right.d + (op === '+' ? right.n : -right.n) * value.d;
    value = { n, d: value.d * right.d };
  }
  if (i < tokens.length) throw new ExpressionError('Finish the calculation.');
  return value;
}

/** Evaluates a keypad expression to minor units; an empty expression is 0. Results beyond ±MAX_AMOUNT are refused. */
export function evaluateAmount(expression: string): AmountResult {
  try {
    const tokens = tokenize(expression);
    if (tokens.length === 0) return { ok: true, value: 0 };
    const { n, d } = evaluate(tokens);
    const minor = roundDiv(n * 100n, d);
    if (minor > BigInt(MAX_AMOUNT) || minor < -BigInt(MAX_AMOUNT)) return { ok: false, error: TOO_LARGE_MESSAGE };
    return { ok: true, value: Number(minor) };
  } catch (error) {
    if (error instanceof ExpressionError) return { ok: false, error: error.message };
    throw error;
  }
}

/** The expression the keypad starts from for an amount: 123456 → "1234,56", 100000 → "1000", -5 → "-0,05". */
export function amountToExpression(minor: number): string {
  const abs = Math.abs(minor);
  const cents = abs % 100;
  const whole = (abs - cents) / 100;
  return `${minor < 0 ? '−' : ''}${whole}${cents === 0 ? '' : `,${String(cents).padStart(2, '0')}`}`;
}

/** The expression as the keypad displays it: thousands grouped, spaces around operators but not signs ("1 234,5 + −20"). */
export function formatExpression(expression: string): string {
  return expression
    .replace(/\d+/g, (digits, offset: number, all: string) =>
      all[offset - 1] === ',' ? digits : digits.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0'),
    )
    .replace(/(?<=[\d,])([+−×÷])/g, ' $1 ');
}
