import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';

async function openSettings(routes: Parameters<typeof fakeApi>[0] = {}) {
  const server = fakeApi({ ...SIGNED_IN, ...routes });
  const app = renderApp('/settings');
  await screen.findByRole('heading', { name: 'Settings' });
  return { ...server, ...app, user: userEvent.setup() };
}

describe('settings', () => {
  it('signs out this device', async () => {
    const { user, history, requests } = await openSettings({ 'POST /api/auth/logout': { body: { ok: true } } });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/auth/logout']);
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
  });

  it('cannot sign out while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openSettings();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
  });
});
