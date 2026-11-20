import type { IsoDate, Month } from '../engine';

/** Source of the current instant; injected so time-dependent logic is testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Calendar date of `instant` in `timeZone`, formatted 'YYYY-MM-DD'. */
export function todayIn(timeZone: string, instant: Date): IsoDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Calendar month of `instant` in `timeZone`, formatted 'YYYY-MM'. */
export function monthIn(timeZone: string, instant: Date): Month {
  return todayIn(timeZone, instant).slice(0, 7);
}
