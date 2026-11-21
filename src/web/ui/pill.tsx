import type { ReactNode } from 'react';
import { cx } from './cx';

/** Spec §6 colours: green = funded, yellow = underfunded or covered by credit, red = overspent, grey = zero. */
export type PillTone = 'green' | 'yellow' | 'red' | 'grey';

const TONES: Record<PillTone, string> = {
  green: 'bg-green-200 text-green-900',
  yellow: 'bg-yellow-200 text-yellow-900',
  red: 'bg-red-200 text-red-900',
  grey: 'bg-gray-200 text-gray-700',
};

/** A rounded amount badge, like the Available pills of the budget. */
export function Pill({ tone, children, className }: { tone: PillTone; children: ReactNode; className?: string }) {
  return (
    <span
      data-tone={tone}
      className={cx('inline-flex rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums whitespace-nowrap', TONES[tone], className)}
    >
      {children}
    </span>
  );
}
