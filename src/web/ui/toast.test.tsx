import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { type ToastApi, ToastProvider, useToast } from './toast';

function renderToasts() {
  let api!: ToastApi;
  function Grab() {
    api = useToast();
    return null;
  }
  render(
    <ToastProvider>
      <Grab />
    </ToastProvider>,
  );
  return () => api;
}

describe('toasts', () => {
  it('show a message with an action that runs and dismisses it', async () => {
    const toasts = renderToasts();
    const undo = vi.fn();
    act(() => {
      toasts().show({ message: 'Rename payee "Lidl"', action: { label: 'Undo', onClick: undo } });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Rename payee "Lidl"');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('replace a toast with the same key and announce errors as alerts', () => {
    const toasts = renderToasts();
    act(() => {
      toasts().show({ message: 'First command', key: 'command' });
      toasts().show({ message: 'Second command', key: 'command' });
      toasts().show({ message: "Can't undo: data changed since.", tone: 'error' });
    });
    expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual(['Second command']);
    expect(screen.getByRole('alert')).toHaveTextContent("Can't undo: data changed since.");
  });

  it('go away by themselves', () => {
    vi.useFakeTimers();
    try {
      const toasts = renderToasts();
      act(() => {
        toasts().show({ message: 'Saved' });
        toasts().show({ message: 'Failed', tone: 'error' });
      });
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.queryByText('Saved')).toBeNull();
      expect(screen.getByText('Failed')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(3000));
      expect(screen.queryByText('Failed')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
