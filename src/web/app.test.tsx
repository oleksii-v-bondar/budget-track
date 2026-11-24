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

  it('send a signed-in owner from the sign-in page and / to Home', async () => {
    fakeApi(SIGNED_IN);
    for (const path of ['/', '/login']) {
      const { history, unmount } = renderApp(path);
      await waitFor(() => expect(history.location.pathname).toBe('/home'));
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

/** Opens the "…" menu of the screen's top bar. */
async function openMenu() {
  await userEvent.click(await screen.findByRole('button', { name: 'More' }));
  return screen.getByRole('menu', { name: 'More' });
}

describe('app shell', () => {
  it('shows the tab bar, and Undo/Redo in the "…" menu', async () => {
    fakeApi(SIGNED_IN);
    renderApp('/budget');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Home',
      'Plan',
      'Spending',
      'Accounts',
      'Reflect',
    ]);
    expect(within(nav).getByRole('link', { name: 'Plan' })).toHaveAttribute('aria-current', 'page');
    const menu = await openMenu();
    expect(within(menu).getByRole('menuitem', { name: 'Undo' })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: 'Redo' })).toBeDisabled();
  });

  it('reaches Settings from the "…" menu', async () => {
    fakeApi(SIGNED_IN);
    renderApp('/budget');
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('closes the "…" menu with Escape', async () => {
    fakeApi(SIGNED_IN);
    renderApp('/home');
    await openMenu();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
  });

  it('opens a new transaction in a sheet from "+ Transaction"', async () => {
    fakeApi(SIGNED_IN);
    renderApp('/home');
    await userEvent.click(await screen.findByRole('button', { name: 'New transaction' }));
    expect(screen.getByRole('dialog', { name: 'New transaction' })).toBeInTheDocument();
  });

  it('undoes and redoes from the "…" menu, naming the command', async () => {
    const { requests } = fakeApi({
      ...SIGNED_IN,
      'GET /api/undo': { body: { undo: { label: 'Create payee "Lidl"' }, redo: null } },
      'POST /api/undo': { body: { undo: null, redo: { label: 'Create payee "Lidl"' }, undone: { label: 'Create payee "Lidl"' } } },
    });
    renderApp('/budget');
    const menu = await openMenu();
    await userEvent.click(await within(menu).findByRole('menuitem', { name: 'Undo Create payee "Lidl"' }));
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
    await userEvent.click(await within(await openMenu()).findByRole('menuitem', { name: 'Undo Move money' }));
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
    await userEvent.click(await within(await openMenu()).findByRole('menuitem', { name: 'Undo Move money' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing to undo.');
    const menu = await openMenu();
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Undo' })).toBeDisabled());
  });

  it('shows the offline banner and disables Undo while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fakeApi({ ...SIGNED_IN, 'GET /api/undo': { body: { undo: { label: 'Move money' }, redo: null } } });
    renderApp('/budget');
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();
    const menu = await openMenu();
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Undo Move money' })).toBeDisabled());
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeDisabled();
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
    renderApp('/home');
    expect(await screen.findByRole('heading', { name: "This page didn't load" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(statusCalls).toBe(2);
  });
});
