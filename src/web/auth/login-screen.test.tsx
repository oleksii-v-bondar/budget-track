import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { renderApp } from '../test/render';

const SIGNED_OUT = {
  'GET /api/auth/status': { body: { setupRequired: false, authenticated: false } },
  'GET /api/undo': { body: { undo: null, redo: null } },
};

describe('sign-in', () => {
  it('signs in with the password and an authenticator code, then opens the page asked for', async () => {
    const user = userEvent.setup();
    const { requests } = fakeApi({ ...SIGNED_OUT, 'POST /api/auth/login': { body: { recoveryCodesRemaining: 10 } } });
    const { history } = renderApp('/login?redirect=%2Fpayees');
    await user.type(await screen.findByLabelText('Password'), 'correct horse battery staple');
    await user.type(screen.getByLabelText('Authenticator code'), '12a3456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/payees'));
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({
      password: 'correct horse battery staple',
      totpCode: '123456',
    });
  });

  it('signs in with a recovery code instead, and warns when few are left', async () => {
    const user = userEvent.setup();
    const { requests } = fakeApi({ ...SIGNED_OUT, 'POST /api/auth/login': { body: { recoveryCodesRemaining: 2 } } });
    const { history } = renderApp('/login');
    await user.type(await screen.findByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('radio', { name: 'Recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), '7kqm-w3xp-9dhr');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/budget'));
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({
      password: 'correct horse battery staple',
      recoveryCode: '7kqm-w3xp-9dhr',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Only 2 recovery codes left.');
  });

  it('explains a wrong password or code, and when to try again after too many attempts', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    fakeApi({
      ...SIGNED_OUT,
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
