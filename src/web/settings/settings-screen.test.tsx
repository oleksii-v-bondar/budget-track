import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';

const SECRET = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
const WRONG = { code: 'invalid_credentials', message: 'Your current password or code is wrong.' };

async function openSettings(routes: Parameters<typeof fakeApi>[0] = {}) {
  const server = fakeApi({ ...SIGNED_IN, ...routes });
  const app = renderApp('/settings');
  await screen.findByRole('heading', { name: 'Settings' });
  return { ...server, ...app, user: userEvent.setup() };
}

const posts = (requests: { method: string; path: string; body: unknown }[]) =>
  requests.filter((r) => r.method === 'POST').map(({ path, body }) => ({ path, body }));

describe('settings', () => {
  it('changes the password with the current one and an authenticator code', async () => {
    let calls = 0;
    const { user, requests } = await openSettings({
      'POST /api/auth/password': () => (++calls === 1 ? json(WRONG, 422) : { body: { ok: true } }),
    });
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    const sheet = screen.getByRole('dialog', { name: 'Change password' });
    await user.type(within(sheet).getByLabelText('Current password'), 'old password!');
    await user.type(within(sheet).getByLabelText('New password'), 'a brand new passphrase');
    await user.type(within(sheet).getByLabelText('Repeat the new password'), 'a brand new passphrase?');
    await user.type(within(sheet).getByLabelText('Authenticator code'), '123456');
    await user.click(within(sheet).getByRole('button', { name: 'Change password' }));
    expect(within(sheet).getByLabelText('Repeat the new password')).toHaveAccessibleDescription("The passwords don't match.");
    expect(posts(requests)).toEqual([]);

    await user.type(within(sheet).getByLabelText('Repeat the new password'), '{Backspace}');
    await user.click(within(sheet).getByRole('button', { name: 'Change password' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Your current password or code is wrong.');
    await user.click(within(sheet).getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed. Other devices were signed out.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(requests).at(-1)).toEqual({
      path: '/api/auth/password',
      body: { currentPassword: 'old password!', newPassword: 'a brand new passphrase', totpCode: '123456' },
    });
  });

  it('switches the authenticator app, confirming with a recovery code', async () => {
    const { user, requests } = await openSettings({
      'POST /api/auth/totp/secret': { body: { secret: SECRET, uri: `otpauth://totp/Budget%20Track:owner?secret=${SECRET}` } },
      'POST /api/auth/totp': { body: { ok: true } },
    });
    await user.click(screen.getByRole('button', { name: 'Change authenticator app' }));
    const sheet = screen.getByRole('dialog', { name: 'Change authenticator app' });
    await user.click(within(sheet).getByRole('button', { name: 'Show the new QR code' }));
    expect(await within(sheet).findByRole('img', { name: 'QR code for your authenticator app' })).toBeInTheDocument();
    expect(within(sheet).getByTestId('totp-secret')).toHaveTextContent('KRSX G5CT');
    await user.type(within(sheet).getByLabelText('Code from the new app'), '654321');
    await user.type(within(sheet).getByLabelText('Current password'), 'my password!');
    await user.click(within(sheet).getByRole('radio', { name: 'Recovery code' }));
    await user.type(within(sheet).getByLabelText('Recovery code'), 'AAAA-BBBB-CCCC');
    await user.click(within(sheet).getByRole('button', { name: 'Switch authenticator' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Authenticator changed.');
    expect(posts(requests).at(-1)).toEqual({
      path: '/api/auth/totp',
      body: { currentPassword: 'my password!', recoveryCode: 'AAAA-BBBB-CCCC', totpSecret: SECRET, totpCode: '654321' },
    });
  });

  it('makes new recovery codes and shows them once', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `NEWC-ODES-00${String(i).padStart(2, '0')}`);
    const { user } = await openSettings({ 'POST /api/auth/recovery-codes': { body: { recoveryCodes: codes } } });
    await user.click(screen.getByRole('button', { name: 'New recovery codes' }));
    const sheet = screen.getByRole('dialog', { name: 'New recovery codes' });
    await user.type(within(sheet).getByLabelText('Current password'), 'my password!');
    await user.type(within(sheet).getByLabelText('Authenticator code'), '123456');
    await user.click(within(sheet).getByRole('button', { name: 'Make new codes' }));
    const list = await within(sheet).findByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('links to the JSON export', async () => {
    await openSettings();
    const link = screen.getByRole('link', { name: 'Download JSON export' });
    expect(link).toHaveAttribute('href', '/api/export');
    expect(link).toHaveAttribute('download');
  });

  it('signs out this device', async () => {
    const { user, history, requests } = await openSettings({ 'POST /api/auth/logout': { body: { ok: true } } });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(posts(requests)).toEqual([{ path: '/api/auth/logout', body: undefined }]);
  });

  it('cannot sign out while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openSettings();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
  });

  it('signs out everywhere after asking', async () => {
    const { user, history, requests } = await openSettings({ 'POST /api/auth/logout-all': { body: { ok: true } } });
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    const sheet = screen.getByRole('dialog', { name: 'Sign out everywhere' });
    expect(posts(requests)).toEqual([]);
    await user.click(within(sheet).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(posts(requests)).toEqual([{ path: '/api/auth/logout-all', body: undefined }]);
  });
});
