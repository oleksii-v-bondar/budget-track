import { useSignOut } from '../auth/auth-api';
import { useOnline } from '../lib/online';
import { BackLink, ScreenHeader } from '../shell/screen-header';
import { ChevronRightIcon } from '../ui/icons';
import { BankSection } from './bank-section';

/** Settings: bank connections and signing out. */
export function SettingsScreen() {
  const online = useOnline();
  const signOut = useSignOut();
  return (
    <>
      <ScreenHeader title="Settings" left={<BackLink to="/home" label="Home" />} />
      <BankSection />
      <div className="mx-4 mt-6 overflow-hidden rounded-2xl bg-surface">
        <button
          type="button"
          className="flex min-h-14 w-full items-center justify-between px-4 text-left text-base hover:bg-white/5 disabled:text-muted"
          disabled={!online}
          onClick={() => signOut.mutate()}
        >
          Sign out
          <ChevronRightIcon className="text-muted" />
        </button>
      </div>
    </>
  );
}
