import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { renderApp } from '../test/render';

const signedOut = (authenticatorEnabled: boolean) => ({
  'GET /api/auth/status': { body: { setupRequired: false, authenticated: false, authenticatorEnabled } },
  'GET /api/undo': { body: { undo: null, redo: null } },
});
const PASSWORD = 'correct horse battery staple';

describe('sign-in without an authenticator', () => {
  it('asks for the password only, then opens the page asked for', async () => {
    const user = userEvent.setup();
    const { requests } = fakeApi({
      ...signedOut(false),
      'POST /api/auth/login': { body: { authenticatorEnabled: false, recoveryCodesRemaining: 0 } },
    });
    const { history } = renderApp('/login?redirect=%2Fpayees');
    await user.type(await screen.findByLabelText('Password'), PASSWORD);
    expect(screen.queryByLabelText('Authenticator code')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/payees'));
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ password: PASSWORD });
    // No recovery codes without an authenticator, so nothing to warn about.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('asks for a code when the server says an authenticator was turned on meanwhile', async () => {
    const user = userEvent.setup();
    const { requests } = fakeApi({
      ...signedOut(false),
      'POST /api/auth/login': ({ body }) =>
        (body as { totpCode?: string }).totpCode === undefined
          ? json({ code: 'code_required', message: 'Enter a code from your authenticator app or a recovery code.' }, 422)
          : { body: { authenticatorEnabled: true, recoveryCodesRemaining: 10 } },
    });
    const { history } = renderApp('/login');
    await user.type(await screen.findByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a code from your authenticator app');
    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/budget'));
    expect(requests.filter((r) => r.method === 'POST').at(-1)!.body).toEqual({ password: PASSWORD, totpCode: '123456' });
  });
});

describe('sign-in with an authenticator', () => {
  it('signs in with the password and an authenticator code, then opens the page asked for', async () => {
    const user = userEvent.setup();
    const { requests } = fakeApi({
      ...signedOut(true),
      'POST /api/auth/login': { body: { authenticatorEnabled: true, recoveryCodesRemaining: 10 } },
    });
    const { history } = renderApp('/login?redirect=%2Fpayees');
    await user.type(await screen.findByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Authenticator code'), '12a3456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/payees'));
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ password: PASSWORD, totpCode: '123456' });
  });

  it('signs in with a recovery code instead, and warns when few are left', async () => {
    const user = userEvent.setup();
    const { requests } = fakeApi({
      ...signedOut(true),
      'POST /api/auth/login': { body: { authenticatorEnabled: true, recoveryCodesRemaining: 2 } },
    });
    const { history } = renderApp('/login');
    await user.type(await screen.findByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('radio', { name: 'Recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), '7kqm-w3xp-9dhr');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/budget'));
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ password: PASSWORD, recoveryCode: '7kqm-w3xp-9dhr' });
    expect(await screen.findByRole('status')).toHaveTextContent('Only 2 recovery codes left.');
  });

  it('explains a wrong password or code, and when to try again after too many attempts', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    fakeApi({
      ...signedOut(true),
      'POST /api/auth/login': () =>
        ++attempts === 1
          ? json({ code: 'invalid_credentials', message: 'Wrong password or code.' }, 401)
          : json({ code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' }, 429, {
              'Retry-After': '42',
            }),
    });
    const { history } = renderApp('/login');
    await user.type(await screen.findByLabelText('Password'), 'guess');
    await user.type(screen.getByLabelText('Authenticator code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password or code.');
    expect(history.location.pathname).toBe('/login');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('You can try again in 42 seconds.'));
  });
});
