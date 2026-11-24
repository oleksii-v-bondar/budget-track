import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from './cx';

export interface ToastOptions {
  message: string;
  tone?: 'info' | 'error';
  /** One button, e.g. Undo or Retry; tapping it also dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** A new toast with the same key replaces the old one (only the latest command offers Undo). */
  key?: string;
  /** Milliseconds before it goes away; default 5 s, errors 8 s. */
  duration?: number;
}

interface Toast extends ToastOptions {
  id: number;
}

export interface ToastApi {
  show: (toast: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Shows toasts from anywhere below it (see useToast). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback((toast: ToastOptions) => {
    const id = nextId.current++;
    setToasts((list) => [...list.filter((t) => toast.key === undefined || t.key !== toast.key), { ...toast, id }].slice(-3));
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(9.5rem+env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-[480px] flex-col gap-2 px-3">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const { id, tone = 'info', duration = tone === 'error' ? 8000 : 5000 } = toast;
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), duration);
    return () => clearTimeout(timer);
  }, [id, duration, onDismiss]);
  return (
    // Taps go through a toast to what is under it (a sheet's last rows), except on its button.
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-white shadow-lg',
        tone === 'error' ? 'bg-red-700' : 'bg-raised ring-1 ring-line',
      )}
    >
      <span className="flex-1">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="pointer-events-auto font-semibold text-brand uppercase"
          onClick={() => {
            onDismiss(id);
            toast.action!.onClick();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast needs a <ToastProvider> above it');
  return api;
}
