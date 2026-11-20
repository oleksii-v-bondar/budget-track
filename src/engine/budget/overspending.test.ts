import { describe, expect, it } from 'vitest';
import { splitOverspending } from './overspending';

describe('splitOverspending', () => {
  it('attributes overspending to credit first, so available money covers cash spending first', () => {
    // Available 10, cash spend 20, card spend 50 → overspent 60
    expect(splitOverspending(60, [50])).toEqual({ cashOver: 10, creditOver: 50, creditOverByCard: [50] });
  });

  it('is fully credit overspending when card spending exceeds the overspent amount', () => {
    // Available 100, cash 80, card 50 → overspent 30
    expect(splitOverspending(30, [50])).toEqual({ cashOver: 0, creditOver: 30, creditOverByCard: [30] });
  });

  it('is fully cash overspending without card spending', () => {
    expect(splitOverspending(25, [])).toEqual({ cashOver: 25, creditOver: 0, creditOverByCard: [] });
  });

  it('splits credit overspending across cards proportionally', () => {
    expect(splitOverspending(20, [30, 10])).toEqual({ cashOver: 0, creditOver: 20, creditOverByCard: [15, 5] });
  });

  it('ignores cards that only had refunds (weight 0)', () => {
    expect(splitOverspending(10, [0, 40])).toEqual({ cashOver: 0, creditOver: 10, creditOverByCard: [0, 10] });
  });

  it('returns zeros when nothing is overspent', () => {
    expect(splitOverspending(0, [50])).toEqual({ cashOver: 0, creditOver: 0, creditOverByCard: [0] });
  });

  it('rejects negative input', () => {
    expect(() => splitOverspending(-1, [])).toThrow();
  });
});
