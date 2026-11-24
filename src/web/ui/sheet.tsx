import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './icons';

export interface SheetProps {
  open: boolean;
  /** Called for the close button, a tap on the backdrop and Escape. */
  onClose: () => void;
  title: string;
  children: ReactNode;
}

const TABBABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]',
].join(', ');

/** Tab and Shift+Tab wrap around inside `panel`, so keyboard focus can't reach the page behind. */
function keepFocusIn(panel: HTMLElement, event: KeyboardEvent): void {
  const items = [...panel.querySelectorAll<HTMLElement>(TABBABLE)].filter((item) => item.tabIndex >= 0);
  const first = items[0] ?? panel;
  const last = items.at(-1) ?? panel;
  const active = document.activeElement;
  // From the panel itself (focused when it has no field), Tab reaches the first item on its own.
  const wrap = event.shiftKey
    ? active === first || active === panel || !panel.contains(active)
    : active === last || !panel.contains(active);
  if (!wrap) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
}

/**
 * A bottom sheet (modal dialog) for forms and pickers. While it is open the page behind doesn't scroll; focus moves
 * into the sheet, Tab keeps it there, and it returns to where it was when the sheet closes.
 */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const autofocus = panel.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea');
    (autofocus ?? panel.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      else if (event.key === 'Tab' && panel.current) keepFocusIn(panel.current, event);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      returnFocus?.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/60" data-testid="sheet-backdrop" onClick={() => close.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative mx-auto flex max-h-[90dvh] w-full max-w-[480px] flex-col rounded-t-3xl bg-surface shadow-xl ring-1 ring-line outline-none"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <h2 id={titleId} className="text-lg font-bold">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => close.current()}
            className="-mr-2 rounded-full p-2 text-muted hover:bg-white/10"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="overflow-y-auto px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
