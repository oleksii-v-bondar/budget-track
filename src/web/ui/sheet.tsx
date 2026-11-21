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

/**
 * A bottom sheet (modal dialog) for forms and pickers. While it is open the page behind doesn't scroll; focus moves
 * into the sheet and returns to where it was when the sheet closes.
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
      <div className="absolute inset-0 bg-black/40" data-testid="sheet-backdrop" onClick={() => close.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative mx-auto flex max-h-[90dvh] w-full max-w-[480px] flex-col rounded-t-2xl bg-white shadow-xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => close.current()}
            className="-mr-2 rounded-full p-2 text-gray-500 hover:bg-gray-100"
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
