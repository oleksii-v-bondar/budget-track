import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { renderApp } from '../test/render';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CC${String(i).padStart(2, '0')}`);
const PASSWORD = 'correct horse battery staple';

function setupServer() {
  return fakeApi({
    'GET /api/auth/status': { body: { setupRequired: true, authenticated: false } },
    'GET /api/undo': { body: { undo: null, redo: null } },
    'POST /api/auth/setup/totp': ({ body }) =>
      (body as { setupToken: string }).setupToken === 'the-token'
        ? { body: { secret: SECRET, uri: `otpauth://totp/Budget%20Track:owner?secret=${SECRET}` } }
        : json({ code: 'invalid_setup_token', message: 'That setup token is not correct.' }, 403),
    'POST /api/auth/setup': ({ body }) =>
      (body as { totpCode: string }).totpCode === '123456'
        ? { status: 201, body: { recoveryCodes: CODES } }
        : json({ code: 'invalid_totp_code', message: "That code didn't match." }, 422),
  });
}

describe('setup wizard', () => {
  it('walks through token, password, authenticator and recovery codes into the app', async () => {
    const user = userEvent.setup();
    const { requests } = setupServer();
    const { history } = renderApp('/setup');

    await user.type(await screen.findByLabelText('Setup token'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That setup token is not correct.');
    await user.clear(screen.getByLabelText('Setup token'));
    await user.type(screen.getByLabelText('Setup token'), 'the-token');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Choose a password' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'too short');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Use at least 12 characters.');
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Repeat the password'), `${PASSWORD}!`);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Repeat the password')).toHaveAccessibleDescription("The passwords don't match.");
    await user.type(screen.getByLabelText('Repeat the password'), '{Backspace}');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Add an authenticator' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeInTheDocument();
    expect(screen.getByTestId('totp-secret')).toHaveTextContent('JBSW Y3DP');
    await user.type(screen.getByLabelText('Code from the app'), '000000');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That code didn't match.");
    await user.clear(screen.getByLabelText('Code from the app'));
    await user.type(screen.getByLabelText('Code from the app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByRole('heading', { name: 'Save your recovery codes' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    const enter = screen.getByRole('button', { name: 'Continue to the budget' });
    expect(enter).toBeDisabled();
    await user.click(screen.getByLabelText("I've saved my recovery codes"));
    await user.click(enter);
    await waitFor(() => expect(history.location.pathname).toBe('/budget'));

    const posts = requests.filter((r) => r.method === 'POST');
    expect(posts.at(-1)).toMatchObject({
      path: '/api/auth/setup',
      body: { setupToken: 'the-token', password: PASSWORD, totpSecret: SECRET, totpCode: '123456' },
    });
  });

  it('points to sign-in when the budget is already set up', async () => {
    const user = userEvent.setup();
    fakeApi({
      'GET /api/auth/status': { body: { setupRequired: true, authenticated: false } },
      'POST /api/auth/setup/totp': json({ code: 'already_setup', message: 'This budget is already set up. Sign in instead.' }, 409),
    });
    renderApp('/setup');
    await user.type(await screen.findByLabelText('Setup token'), 'the-token');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This budget is already set up.');
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/login');
  });
});
