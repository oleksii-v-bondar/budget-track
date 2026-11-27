import { describe, expect, it } from 'vitest';
import { matchRoundUps, type RoundUpCandidate } from './round-ups';

let created = 0;
const row = (id: string, amount: number, fields: Partial<RoundUpCandidate> = {}): RoundUpCandidate => ({
  id,
  accountId: 'revolut',
  date: '2026-11-18',
  amount,
  createdAt: new Date(Date.UTC(2026, 10, 18, 12, 0, created++)),
  text: 'Żabka',
  ...fields,
});
const roundUp = (id: string, amount: number, fields: Partial<RoundUpCandidate> = {}) =>
  row(id, amount, { text: 'To PLN MB:be9ad12', ...fields });

describe('matchRoundUps', () => {
  it('links a round-up to the purchase it rounds up to a multiple of 5 zł, also a round 120 zł with 5 zł', () => {
    const rows = [
      row('X', -1125),
      roundUp('R', -375),
      row('Y', -12_000, { date: '2026-11-19' }),
      roundUp('R5', -500, { date: '2026-11-19' }),
      // Money sent to someone has no round-up.
      row('Sent', -5000, { text: 'Jan Nowak' }),
    ];
    expect(matchRoundUps(rows)).toEqual(new Map([['R', 'X'], ['R5', 'Y']]));
  });

  it('leaves a round-up alone without a fitting purchase', () => {
    const rows = [
      roundUp('R', -375),
      row('Off', -1000),
      row('Elsewhere', -1125, { accountId: 'pko' }),
      row('Too late', -1125, { date: '2026-11-20' }),
      row('Inflow', 1125),
    ];
    expect(matchRoundUps(rows)).toEqual(new Map());
  });

  it('prefers the purchase of the same date, then the closest created; a tie links nothing', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 18, 12, 0, s));
    const r = roundUp('R', -375, { createdAt: at(10) });
    expect(matchRoundUps([row('Day before', -1125, { date: '2026-11-17', createdAt: at(10) }), row('Same day', -2125, { createdAt: at(0) }), r])).toEqual(
      new Map([['R', 'Same day']]),
    );
    expect(matchRoundUps([row('Far', -1125, { createdAt: at(0) }), row('Close', -2125, { createdAt: at(9) }), r])).toEqual(
      new Map([['R', 'Close']]),
    );
    expect(matchRoundUps([row('A', -1125, { createdAt: at(10) }), row('B', -2125, { createdAt: at(10) }), r])).toEqual(new Map());
  });
});
