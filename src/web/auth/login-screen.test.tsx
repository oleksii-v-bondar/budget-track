import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { renderApp } from '../test/render';

const SIGNED_OUT = {
  'GET /api/auth/status': { body: { authenticated: false } },
  'GET /api/undo': { body: { undo: null, redo: null } },
};
const CREDENTIALS = { username: 'owner', password: 'correct horse battery staple' };

describe('sign-in', () => {
  it('asks for the username and password, then opens the page asked for', async () => {
    const user = userEvent.setup();
    const { requests } = fakeApi({ ...SIGNED_OUT, 'POST /api/auth/login': { body: { ok: true } } });
    const { history } = renderApp('/login?redirect=%2Fpayees');
    await user.type(await screen.findByLabelText('Username'), CREDENTIALS.username);
    await user.type(screen.getByLabelText('Password'), CREDENTIALS.password);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/payees'));
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual(CREDENTIALS);
  });

  it('explains a wrong username or password', async () => {
    const user = userEvent.setup();
    fakeApi({
      ...SIGNED_OUT,
      'POST /api/auth/login': json({ code: 'invalid_credentials', message: 'Wrong username or password.' }, 401),
    });
    const { history } = renderApp('/login');
    await user.type(await screen.findByLabelText('Username'), 'owner');
    await user.type(screen.getByLabelText('Password'), 'guess');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password.');
    expect(history.location.pathname).toBe('/login');
  });
});
