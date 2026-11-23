import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';

const SECRET = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
const SECRET_REPLY = { body: { secret: SECRET, uri: `otpauth://totp/Budget%20Track:owner?secret=${SECRET}` } };
const WRONG = { code: 'invalid_credentials', message: 'Your current password or code is wrong.' };
const CODES = Array.from({ length: 10 }, (_, i) => `NEWC-ODES-00${String(i).padStart(2, '0')}`);

/** The signed-in owner's status with the authenticator app on. */
const WITH_AUTHENTICATOR = {
  'GET /api/auth/status': { body: { setupRequired: false, authenticated: true, authenticatorEnabled: true } },
};

async function openSettings(routes: Parameters<typeof fakeApi>[0] = {}) {
  const server = fakeApi({ ...SIGNED_IN, ...routes });
  const app = renderApp('/settings');
  await screen.findByRole('heading', { name: 'Settings' });
  return { ...server, ...app, user: userEvent.setup() };
}

const posts = (requests: { method: string; path: string; body: unknown }[]) =>
  requests.filter((r) => r.method === 'POST').map(({ path, body }) => ({ path, body }));

const authenticatorSection = () => screen.getByRole('region', { name: 'Authenticator app' });

describe('settings', () => {
  it('changes the password with the current one only while no authenticator is on', async () => {
    const { user, requests } = await openSettings({ 'POST /api/auth/password': { body: { ok: true } } });
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    const sheet = screen.getByRole('dialog', { name: 'Change password' });
    expect(within(sheet).queryByLabelText('Authenticator code')).toBeNull();
    await user.type(within(sheet).getByLabelText('Current password'), 'old password!');
    await user.type(within(sheet).getByLabelText('New password'), 'a brand new passphrase');
    await user.type(within(sheet).getByLabelText('Repeat the new password'), 'a brand new passphrase');
    await user.click(within(sheet).getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed. Other devices were signed out.');
    expect(posts(requests)).toEqual([
      { path: '/api/auth/password', body: { currentPassword: 'old password!', newPassword: 'a brand new passphrase' } },
    ]);
  });

  it('changes the password with the current one and an authenticator code', async () => {
    let calls = 0;
    const { user, requests } = await openSettings({
      ...WITH_AUTHENTICATOR,
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

  it('shows the authenticator app as off, with nothing to replace or turn off', async () => {
    await openSettings();
    const section = authenticatorSection();
    expect(section).toHaveTextContent('Off');
    expect(within(section).getByRole('button', { name: 'Turn on' })).toBeInTheDocument();
    for (const name of ['Turn off', 'Replace authenticator app', 'New recovery codes']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('turns the authenticator on: password, QR code, a code from the app, then the recovery codes once', async () => {
    const { user, requests } = await openSettings({
      'POST /api/auth/totp/secret': SECRET_REPLY,
      'POST /api/auth/totp': { body: { ok: true, recoveryCodes: CODES } },
    });
    await user.click(within(authenticatorSection()).getByRole('button', { name: 'Turn on' }));
    const sheet = screen.getByRole('dialog', { name: 'Turn on authenticator app' });
    await user.click(within(sheet).getByRole('button', { name: 'Continue' }));
    expect(within(sheet).getByLabelText('Current password')).toHaveAccessibleDescription('Enter your password.');
    expect(posts(requests)).toEqual([]);
    await user.type(within(sheet).getByLabelText('Current password'), 'my password!');
    await user.click(within(sheet).getByRole('button', { name: 'Continue' }));

    expect(await within(sheet).findByRole('img', { name: 'QR code for your authenticator app' })).toBeInTheDocument();
    expect(within(sheet).getByTestId('totp-secret')).toHaveTextContent('KRSX G5CT');
    await user.type(within(sheet).getByLabelText('Code from the app'), '654321');
    await user.click(within(sheet).getByRole('button', { name: 'Turn on' }));

    const list = await within(sheet).findByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(posts(requests).at(-1)).toEqual({
      path: '/api/auth/totp',
      body: { currentPassword: 'my password!', totpSecret: SECRET, totpCode: '654321' },
    });
    const done = within(sheet).getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(within(sheet).getByLabelText("I've saved my recovery codes"));
    await user.click(done);
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(authenticatorSection()).toHaveTextContent('On');
    for (const name of ['Turn off', 'Replace authenticator app', 'New recovery codes']) {
      expect(within(authenticatorSection()).getByRole('button', { name })).toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(within(screen.getByRole('dialog')).getByLabelText('Authenticator code')).toBeInTheDocument();
  });

  it('goes back to the password when it is wrong, keeping the new secret', async () => {
    let calls = 0;
    const { user, requests } = await openSettings({
      'POST /api/auth/totp/secret': SECRET_REPLY,
      'POST /api/auth/totp': () =>
        ++calls === 1
          ? json({ code: 'invalid_credentials', message: 'Your current password is wrong.' }, 422)
          : { body: { ok: true, recoveryCodes: CODES } },
    });
    await user.click(within(authenticatorSection()).getByRole('button', { name: 'Turn on' }));
    const sheet = screen.getByRole('dialog', { name: 'Turn on authenticator app' });
    await user.type(within(sheet).getByLabelText('Current password'), 'not it');
    await user.click(within(sheet).getByRole('button', { name: 'Continue' }));
    await user.type(await within(sheet).findByLabelText('Code from the app'), '654321');
    await user.click(within(sheet).getByRole('button', { name: 'Turn on' }));

    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Your current password is wrong.');
    await user.clear(within(sheet).getByLabelText('Current password'));
    await user.type(within(sheet).getByLabelText('Current password'), 'my password!');
    await user.click(within(sheet).getByRole('button', { name: 'Continue' }));
    expect(within(sheet).queryByRole('alert')).toBeNull();
    await user.clear(within(sheet).getByLabelText('Code from the app'));
    await user.type(within(sheet).getByLabelText('Code from the app'), '765432');
    await user.click(within(sheet).getByRole('button', { name: 'Turn on' }));
    expect(await within(sheet).findByRole('list', { name: 'Recovery codes' })).toBeInTheDocument();
    expect(posts(requests).filter((r) => r.path === '/api/auth/totp/secret')).toHaveLength(1);
    expect(posts(requests).at(-1)!.body).toEqual({ currentPassword: 'my password!', totpSecret: SECRET, totpCode: '765432' });
  });

  it('turns the authenticator off with the password and a code, once confirmed', async () => {
    let calls = 0;
    const { user, requests } = await openSettings({
      ...WITH_AUTHENTICATOR,
      'POST /api/auth/totp/disable': () => (++calls === 1 ? json(WRONG, 422) : { body: { ok: true } }),
    });
    expect(authenticatorSection()).toHaveTextContent('On');
    await user.click(within(authenticatorSection()).getByRole('button', { name: 'Turn off' }));
    const sheet = screen.getByRole('dialog', { name: 'Turn off authenticator app' });
    await user.type(within(sheet).getByLabelText('Current password'), 'my password!');
    await user.type(within(sheet).getByLabelText('Authenticator code'), '123456');
    const submit = within(sheet).getByRole('button', { name: 'Turn off' });
    expect(submit).toBeDisabled();
    await user.click(within(sheet).getByLabelText('Sign in with the password only from now on'));
    await user.click(submit);
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Your current password or code is wrong.');
    await user.click(submit);

    expect(await screen.findByRole('status')).toHaveTextContent('Authenticator app turned off. Other devices were signed out.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(requests).at(-1)).toEqual({
      path: '/api/auth/totp/disable',
      body: { currentPassword: 'my password!', totpCode: '123456' },
    });
    expect(authenticatorSection()).toHaveTextContent('Off');
    expect(within(authenticatorSection()).getByRole('button', { name: 'Turn on' })).toBeInTheDocument();
  });

  it('turns the authenticator off with a recovery code', async () => {
    const { user, requests } = await openSettings({
      ...WITH_AUTHENTICATOR,
      'POST /api/auth/totp/disable': { body: { ok: true } },
    });
    await user.click(within(authenticatorSection()).getByRole('button', { name: 'Turn off' }));
    const sheet = screen.getByRole('dialog', { name: 'Turn off authenticator app' });
    await user.type(within(sheet).getByLabelText('Current password'), 'my password!');
    await user.click(within(sheet).getByRole('radio', { name: 'Recovery code' }));
    await user.type(within(sheet).getByLabelText('Recovery code'), 'AAAA-BBBB-CCCC');
    await user.click(within(sheet).getByLabelText('Sign in with the password only from now on'));
    await user.click(within(sheet).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(requests).at(-1)!.body).toEqual({ currentPassword: 'my password!', recoveryCode: 'AAAA-BBBB-CCCC' });
  });

  it('replaces the authenticator app, confirming with a recovery code', async () => {
    const { user, requests } = await openSettings({
      ...WITH_AUTHENTICATOR,
      'POST /api/auth/totp/secret': SECRET_REPLY,
      'POST /api/auth/totp': { body: { ok: true } },
    });
    await user.click(screen.getByRole('button', { name: 'Replace authenticator app' }));
    const sheet = screen.getByRole('dialog', { name: 'Replace authenticator app' });
    await user.click(within(sheet).getByRole('button', { name: 'Show the new QR code' }));
    expect(await within(sheet).findByRole('img', { name: 'QR code for your authenticator app' })).toBeInTheDocument();
    expect(within(sheet).getByTestId('totp-secret')).toHaveTextContent('KRSX G5CT');
    await user.type(within(sheet).getByLabelText('Code from the new app'), '654321');
    await user.type(within(sheet).getByLabelText('Current password'), 'my password!');
    await user.click(within(sheet).getByRole('radio', { name: 'Recovery code' }));
    await user.type(within(sheet).getByLabelText('Recovery code'), 'AAAA-BBBB-CCCC');
    await user.click(within(sheet).getByRole('button', { name: 'Replace authenticator' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Authenticator replaced.');
    expect(posts(requests).at(-1)).toEqual({
      path: '/api/auth/totp',
      body: { currentPassword: 'my password!', recoveryCode: 'AAAA-BBBB-CCCC', totpSecret: SECRET, totpCode: '654321' },
    });
    expect(authenticatorSection()).toHaveTextContent('On');
  });

  it('makes new recovery codes and shows them once', async () => {
    const { user } = await openSettings({
      ...WITH_AUTHENTICATOR,
      'POST /api/auth/recovery-codes': { body: { recoveryCodes: CODES } },
    });
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
