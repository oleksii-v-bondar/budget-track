import { useOnline } from '../lib/online';
import { OfflineIcon } from '../ui/icons';

/** Spec §11 "Offline": explains why every control that changes data is disabled. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-40 flex items-center justify-center gap-2 bg-yellow-100 px-4 py-2 text-sm font-medium text-yellow-900"
    >
      <OfflineIcon className="size-4" />
      You're offline. Changes are paused until you're back online.
    </div>
  );
}
