import type { IsoDate, Month } from '../engine';

/** Source of the current instant; injected so time-dependent logic is testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Calendar date of `instant` in `timeZone`, formatted 'YYYY-MM-DD'. */
export function todayIn(timeZone: string, instant: Date): IsoDate {
  // Built from parts: a locale's date pattern (e.g. en-CA's) can change between ICU versions.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: 'year' | 'month' | 'day') => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

/** Calendar month of `instant` in `timeZone`, formatted 'YYYY-MM'. */
export function monthIn(timeZone: string, instant: Date): Month {
  return todayIn(timeZone, instant).slice(0, 7);
}
