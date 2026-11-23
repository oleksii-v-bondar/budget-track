import { useMutation } from '@tanstack/react-query';
import { authApi, useLeaveApp } from '../auth/auth-api';
import { errorMessage } from '../lib/commands';
import { useOnline } from '../lib/online';
import { ChevronRightIcon } from '../ui/icons';
import { useToast } from '../ui/toast';

/** Settings: signing out. */
export function SettingsScreen() {
  const online = useOnline();
  const toast = useToast();
  const leaveApp = useLeaveApp();
  const signOut = useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => leaveApp(),
    onError: (error) => toast.show({ tone: 'error', message: errorMessage(error) }),
  });

  return (
    <div className="mt-6 border-y border-gray-200">
      <button
        type="button"
        className="flex min-h-14 w-full items-center justify-between px-4 text-left text-base hover:bg-gray-50 disabled:text-gray-400"
        disabled={!online}
        onClick={() => signOut.mutate()}
      >
        Sign out
        <ChevronRightIcon className="text-gray-400" />
      </button>
    </div>
  );
}
