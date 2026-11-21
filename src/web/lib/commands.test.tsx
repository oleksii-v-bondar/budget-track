import { useQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from '../ui/button';
import { fakeApi, json } from '../test/fake-api';
import { renderWithProviders } from '../test/render';
import { api, unwrap } from './api';
import { useCommand } from './commands';
import { formErrorsOf } from './form-errors';

/** A tiny screen: a list read through the cache, and a command that adds to it. */
function Payees() {
  const list = useQuery({ queryKey: ['payees'], queryFn: () => unwrap(api.api.payees.$get()) });
  const create = useCommand((name: string) => unwrap(api.api.payees.$post({ json: { name } })));
  const errors = formErrorsOf(create.error, ['name']);
  return (
    <>
      <p data-testid="count">{list.data?.payees.length ?? '…'}</p>
      <Button mutating busy={create.isPending} onClick={() => create.mutate('Lidl')}>
        Add Lidl
      </Button>
      {errors.fields.name && <p>{errors.fields.name}</p>}
    </>
  );
}

const payee = { id: 'p1', name: 'Lidl', kind: 'user', transferAccountId: null, lastCategoryId: null, usageCount: 0 };

describe('useCommand', () => {
  it('refreshes the data after the command and offers to undo it', async () => {
    let payees: (typeof payee)[] = [];
    let undo = null as { label: string } | null;
    const { requests } = fakeApi({
      'GET /api/payees': () => ({ body: { payees } }),
      'POST /api/payees': () => {
        payees = [payee];
        undo = { label: 'Create payee "Lidl"' };
        return { status: 201, body: payee };
      },
      'GET /api/undo': () => ({ body: { undo, redo: null } }),
      'POST /api/undo': () => {
        payees = [];
        return { body: { undo: null, redo: undo, undone: undo } };
      },
    });
    renderWithProviders(<Payees />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    await userEvent.click(screen.getByRole('button', { name: 'Add Lidl' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Create payee "Lidl"');
    expect(screen.getByTestId('count')).toHaveTextContent('1');

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Undone: Create payee "Lidl"');
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/payees', '/api/undo']);
  });

  it('leaves validation errors to the form, and offers Retry after a server failure', async () => {
    let calls = 0;
    fakeApi({
      'GET /api/payees': { body: { payees: [] } },
      'GET /api/undo': { body: { undo: null, redo: null } },
      'POST /api/payees': () => {
        calls++;
        return calls === 1
          ? json({ code: 'validation', message: 'Some fields are invalid.', fieldErrors: { name: ['Enter a name.'] } }, 400)
          : json({ code: 'internal', message: 'Something went wrong.', requestId: 'r1' }, 500);
      },
    });
    renderWithProviders(<Payees />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add Lidl' }));
    expect(await screen.findByText('Enter a name.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add Lidl' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toBe(3));
  });
});
