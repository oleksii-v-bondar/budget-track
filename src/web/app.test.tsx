import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, json } from './test/fake-api';
import { renderApp, SIGNED_IN } from './test/render';
import { safeRedirect } from './router';

describe('route guards', () => {
  it('send a signed-out visitor to sign in, remembering where they were going', async () => {
    fakeApi({ 'GET /api/auth/status': { body: { authenticated: false } } });
    const { history } = renderApp('/settings');
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(history.location.search).toBe('?redirect=%2Fsettings');
  });

  it('send a signed-in owner from the sign-in page and / to the budget', async () => {
    fakeApi(SIGNED_IN);
    for (const path of ['/', '/login']) {
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
    for (const unsafe of ['//evil.example', '/\\evil.example', 'https://evil.example', '/login', '/login?x', 42]) {
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
      'Settings',
    ]);
    expect(within(nav).getByRole('link', { name: 'Budget' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
  });

  it('reaches Settings from the bottom navigation', async () => {
    fakeApi(SIGNED_IN);
    renderApp('/budget');
    await userEvent.click(await screen.findByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
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

  it('refreshes Undo and Redo when the server has nothing to undo', async () => {
    let undo: { label: string } | null = { label: 'Move money' };
    fakeApi({
      ...SIGNED_IN,
      'GET /api/undo': () => ({ body: { undo, redo: null } }),
      // Undone meanwhile on another device.
      'POST /api/undo': () => {
        undo = null;
        return json({ code: 'nothing_to_undo', message: 'Nothing to undo.' }, 409);
      },
    });
    renderApp('/budget');
    await userEvent.click(await screen.findByRole('button', { name: 'Undo Move money' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing to undo.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled());
  });

  it('shows the offline banner and disables Undo while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fakeApi({ ...SIGNED_IN, 'GET /api/undo': { body: { undo: { label: 'Move money' }, redo: null } } });
    renderApp('/budget');
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo Move money' })).toBeDisabled());
  });
});

describe('error screen', () => {
  it('offers to try again when a page fails to load', async () => {
    // The router reports the failed route to the console.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let statusCalls = 0;
    fakeApi({
      ...SIGNED_IN,
      // A proxy's error page the first time (not retried on its own), then the real answer.
      'GET /api/auth/status': () =>
        ++statusCalls === 1 ? new Response('<h1>Not Found</h1>', { status: 404 }) : SIGNED_IN['GET /api/auth/status'],
    });
    renderApp('/budget');
    expect(await screen.findByRole('heading', { name: "This page didn't load" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Budget' })).toBeInTheDocument();
    expect(statusCalls).toBe(2);
  });
});
