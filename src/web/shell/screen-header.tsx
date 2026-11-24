import { Link, type LinkProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ChevronLeftIcon } from '../ui/icons';
import { MoreMenu } from './more-menu';

/** The top bar's round icon buttons ("…", search, back). */
export const ROUND_BUTTON =
  'flex size-11 shrink-0 items-center justify-center rounded-full bg-raised text-white ring-1 ring-white/5 hover:bg-white/10 disabled:text-muted';

/** The top bar's text buttons (Select, Done). */
export const PILL_BUTTON =
  'flex h-11 shrink-0 items-center rounded-full bg-raised px-5 font-semibold text-white ring-1 ring-white/5 hover:bg-white/10';

interface ScreenHeaderProps {
  /** The large title under the bar ("Spending"). */
  title?: string;
  /** The bar's left end: a back link, or the Plan's edit and filter buttons. */
  left?: ReactNode;
  /** The bar's middle: the Plan's month. */
  center?: ReactNode;
  /** Buttons before "…". */
  actions?: ReactNode;
}

/** A screen's top bar (with the "…" menu at its right end) and its large title, as in YNAB's iOS app. */
export function ScreenHeader({ title, left, center, actions }: ScreenHeaderProps) {
  return (
    <header className="px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
      <div className="grid min-h-12 grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="flex min-w-0 items-center">{left}</div>
        <div className="flex justify-center">{center}</div>
        <div className="flex items-center justify-end gap-2">
          {actions}
          <MoreMenu />
        </div>
      </div>
      {title && <h1 className="mt-4 mb-2 text-[34px] leading-tight font-bold tracking-tight">{title}</h1>}
    </header>
  );
}

/** A round back button to a parent screen. */
export function BackLink({ to, params, label }: { to: LinkProps['to']; params?: LinkProps['params']; label: string }) {
  return (
    <Link to={to} params={params} aria-label={`Back to ${label}`} className={ROUND_BUTTON}>
      <ChevronLeftIcon />
    </Link>
  );
}
