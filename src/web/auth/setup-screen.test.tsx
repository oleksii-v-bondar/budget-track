import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { renderApp } from '../test/render';

const PASSWORD = 'correct horse battery staple';
const ALREADY_SETUP = { code: 'already_setup', message: 'This budget is already set up. Sign in instead.' };
const SETUP_REQUIRED = {
  'GET /api/auth/status': { body: { setupRequired: true, authenticated: false, authenticatorEnabled: false } },
  'GET /api/undo': { body: { undo: null, redo: null } },
};

async function enterPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Password'), PASSWORD);
  await user.type(screen.getByLabelText('Repeat the password'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Finish setup' }));
}

describe('setup wizard', () => {
  it('asks for the setup token and a password, then signs in and opens the budget', async () => {
    const user = userEvent.setup();
    const { requests } = fakeApi({ ...SETUP_REQUIRED, 'POST /api/auth/setup': { status: 201, body: { ok: true } } });
    const { history } = renderApp('/setup');

    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Setup token')).toHaveAccessibleDescription('Enter the setup token.');
    await user.type(screen.getByLabelText('Setup token'), 'the-token');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Choose a password' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'too short');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Use at least 12 characters.');
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Repeat the password'), `${PASSWORD}!`);
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(screen.getByLabelText('Repeat the password')).toHaveAccessibleDescription("The passwords don't match.");
    expect(requests.filter((r) => r.method === 'POST')).toEqual([]);

    await user.type(screen.getByLabelText('Repeat the password'), '{Backspace}');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(history.location.pathname).toBe('/budget'));
    expect(screen.queryByRole('img', { name: 'QR code for your authenticator app' })).toBeNull();
    expect(requests.filter((r) => r.method === 'POST').map(({ path, body }) => ({ path, body }))).toEqual([
      { path: '/api/auth/setup', body: { setupToken: 'the-token', password: PASSWORD } },
    ]);
  });

  it('goes back to the setup token when the server refuses it, keeping the password', async () => {
    const user = userEvent.setup();
    const { requests } = fakeApi({
      ...SETUP_REQUIRED,
      'POST /api/auth/setup': ({ body }) =>
        (body as { setupToken: string }).setupToken === 'the-token'
          ? { status: 201, body: { ok: true } }
          : json({ code: 'invalid_setup_token', message: 'That setup token is not correct.' }, 403),
    });
    const { history } = renderApp('/setup');
    await user.type(await screen.findByLabelText('Setup token'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await enterPassword(user);

    expect(await screen.findByRole('heading', { name: 'Set up your budget' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('That setup token is not correct.');
    await user.clear(screen.getByLabelText('Setup token'));
    await user.type(screen.getByLabelText('Setup token'), 'the-token');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Password')).toHaveValue(PASSWORD);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(history.location.pathname).toBe('/budget'));
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(2);
  });

  it('points to sign-in when the budget is already set up', async () => {
    const user = userEvent.setup();
    fakeApi({ ...SETUP_REQUIRED, 'POST /api/auth/setup': () => json(ALREADY_SETUP, 409) });
    const { history } = renderApp('/setup');
    await user.type(await screen.findByLabelText('Setup token'), 'the-token');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await enterPassword(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('This budget is already set up.');
    await user.click(screen.getByRole('link', { name: 'Go to sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
