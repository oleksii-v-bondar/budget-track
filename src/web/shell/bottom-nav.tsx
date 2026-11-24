import { Link } from '@tanstack/react-router';
import type { ComponentType, SVGProps } from 'react';
import { AccountsIcon, HomeIcon, PlanIcon, ReflectIcon, SpendingIcon } from '../ui/icons';

const tab = 'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-semibold';
// Exactly one colour class at a time: two text colours on one element would leave the winner to CSS order.
const active = { className: 'bg-page/80 text-brand', 'aria-current': 'page' } as const;
const inactive = { className: 'text-white' } as const;

const TABS: {
  to: '/home' | '/budget' | '/transactions' | '/accounts' | '/reflect';
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}[] = [
  { to: '/home', label: 'Home', icon: HomeIcon },
  { to: '/budget', label: 'Plan', icon: PlanIcon },
  { to: '/transactions', label: 'Spending', icon: SpendingIcon },
  { to: '/accounts', label: 'Accounts', icon: AccountsIcon },
  { to: '/reflect', label: 'Reflect', icon: ReflectIcon },
];

/** The floating tab bar: Home · Plan · Spending · Accounts · Reflect. */
export function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[480px] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex gap-1 rounded-full bg-raised/80 p-1 shadow-2xl ring-1 ring-white/10 backdrop-blur-md">
        {TABS.map(({ to, label, icon: Icon }) => (
          <Link key={to} to={to} className={tab} activeProps={active} inactiveProps={inactive}>
            <Icon className="size-6" />
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
