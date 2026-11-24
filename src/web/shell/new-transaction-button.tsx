import { useLocation, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { TransactionForm } from '../transactions/transaction-form';
import { PlusIcon } from '../ui/icons';
import { Sheet } from '../ui/sheet';

/** The floating "+ Transaction" button above the tab bar; in an account's register it starts in that account. */
export function NewTransactionButton() {
  const [open, setOpen] = useState(false);
  const { accountId } = useParams({ strict: false });
  const { pathname } = useLocation();
  const close = () => setOpen(false);
  if (pathname === '/transactions/new') return null;
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+max(0.75rem,env(safe-area-inset-bottom)))] z-20 mx-auto flex max-w-[480px] justify-end px-4">
        <button
          type="button"
          aria-label="New transaction"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className="pointer-events-auto flex h-14 items-center gap-2 rounded-full bg-raised/90 px-6 text-lg font-semibold text-white shadow-2xl ring-1 ring-white/10 backdrop-blur-md hover:bg-zero"
        >
          <PlusIcon />
          Transaction
        </button>
      </div>
      <Sheet open={open} onClose={close} title="New transaction">
        <TransactionForm prefill={accountId ? { accountId } : {}} onDone={close} />
      </Sheet>
    </>
  );
}
