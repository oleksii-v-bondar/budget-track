import { errorMessage } from '../lib/commands';
import { Button } from './button';

/** What a screen shows while its first data loads. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p aria-busy="true" className="px-4 py-12 text-center text-gray-500">
      {label}
    </p>
  );
}

/** A read that failed (after its retries): the reason and a way to try again. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <p className="text-gray-700">{errorMessage(error)}</p>
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
