import { Link } from '@tanstack/react-router';
import { AccountsIcon, BudgetIcon, PlusIcon, SettingsIcon } from '../ui/icons';

const tab = 'flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-medium';
// Exactly one colour class at a time: two text colours on one element would leave the winner to CSS order.
const active = { className: 'text-brand', 'aria-current': 'page' } as const;
const inactive = { className: 'text-gray-500' } as const;

/** Budget · Accounts · ＋ (new transaction) · Settings. */
export function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-[480px] items-center border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)]"
    >
      <Link to="/budget" className={tab} activeProps={active} inactiveProps={inactive}>
        <BudgetIcon />
        Budget
      </Link>
      <Link to="/accounts" className={tab} activeProps={active} inactiveProps={inactive}>
        <AccountsIcon />
        Accounts
      </Link>
      <div className="flex flex-1 justify-center">
        <Link
          to="/transactions/new"
          aria-label="New transaction"
          className="-mt-5 flex size-14 items-center justify-center rounded-full bg-brand text-white shadow-lg"
        >
          <PlusIcon className="size-7" />
        </Link>
      </div>
      <Link to="/settings" className={tab} activeProps={active} inactiveProps={inactive}>
        <SettingsIcon />
        Settings
      </Link>
    </nav>
  );
}
