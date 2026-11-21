import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RecoveryCodes } from './recovery-codes';

const CODES = ['7KQM-W3XP-9DHR', 'AB2C-DE3F-GH4J'];

describe('RecoveryCodes', () => {
  it('lists the codes and copies them', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<RecoveryCodes codes={CODES} />);
    const list = screen.getByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(CODES);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('7KQM-W3XP-9DHR\nAB2C-DE3F-GH4J\n'));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('offers them as a text file', () => {
    render(<RecoveryCodes codes={CODES} />);
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute('download', 'budget-track-recovery-codes.txt');
    const href = link.getAttribute('href')!;
    expect(href.startsWith('data:text/plain;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(href.slice(href.indexOf(',') + 1))).toContain('7KQM-W3XP-9DHR\nAB2C-DE3F-GH4J\n');
  });

  it('says so when copying is not allowed', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    render(<RecoveryCodes codes={CODES} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText(/Couldn't copy/)).toBeInTheDocument();
  });
});
