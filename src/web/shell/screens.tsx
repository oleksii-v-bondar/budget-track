import { type ErrorComponentProps, Link, useRouter } from '@tanstack/react-router';
import { errorMessage } from '../lib/commands';
import { Button } from '../ui/button';

export function NotFoundScreen() {
  return (
    <div className="mx-auto max-w-[480px] px-4 py-12 text-center">
      <p className="text-lg font-semibold">Page not found</p>
      <Link to="/home" className="text-brand underline">
        Go to Home
      </Link>
    </div>
  );
}

/** A route failed to load (e.g. the sign-in check couldn't reach the server): Try again runs its checks again. */
export function ErrorScreen({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className="mx-auto flex max-w-[480px] flex-col items-center gap-4 px-4 py-12 text-center">
      <h1 className="text-lg font-semibold">This page didn't load</h1>
      <p className="text-muted">{errorMessage(error)}</p>
      <Button onClick={() => void router.invalidate()}>Try again</Button>
    </div>
  );
}
