import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSignOut } from '../auth/auth-api';
import { undoStateQuery, useUndoRedo } from '../lib/commands';
import { useOnline } from '../lib/online';
import { MoreIcon, RedoIcon, SettingsIcon, UndoIcon } from '../ui/icons';

const MENU_ITEM =
  'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-base text-white hover:bg-white/10 disabled:text-muted disabled:hover:bg-transparent';

function MenuButton({
  onClick,
  disabled,
  icon,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  children: string;
}) {
  const online = useOnline();
  return (
    <button
      type="button"
      role="menuitem"
      className={MENU_ITEM}
      disabled={disabled || !online}
      title={online ? undefined : "You're offline"}
      onClick={onClick}
    >
      <span className="size-5 shrink-0">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

/**
 * The "…" button at the right end of every top bar. Its menu has Undo and Redo (named after the command they would
 * undo or redo), Settings and Sign out.
 */
export function MoreMenu() {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { data } = useQuery(undoStateQuery);
  const { undo, redo, busy } = useUndoRedo();
  const signOut = useSignOut();
  const close = () => setOpen(false);
  const pick = (run: () => void) => () => {
    close();
    run();
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex size-11 items-center justify-center rounded-full bg-raised text-white ring-1 ring-white/5 hover:bg-white/10"
      >
        <MoreIcon />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" data-testid="menu-backdrop" onClick={close} />
          <div
            ref={menu}
            role="menu"
            aria-label="More"
            className="absolute top-full right-0 z-50 mt-2 flex w-64 flex-col rounded-2xl bg-raised p-1.5 shadow-2xl ring-1 ring-line"
          >
            <MenuButton icon={<UndoIcon className="size-5" />} disabled={!data?.undo || busy} onClick={pick(undo)}>
              {data?.undo ? `Undo ${data.undo.label}` : 'Undo'}
            </MenuButton>
            <MenuButton icon={<RedoIcon className="size-5" />} disabled={!data?.redo || busy} onClick={pick(redo)}>
              {data?.redo ? `Redo ${data.redo.label}` : 'Redo'}
            </MenuButton>
            <div role="separator" className="my-1 h-px bg-line" />
            <Link to="/settings" role="menuitem" className={MENU_ITEM} onClick={close}>
              <SettingsIcon className="size-5 shrink-0" />
              Settings
            </Link>
            <MenuButton disabled={signOut.isPending} onClick={pick(() => signOut.mutate())}>
              Sign out
            </MenuButton>
          </div>
        </>
      )}
    </div>
  );
}
