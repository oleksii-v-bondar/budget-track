import type { ReactNode } from 'react';
import { cx } from './cx';

/** Spec §6 colours: green = funded, yellow = underfunded or covered by credit, red = overspent, grey = zero. */
export type PillTone = 'green' | 'yellow' | 'red' | 'grey';

const TONES: Record<PillTone, string> = {
  green: 'bg-lime text-page',
  yellow: 'bg-yellow-400 text-page',
  red: 'bg-red-500 text-white',
  grey: 'bg-zero text-muted',
};

/** A rounded amount badge, like the Available pills of the budget. */
export function Pill({ tone, children, className }: { tone: PillTone; children: ReactNode; className?: string }) {
  return (
    <span
      data-tone={tone}
      className={cx('inline-flex rounded-full px-3 py-0.5 text-base font-semibold tabular-nums whitespace-nowrap', TONES[tone], className)}
    >
      {children}
    </span>
  );
}
