import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, json } from './test/fake-api';
import { renderApp, SIGNED_IN } from './test/render';
import { safeRedirect } from './router';

const status = (setupRequired: boolean, authenticated: boolean) => ({
  'GET /api/auth/status': { body: { setupRequired, authenticated } },
});

describe('route guards', () => {
  it('send a fresh install to setup', async () => {
    fakeApi(status(true, false));
    const { history } = renderApp('/budget');
    await waitFor(() => expect(history.location.pathname).toBe('/setup'));
  });

  it('send a signed-out visitor to sign in, remembering where they were going', async () => {
    fakeApi(status(false, false));
    const { history } = renderApp('/payees');
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(history.location.search).toBe('?redirect=%2Fpayees');
  });

  it('send a signed-in owner from the sign-in pages and / to the budget', async () => {
    fakeApi(SIGNED_IN);
    for (const path of ['/', '/login', '/setup']) {
      const { history, unmount } = renderApp(path);
      await waitFor(() => expect(history.location.pathname).toBe('/budget'));
      unmount();
    }
  });

  it('send the owner to sign in when the session ends', async () => {
    fakeApi({
      ...SIGNED_IN,
      'GET /api/undo': json({ code: 'unauthorized', message: 'Please sign in.' }, 401),
    });
    const { history } = renderApp('/accounts');
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(history.location.search).toBe('?redirect=%2Faccounts');
  });

  it('only redirect to paths of this app after signing in', () => {
    expect(safeRedirect('/budget/2026-11?x=1')).toBe('/budget/2026-11?x=1');
    for (const unsafe of ['//evil.example', '/\\evil.example', 'https://evil.example', '/login', '/setup?x', 42]) {
      expect(safeRedirect(unsafe)).toBeUndefined();
    }
  });
});

describe('app shell', () => {
  it('shows the screen title, Undo/Redo and the bottom navigation', async () => {
    fakeApi(SIGNED_IN);
    renderApp('/budget');
    expect(await screen.findByRole('heading', { name: 'Budget' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent || link.getAttribute('aria-label'))).toEqual([
      'Budget',
      'Accounts',
      'New transaction',
      'More',
    ]);
    expect(within(nav).getByRole('link', { name: 'Budget' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
  });

  it('reaches Scheduled, Payees and Settings through More', async () => {
    fakeApi(SIGNED_IN);
    renderApp('/budget');
    await userEvent.click(await screen.findByRole('link', { name: 'More' }));
    expect(await screen.findByRole('heading', { name: 'More' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Payees' }));
    expect(await screen.findByRole('heading', { name: 'Payees' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'More' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Budget' })).not.toHaveAttribute('aria-current');
  });

  it('undoes and redoes from the header, naming the command', async () => {
    const { requests } = fakeApi({
      ...SIGNED_IN,
      'GET /api/undo': { body: { undo: { label: 'Create payee "Lidl"' }, redo: null } },
      'POST /api/undo': { body: { undo: null, redo: { label: 'Create payee "Lidl"' }, undone: { label: 'Create payee "Lidl"' } } },
    });
    renderApp('/budget');
    await userEvent.click(await screen.findByRole('button', { name: 'Undo Create payee "Lidl"' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Undone: Create payee "Lidl"');
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/undo']);
    expect(requests.find((r) => r.method === 'POST')!.headers.get('X-Requested-With')).toBe('budget-track');
  });

  it("shows the server's message when undo is refused", async () => {
    fakeApi({
      ...SIGNED_IN,
      'GET /api/undo': { body: { undo: { label: 'Move money' }, redo: null } },
      'POST /api/undo': json({ code: 'undo_conflict', message: "Can't undo: data changed since." }, 409),
    });
    renderApp('/budget');
    await userEvent.click(await screen.findByRole('button', { name: 'Undo Move money' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't undo: data changed since.");
  });

  it('shows the offline banner and disables Undo while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fakeApi({ ...SIGNED_IN, 'GET /api/undo': { body: { undo: { label: 'Move money' }, redo: null } } });
    renderApp('/budget');
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo Move money' })).toBeDisabled());
  });
});
